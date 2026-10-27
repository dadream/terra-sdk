const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')
const {invariant} = require('../../sdk/js/core/terra_globe_common')
const {CooperativeTask, TASK_WAIT} = require('../../sdk/js/runtime/cooperative_task')
const {textureCellTransform} = require('../../sdk/js/imagery/terra_texture_tiles')
const wasmLoader = require('./terra_wasm')
const {requireStatus} = require('./abi_status')
const {Cleanup} = require('../../sdk/js/runtime/cleanup')
const {NativeMeasurementRows,NativeMeasurementLoans}=require('./native_surface_measurement')

// One owner for a persistent native tree, its source mapping and input snapshot.
// Distinct owners can interleave steps; a newer task cancels only this owner's
// previous packing/continuation. No terrain or image payload is duplicated here.
class ImageryPlanner {
  constructor(abi) {
    invariant(abi.context&&!abi.destroyed,'Imagery planner is closed')
    this.abi = abi
    this.tasks = new Set()
    this.closed = false
    const pointer = abi.alloc(4)
    try {
      requireStatus(abi.module.call('terra_open_imagery', abi.context, pointer), 'terra_open_imagery')
      this.id = abi.module.refreshMemory().dataView.getUint32(pointer, true)
      abi.imageryPlanners.add(this)
    } catch (error) {
      if (this.id) abi.module.call('terra_close_imagery', abi.context, this.id)
      throw error
    } finally { abi.free(pointer) }
  }

  assertOpen() { invariant(!this.closed && this.abi.context, 'Imagery planner is closed') }

  call(name, ...args) {
    this.assertOpen()
    try { requireStatus(this.abi.module.call(name, this.abi.context, this.id, ...args), name) }
    finally {
      if (['terra_step_imagery', 'terra_commit_imagery_input', 'terra_reset_imagery',
        'terra_close_imagery'].includes(name) || name === 'terra_accept_imagery' && args[1] > 0)
        ++this.abi.imageryReferenceRevision
      this.abi.observeImageryInput()
    }
  }

  cancelTasks() {
    const cleanup=new Cleanup(),tasks=Array.from(this.tasks)
    this.tasks.clear()
    for(const task of tasks)cleanup.run(()=>task.cancel())
    cleanup.finish()
  }

  invalidate() {
    if (this.closed) return
    this.closed = true
    try {this.cancelTasks()}
    finally {this.input = this.adapter = this.output = null;this.abi.imageryPlanners.delete(this)}
  }

  destroy() {
    if (this.closed) return
    const cleanup=new Cleanup()
    cleanup.run(()=>this.abi.closeNativeSurfaceOwners(this.id))
    cleanup.run(()=>this.call('terra_close_imagery'))
    cleanup.run(()=>this.invalidate());cleanup.finish()
  }

  plan(draws, measureDraw, options) {
    this.assertOpen()
    this.cancelTasks()
    const loans=new NativeMeasurementLoans(),steps = this.steps(draws, measureDraw, options,loans)
    try {
      let result = steps.next()
      while (!result.done) result = steps.next()
      return result.value
    }finally{loans.clear()}
  }

  createTask(draws, measureDraw, options) {
    this.assertOpen()
    this.cancelTasks()
    const owner = this,loans=new NativeMeasurementLoans()
    let task
    function* work() {
      try { return yield* owner.steps(draws, measureDraw, {...options, incremental: true},loans) }
      finally { owner.tasks.delete(task);loans.clear() }
    }
    task = new CooperativeTask(work())
    const cancel = task.cancel.bind(task)
    task.cancel = () => { this.tasks.delete(task); cancel() }
    this.tasks.add(task)
    return task
  }

