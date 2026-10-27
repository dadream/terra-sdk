const {textureKeyString: key, invariant} = require('../../sdk/js/core/terra_globe_common')
const {parentTextureTile, descendantTextureTile, textureCellTransform} = require('../../sdk/js/imagery/terra_texture_tiles')
const {OutputTransaction} = require('../../sdk/js/resources/output_transaction')
const {ResourceWorkspace} = require('../../sdk/js/resources/resource_workspace')
const {meshPartitionSource} = require('./mesh_partition_source')
const {intersectsCell} = require('../../sdk/js/terrain/terra_surface_plan')
const {geometryRequests} = require('./geometry_cache')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {Cleanup} = require('../../sdk/js/runtime/cleanup')
const {ImageryPresentation} = require('../../sdk/js/imagery/terra_imagery_presentation')
const {terrainSourceDraws} = require('./world_display_inputs')

// A terrain publication inherits a fixed display footprint. A candidate can
// also fund its planned imagery destinations; unused UV credit survives the
// terrain receipt until those destinations are produced or the view changes.
class MeshOutputPlan {
  constructor(renderer, packet, geometryKey) {
    this.renderer = renderer
    this.planId = packet.nativePlan.id
    this.geometryKey = geometryKey
    this.generation = renderer.partitionGeneration
    this.sourceGeneration = renderer.textures.generation
    this.mode = renderer.mode
    this.forecast = packet.imageryPlan || null
    this.states = new Map()
    renderer.presentation.cells.forEach(state => {
      // A completed coarsening fade no longer needs its old child footprint.
      const cell = key(state.a) === key(state.b) && state.b.level < state.cell.level ? state.b : state.cell
      this.states.set(key(cell), Object.assign({}, state, {cell}))
    })
    this.branches = new Set()
    this.rows = new Map()
    this.pending = new Map()
    this.requiredKeys = new Set()
    this.reused = new Map()
    this.inherited = new Map()
    this.borrowed = new Map()
    this.retiringGeometry = renderer.geometry.handoff(
      renderer.displaySurface ? renderer.displaySurface.current.draws : [], geometryKey)
    const images = new Set()
    this.states.forEach(state => {
      images.add(key(state.a)); images.add(key(state.b))
      for (let tile = parentTextureTile(state.cell); tile; tile = parentTextureTile(tile)) this.branches.add(key(tile))
    })
    for (const draw of renderer.displaySurface ? renderer.displaySurface.current.draws : []) {
      if (draw.flags & 1) continue
      const id = geometryKey(draw), geometry = renderer.geometry.get(id)
      if (geometry && geometry.model) this.inherited.set(id, geometry)
    }
    this.releaseImages = []
    this.heldImages = new Map()
    images.forEach(id => this.holdImage(id))
  }

  valid() {
    const r = this.renderer
    return !this.closed && !r.destroyed && !r.contextLost && !r.paused &&
      this.mode === r.mode && this.generation === r.partitionGeneration &&
      this.sourceGeneration === r.textures.generation
  }

  holdImage(id) {
    const cache = this.renderer.textures.cache, entry = cache.entries.get(id)
    if (this.heldImages.has(id)) return this.heldImages.get(id) === entry
    const release = entry && cache.retain(id)
    if (!release) return false
    this.heldImages.set(id, entry); this.releaseImages.push(release)
    return true
  }

  hasResidentCoverage(packet) {
    const r = this.renderer, display = r.displaySurface
    this.attempt.residentCoverage = false
    if (!this.valid() || this.forecast || !packet.frame || !packet.frame.coverageComplete ||
        packet.frame.omittedDrawCount || !display || r.lastSubmittedSurface !== display.current) return false
    // The inherited footprint covers whole immutable meshes, independent of
    // the camera. Its UV destinations are already priced/funded by admit().
    // Pin every blend endpoint and every ready fallback before using that
    // receipt to publish geometry without a whole-view precision forecast.
    const images = new Set()
    this.states.forEach(state => {images.add(key(state.a)); images.add(key(state.b))})
    this.handoverFootprint.forEach(draw => images.add(key(draw.imageryTarget)))
    r.textures.coverageTiles.forEach(tile => images.add(key(tile)))
    for (const draw of packet.draws) if (draw.flags & 1) images.add(key(r.rootImageryDraw(draw).texture))
    return this.attempt.residentCoverage = images.size > 0 && Array.from(images).every(id =>
      r.textures.gpuReady(id) && this.holdImage(id))
  }

