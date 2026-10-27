const {textureKeyString: key, invariant} = require('../../sdk/js/core/terra_globe_common')
const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const {OutputTransaction} = require('../../sdk/js/resources/output_transaction')
const {ResourceWorkspace} = require('../../sdk/js/resources/resource_workspace')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {monotonicNow} = require('../../sdk/js/diagnostics/timing')
const {textureTileContains} = require('../../sdk/js/imagery/terra_texture_tiles')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {imageryMembers} = require('./imagery_candidate')
const {selectImageryFootprints} = require('./imagery_footprint_selection')
const {ImageryFootprintQuotes} = require('./imagery_footprint_quotes')

// Price the entire publication dependency before producing its first array.
// Only one group owns unclaimed output credit; the renderer still produces and
// uploads small batches. Existing images/meshes are borrowed, never recharged.
class PartitionGroups {
  constructor(renderer) {
    this.renderer = renderer; this.current = null
    this.refused = new Map(); this.prepared = new Map()
    this.pricing = {groups: 0, meshes: 0, batches: 0, footprintSelections:0, footprintSlices:0,
      maximumFootprintSliceMs:0, footprintCreditHighWaterBytes:0, quoteReuses:0}
    this.quotes = new ImageryFootprintQuotes(renderer, {
      matches:group=>this.sameFootprint(group), stamp:()=>this.admissionKey(),
      parked:(group,stamp)=>{this.refused.set(group.futureName,stamp);if(this.current===group)this.current=null}
    })
  }

  id(object) { return this.quotes.id(object) }

  valid(group) {
    const r = this.renderer
    return !group.closed && group.generation === r.partitionGeneration &&
      (!group.inputs || Array.from(group.inputs.values()).every(row =>
        r.geometry.entries.get(row.geometry.key) === row.owner && row.geometry.partitions === row.partitions)) &&
      !r.destroyed && !r.contextLost && !r.paused && Array.from(group.rows.values()).every(row =>
        r.geometryPinnedKeys.has(row.geometry.key) && r.geometry.entries.get(row.geometry.key) === row.owner && row.geometry.partitions === row.partitions &&
        (!group.demand || row.cells.every(cell => r.partitionPublication.wanted(row.geometry.key, cell.key)) &&
          (r.partitionPublication.meshes.get(row.geometry.key) || []).every(draw => !draw.imageryClipCell || draw.imageryDirectClip ||
            group.required.has(row.geometry.key + ':' + key(draw.texture))))) &&
      group.images.every(([id, entry]) => r.textures.cache.entries.get(id) === entry) &&
      (!group.borrowedOutputs || Array.from(group.borrowedOutputs.values()).every(dependency =>
        this.outputAvailable(dependency))) &&
      (!group.future || group.source === r.textures.generation &&
        this.sameFootprint(group) &&
        Array.from(group.future.keys()).every(id => r.textures.desired.has(id) && !r.textures.failed.has(id)))
  }

  outputAvailable(dependency) {
    if (dependency.geometry.partitions.has(dependency.cell) || !dependency.plan.closed) return true
    // Repeated terrain publications may replace a forecast on the same
    // immutable mesh. The row/owner checks above establish geometry identity;
    // has() proves that its successor actually funded this exact destination.
    // Follow that owner through take(), which removes pending credit while the
    // producer still holds it. A missing successor still requires admission.
    const successor = this.meshFor(dependency.geometry.key, dependency.cell)
    if (!successor) return false
    dependency.plan = successor
    return true
  }

  sameFootprint(group) {
    const draws = this.renderer.renderDraws
    if (group.draws === draws || group.drawsId === this.id(draws)) return true
    const sources = this.sources(draws, group.future)
    if (sources.size !== group.sources.size || Array.from(sources).some(([id, value]) => value !== group.sources.get(id))) return false
    group.drawsId = this.id(draws)
    if (!group.metadata || !group.metadata.disposable) group.draws = draws
    return true
  }