  *steps(draws, measureDraw, options,loans) {
    invariant(this.abi.imageryLayout, 'Core imagery planning is unavailable')
    this.assertOpen()
    const value = options || {}, descriptor = value.descriptor || {}
    const signature = JSON.stringify(descriptor)
    if (value.continuation) {
      invariant(this.input && signature === this.signature, 'Imagery continuation has no matching input')
      return yield* this.continuePlan(this.input.draws, {...this.input.options, ...value})
    }
    const adapter = new ImageryAdapter(descriptor)
    const surfaces = []
    const previous = this.signature === signature && !value.resetHistory && this.input && this.input.members
    let newSurfaces = 0, regionCount = 0, hullCount = 0, totalRegions = 0, totalHull = 0
    for (let index = 0; index < draws.length; ++index) {
      const draw = draws[index]
      const m = measureDraw(draw)
      if (m.visible) {
        const regions = m.regions || [{ uv: m.bounds, pixelsPerUv: m.pixelsPerUv }]
        const hull = m.hull || []
        const source = JSON.stringify(draw.textureNode)
        // Measurements are immutable snapshots. Projection/refinement changes
        // produce a new object; a global cut revision or reordering does not.
        const old = previous && Number.isSafeInteger(draw.resourceId) && previous.get(draw.resourceId)
        const retained = old && old.measurement === m && old.source === source ? old : null
        const native=regions instanceof NativeMeasurementRows
        if(native)loans.hold(regions)
        surfaces.push({draw, index, regions, hull, source, measurement:m, retained,native})
        totalRegions += regions.length; totalHull += hull.length
        if (!retained&&!native) { ++newSurfaces; regionCount += regions.length; hullCount += hull.length }
      }
      if (value.incremental && (index + 1) % 64 === 0) yield
    }
    invariant(surfaces.length <= 65536 && totalRegions <= 1048576 && totalHull <= 393216,
      'Imagery input exceeds the native shape limits')
    const nativeBytes = this.abi.module.call('terra_imagery_input_work_bytes', surfaces.length, newSurfaces, regionCount, hullCount) >>> 0
    const surfaceBytes = newSurfaces ? 48 : 0
    const regionBytes = Math.min(regionCount, 256) * 176, hullBytes = Math.min(hullCount, 256) * 16
    const workBytes = nativeBytes + 52 + surfaceBytes + regionBytes + hullBytes
    invariant(nativeBytes !== 0xffffffff && Number.isSafeInteger(workBytes), 'Invalid imagery input quote')
    let credit
    if (value.inputWorkspace) {
      while (!(credit = value.inputWorkspace.reserve(workBytes))) yield TASK_WAIT
    } else credit = this.abi.beginImageryInput(workBytes)
    const pointers = []
    let staged = false
    const alloc = bytes => {
      if (!bytes) return 0
      const pointer = this.abi.alloc(bytes,'imagery-input'); pointers.push({pointer, bytes})
      return pointer
    }
    try {
      const optionPointer = alloc(48), surfacePointer = alloc(surfaceBytes)
      const regionPointer = alloc(regionBytes), hullPointer = alloc(hullBytes)
      let view = this.abi.module.refreshMemory().dataView
      view.setUint32(optionPointer, 48, true); view.setUint32(optionPointer + 4, wasmLoader.TERRA_ABI_VERSION, true)
      view.setUint32(optionPointer + 8, adapter.tileSize, true)
      view.setUint32(optionPointer + 12, adapter.maximumDepth, true)
      view.setFloat64(optionPointer + 16, value.targetPixelError || 1.25, true)
      view.setUint32(optionPointer + 24, value.maximumTextures || 214, true)
      view.setUint32(optionPointer + 28, draws.length +
        (Number.isInteger(value.maximumDraws) ? value.maximumDraws : 512), true)
      view.setUint32(optionPointer + 32, descriptor.level_zero_columns, true)
      view.setUint32(optionPointer + 36, descriptor.level_zero_rows, true)
      view.setUint32(optionPointer + 40, descriptor.maximum_level, true)
      view.setUint32(optionPointer + 44, 0, true)
      staged = true
      this.call('terra_stage_imagery_input', optionPointer, surfaces.length, newSurfaces, regionCount, hullCount,
        nativeBytes, this.signature !== signature || value.resetHistory ? 1 : 0)
      let copied = 0
      for (let i = 0; i < surfaces.length; ++i) {
        const surface = surfaces[i], tile = surface.draw.textureNode, offset = surfacePointer
        if (surface.retained) {
          this.call('terra_append_retained_imagery_surface', surface.retained.index, surface.index)
          if (value.incremental && (i + 1) % 64 === 0) yield
          continue
        }
        if(surface.native) {
          surface.regions.appendTo(this,surface.index)
          if(value.incremental&&(i+1)%64===0)yield
          continue
        }
        view = this.abi.module.refreshMemory().dataView
        view.setUint32(offset, 48, true); view.setUint32(offset + 4, surface.index, true)
        view.setUint32(offset + 8, tile.level, true); view.setInt32(offset + 12, tile.root, true)
        view.setInt32(offset + 16, tile.row, true); view.setInt32(offset + 20, tile.column, true)
        view.setUint32(offset + 24, 0, true); view.setUint32(offset + 28, surface.regions.length, true)
        view.setUint32(offset + 32, 0, true); view.setUint32(offset + 36, surface.hull.length, true)
        view.setUint32(offset + 40, value.detached ? 0 : surface.draw.resourceId || 0, true); view.setUint32(offset + 44, 0, true)
        this.call('terra_append_imagery_surface', surfacePointer)
        for (let first = 0; first < surface.regions.length; first += 256) {
          const count = Math.min(256, surface.regions.length - first)
          view = this.abi.module.refreshMemory().dataView
          for (let j = 0; j < count; ++j) {
            const region = surface.regions[first + j], uv = region.uv, offset = regionPointer + j * 176
            view.setFloat64(offset, uv.minimumU, true); view.setFloat64(offset + 8, uv.minimumV, true)
            view.setFloat64(offset + 16, uv.maximumU, true); view.setFloat64(offset + 24, uv.maximumV, true)
            view.setFloat64(offset + 32, region.pixelsPerUv, true)
            for (let k = 0; k < 9; ++k) view.setFloat64(offset + 40 + k * 8, region.projection ? region.projection[k] : 0, true)
            for (let k = 0; k < 3; ++k) {
              view.setFloat64(offset + 112 + k * 16, region.triangle ? region.triangle[k][0] : 0, true)
              view.setFloat64(offset + 120 + k * 16, region.triangle ? region.triangle[k][1] : 0, true)
            }
            view.setFloat64(offset + 160, region.numeratorBound === undefined ? -1 : region.numeratorBound, true)
            view.setUint32(offset + 168, Number(Boolean(region.projection)) | Number(Boolean(region.triangle)) << 1 |
              Number(region.numeratorBound !== undefined) << 2, true)
            const domain = region.domain === undefined ? 0xffffffff : region.domain
            invariant(Number.isInteger(domain) && domain >= 0 && domain <= 0xffffffff, 'Invalid measurement domain')
            view.setUint32(offset + 172, domain, true)
          }
          this.call('terra_append_imagery_regions', regionPointer, count)
          copied += count
          if (value.incremental && copied >= 256) { copied = 0; yield }
        }
        for (let first = 0; first < surface.hull.length; first += 256) {
          const count = Math.min(256, surface.hull.length - first)
          view = this.abi.module.refreshMemory().dataView
          for (let j = 0; j < count; ++j) {
            const point = surface.hull[first + j], offset = hullPointer + j * 16
            view.setFloat64(offset, point[0], true); view.setFloat64(offset + 8, point[1], true)
          }
          this.call('terra_append_imagery_hull', hullPointer, count)
          copied += count
          if (value.incremental && copied >= 256) { copied = 0; yield }
        }
        if (value.incremental && (i + 1) % 64 === 0) yield
      }
      this.call('terra_commit_imagery_input', 1)
      staged = false
      this.signature = signature
      this.adapter = adapter
      this.output = null
      this.sourceDrawCount = surfaces.length
      this.input = {draws: draws.slice(), options: value, members: new Map(surfaces.map(surface =>
        [surface.draw.resourceId, {index:surface.index, source:surface.source, measurement:surface.measurement}]))}
    } finally {
      if (staged && !this.closed && this.abi.context)
        this.abi.module.call('terra_cancel_imagery_input', this.abi.context, this.id)
      for (const {pointer, bytes} of pointers) {
        this.abi.free(pointer)
      }
      this.abi.observeImageryInput()
      credit.release()
    }
    return yield* this.continuePlan(draws, value)
  }