  draws(draws) {
    const work=this.drawsWork(draws);let result
    do{result=work.next()}while(!result.done)
    return result.value
  }

  *drawsWork(draws, context = this.renderer, reserve = () => {}) {
    const r = context, result = [], seen = new Set()
    for (const draw of draws) {
      yield
      const id = this.geometryKey(draw)
      if (seen.has(id) || draw.flags & 1) continue
      seen.add(id)
      const source = draw.sourceTexture || draw.texture
      const geometry = this.inherited.get(id)
      const stack=[source]
      while(stack.length) {
        yield
        const tile=stack.pop()
        const t = textureCellTransform(source, tile)
        // This is the complete immutable hull, never a camera-cropped set of
        // visible regions. New camera areas remain part of the handoff proof.
        if (geometry && geometry.model.hull && !intersectsCell(geometry.model.hull,
          -t.offsetX / t.scale, -t.offsetY / t.scale, (1 - t.offsetX) / t.scale, (1 - t.offsetY) / t.scale)) continue
        if (this.branches.has(key(tile))) {
          reserve(4*96)
          for (let row = 1; row >= 0; --row) for (let column = 1; column >= 0; --column)
            stack.push(descendantTextureTile(tile, 1, row, column))
          continue
        }
        let state
        for (let parent = tile; parent && !state; parent = parentTextureTile(parent)) state = this.states.get(key(parent))
        const textures = r.textures
        let target
        // A provisional root is coverage, not permission to discard detail.
        // Coarsening needs current-view error proof on this geometry. Finer
        // goals outside the fixed footprint wait for the next handoff.
        for (let parent = tile; parent && !target; parent = parentTextureTile(parent))
          if (textures.targetDesired.has(key(parent)) && textures.gpuReady(key(parent)) &&
              (!state || parent.level >= Math.max(state.a.level, state.b.level) ||
                r.plannedCameraVersion === r.cameraVersion &&
                r.measureTextureDraw(draw, parent.level) <= (r.options.imageryPixelError || 1.25))) target = parent
        target = target || (state ? state.b : textures.presentationTileFor(tile))
        const cell = Object.assign({}, draw, {geometryKey: id, sourceTexture: source, texture: tile,
          imageryTarget: target, imageryHandover: true, imageryCellScale: t.scale,
          imageryCellOffsetX: t.offsetX, imageryCellOffsetY: t.offsetY, imageryClipCell: tile.level > source.level})
        const parent = meshPartitionSource(r, geometry, cell)
        if (parent) {
          cell.imageryDirectClip = true
          cell.imageryIndexCell = parent.cell
          if (parent.part) this.borrowed.set(id + ':' + parent.cell, {geometry, key: parent.cell, part: parent.part})
        }
        reserve(384);result.push(cell)
      }
    }
    return result
  }