  sources(draws, children, reserve = () => {}) {
    const members = imageryMembers(draws, children), sources = new Map()
    for (const draw of draws) {
      if (!members.has(draw.geometryKey)) continue
      const value = key(draw.sourceTexture || draw.texture) + ':' + (draw.textureResourceId || 0)
      if (!sources.has(draw.geometryKey)) { reserve(128 + value.length * 2); sources.set(draw.geometryKey, new Set()) }
      const values = sources.get(draw.geometryKey)
      if (!values.has(value)) { reserve(64 + value.length * 2); values.add(value) }
    }
    return new Map(Array.from(sources, ([id, values]) => [id, Array.from(values).sort().join('|')]))
  }

  inputsReady(children) {
    const r = this.renderer
    for (const draw of r.renderDraws) {
      if (r.geometry.entries.has(draw.geometryKey)) continue
      const source = draw.sourceTexture || draw.texture
      for (const tile of children.values())
        if (textureTileContains(source, tile) || textureTileContains(tile, source)) return false
    }
    return true
  }

  complete(group = this.current) {
    return group && !group.task && !group.pending.size && (!group.future ||
      !group.required.size || group.published)
  }

  admissionKey() {
    return this.renderer.resourceLedger.availabilityRevision + ':' + this.admissionContext()
  }

  admissionContext() {
    const r = this.renderer
    // A new surface/share can need a fresh complete-group price without
    // changing owned bytes. Pressure recovery must not clear the image queue's
    // refusal while leaving this earlier admission gate parked on the old cut.
    return [r.partitionAdmissionRevision || 0,
      r.partitionCapacityBytes, r.cameraVersion, r.textures.generation,
      r.current && r.current.frame && r.current.frame.sequence,
      r.textures.requestedMaximumBytes, r.textures.protectionRevision || 0].join(':')
  }

  refuse(group, name) {
    const ledger = this.renderer.resourceLedger, stamp = this.admissionKey()
    const context = this.admissionContext(), bytes = ledger.bytes, leases = ledger.leases.size
    // A failed probe temporarily borrows live geometry/images. Releasing those
    // same loans restores the pre-probe state; it does not fund another group.
    // Preserve only refusals from that exact state. External changes during
    // pricing, real refunds and changed demand still invalidate them normally.
    const prior = stamp === group.probeStamp ? Array.from(this.refused)
      .filter(([, value]) => value === stamp).map(([key]) => key) : []
    this.release(group)
    const next = this.admissionKey()
    if (ledger.bytes === bytes && ledger.leases.size === leases && this.admissionContext() === context) {
      prior.forEach(key => this.refused.set(key, next))
    }
    this.refused.set(name, next)
  }

  // Read-only queue hint, never an admission receipt. Refresh once on the
  // resource wake before ranking requests; prepareImagery still revalidates
  // complete footprints and obtains real credit at dispatch.
  imageryRunnable(children) {
    if (!children) return false
    const name = Array.from(children.keys()).sort().join('|'), r = this.renderer
    if (this.prepared.has(name)) return true
    if (this.current) {
      if (this.current.futureName === name) return Boolean(this.current.pool)
      if (!this.complete()) return false
    }
    return Boolean(r.current && !(r.meshOutputPlan && r.meshOutputPlan.accepted) &&
      !r.partitionActive && !r.partitionUploads.length)
  }