  *continuePlan(draws, options) {
    const pointer = this.abi.alloc(4)
    try {
      let rounds = 0
      for (;;) {
        const outputNeeded = this.abi.module.call('terra_imagery_output_work_bytes', this.abi.context, this.id) >>> 0
        invariant(outputNeeded !== 0xffffffff, 'Invalid imagery output quote')
        const needed = this.abi.module.call('terra_imagery_reference_work_bytes', this.abi.context, this.id) >>> 0
        invariant(needed !== 0xffffffff, 'Invalid imagery reference quote')
        let credit
        if (needed && !outputNeeded) {
          if (options.referenceWorkspace) {
            const workspace = options.referenceWorkspace()
            while (!(credit = workspace.reserve(needed))) yield TASK_WAIT
            credit.bytes = workspace.granted
          } else credit = this.abi.beginImageryReferences(needed)
        }
        let outputCredit
        try {
          if (outputNeeded) outputCredit = yield* this.outputCredit(outputNeeded, options)
          this.stepPlan(pointer, options, credit, outputCredit)
        } finally { if (credit) credit.release(); if (outputCredit) outputCredit.release() }
        const done = this.abi.module.refreshMemory().dataView.getUint32(pointer, true)
        const waiting = (this.abi.module.call('terra_imagery_reference_work_bytes', this.abi.context, this.id) >>> 0) ||
          (this.abi.module.call('terra_imagery_output_work_bytes', this.abi.context, this.id) >>> 0)
        // A quota stop is a resumable allocation boundary, not a completed
        // planning round. Keep this task until the grant has been consumed.
        if (done || options.incremental && !waiting && ++rounds >= (options.maximumRounds || Infinity)) break
        if (options.incremental) yield
      }
      return yield* this.readPlanSteps(draws, options)
    } finally { this.abi.free(pointer) }
  }