  async admit(packet, producerBytes, stage) {
    if (!this.valid()) return null
    const r = this.renderer, rows = new Map()
    const stats = r.meshPreparationStats || (r.meshPreparationStats = {
      attempts: 0, refusedBeforePricing: 0, refusedAfterPricing: 0, pricedMeshes: 0, pricedCells: 0,
      residentMeshes: 0, sampledMeshes: 0, batches: 0, progressSlices: 0})
    const current = this.attempt = stats.last = {planId: this.planId,
      meshes: new Set(packet.draws.map(this.geometryKey)).size,
      producerBytes, knownPartitionBytes: 0, pricedMeshes: 0, residentMeshes: 0, sampledMeshes: 0,
      batches: 0, progressSlices: 0, state: 'checking'}
    ++stats.attempts
    this.capacityShortfallBytes = 0
    this.releasePreparedWorld()
    const sourceDraws=terrainSourceDraws({draws:packet.draws.map(draw=>Object.assign({},draw,
      {geometryKey:this.geometryKey(draw)}))},r.options.textureDescriptor)
    let handoverFootprint=this.draws(sourceDraws)
    if(packet.frame)for(const row of handoverFootprint) {
      let state
      for(let tile=row.texture;tile&&!state;tile=parentTextureTile(tile))state=this.states.get(key(tile))
      // Publication can outlive its camera. Its first coverage receipt keeps
      // the already owned fine endpoint; ordinary imagery can independently
      // coarsen it after handoff with the live camera's error proof.
      if(state) {
        const fine=state.a.level>state.b.level?state.a:state.b
        if(row.imageryTarget.level<fine.level)row.imageryTarget=fine
      }
    }
    this.handoverFootprint=handoverFootprint
    const footprint = handoverFootprint.concat(packet.imageryPlan
      ? packet.imageryPlan.draws.map(draw => Object.assign({}, draw, {geometryKey:this.geometryKey(draw)})) : [])
    current.inheritedMeshes = new Set(footprint.filter(draw => this.inherited.has(draw.geometryKey)).map(draw => draw.geometryKey)).size
    current.directCoverageCells = footprint.filter(draw => draw.imageryDirectClip).length
    for (const draw of footprint) {
      if (!draw.imageryClipCell || draw.imageryDirectClip) continue
      if (!rows.has(draw.geometryKey)) rows.set(draw.geometryKey, {draw, cells: []})
      const cells = rows.get(draw.geometryKey).cells, cell = r.partitionCell(draw)
      if (!cells.some(value => value.key === cell.key)) cells.push(cell)
    }
    this.required = rows
    const requests = geometryRequests(packet.draws, this.geometryKey)
    const workspace = this.preparationWorkspace = new ResourceWorkspace('mesh-preparation')
    this.preparationHolds = []
    for (const id of requests.keys()) {
      const hold = r.geometry.retain(id)
      if (hold) this.preparationHolds.push(hold)
    }
    let scratchBytes = 0,worldWorkBytes=0,worldJob
    const unpriced = () => Array.from(rows, ([id, row]) => ({geometryKey: id, draw: row.draw,
      cells: row.cells.filter(cell => !this.rows.get(id).prices.has(cell.key))})).filter(row => row.cells.length)
    for (const [id, row] of rows) {
      if (!this.rows.has(id)) this.rows.set(id, {prices: new Map()})
      const geometry = r.geometry.get(id), prices = this.rows.get(id).prices
      for (const cell of row.cells) {
        const part = geometry && geometry.partitions.get(cell.key)
        if (part) prices.set(cell.key, part.byteSize || 0)
      }
    }
    const fundKnown = () => {
      if (!this.valid()) return false
      const {bytes, reused} = this.requirements(true)
      current.knownPartitionBytes = bytes
      this.reused = reused
      if (r.partitionReservedBytes + r.partitionCpuBytes + 2 * bytes > r.partitionCapacityBytes) return false
      const refusal = {}
      const plan = r.geometry.planBatch(requests, producerBytes + 2 * bytes + r.indices.quote(packet),
        Array.from(reused.values(), item => item.part.allocation).filter(Boolean),
        {retiring:this.retiringGeometry, refusal})
      if (!plan) {
        current.refusal = refusal
        this.capacityShortfallBytes = refusal.shortfallBytes || 0
        return false
      }
      // Pricing and materialization are sequential stages of the same work.
      // Fund their maximum, not their sum. Unknown UV costs are a lower bound;
      // completed prices grow the owned envelope before more pricing proceeds.
      const needed = Math.max(plan.bytes, scratchBytes, worldWorkBytes)
      current.requiredBytes = needed
      const growth = Math.max(0, needed - workspace.bytes)
      if (growth) {
        const refusal = {}
        let credit = r.resourceLedger.reserve(workspace.owner, growth, plan.victims, plan.keep, [], refusal)
        if (!credit && r.textures.withdrawShare && r.textures.withdrawShare(true)) {
          // Unused imagery grants refund immediately. Displayed images keep
          // their holds until a complete coarser replacement is submitted.
          if (r.options.onImageryPlanningChange) r.options.onImageryPlanningChange()
          credit = r.resourceLedger.reserve(workspace.owner, growth, plan.victims, plan.keep, [], refusal)
        }
        if (!credit) { current.refusal = refusal; this.capacityShortfallBytes = refusal.shortfallBytes || 0; return false }
        this.capacityShortfallBytes = 0
        workspace.accept(credit)
      }
      current.fundedBytes = workspace.bytes
      current.scratchBytes = scratchBytes
      return true
    }
    const refuse = () => {
      if (this.valid()) {
        ++stats[current.pricedMeshes ? 'refusedAfterPricing' : 'refusedBeforePricing']
        current.state = 'refused'
      } else current.state = 'cancelled'
      return null
    }
    try {
      const initial = unpriced()
      if (initial.length) {
        invariant(typeof r.options.meshPartitionWorkspaceBytes === 'function', 'Prepared UV workspace quote is required')
        scratchBytes = r.options.meshPartitionWorkspaceBytes(initial)
      }
      const pricingScratchBytes = scratchBytes
      scratchBytes = Math.max(scratchBytes, stage ? stage.bytes : 0)
      r.resourceLedger.size(scratchBytes)
      if (!fundKnown()) {
        const pending = r.resourceLedger.reclamation.pending
        if (pending) await pending
        if (!fundKnown()) return refuse()
      }
      if (stage && stage.bytes) {
        // Boundary work precedes GPU destination allocation as well as CPU
        // mesh production. Its grant shares the ENTIRE transaction peak.
        const boundary = workspace.take(stage.bytes)
        invariant(boundary, 'Candidate boundary workspace was not funded')
        current.state = 'boundary'; current.boundaryBytes = boundary.bytes
        try { await stage.run(boundary) }
        finally { boundary.release() }
        if (!this.valid()) return null
        scratchBytes = pricingScratchBytes
        if (!fundKnown()) return refuse()
        workspace.trim(current.requiredBytes)
        current.fundedBytes = workspace.bytes
      }
      for (;;) {
        const batch = unpriced()
        if (!batch.length) break
        if (!this.valid()) return null
        let cursor = 0, stopped = false, task, value
        const scratch = scratchBytes ? workspace.take(scratchBytes) : null
        invariant(!scratchBytes || scratch, 'Prepared UV workspace was not funded')
        current.state = 'pricing'; ++current.batches; ++stats.batches
        try {
          if (scratch) scratch.mark('resident')
          task = this.task = r.options.createMeshPartitionPlanTask(this.planId, batch, completed => {
            if (!this.valid()) return false
            ++current.progressSlices; ++stats.progressSlices
            if (!completed.length) return true
            for (const result of completed) {
              const row = batch[cursor++]
              invariant(row && result.resourceId === row.draw.resourceId &&
                ['resident', 'sampled'].includes(result.source) && Array.isArray(result.prices) &&
                result.prices.length === row.cells.length && result.prices.every((item, i) =>
                  item.key === row.cells[i].key && Number.isSafeInteger(item.bytes) && item.bytes >= 0),
              'Invalid prepared UV costs')
              const prices = this.rows.get(row.geometryKey).prices
              result.prices.forEach(item => prices.set(item.key, item.bytes))
              ++stats.pricedMeshes; stats.pricedCells += row.cells.length; ++current.pricedMeshes
              const source = result.source + 'Meshes'
              ++stats[source]; ++current[source]
            }
            // Stop at a bounded producer slice if the complete known output no
            // longer fits. The running scratch keeps its loan until its receipt.
            stopped = !fundKnown()
            return !stopped
          }, scratch)
          value = await task.promise
        } finally {
          if (this.task === task) this.task = null
          if (scratch) scratch.release()
        }
        if (!this.valid() || !value && !stopped) return null
        if (!fundKnown()) {
          const pending = r.resourceLedger.reclamation.pending
          if (pending) await pending
          if (!fundKnown()) return refuse()
        }
        invariant(stopped || cursor === batch.length, 'Incomplete prepared UV batch')
      }
      current.state = 'priced'
      // New meshes had no resident hull when their fixed footprint was made.
      // Exact UV prices now prove which clipped cells contain no triangles.
      // Empty cells need neither a display row nor publication ownership; keep
      // unknown/unclipped/direct cells, whose coverage uses another proof.
      const beforePruning = handoverFootprint.length
      handoverFootprint = handoverFootprint.filter(draw => {
        const priced = this.rows.get(draw.geometryKey)
        return !draw.imageryClipCell || draw.imageryDirectClip || !priced ||
          priced.prices.get(r.partitionCell(draw).key) !== 0
      })
      current.emptyCoverageCells = beforePruning - handoverFootprint.length
      this.handoverFootprint = handoverFootprint
      if(packet.frame&&handoverFootprint.length) {
        // Price and prepare the mandatory display successor BEFORE native,
        // host and GPU materialization. Its transient work shares the same
        // stage peak; resident cuts remain charged through the real receipt.
        worldJob={sourceDraws,releases:[],used:0,outputs:new Set(),camera:r.cameraVersion}
        const account=bytes=>{
          worldJob.used+=bytes;worldWorkBytes=worldJob.used
          current.worldWorkPeakBytes=Math.max(current.worldWorkPeakBytes||0,worldWorkBytes)
          if(worldWorkBytes<=workspace.availableBytes)return
          if(!fundKnown())throw Object.assign(new Error('Mesh display successor is not funded'),{status:9})
          // The complete producer envelope can already fund this numerical
          // stage. Reprice only when that owned space is exhausted, rather
          // than scanning the entire geometry/UV cut for every copied row.
          // Batch additional work using immediately free bytes only; tight
          // budgets still admit the exact minimum without extra eviction.
          const free=r.resourceLedger.maximumBytes
            ?Math.max(0,r.resourceLedger.maximumBytes-r.resourceLedger.bytes):65536
          const growth=Math.min(65536,free)
          if(growth) {
            const credit=r.resourceLedger.reserve(workspace.owner,growth)
            if(credit)workspace.accept(credit)
          }
        }
        worldJob.takeCredit=bytes=>{
          const lease=workspace.fund(0,funding=>r.resourceLedger.reserve('display-cut',bytes,[],[],funding))
          invariant(lease,'Mesh display payload was not funded')
          worldWorkBytes=Math.max(0,worldJob.used-bytes)
          return lease
        }
        account(1024+sourceDraws.length*96+handoverFootprint.length*384)
        const presentation=new ImageryPresentation(r.presentation.duration)
        presentation.cells=this.states
        const task=this.worldTask=new CooperativeTask(r.worldDisplay.buildCuts(worldJob,
          handoverFootprint,presentation,new Map(),account),1024)
        try { worldJob.result=await task.run() }
        catch(error) {if(error.status===9)return refuse();throw error}
        finally {if(this.worldTask===task)this.worldTask=null}
        if(!this.valid())return null
        current.worldCutBytes=worldJob.residentBytes||0
        worldJob.releases.splice(0).forEach(close=>close())
        worldWorkBytes=0
        if(!fundKnown())return refuse()
        workspace.trim(current.requiredBytes)
        this.preparedWorld=worldJob;worldJob=null
      }
      // A successful quote must leave this continuation with all destinations
      // funded. Yielding a boolean here lets another producer spend the same
      // capacity before MeshFrames can acquire the complete replacement group.
      const outputs = this.fund(packet, producerBytes)
      if (outputs) return outputs
      const pending = r.resourceLedger.reclamation.pending
      if (!pending) return null
      await pending
      return this.fund(packet, producerBytes)
    } finally {
      if(worldJob)this.releaseWorldJob(worldJob)
      if(current.state!=='admitted')this.releasePreparedWorld()
      this.releasePreparation()
    }
  }