  // Synchronous request admission waits for a bounded asynchronous UV price.
  // Only this lane can promise an unclaimed footprint. A later input borrows
  // its already-funded image destination and the shared serial workspace.
  prepareImagery(children, reserve) {
    const r = this.renderer, store = r.textures
    this.refresh()
    children = new Map(Array.from(children).filter(([id]) => !store.failed.has(id)))
    if (Array.from(children).some(([id, tile]) => !tile || !store.desired.has(id))) return 'waiting'
    const name = Array.from(children.keys()).sort().join('|')
    if (this.prepared.has(name)) return 'ready'
    const quoted = this.quotes.get(name)
    if (quoted) {
      if (!this.quotes.valid(quoted)) this.quotes.discard(quoted)
      else if (quoted.refusedAt === this.admissionKey()) return 'blocked'
      else if (!this.current) {
        const metadata = r.resourceLedger.claimMemo(quoted.metadata, 'imagery-footprint-work')
        if (!metadata) return 'blocked'
        this.quotes.delete(name); quoted.metadata = metadata
        ++this.pricing.quoteReuses
        this.quotes.restore(quoted, reserve); this.current = quoted
        this.fund(quoted)
        if (quoted.pool) { this.refresh(); return 'ready' }
        this.quotes.park(quoted)
        return 'blocked'
      }
    }
    if (this.current) {
      if (this.current.futureName === name) return this.current.pool ? 'ready' : 'waiting'
      if (this.complete()) this.release()
      else return 'waiting'
    }
    if (this.refused.get(name) === this.admissionKey()) return 'blocked'
    // A private successor has not replaced current geometry. Its background
    // preparation must not starve the current surface's image lane. The
    // accepted handoff still parks this lane until its mesh inputs arrive;
    // per-group ownership, footprint pricing and shared credit follow below.
    if (!r.current || r.meshOutputPlan && r.meshOutputPlan.accepted ||
        r.partitionActive || r.partitionUploads.length) return 'waiting'
    // Price from paid complete mesh footprints. Unrelated image goals may
    // still be refining; only this group's sources must have current receipts.
    const state=r.mode==='texture'&&r.worldDisplay?r.worldDisplay.targetState(children):'ready'
    if(state==='waiting')return state
    // The last submitted terrain may still contain independent old groups.
    // Only this image group's immutable inputs must exist; waiting for the
    // whole new surface can wait on the very images/UVs being admitted here.
    // Missing inputs are a data dependency, not a failed capacity quote. Wait
    // without starting/refunding metadata; GPU commits already wake admission.
    if (!this.inputsReady(children)) return 'waiting'
    // A missing geometry producer is still a dependency even if world
    // metadata also lacks capacity. Preserve that priority over coarsening.
    if(state!=='ready')return state
    const group = this.current = {rows: new Map(), required: new Set(), pending: new Map(), images: [],
      releases: [], generation: r.partitionGeneration, demand: false, task: null, probeStamp: this.admissionKey(),
      future: new Map(children), futureName: name, source: store.generation, reserve,
      draws: r.renderDraws, selectionReleases: [], inputs: new Map()}
    group.metadata = r.resourceLedger.reserve('imagery-footprint-work', 512)
    if (!group.metadata) { this.refuse(group, name); return 'blocked' }
    this.pricing.footprintCreditHighWaterBytes = Math.max(this.pricing.footprintCreditHighWaterBytes, 512)
    group.metadataUsed = 512
    ++this.pricing.footprintSelections
    const account = bytes => {
      group.metadataUsed += bytes
      if (group.metadataUsed <= group.metadata.bytes) return
      const minimum = group.metadataUsed - group.metadata.bytes
      const free = r.resourceLedger.maximumBytes ? Math.max(0, r.resourceLedger.maximumBytes - r.resourceLedger.bytes) : 65536
      if (!group.metadata.resize(group.metadata.bytes + Math.max(minimum, Math.min(65536, free))))
        throw Object.assign(new Error('Imagery footprint workspace is not funded'), {status:9})
      this.pricing.footprintCreditHighWaterBytes = Math.max(this.pricing.footprintCreditHighWaterBytes, group.metadata.bytes)
    }
    try {
      group.sources = this.sources(group.draws, children, account)
      group.members = new Set(group.sources.keys())
    } catch (error) { this.refuse(group, name); if (error.status === 9) return 'blocked'; throw error }
    let complete, fail
    const selected = new Promise((resolve, reject) => { complete = resolve; fail = reject })
    const work = group.selection = new CooperativeTask(selectImageryFootprints(r, group, children, account), 1024)
    group.selectionComplete = complete; group.selectionFailed = fail
    group.task = {cancel: () => { work.cancel(); complete(false) }}
    selected.then(value => {
      group.selectionReady = value
      if (value && this.valid(group)) return this.price(group)
    }).catch(error => {
      if (this.valid(group) && error.status !== 9) r.onDiagnostic('partition_prepare_failed', {message: error.message || String(error)})
    }).finally(() => {
      group.task = null; group.selection = null
      if (!group.pool || !this.valid(group)) {
        const blocked = this.valid(group)
        if (blocked && group.selectionReady === false) this.release(group)
        else if (blocked && group.allPrices && group.allPrices.size === group.required.size) this.quotes.park(group)
        else if (blocked) this.refuse(group, name)
        else this.release(group)
      } else this.refresh()
      this.wakeImagery()
      if (!r.destroyed && !r.paused && !r.contextLost) r.requestResources()
    })
    r.requestResources()
    return 'waiting'
  }