  stepPlan(pointer, options, credit, outputCredit) {
    const started = Date.now()
    // Amortize allocation-free work and reuse one funded reference slice across
    // small priority/topology steps within the same CPU/operation limit.
    // No yield or other planner may intervene while its retained delta is
    // measured. Native still funds the whole new buffer during each reserve.
    // A decrease may already refund resident ownership through observe(); it
    // cannot replenish this grant. Debit each positive step delta separately.
    let remaining = credit ? credit.bytes : 0
    for (let step = 0; step < 8; ++step) {
      const before = this.abi.imageryReferencePayloadBytes()
      this.call('terra_step_imagery', 16, 64, options.incremental ? Math.max(1, 4 - (Date.now() - started)) : 0,
        remaining, outputCredit ? outputCredit.bytes : 0, pointer)
      remaining -= Math.max(0, this.abi.imageryReferencePayloadBytes() - before)
      invariant(remaining >= 0, 'Imagery references exceeded their credit')
      // A missing reference grant allows only zero-growth native work; the
      // zero allowance and delta check still forbid unpriced allocations.
      // Output publication consumes its own receipt before another step.
      if (outputCredit || this.abi.module.refreshMemory().dataView.getUint32(pointer, true) ||
          (this.abi.module.call('terra_imagery_output_work_bytes', this.abi.context, this.id) >>> 0) ||
          (this.abi.module.call('terra_imagery_reference_work_bytes', this.abi.context, this.id) >>> 0) > remaining ||
          options.incremental && Date.now() - started >= 4) break
    }
  }

  readPlan(draws, value) {
    const work = this.readPlanSteps(draws, {...value, incremental:false})
    let result = work.next()
    while (!result.done) result = work.next()
    return result.value
  }