  releaseWorldJob(job) {
    if(job.installed)return
    const cleanup=new Cleanup()
    for(const cut of job.outputs||[])cleanup.run(()=>cut.ownership.retire())
    for(const close of job.releases.splice(0))cleanup.run(close)
    cleanup.finish()
  }

  releasePreparedWorld() {
    if(this.worldTask){this.worldTask.cancel();this.worldTask=null}
    if(this.preparedWorld)this.releaseWorldJob(this.preparedWorld)
    this.preparedWorld=null
  }

  releasePreparation() {
    if (this.preparationWorkspace) this.preparationWorkspace.retire()
    this.preparationWorkspace = null
    if (this.preparationHolds) this.preparationHolds.splice(0).forEach(release => release())
  }

  requirements(partial = false) {
    const r = this.renderer, missing = new Map(), reused = new Map(this.borrowed)
    let bytes = 0
    for (const [id, row] of this.required) {
      const entry = r.geometry.entries.get(id), geometry = entry && entry.value, priced = this.rows.get(id)
      for (const cell of row.cells) {
        const part = geometry && geometry.partitions.get(cell.key), label = id + ':' + cell.key
        if (part) reused.set(label, {geometry, key: cell.key, part})
        else if (priced && priced.prices.has(cell.key)) {
          const size = priced.prices.get(cell.key); missing.set(label, size); bytes += size
        } else invariant(partial, 'Mesh output cell was not priced')
      }
    }
    return {missing, reused, bytes}
  }