  advanceSelection() {
    const group = this.current, r = this.renderer
    if (!group || !group.selection) return
    if (!this.valid(group)) { this.release(group); return }
    const started = monotonicNow()
    ++this.pricing.footprintSlices
    try {
      const result = group.selection.step()
      if (result.done) { group.selection = null; group.selectionComplete(result.value) }
      else r.requestResources()
    } catch (error) { group.selection = null; group.selectionFailed(error) }
    finally {this.pricing.maximumFootprintSliceMs = Math.max(this.pricing.maximumFootprintSliceMs, monotonicNow()-started)}
  }


  wakeImagery() {
    const store = this.renderer.textures
    if (!store.preparationWaiting) return
    store.preparationWaiting.clear()
    if (store.scheduleAdvance) store.scheduleAdvance()
  }

  refresh() {
    const r = this.renderer
    for (const group of this.quotes.values()) if (group.generation !== r.partitionGeneration ||
        group.source !== r.textures.generation || Array.from(group.future.keys()).some(id =>
          !r.textures.desired.has(id) || r.textures.failed.has(id)) ||
        Array.from(group.rows.keys()).some(id => !r.geometryPinnedKeys.has(id))) this.quotes.discard(group)
    for (const group of this.prepared.values()) if (!this.valid(group)) this.release(group)
    const group = this.current
    if (!group) return
    if (!this.valid(group)) { this.release(); return }
    if (!group.pool) return
    // A terrain handoff can supply the same immutable destination, or rebuild
    // the request queue while this group still owns credit. Reconcile both:
    // completed destinations refund credit; missing ones retain a producer.
    for (const [id, row] of group.rows) for (const cell of row.cells) {
      const label = id + ':' + cell.key
      if (!group.pending.has(label)) continue
      if (row.geometry.partitions.has(cell.key)) {
        const bytes = group.pending.get(label)
        group.pool.output.split(bytes).release()
        r.partitionReservedBytes -= bytes
        group.pending.delete(label)
      } else {
        if (row.geometry.partitionBlocked) row.geometry.partitionBlocked.delete(cell.key)
        r.requestPartitionSet(row.geometry, [cell], 2)
      }
    }
    // Completed GPU UV destinations keep their ownership ticket, not the
    // production lane. Other admitted image groups may download/prepare while
    // this one waits for images. Publish consumes the ticket after a complete
    // canonical mesh footprint has adopted these ready destinations.
    if (group.future && !group.task && !group.pending.size &&
        Array.from(group.rows.values()).every(row => row.cells.every(cell => row.geometry.partitions.has(cell.key)))) {
      if (!group.required.size) { this.release(); return }
      r.partitionReservedBytes -= group.pool.output.bytes
      group.workspace.retire(); group.pool.output.release(); group.pool = null
      this.current = null
      this.prepared.set(group.futureName, group)
      this.wakeImagery()
    }
  }

  publish() {
    const r = this.renderer
    for (const group of this.prepared.values()) {
      if (!this.valid(group)) { this.release(group); continue }
      if (!Array.from(group.future.keys()).every(id => r.textures.gpuReady(id))) continue
      // A persistent or coarsening cut can submit the same immutable terrain
      // while its full successor still needs other UVs. Actual submitted
      // ownership acknowledges these production loans, not successor-array
      // identity. Resident assets and submitted blend endpoints keep their
      // independent owners/protection after this ticket is consumed.
      if (!Array.from(group.rows.values()).every(row => r.worldDisplay.submitted(row.geometry))) continue
      group.published = true
      this.release(group)
    }
  }