  *outputCredit(bytes, options) {
    if (!options.outputWorkspace) return this.abi.beginImageryOutput(bytes)
    const workspace = options.outputWorkspace()
    let credit
    while (!(credit = workspace.reserve(bytes))) yield TASK_WAIT
    credit.bytes = workspace.granted
    return credit
  }

  *readPlanSteps(draws, value) {
    // Fixed ABI control scalars remain administrative scratch. Bulk range
    // storage needs a production grant only when the immutable output changes.
    const qualityPointer = this.abi.alloc(56)
    let rangePointer = 0, bytes = 0, credit
    try {
      let view = this.abi.module.refreshMemory().dataView
      view.setUint32(qualityPointer, 56, true)
      requireStatus(this.abi.module.call('terra_get_imagery_quality', this.abi.context, this.id, qualityPointer), 'terra_get_imagery_quality')
      view = this.abi.module.refreshMemory().dataView
      // Copy scalars before draw readback can allocate or grow Wasm memory.
      const requested = view.getFloat64(qualityPointer + 8, true)
      const textureCount = view.getUint32(qualityPointer + 32, true)
      const drawCount = view.getUint32(qualityPointer + 36, true)
      const cachedNodeCount = view.getUint32(qualityPointer + 40, true)
      const flags = view.getUint32(qualityPointer + 44, true)
      const revision = `${view.getUint32(qualityPointer + 52, true)}:${view.getUint32(qualityPointer + 48, true)}`
      if (!this.output || this.output.revision !== revision || this.output.requested !== requested) {
        if (drawCount) {
          bytes = 8 + Math.min(drawCount, 256) * 32
          credit = yield* this.outputCredit(bytes, value)
          rangePointer = this.abi.alloc(bytes,'imagery-output')
        }
        const result = []
        const selectedLevels = []
        for (let first = 0; first < drawCount; first += 256) {
          const count = Math.min(256, drawCount - first), countPointer = rangePointer
          const drawPointer = rangePointer + 8
          requireStatus(this.abi.module.call('terra_get_imagery_draws', this.abi.context, this.id,
            first, drawPointer, count, countPointer), 'terra_get_imagery_draws')
          const output = this.abi.module.refreshMemory().dataView
          invariant(output.getUint32(countPointer, true) === count, 'Imagery output snapshot range changed')
          for (let row = 0; row < count; ++row) {
            const offset = drawPointer + row * 32
            const source = draws[output.getUint32(offset + 4, true)]
            invariant(source, 'Core imagery returned an invalid draw index')
            const node = { level: output.getUint32(offset + 8, true), root: output.getInt32(offset + 12, true),
              row: output.getInt32(offset + 16, true), column: output.getInt32(offset + 20, true) }
            const nodeError = output.getFloat64(offset + 24, true)
            const coarseRoot = node.level === 0 && this.adapter.levelOffset > 0 &&
              this.adapter.source.maximum_level >= this.adapter.levelOffset &&
              nodeError * Math.pow(2, this.adapter.levelOffset) <= (value.targetPixelError || 1.25)
            const binding = this.adapter.bind(node, coarseRoot ? 0 : undefined)
            const tile = binding.resource
            const t = textureCellTransform(source.texture, tile)
            const error = nodeError * this.adapter.tileSize / binding.effectivePixels
            selectedLevels.push(tile.level)
            result.push(Object.assign({}, source, { texture: tile, textureNode: node, binding, sourceTexture: source.texture,
              imageryCellScale: t.scale, imageryCellOffsetX: t.offsetX, imageryCellOffsetY: t.offsetY,
              imageryClipCell: tile.level > source.texture.level, imageryCoverageDraw: false,
              imageryPixelError: error, imageryPriority: error, imageryDesiredLevel: tile.level,
              imageryCapacityCoarsened: !!(flags & 19) && error > requested }))
          }
          if (value.incremental) yield
        }
        const textureCount = new Set(result.map(draw => `${draw.texture.level}/${draw.texture.row}/${draw.texture.column}`)).size
        this.output = {revision, draws: result, requested, capacity: !!(flags & 19), metrics: {
          measuredMaxPixelError: result.reduce((m, draw) => Math.max(m, draw.imageryPixelError), 0),
          renderedDrawCount: result.length, desiredDrawCount: result.length,
          selectedTextureCount: textureCount, desiredTextureCount: textureCount,
          selectedLevelMinimum: selectedLevels.length ? selectedLevels.reduce((a, b) => Math.min(a, b)) : null,
          selectedLevelMaximum: selectedLevels.length ? selectedLevels.reduce((a, b) => Math.max(a, b)) : null,
          clippedDrawCount: result.filter(draw => draw.imageryClipCell).length,
          coarsenedDrawCount: result.filter(draw => draw.texture.level < draw.sourceTexture.level).length
        }}
      }
      const snapshot = this.output, capacity = !!(flags & 19), metrics = snapshot.metrics
      invariant(metrics.selectedTextureCount === textureCount && snapshot.draws.length === drawCount,
        'Core and source adapter disagree about physical imagery resources')
      if (snapshot.capacity !== capacity) {
        // Previously returned plans own their rows. A changed diagnostic must
        // not mutate a snapshot retained by another stage of the pipeline.
        snapshot.draws = snapshot.draws.map(draw => ({...draw,
          imageryCapacityCoarsened: capacity && draw.imageryPixelError > requested}))
        snapshot.capacity = capacity
      }
      return { draws: snapshot.draws, coverageDraws: [], levels: new Set(), quality: {
        ...metrics, targetPixelError: requested,
        feasiblePixelError: Math.max(requested, metrics.measuredMaxPixelError),
        sourceDrawCount: this.sourceDrawCount,
        maximumTextureCount: value.maximumTextures || 214, desiredTextureCountIsUpperBound: false,
        coverageDrawCount: 0, coverageGuaranteed: true, limitedByBudget: capacity,
        planningComplete: !(flags & 32), rebuilding: !!(flags & 64), limitedByPartitionBudget: !!(flags & 16),
        limitedByTextureBudget: !!(flags & 1), limitedByLevel: !!(flags & 4), limitedByProjection: !!(flags & 8),
        meetsTarget: metrics.measuredMaxPixelError <= requested * 1.001, spatialCut: true, planner: 'terra-core',
        cachedNodeCount
      } }
    } finally {
      this.abi.free(qualityPointer)
      if (rangePointer) {
        this.abi.free(rangePointer)
      }
      this.abi.observeImageryInput(); if (credit) credit.release()
    }
  }