  fund(packet, producerBytes) {
    if (!this.valid()) return null
    const r = this.renderer, {missing, reused, bytes} = this.requirements()
    this.attempt.state = 'capacity-refused'
    this.reused = reused // Local eviction must preserve these destinations too.
    if (2 * bytes > r.partitionCapacityBytes) return null
    r.prunePartitions(2 * bytes, r.partitionCapacityBytes)
    if (r.partitionBytes + r.partitionReservedBytes + r.partitionCpuBytes + 2 * bytes > r.partitionCapacityBytes) return null
    const refusal = {}
    const indexBytes = r.indices.quote(packet)
    const outputs = this.preparationWorkspace.fund(0, funding => r.geometry.reserveBatch(geometryRequests(packet.draws,
      this.geometryKey), producerBytes + 2 * bytes + indexBytes, 'mesh-transfer',
      Array.from(reused.values(), item => item.part.allocation).filter(Boolean), funding, refusal,
      {retiring:this.retiringGeometry}))
    if (!outputs) { this.attempt.refusal = refusal; this.capacityShortfallBytes = refusal.shortfallBytes || 0; return null }
    r.indices.fund(outputs, indexBytes)
    this.capacityShortfallBytes = 0
    if (r.textures.resourceShare) r.textures.resourceShare.pressured = false
    this.attempt.state = 'admitted'
    this.pool = new OutputTransaction(outputs.credit.split(bytes, 'reserved', 'partition-output'),
      outputs.credit.split(bytes, 'reserved', 'partition-gpu'))
    this.pending = missing
    this.requiredKeys = new Set([...missing.keys(), ...reused.keys()])
    r.partitionCpuBytes += bytes; r.partitionReservedBytes += bytes
    const valid = outputs.valid, release = outputs.release
    outputs.valid = () => this.valid() && valid() && Array.from(reused.values()).every(item =>
      item.geometry.partitions.get(item.key) === item.part)
    outputs.hasResidentCoverage = () => outputs.valid() && this.hasResidentCoverage(packet)
    // A quote for a future model is not a display dependency. The receiver
    // marks this envelope only after accepting its immutable mesh frame.
    outputs.acceptSurface = () => { this.accepted = true }
    outputs.release = () => { release(); this.release() }
    outputs.presented = () => {
      release()
      if (this.forecast) this.finishHandoff()
      else {
        const notify=this.accepted&&this.valid()&&r.meshOutputPlan===this
        this.release()
        if(notify)r.requestResources()
      }
    }
    return outputs
  }