  clear() {
    this.release()
    for (const group of this.prepared.values()) this.release(group)
    this.quotes.clear()
    this.refused.clear()
  }

  protects(id, cell) {
    const mesh = this.renderer.meshOutputPlan
    const forecast = this.renderer.forecastOutputPlan
    const label = id + ':' + cell
    return Boolean(mesh && mesh.protects(id, cell) || forecast && forecast.protects(id, cell) ||
      this.current && !this.current.closed && this.current.required.has(label) ||
      Array.from(this.prepared.values()).some(group => !group.closed && group.required.has(label)))
  }
  rank(id, cell) {
    const mesh = this.meshFor(id, cell)
    return mesh && mesh.has(id, cell) ? 2 : Number(Boolean(this.current && !this.current.closed && this.current.pending.has(id + ':' + cell)))
  }

  meshFor(id, cell) {
    return [this.renderer.meshOutputPlan, this.renderer.forecastOutputPlan]
      .find(plan => plan && plan.has(id, cell))
  }

  take(id, cells) {
    const mesh = this.meshFor(id, cells[0].key)
    if (mesh && cells.every(cell => mesh.has(id, cell.key))) return mesh.take(id, cells)
    const group = this.current
    if (!group || !group.pool || !this.valid(group) || !cells.every(cell => group.pending.has(id + ':' + cell.key))) return null
    const plan = cells.map(cell => ({key: cell.key, bytes: group.pending.get(id + ':' + cell.key)}))
    const bytes = plan.reduce((n, item) => n + item.bytes, 0)
    cells.forEach(cell => group.pending.delete(id + ':' + cell.key))
    const input = bytes ? group.workspace.take(bytes) : group.pool.output.split(0, 'reserved', 'partition-output')
    invariant(input, 'Partition workspace is unavailable')
    const output = new OutputTransaction(input, group.pool.output.split(bytes))
    output.workspace = true
    return {plan, bytes, output}
  }

  count(id, cells, maximum, staging) {
    const mesh = this.meshFor(id, cells[0].key)
    const group = mesh || this.current
    let bytes = 0, objects = 0, count = 0
    while (count < maximum) {
      const cell = cells[count], size = group.pending.get(id + ':' + cell.key)
      if (size === undefined) break
      bytes += size
      objects += size ? cell.sourceUv ? 1 : 3 : 0
      if (!mesh && bytes > group.workspace.availableBytes ||
          staging && !staging.fits(bytes, objects, count === 0)) break
      ++count
    }
    return count
  }