  accept(plan, epoch) {
    this.assertOpen()
    const tiles = plan ? Array.from(new Map(plan.draws.flatMap(draw => this.adapter.nodesForResource(draw.texture).filter(node => node.root === draw.textureNode.root)).map(node => [`${node.level}/${node.row}/${node.column}`, node])).values()) : []
    const pointer = tiles.length ? this.abi.alloc(tiles.length * 32) : 0
    try {
      const view = this.abi.module.refreshMemory().dataView
      tiles.forEach((tile, i) => {
        const offset = pointer + i * 32
        view.setUint32(offset, 32, true); view.setUint32(offset + 4, 0, true)
        view.setUint32(offset + 8, tile.level, true); view.setInt32(offset + 12, tile.root, true)
        view.setInt32(offset + 16, tile.row, true); view.setInt32(offset + 20, tile.column, true)
        view.setFloat64(offset + 24, 0, true)
      })
      this.call('terra_accept_imagery', pointer, tiles.length, epoch)
    } finally { if (pointer) this.abi.free(pointer) }
  }

  reset() {
    this.assertOpen()
    this.cancelTasks()
    this.call('terra_reset_imagery')
    this.signature = null; this.input = this.output = null; this.sourceDrawCount = 0
  }

}

module.exports = {ImageryPlanner}