  finishHandoff() {
    if (!this.valid()) { this.release(); return }
    const r = this.renderer
    if (r.meshOutputPlan === this) r.meshOutputPlan = null
    if (r.forecastOutputPlan && r.forecastOutputPlan !== this) r.forecastOutputPlan.release()
    r.forecastOutputPlan = this
    r.partitionGroups.wakeImagery()
    this.retiringGeometry.clear()
    this.releaseImages.splice(0).forEach(release => release())
    this.heldImages.clear()
    r.requestResources()
    r.requestRender()
  }

  protects(id, cell) { return !this.closed && (this.reused.has(id + ':' + cell) || this.requiredKeys.has(id + ':' + cell) ||
    this.borrowed.has(id + ':' + cell)) }
  has(id, cell) { return !this.closed && this.pending.has(id + ':' + cell) }
  price(id, cell) {
    const row = this.rows.get(id)
    return row && row.prices.get(cell)
  }
  take(id, cells) {
    if (!this.pool || !cells.every(cell => this.has(id, cell.key))) return null
    const plan = cells.map(cell => ({key: cell.key, bytes: this.pending.get(id + ':' + cell.key)}))
    const bytes = plan.reduce((sum, cell) => sum + cell.bytes, 0)
    cells.forEach(cell => this.pending.delete(id + ':' + cell.key))
    return {plan, bytes, output: new OutputTransaction(this.pool.input.split(bytes), this.pool.output.split(bytes))}
  }

  release() {
    if (this.closed) return
    const active = this.valid()
    this.closed = true
    if (this.attempt && ['checking', 'pricing'].includes(this.attempt.state)) this.attempt.state = 'cancelled'
    if (this.task) this.task.cancel()
    this.releasePreparedWorld()
    this.releasePreparation()
    const r = this.renderer
    if (this.pool) {
      r.partitionCpuBytes -= this.pool.input.bytes; r.partitionReservedBytes -= this.pool.output.bytes
      this.pool.release()
    }
    this.releaseImages.splice(0).forEach(release => release())
    this.heldImages.clear()
    this.rows.clear(); this.pending.clear(); this.reused.clear(); this.requiredKeys.clear(); this.inherited.clear(); this.borrowed.clear()
    this.retiringGeometry.clear()
    if (r.meshOutputPlan === this) {
      r.meshOutputPlan = null
      r.partitionGroups.wakeImagery()
      // Cancellation/replacement can still need a display update. Only the
      // presented receipt wakes preparation beyond a completed fixed footprint.
      if (active) r.requestRender()
    }
    if (r.forecastOutputPlan === this) r.forecastOutputPlan = null
  }
}

module.exports = {MeshOutputPlan}