  prepare() {
    this.refresh()
    if (this.renderer.partitionQueue.some(job => job.cells.some(cell => this.meshFor(job.geometry.key, cell.key)))) return true
    if (this.current) {
      if (this.current.task) return false
      if (this.current.pending.size) return true
      if (!this.complete()) return false
      this.release()
    }
    const r = this.renderer, first = r.partitionQueue[0]
    if (!first) return false
    const publication = r.partitionPublication
    // A retained handoff can share a mesh with an unrelated current cut. Only
    // price that cut when it actually owns one of the queued UV destinations.
    const ids = first.cells.some(cell => publication.required.has(first.geometry.key + ':' + cell.key)) &&
      Array.from(publication.pending.values()).find(ids => ids.has(first.geometry.key))
    const group = {rows: new Map(), required: new Set(), pending: new Map(), images: [],
      releases: [], generation: r.partitionGeneration, demand: Boolean(ids), task: null}
    for (const id of ids || [first.geometry.key]) {
      const owner = r.geometry.entries.get(id)
      if (!owner) return false
      const draws = ids ? publication.meshes.get(id) : []
      const cells = ids ? draws.filter(draw => draw.imageryClipCell && !draw.imageryDirectClip).map(draw => r.partitionCell(draw)) : first.cells
      const row = {geometry: owner.value, owner, partitions: owner.value.partitions, cells: Array.from(new Map(cells.map(cell => [cell.key, cell])).values())}
      group.rows.set(id, row)
      row.cells.forEach(cell => group.required.add(id + ':' + cell.key))
    }
    // Installed-cut UV production needs immutable geometry, not image data.
    // A shared mesh can contain independent image groups; waiting for every
    // bitmap also blocks ready neighbours and may strand obsolete targets.
    // PartitionPublication retains each group's image/readiness checks.
    // prepareImagery still jointly funds future images and their UV outputs.
    // Reject obsolete metadata before borrowing resources: releasing an
    // invalid candidate must not manufacture an availability wakeup/retry.
    if (!this.valid(group)) return false
    this.current = group
    for (const [id, row] of group.rows) group.releases.push(r.geometry.retain(id), holdMeshes([row.geometry.resource]))
    // The task remains the single planning lane through cancellation receipts.
    group.task = {cancel() {}}
    this.price(group).catch(error => {
      if (this.valid(group)) r.onDiagnostic('partition_prepare_failed', {message: error.message || String(error)})
    }).finally(() => {
      group.task = null
      if (!group.pool || !this.valid(group)) {
        const blocked = this.valid(group)
        this.release(group)
        // Releasing borrowed ownership changes availability. Record refusal
        // afterwards, otherwise our own refund immediately retries the group.
        if (blocked) {
          for (const row of group.rows.values()) r.blockPartitionJob(row)
          r.partitionQueue = r.partitionQueue.filter(job => {
            job.cells = job.cells.filter(cell => !group.required.has(job.geometry.key + ':' + cell.key))
            return job.cells.length > 0
          })
        }
      }
      // Resume through the bounded resource clock. Direct pumping here can
      // repeatedly price an empty/obsolete group in the same microtask turn,
      // preventing presentation from advancing the cut that would retire it.
      if (!r.destroyed && !r.paused && !r.contextLost) r.requestResources()
    })
    return false
  }

  async price(group) {
    const r = this.renderer, rows = []
    group.borrowedOutputs = new Map()
    group.allPrices = group.future ? new Map() : null
    for (const [id, row] of group.rows) {
      if (!this.valid(group)) return
      const missing = row.cells.filter(cell => {
        const part = row.geometry.partitions.get(cell.key)
        if (part && group.allPrices) group.allPrices.set(id + ':' + cell.key, part.byteSize || 0)
        const plan = !part && this.meshFor(id, cell.key)
        // This destination is funded by the terrain transaction. If that
        // transaction retires before producing it, follow an already funded
        // successor or retry admission; never wait on a vanished destination.
        if (plan) {
          group.borrowedOutputs.set(id + ':' + cell.key, {plan, geometry: row.geometry, cell: cell.key})
          if (group.allPrices) {
            const value = plan.price(id, cell.key)
            if (Number.isSafeInteger(value) && value >= 0) group.allPrices.set(id + ':' + cell.key, value)
          }
        }
        return !part && !plan
      })
      if (!missing.length) continue
      rows.push({id, geometry: row.geometry, cells: missing})
    }
    this.pricing.groups += 1; this.pricing.meshes += rows.length
    let costs
    if (rows.length && r.options.createPartitionGroupPlanTask) {
      ++this.pricing.batches
      const task = group.task = r.options.createPartitionGroupPlanTask(rows)
      costs = await task.promise
      if (!this.valid(group)) return
      invariant(costs instanceof Map, 'Invalid partition group output plan')
    }
    for (const {id, geometry, cells: missing} of rows) {
      if (!this.valid(group)) return
      let plan = costs && costs.get(geometry.key)
      if (!costs) {
        const task = group.task = r.options.createPartitionPlanTask && geometry.resourceId
          ? r.options.createPartitionPlanTask(geometry.resourceId, missing, geometry)
          : surface.createPartitionPlanTask(geometry.model, missing)
        plan = await (task.promise || task.run())
      }
      if (!this.valid(group)) return
      invariant(Array.isArray(plan) && plan.length === missing.length && plan.every((item, i) =>
        item.key === missing[i].key && Number.isSafeInteger(item.bytes) && item.bytes >= 0), 'Invalid partition output plan')
      for (const item of plan) {
        group.pending.set(id + ':' + item.key, item.bytes)
        if (group.allPrices) group.allPrices.set(id + ':' + item.key, item.bytes)
      }
    }
    if (!this.valid(group)) return
    this.fund(group)
  }

  fund(group) {
    const r = this.renderer, keep = [], pending = new Map()
    const prices = group.allPrices || group.pending
    const borrowed = group.borrowedOutputs
    group.borrowedOutputs = new Map()
    for (const [id, row] of group.rows) for (const cell of row.cells) {
      const part = row.geometry.partitions.get(cell.key), label = id + ':' + cell.key
      if (part) { if (part.allocation) keep.push(part.allocation); continue }
      // Async pricing can span take(): that removes a funded destination from
      // the terrain plan's pending map while its producer still owns it. Keep
      // the existing loan through the receipt instead of repricing it as new.
      const dependency = borrowed && borrowed.get(label)
      if (dependency && this.outputAvailable(dependency)) {
        group.borrowedOutputs.set(label, dependency)
        continue
      }
      const plan = this.meshFor(id, cell.key)
      if (plan) group.borrowedOutputs.set(label, {plan, geometry:row.geometry, cell:cell.key})
      else pending.set(label, prices.get(label))
    }
    group.pending = pending
    const bytes = Array.from(pending.values()).reduce((n, value) => n + value, 0)
    const sizes = Array.from(group.pending.values()).sort((a,b) => b-a)
    const minimum = sizes[0] || 0, preferred = sizes.slice(0,8).reduce((n,b) => n+b,0)
    if (bytes + minimum > r.partitionCapacityBytes) return
    r.prunePartitions(bytes + preferred, r.partitionCapacityBytes)
    const room = r.partitionCapacityBytes - r.partitionBytes - r.partitionReservedBytes - r.partitionCpuBytes - bytes
    if (room < minimum) return
    const reserve = work => {
      if (!group.reserve) return OutputTransaction.reserve(r.resourceLedger, work, bytes, 'partition-output', 'partition-gpu', keep)
      let pool = null
      group.reserve({bytes: work + bytes, keep, accept: credit => {
        pool = new OutputTransaction(credit.split(work, 'reserved', 'partition-output'),
          credit.split(bytes, 'reserved', 'partition-gpu'))
        credit.release()
      }})
      return pool
    }
    const work = Math.min(preferred, room)
    group.pool = reserve(work) || (work > minimum ? reserve(minimum) : null)
    if (group.pool) {
      let charged = 0
      group.workspace = new ResourceWorkspace('partition-output', () => {
        r.partitionCpuBytes += group.workspace.bytes - charged
        charged = group.workspace.bytes
      })
      group.workspace.accept(group.pool.input)
      r.partitionReservedBytes += bytes
    }
  }


  release(group = this.current) {
    if (!group) return
    const completed = this.complete(group) && this.valid(group)
    group.closed = true
    if (group.pool) {
      this.renderer.partitionReservedBytes -= group.pool.output.bytes
      group.workspace.retire(); group.pool.output.release(); group.pool = null
    }
    if (group.task) { group.task.cancel(); return }
    if (group.future && !completed && this.renderer.textures.releasePreparedGroup) this.renderer.textures.releasePreparedGroup(group.future)
    group.releases.splice(0).forEach(release => release())
    if (group.selectionReleases) group.selectionReleases.splice(0).forEach(release => release())
    if (group.metadata) { group.metadata.release(); group.metadata = null }
    group.inputs = null
    if (group.future) {
      group.rows.clear(); group.images.length = 0; group.draws = null; group.borrowedOutputs = null
    }
    if (this.current === group) this.current = null
    this.prepared.delete(group.futureName)
    // Refusal stamps describe the current availability only. Keep them bounded
    // by live demand; releasing this group's own holds must precede a stamp.
    this.refused.forEach((stamp, name) => { if (stamp !== this.admissionKey()) this.refused.delete(name) })
    this.wakeImagery()
  }
}

module.exports = {PartitionGroups}
