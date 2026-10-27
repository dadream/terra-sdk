const {NativePayloadBudget} = require('../../sdk/js/resources/native_payload_budget')
const {terrainCapacityPolicy} = require('../../sdk/js/resources/terrain_capacity_policy')
const {runHeightWork, runHeightSlice} = require('../../sdk/js/terrain/height_work')
const { ImageryAdapter } = require('../../sdk/js/imagery/terra_imagery_adapter')
const wasmLoader = require('./terra_wasm')
const { invariant } = require('../../sdk/js/core/terra_globe_common')
const { CooperativeTask } = require('../../sdk/js/runtime/cooperative_task')
const { NativeMeshBudget } = require('../../sdk/js/resources/native_mesh_budget')
const surfacePlan = require('../../sdk/js/terrain/terra_surface_plan')
const {createPreparedPartitionTask} = require('./prepared_partitions')
const {createPreparedSurfaceTask} = require('./prepared_surface')
const {ImageryPlanner} = require('./imagery_planner')
const {statusError, requireStatus} = require('./abi_status')
const {terrainRecordBytes} = require('../../sdk/js/terrain/terrain_record')
const {Cleanup,cleanupAfterError} = require('../../sdk/js/runtime/cleanup')
const BOUNDARY = {
  bytes: 'terra_mesh_replacement_work_bytes', begin: 'terra_begin_mesh_replacement',
  step: 'terra_step_mesh_replacement', get: 'terra_get_mesh_replacement', end: 'terra_end_mesh_replacement'
}
const STATUS_OK = 0
const STATUS_BUFFER_TOO_SMALL = 6
const TRANSFORM_PLANAR = 1
const TRANSFORM_CYLINDRICAL = 2

const ABI_LAYOUT = {
  manifest: 72,
  viewport: 24,
  camera: 40,
  cameraSnapshot: 160,
  terrainSample: 64,
  heightQuery: 112,
  heightRegion: 104,
  key: 16,
  texture: 16,
  request: 24,
  decision: 32,
  draw: 88,
  frame: 224,
  stats: 56,
  atmosphereParameters: 32,
  atmosphereResult: 72
}

function readU64(view, offset) {
  return view.getUint32(offset, true) +
    view.getUint32(offset + 4, true) * 4294967296
}

function writeKey(view, pointer, key) {
  view.setUint32(pointer, key.level, true)
  view.setInt32(pointer + 4, key.i, true)
  view.setInt32(pointer + 8, key.j, true)
  view.setInt32(pointer + 12, key.k, true)
}

function readKey(view, pointer) {
  return {
    level: view.getUint32(pointer, true),
    i: view.getInt32(pointer + 4, true),
    j: view.getInt32(pointer + 8, true),
    k: view.getInt32(pointer + 12, true)
  }
}

function readDraw(view, offset) {
  return {
    fragment: view.getUint32(offset + 4, true),
    key: readKey(view, offset + 8),
    textureNode: {
      level: view.getUint32(offset + 24, true),
      root: view.getInt32(offset + 28, true),
      row: view.getInt32(offset + 32, true),
      column: view.getInt32(offset + 36, true)
    },
    firstVertex: view.getUint32(offset + 40, true),
    vertexCount: view.getUint32(offset + 44, true),
    firstIndex: view.getUint32(offset + 48, true),
    indexCount: view.getUint32(offset + 52, true),
    origin: [view.getFloat64(offset + 56, true),
      view.getFloat64(offset + 64, true), view.getFloat64(offset + 72, true)],
    flags: view.getUint32(offset + 80, true)
  }
}

class TerraAbi {
  constructor(module) {
    this.nativeRevision = 0
    this.imageryReferenceRevision = 0
    this.imageryPlanners = new Set()
    this.imageryScratchOwners = new Set()
    this.nativeSurfaceOwners = new Set()
    this.nativeAllocations = new Map()
    invariant(module && module.exports, 'Terra Wasm module is required')
    this.module = module
    this.exports = module.exports
    this.layout = this.readLayout()
    this.incrementalLayout = this.readIncrementalLayout()
    this.imageryLayout = this.readImageryLayout()
    this.context = this.module.call('terra_create')
    invariant(this.context, 'terra_create returned null')
  }

  readLayout() {
    const exported = {
      manifest: 'terra_sizeof_terrain_manifest_v3',
      viewport: 'terra_sizeof_viewport_v1',
      camera: 'terra_sizeof_camera_v3',
      cameraSnapshot: 'terra_sizeof_camera_snapshot_v1',
      terrainSample: 'terra_sizeof_terrain_sample_v1',
      heightQuery: 'terra_sizeof_height_query_state_v1',
      heightRegion: 'terra_sizeof_height_region_v1',
      key: 'terra_sizeof_patch_key_v1',
      texture: 'terra_sizeof_texture_node_v3',
      request: 'terra_sizeof_request_v1',
      decision: 'terra_sizeof_patch_decision_v1',
      draw: 'terra_sizeof_draw_range_v1',
      frame: 'terra_sizeof_frame_v1',
      stats: 'terra_sizeof_stats_v1',
      atmosphereParameters: 'terra_sizeof_atmosphere_parameters_v1',
      atmosphereResult: 'terra_sizeof_atmosphere_result_v1'
    }
    const layout = {}
    Object.keys(exported).forEach((name) => {
      layout[name] = this.module.call(exported[name])
      const supported = layout[name] === ABI_LAYOUT[name]
      invariant(supported,
        `Unsupported Terra ABI ${name} size: ${layout[name]}`)
    })
    return layout
  }

  assertLiveOwner() {
    if(this.destroyed)
      throw Object.assign(new Error('Terra ABI is destroyed'),{name:'AbortError'})
  }

  failNative(error) {
    if(this.destroying)throw error
    cleanupAfterError(error,()=>this.destroy())
  }

  alloc(size,channel) {
    this.assertLiveOwner()
    invariant(Number.isInteger(size)&&size>0&&size<0x100000000,'Invalid Terra allocation size')
    let pointer
    try {pointer=this.module.alloc(size)}catch(error) {
      if(error&&error.status===9)throw error
      this.allocationFailed=true;this.allocationFailure=error
      this.failNative(error)
    }
    this.nativeAllocations.set(pointer,{bytes:size,channel})
    if(channel==='imagery-input')this.imageryPackingBytes=(this.imageryPackingBytes||0)+size
    if(channel==='imagery-output')this.imageryOutputPackingBytes=(this.imageryOutputPackingBytes||0)+size
    if(channel)this.observeImageryInput()
    return pointer
  }

  readImageryLayout() {
    const sizes = { options: 48, surface: 48, region: 176, hull_point: 16, draw: 32, quality: 56 }
    Object.keys(sizes).forEach(name => invariant(
      this.module.call(`terra_sizeof_imagery_${name}_v${['options','quality','region'].includes(name) ? 4 : 3}`) === sizes[name],
      `Unsupported Terra imagery ${name} layout`))
    return sizes
  }

  createImageryPlanner() { return new ImageryPlanner(this) }

  getImageryPlanner() {
    if (!this.primaryImagery || this.primaryImagery.closed) this.primaryImagery = this.createImageryPlanner()
    return this.primaryImagery
  }

  invalidateImageryPlanners() {
    const cleanup=new Cleanup()
    for (const planner of Array.from(this.imageryPlanners)) cleanup.run(()=>planner.invalidate())
    this.primaryImagery = null
    cleanup.finish()
  }

  planImagery(draws, measureDraw, options) { return this.getImageryPlanner().plan(draws, measureDraw, options) }

  async planImageryAsync(draws, measureDraw, options) {
    return this.createImageryTask(draws, measureDraw, options).run(options && options.yieldWork)
  }

  createImageryTask(draws, measureDraw, options) {
    return this.getImageryPlanner().createTask(draws, measureDraw, options)
  }

  createNativeSurfaceModelTask(draw,options) {
    return require('./native_surface_measurement').createNativeSurfaceModelTask(this,draw,options)
  }

  createNativeSurfaceMeasurementTask(model,projection,options) {
    return require('./native_surface_measurement').createNativeSurfaceMeasurementTask(this,model,projection,options)
  }

  closeNativeSurfaceOwners(session=0) {
    const cleanup=new Cleanup()
    for(const owner of Array.from(this.nativeSurfaceOwners))if(!session||owner.session===session)cleanup.run(()=>owner.close())
    cleanup.finish()
  }

  acceptImagery(plan, epoch) { this.getImageryPlanner().accept(plan, epoch) }

  resetImagery() { if (this.primaryImagery && !this.primaryImagery.closed) this.primaryImagery.reset() }

  createImageryScratch(onDestroy) {
    return new (require('./imagery_scratch').ImageryScratch)(this,onDestroy)
  }

  imageryPayloadBytes() {
    return this.context ? (this.module.call('terra_imagery_payload_bytes', this.context) >>> 0) +
      (this.imageryPackingBytes || 0) + (this.imageryOutputPackingBytes || 0) + (this.imageryScratchBytes || 0) : 0
  }

  imageryInputPayloadBytes() {
    return this.context ? (this.module.call('terra_imagery_input_payload_bytes', this.context) >>> 0) +
      (this.imageryPackingBytes || 0) + (this.imageryScratchBytes || 0) : 0
  }

  observeImageryInput() {
    // No new production can start during teardown. Keep its credits until the
    // context and every independently allocated ABI buffer have been released.
    if(this.destroying||this.destroyed)return
    try {
      if (this.imageryInputBudget) this.imageryInputBudget.observe(this.imageryInputPayloadBytes())
      if (this.imageryReferenceBudget) this.imageryReferenceBudget.observe(this.imageryReferencePayloadBytes())
      if (this.imageryOutputBudget) this.imageryOutputBudget.observe(this.imageryOutputPayloadBytes())
    }catch(error){this.failNative(error)}
  }

  imageryOutputPayloadBytes() {
    return this.context ? (this.module.call('terra_imagery_output_payload_bytes', this.context) >>> 0) +
      (this.imageryOutputPackingBytes || 0) : 0
  }

  beginImageryOutput(bytes) {
    const budget = this.imageryOutputBudget
    if (!budget) return {bytes, release() {}}
    const refusal = {}, credit = budget.begin(bytes, false, refusal)
    if (!credit) throw Object.assign(new Error('Imagery output capacity is occupied'),
      {status:9, capacityShortfallBytes:refusal.shortfallBytes, capacityRevision:budget.ledger.availabilityRevision})
    return {bytes:credit.bytes, release: () => { this.observeImageryInput(); budget.finish(credit) }}
  }

  imageryReferencePayloadBytes() {
    return this.context ? this.module.call('terra_imagery_reference_payload_bytes', this.context) >>> 0 : 0
  }

  reclaimImageryReferenceSlice(needed, restart) {
    const pointer = this.alloc(8)
    try {
      requireStatus(this.module.call('terra_reclaim_imagery_references', this.context,
        needed, 64, restart ? 1 : 0, pointer, pointer + 4), 'terra_reclaim_imagery_references')
      const view = this.module.refreshMemory().dataView
      return {releasedBytes:view.getUint32(pointer,true), pending:view.getUint32(pointer + 4,true) !== 0}
    } finally { this.free(pointer); this.observeImageryInput() }
  }

  reclaimImageryReferences(needed) {
    return require('../../sdk/js/resources/imagery_reference_reclamation').reclaimImageryReferences(this, needed,
      (bytes, restart) => this.reclaimImageryReferenceSlice(bytes, restart),
      () => new Promise(resolve => setTimeout(resolve, 0)))
  }

  beginImageryReferences(bytes) {
    const budget = this.imageryReferenceBudget, preferred = Math.max(bytes, 65536)
    if (!budget) return {bytes:preferred, release() {}}
    const refusal = {}, credit = budget.beginPreferred(bytes, preferred, refusal)
    if (!credit) throw Object.assign(new Error('Imagery reference capacity is occupied'),
      {status:9, capacityShortfallBytes:refusal.shortfallBytes, capacityRevision:budget.ledger.availabilityRevision})
    return {bytes:credit.bytes, release: () => { this.observeImageryInput(); budget.finish(credit) }}
  }

  beginImageryInput(bytes) {
    const budget = this.imageryInputBudget
    if (!budget) return {release() {}}
    const refusal = {}, credit = budget.begin(bytes, false, refusal)
    if (!credit) throw Object.assign(new Error('Imagery input capacity is occupied'),
      {status:9, capacityShortfallBytes:refusal.shortfallBytes, capacityRevision:budget.ledger.availabilityRevision})
    return {release: () => { this.observeImageryInput(); budget.finish(credit) }}
  }

  readIncrementalLayout() {
    const sizes = {
      budget: ['terra_sizeof_update_budget_v2', 40],
      state: ['terra_sizeof_update_state_v2', 104],
      plan: ['terra_sizeof_mesh_plan_v1', 368],
      mesh: ['terra_sizeof_mesh_resource_v3', 112],
      receipt: ['terra_sizeof_frame_receipt_v2', 16],
      replacement: ['terra_sizeof_replacement_member_v1', 12],
      surfaceWork:['terra_sizeof_surface_work_v1',68],
      surfaceProjection:['terra_sizeof_surface_projection_v1',176],
      surfaceSummary:['terra_sizeof_surface_summary_v1',64]
    }
    const functions = ['terra_imagery_output_payload_bytes', 'terra_imagery_output_work_bytes', 'terra_reclaim_imagery_references', 'terra_imagery_reference_payload_bytes', 'terra_imagery_reference_work_bytes', 'terra_stage_imagery_input', 'terra_append_imagery_surface', 'terra_append_retained_imagery_surface', 'terra_append_imagery_regions', 'terra_append_imagery_hull', 'terra_commit_imagery_input', 'terra_cancel_imagery_input', 'terra_open_imagery', 'terra_close_imagery', 'terra_imagery_payload_bytes', 'terra_imagery_input_payload_bytes', 'terra_imagery_input_work_bytes', 'terra_prepare_mesh_frame', 'terra_get_prepared_mesh_resources', 'terra_get_prepared_mesh_uv', 'terra_get_prepared_mesh_positions',
      'terra_step_mesh_frame', 'terra_commit_mesh_frame', 'terra_discard_mesh_plan', 'terra_mesh_payload_bytes',
      'terra_trim_mesh_cache', 'terra_select_mesh_groups', 'terra_reuse_mesh_replacement', 'terra_update_step', 'terra_advance_terrain', 'terra_get_update_state',
      'terra_get_mesh_resources', 'terra_get_mesh_position_view',
      'terra_get_mesh_texture_view', 'terra_acquire_mesh_resource', 'terra_release_mesh_resource',
      'terra_present_frame', 'terra_retain_meshes']
      .concat(Object.values(BOUNDARY), Object.values(sizes).map(value => value[0]))
    functions.push('terra_surface_model_work_bytes','terra_surface_measurement_work_bytes','terra_open_surface_model',
      'terra_step_surface_model','terra_close_surface_model','terra_open_surface_measurement','terra_step_surface_measurement',
      'terra_get_surface_measurement_summary','terra_get_surface_measurement_regions','terra_get_surface_measurement_hull',
      'terra_append_measured_imagery_surface','terra_close_surface_measurement')
    functions.forEach(name => invariant(typeof this.exports[name] === 'function',
      `Missing Terra incremental ABI function: ${name}`))
    const result = {}
    Object.keys(sizes).forEach(name => {
      result[name] = this.module.call(sizes[name][0])
      invariant(result[name] === sizes[name][1],
        `Unsupported Terra incremental ABI ${name} size: ${result[name]}`)
    })
    return result
  }

  free(pointer) {
    if(!pointer)return
    const allocation=this.nativeAllocations.get(pointer)
    if(!allocation) {
      invariant(this.destroyed,'Terra allocation is not owned by this ABI')
      return // A cancelled iterator can finish after teardown freed its buffer.
    }
    if(allocation.failed)this.failNative(allocation.error)
    try {this.module.free(pointer)}catch(error) {
      // The allocator may have freed before throwing. Never attempt this
      // uncertain pointer twice; a Worker must terminate its whole producer.
      allocation.failed=true;allocation.error=error
      this.failNative(error)
    }
    this.nativeAllocations.delete(pointer)
    if(allocation.channel==='imagery-input')this.imageryPackingBytes-=allocation.bytes
    if(allocation.channel==='imagery-output')this.imageryOutputPackingBytes-=allocation.bytes
  }

  setResourceLedger(ledger) {
    this.assertLiveOwner()
    if (!this.imageryOutputBudget || this.imageryOutputBudget.ledger !== ledger) {
      invariant(!this.imageryOutputBudget || !this.imageryOutputBudget.credits.size,
        'Imagery output ledger cannot change during production')
      const next = new NativePayloadBudget(ledger, 'imagery-output-native', this.imageryOutputPayloadBytes())
      if (this.imageryOutputBudget) this.imageryOutputBudget.close()
      this.imageryOutputBudget = next
    }
    if (!this.imageryReferenceBudget || this.imageryReferenceBudget.ledger !== ledger) {
      invariant(!this.imageryReferenceBudget || !this.imageryReferenceBudget.credits.size,
        'Imagery reference ledger cannot change during production')
      const next = new NativePayloadBudget(ledger, 'imagery-reference-native', this.imageryReferencePayloadBytes(), {
        revision: () => this.imageryReferenceRevision,
        trim: needed => this.reclaimImageryReferences(needed)
      })
      if (this.imageryReferenceBudget) this.imageryReferenceBudget.close()
      this.imageryReferenceBudget = next
    }
    if (!this.imageryInputBudget || this.imageryInputBudget.ledger !== ledger) {
      invariant(!this.imageryInputBudget || !this.imageryInputBudget.credits.size,
        'Imagery input ledger cannot change during production')
      const next = new NativePayloadBudget(ledger, 'imagery-input-native', this.imageryInputPayloadBytes())
      if (this.imageryInputBudget) this.imageryInputBudget.close()
      this.imageryInputBudget = next
    }
    if (this.nativeBudget && this.nativeBudget.ledger !== ledger) {
      invariant(!this.nativeBudget.actual && !this.nativeBudget.credit,
        'Native mesh ledger cannot change while occupied')
      this.nativeBudget.close(); this.nativeBudget = null
    }
    if (!this.nativeBudget) this.nativeBudget = new NativeMeshBudget(ledger, this.meshPayloadBytes(), {
      revision: () => this.nativeRevision,
      trim: needed => this.reclaimNative(needed)
    })
    invariant(this.nativeBudget.ledger === ledger, 'Native mesh ledger cannot change')
    if (!this.recordBudget || this.recordBudget.ledger !== ledger) {
      invariant(!this.recordBudget || !this.recordBudget.credits.size && !this.recordBudget.queue.pending.length,
        'Native record ledger cannot change during production')
      const next = new NativePayloadBudget(ledger, 'terrain-record-native', this.recordPayloadBytes(), {
        revision: () => this.nativeRevision,
        trim: needed => this.reclaimRecords(needed)
      })
      if (this.recordBudget) this.recordBudget.close()
      this.recordBudget = next
    }
    if (!this.heightBudget || this.heightBudget.ledger !== ledger) {
      invariant(!this.heightBudget || !this.heightBudget.credits.size,
        'Native height ledger cannot change during production')
      const next = new NativePayloadBudget(ledger, 'terrain-height-native', this.heightPayloadBytes(), {
        revision: () => this.nativeRevision, trim: needed => this.reclaimHeights(needed)
      })
      if (this.heightBudget) this.heightBudget.close()
      this.heightBudget = next
    }
    return this.nativeBudget
  }

  recordPayloadBytes() {
    return this.context ? this.module.call('terra_record_payload_bytes', this.context) >>> 0 : 0
  }

  heightPayloadBytes() {
    return this.context ? this.module.call('terra_height_payload_bytes', this.context) >>> 0 : 0
  }

  reclaimHeights(needed) {
    const before = this.heightPayloadBytes()
    requireStatus(this.nativeCall('terra_trim_height_cache', this.context, Math.max(0, before - needed)),
      'terra_trim_height_cache')
    return before - this.heightPayloadBytes()
  }

  discardTerrainWork() {
    this.activeHeightWork = null
    if (this.context) requireStatus(this.nativeCall('terra_discard_terrain_work', this.context), 'terra_discard_terrain_work')
  }

  heightSlice(bytes, produce) {
    invariant(this.context, 'Native height producer is destroyed')
    try {
      const result = runHeightSlice(bytes, credit => {
        requireStatus(this.module.call('terra_set_height_work_limit', this.context, credit, 1), 'terra_set_height_work_limit')
        try { return produce() }
        catch (error) {
          if (error.status !== 10) throw error
          return {heightPending:true, heightWorkBytes:this.module.call('terra_height_work_bytes', this.context)}
        }
      }, () => this.heightPayloadBytes())
      if (result && result.heightPending) result.requests = this.getRequests()
      return result
    } finally {
      if (this.context) this.module.call('terra_set_height_work_limit', this.context, 0, 1)
    }
  }

  async heightWork(produce) {
    invariant(!this.activeHeightWork, 'A terrain selection is already active')
    const work = this.activeHeightWork = {}
    try {
      return await runHeightWork(bytes => {
        if (this.activeHeightWork !== work)
          throw Object.assign(new Error('Terrain selection was cancelled'), {name: 'AbortError'})
        return this.heightSlice(bytes, produce)
      }, this.heightBudget, () => {
        if (this.activeHeightWork === work) this.discardTerrainWork()
      }, () => new Promise(resolve => setTimeout(resolve, 0)))
    } finally { if (this.activeHeightWork === work) this.activeHeightWork = null }
  }

  reclaimRecords(needed) {
    const before = this.recordPayloadBytes()
    requireStatus(this.nativeCall('terra_trim_record_cache', this.context, Math.max(0, before - needed)),
      'terra_trim_record_cache')
    return before - this.recordPayloadBytes()
  }

  produceRecord(bytes, remoteCredit, produce, reset = false) {
    const run = credit => {
      invariant(this.context, 'Native record producer is destroyed')
      requireStatus(this.module.call('terra_set_record_work_limit', this.context, credit), 'terra_set_record_work_limit')
      try { return produce() }
      finally { if (this.context) this.module.call('terra_set_record_work_limit', this.context, 0) }
    }
    if (this.recordBudget) {
      invariant(remoteCredit === undefined, 'Managed production cannot receive external record credit')
      return reset ? this.recordBudget.runReset(bytes, run) : this.recordBudget.run(bytes, run)
    }
    return run(remoteCredit === undefined ? bytes : remoteCredit)
  }

  meshPayloadBytes() {
    return this.context ? this.module.call('terra_mesh_payload_bytes', this.context) >>> 0 : 0
  }

  nativeCall(name, ...args) {
    if(!this.destroying)this.assertLiveOwner()
    let failed=false,original
    try { return this.module.call(name, ...args) }
    catch(error){failed=true;original=error;throw error}
    finally {
      // nativeCall wraps mesh allocation/ownership mutations. Trimming is a
      // response to pressure, not a reason to repeat an unchanged no-op scan.
      if (!['terra_trim_mesh_cache', 'terra_trim_record_cache', 'terra_trim_height_cache'].includes(name)) ++this.nativeRevision
      if(!this.destroying&&!this.destroyed)try {
        if (this.nativeBudget) this.nativeBudget.observe(this.meshPayloadBytes())
        if (this.recordBudget) this.recordBudget.observe(this.recordPayloadBytes())
        if (this.heightBudget) this.heightBudget.observe(this.heightPayloadBytes())
        this.observeImageryInput()
      } catch (error) {
        if(failed)cleanupAfterError(original,()=>this.failNative(error))
        this.failNative(error)
      }
    }
  }

  trimMeshCache(maximumBytes = 0) {
    requireStatus(this.nativeCall('terra_trim_mesh_cache', this.context, maximumBytes), 'terra_trim_mesh_cache')
  }

  reclaimNative(needed) {
    const before = this.meshPayloadBytes()
    this.trimMeshCache(Math.max(0, before - needed))
    return before - this.meshPayloadBytes()
  }

  lastError() {
    const countPointer = this.alloc(4)
    try {
      let memory = this.module.refreshMemory()
      memory.dataView.setUint32(countPointer, 0, true)
      const sizing = this.module.call('terra_get_last_error', this.context,
        0, 0, countPointer)
      memory = this.module.refreshMemory()
      const count = memory.dataView.getUint32(countPointer, true)
      if (sizing !== STATUS_BUFFER_TOO_SMALL || count <= 1) {
        return ''
      }
      const pointer = this.alloc(count)
      try {
        const status = this.module.call('terra_get_last_error', this.context,
          pointer, count, countPointer)
        if (status !== STATUS_OK) {
          return ''
        }
        memory = this.module.refreshMemory()
        let result = ''
        for (let index = 0; index + 1 < count; ++index) {
          result += String.fromCharCode(memory.bytes[pointer + index])
        }
        return result
      } finally {
        this.free(pointer)
      }
    } catch (error) {
      return ''
    } finally {
      this.free(countPointer)
    }
  }

  computeAtmosphere(options) {
    const width = 256
    const height = 32
    const rgbaCapacity = width * height * 4
    const parametersPointer = this.alloc(this.layout.atmosphereParameters)
    const resultPointer = this.alloc(this.layout.atmosphereResult)
    const rgbaPointer = this.alloc(rgbaCapacity)
    try {
      let memory = this.module.refreshMemory()
      const view = memory.dataView
      view.setUint32(parametersPointer, this.layout.atmosphereParameters, true)
      view.setUint32(parametersPointer + 4, 0, true)
      view.setFloat32(parametersPointer + 8, options.sunAzimuthDegrees, true)
      view.setFloat32(parametersPointer + 12, options.sunZenithDegrees, true)
      view.setFloat32(parametersPointer + 16, options.turbidity, true)
      view.setFloat32(parametersPointer + 20, options.exposure, true)
      view.setUint32(parametersPointer + 24, width, true)
      view.setUint32(parametersPointer + 28, height, true)
      view.setUint32(resultPointer, this.layout.atmosphereResult, true)
      requireStatus(this.module.call('terra_compute_atmosphere',
        parametersPointer, resultPointer, rgbaPointer, rgbaCapacity),
      'terra_compute_atmosphere')
      memory = this.module.refreshMemory()
      const output = memory.dataView
      const color = (offset) => [
        output.getFloat32(resultPointer + offset, true),
        output.getFloat32(resultPointer + offset + 4, true),
        output.getFloat32(resultPointer + offset + 8, true)
      ]
      const required = output.getUint32(resultPointer + 68, true)
      invariant(required <= rgbaCapacity,
        'Atmosphere result exceeds the allocated buffer')
      return {
        width: output.getUint32(resultPointer + 4, true),
        height: output.getUint32(resultPointer + 8, true),
        sunVisible: output.getUint32(resultPointer + 12, true) !== 0,
        sunDirection: color(16),
        ambientColor: color(28),
        diffuseColor: color(40),
        fogColor: color(52),
        seaLevelFogDensity: output.getFloat32(resultPointer + 64, true),
        rgba: memory.bytes.slice(rgbaPointer, rgbaPointer + required)
      }
    } finally {
      this.free(rgbaPointer)
      this.free(resultPointer)
      this.free(parametersPointer)
    }
  }

  loadManifest(manifest, capacityBytes = this.terrainCapacity && this.terrainCapacity.meshBytes, credit) {
    const capacity = terrainCapacityPolicy(capacityBytes)
    requireStatus(this.module.call('terra_configure_terrain_capacity', this.context, capacity.meshBytes),
      'terra_configure_terrain_capacity')
    this.terrainCapacity = capacity
    return this.produceRecord(4 * manifest.patchDimension * manifest.patchDimension, credit,
      () => this.loadManifestInput(manifest), true)
  }

  loadManifestInput(manifest) {
    invariant(manifest.transform === 'cylindrical'
      ? manifest.texture.kind === 'global-geodetic'
      : manifest.texture.kind !== 'global-geodetic' && JSON.stringify(manifest.texture.bounds) ===
        JSON.stringify([[manifest.minimumU, manifest.minimumV], [manifest.maximumU, manifest.maximumV]]),
    'Imagery coordinate model or extent does not match terrain')
    const imageryAdapter = new ImageryAdapter(manifest.texture)
    const pointer = this.alloc(this.layout.manifest)
    try {
      const view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.manifest, true)
      view.setUint32(pointer + 4, wasmLoader.TERRA_ABI_VERSION, true)
      view.setUint32(pointer + 8, manifest.formatVersion, true)
      view.setUint32(pointer + 12, manifest.patchDimension, true)
      view.setUint32(pointer + 16,
        manifest.transform === 'planar' ? TRANSFORM_PLANAR : TRANSFORM_CYLINDRICAL, true)
      view.setFloat64(pointer + 24, manifest.heightScale, true)
      view.setFloat64(pointer + 32, manifest.minimumU, true)
      view.setFloat64(pointer + 40, manifest.minimumV, true)
      view.setFloat64(pointer + 48, manifest.maximumU, true)
      view.setFloat64(pointer + 56, manifest.maximumV, true)
      view.setFloat64(pointer + 64, manifest.radius, true)
      this.discardTerrainWork()
      requireStatus(this.nativeCall('terra_load_terrain_manifest', this.context, pointer),
        'terra_load_terrain_manifest')
      for(const owner of this.nativeSurfaceOwners)if(owner.id)owner.id=0
      this.closeNativeSurfaceOwners()
      this.invalidateImageryPlanners()
      this.manifest = manifest
      this.imageryAdapter = imageryAdapter
    } finally {
      this.free(pointer)
    }
  }

  setViewport(width, height, fovRadians) {
    const pointer = this.alloc(this.layout.viewport)
    try {
      const view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.viewport, true)
      view.setUint32(pointer + 4, width, true)
      view.setUint32(pointer + 8, height, true)
      view.setFloat64(pointer + 16, fovRadians, true)
      requireStatus(this.module.call('terra_set_viewport', this.context, pointer),
        'terra_set_viewport')
    } finally {
      this.free(pointer)
    }
  }

  setCamera(camera) {
    invariant(camera.model === undefined || camera.model === 'orbit' || camera.model === 'eye', 'Unknown camera model')
    const pointer = this.alloc(this.layout.camera)
    try {
      const view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.camera, true)
      view.setUint32(pointer + 4, camera.model === 'eye' ? 1 : 0, true)
      view.setFloat64(pointer + 8, camera.distance, true)
      view.setFloat64(pointer + 32, camera.targetHeightMeters === undefined ? 0 : camera.targetHeightMeters, true)
      view.setFloat64(pointer + 16, camera.tiltRadians, true)
      view.setFloat64(pointer + 24, camera.yawRadians, true)
      requireStatus(this.module.call('terra_set_camera', this.context, pointer),
        'terra_set_camera')
    } finally {
      this.free(pointer)
    }
  }

  setGlobeTarget(longitudeDegrees, latitudeDegrees) {
    requireStatus(this.module.call('terra_set_globe_target', this.context,
      longitudeDegrees, latitudeDegrees), 'terra_set_globe_target')
  }

  setPlanarTarget(x, y) {
    requireStatus(this.module.call('terra_set_planar_target', this.context,
      x, y), 'terra_set_planar_target')
  }

  setPlanarLevel(targetLevel) {
    requireStatus(this.nativeCall('terra_set_planar_level', this.context,
      targetLevel), 'terra_set_planar_level')
  }

  update(lodThreshold) {
    invariant(!this.nativeBudget, 'Managed meshes require prepare/materialize')
    const status = this.module.call('terra_update', this.context, lodThreshold)
    if (status !== STATUS_OK) {
      throw statusError('terra_update', status, this.lastError())
    }
    return this.getFrame()
  }

  updateStep(lodThreshold, options) {
    invariant(!this.nativeBudget, 'Managed meshes require prepare/materialize')
    this.runTerrainStep('terra_update_step', lodThreshold, options)
    return this.getFrame()
  }

  prepareMeshFrame(lodThreshold, options) {
    return this.heightBudget ? this.heightWork(() => this.prepareMeshFrameRaw(lodThreshold, options))
      : this.prepareMeshFrameRaw(lodThreshold, options)
  }

  prepareMeshFrameRaw(lodThreshold, options) {
    const pointer = this.alloc(this.incrementalLayout.plan)
    try {
      this.module.refreshMemory().dataView.setUint32(pointer, this.incrementalLayout.plan, true)
      this.runTerrainStep('terra_prepare_mesh_frame', lodThreshold, options, pointer)
      return this.readMeshPlan(pointer)
    } finally { this.free(pointer) }
  }

  createPreparedPartitionTask(planId, draw, cells, indices, maximumBytes) {
    return createPreparedPartitionTask(this, planId, draw, cells, indices, maximumBytes)
  }

  createPreparedSurfaceTask(planId, draw, maximumBytes) {
    return createPreparedSurfaceTask(this, planId, draw, maximumBytes)
  }

  readMeshPlan(pointer) {
    const view = this.module.refreshMemory().dataView
    const nativePlan = {id: view.getUint32(pointer + 8, true),
      residentBytes: readU64(view, pointer + 16), additionalBytes: readU64(view, pointer + 24),
      reclaimableBytes: readU64(view, pointer + 32)}
    try {
      const updateState = this.readUpdateState(pointer + 264, false)
      nativePlan.maximumBytes = updateState.maximumMeshBytes
      this.meshSelection = nativePlan
      return {nativePlan, frame: this.readFrame(pointer + 40), updateState,
        draws: this.getMeshResources(nativePlan.id)}
    } catch (error) { this.discardMeshPlan(nativePlan); throw error }
  }

  selectMeshGroups(plan, groups) {
    const pointer = this.alloc(this.incrementalLayout.plan + groups.length * 4)
    try {
      const view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.incrementalLayout.plan, true)
      const ids = pointer + this.incrementalLayout.plan
      groups.forEach((id, i) => view.setUint32(ids + i * 4, id, true))
      requireStatus(this.nativeCall('terra_select_mesh_groups', this.context, plan.id,
        ids, groups.length, pointer), 'terra_select_mesh_groups')
      return this.readMeshPlan(pointer)
    } finally { this.free(pointer) }
  }

  reuseReplacementPlan(plan, beforeIds) {
    const pointer = this.alloc(4 + beforeIds.length * 4)
    try {
      const view = this.module.refreshMemory().dataView
      beforeIds.forEach((id, i) => view.setUint32(pointer + 4 + i * 4, id, true))
      requireStatus(this.nativeCall('terra_reuse_mesh_replacement', this.context, plan.id,
        pointer + 4, beforeIds.length, pointer), 'terra_reuse_mesh_replacement')
      return this.module.refreshMemory().dataView.getUint32(pointer, true) ? this.readReplacementPlan(plan) : null
    } finally { this.free(pointer) }
  }

  readReplacementPlan(plan) {
    const bytes = this.copyVector(BOUNDARY.get, 12, [plan.id])
    const members = new DataView(bytes), groups = []
    for (let offset = 0; offset < bytes.byteLength; offset += 12) {
      const id = members.getUint32(offset, true), after = members.getUint32(offset + 4, true)
      invariant(id <= groups.length && after <= 1, 'Invalid boundary member')
      if (!groups[id]) groups[id] = {before: [], after: []}
      groups[id][after ? 'after' : 'before'].push(members.getUint32(offset + 8, true))
    }
    return {groups}
  }

  replacementWorkBytes(plan, beforeIds) {
    const pointer = this.alloc(Math.max(4, beforeIds.length * 4))
    try {
      const view = this.module.refreshMemory().dataView
      beforeIds.forEach((id, i) => view.setUint32(pointer + i * 4, id, true))
      const bytes = this.module.call(BOUNDARY.bytes, this.context, plan.id, pointer, beforeIds.length)
      invariant(bytes > 0, 'Boundary capacity unavailable')
      return bytes
    } finally {this.free(pointer)}
  }

  createReplacementTask(plan, beforeIds, maximumBytes) {
    return new CooperativeTask(this.replacementSteps(plan, beforeIds, maximumBytes), 64)
  }

  *replacementSteps(plan, beforeIds, maximumBytes) {
    const pointer = this.alloc(Math.max(4, beforeIds.length * 4)), complete = this.alloc(4)
    let begun = false
    try {
      const view = this.module.refreshMemory().dataView
      beforeIds.forEach((id, i) => view.setUint32(pointer + i * 4, id, true))
      requireStatus(this.module.call(BOUNDARY.begin, this.context,
        plan.id, pointer, beforeIds.length, maximumBytes), BOUNDARY.begin)
      begun = true
      for (;;) {
        requireStatus(this.module.call(BOUNDARY.step, this.context,
          plan.id, 512, complete), BOUNDARY.step)
        if (this.module.refreshMemory().dataView.getUint32(complete, true)) break
        yield
      }
      return this.readReplacementPlan(plan)
    } finally {
      if (begun) requireStatus(this.nativeCall(BOUNDARY.end, this.context, plan.id),
        BOUNDARY.end, [STATUS_OK, 2])
      this.free(complete); this.free(pointer)
    }
  }

  // Explicit synchronous callers drain the same production iterator. Runtime
  // owners keep its cooperative task so credit and cancellation span yields.
  materializeMeshFrame(packet, maximumBytes) {
    const work = this.meshProductionSteps(packet, maximumBytes)
    try { while (!work.next().done) {} } finally { work.return() }
  }

  createMeshTask(packet, maximumBytes) {
    return new CooperativeTask(this.meshProductionSteps(packet, maximumBytes), 64)
  }

  commitMeshFrame(packet) {
    const plan = packet.nativePlan
    invariant(plan && plan === this.meshSelection && plan.produced, 'Mesh publication is not prepared')
    requireStatus(this.nativeCall('terra_commit_mesh_frame', this.context, plan.id), 'terra_commit_mesh_frame')
    packet.nativePlan = null
    this.meshSelection = null
    packet.updateState = this.getUpdateState()
  }

  *meshProductionSteps(packet, maximumBytes) {
    const plan = packet.nativePlan
    invariant(plan && plan === this.meshSelection && Number.isInteger(plan.additionalBytes) && plan.additionalBytes <= 0xffffffff,
      'Native mesh production credit is invalid')
    const credit = this.nativeBudget && this.nativeBudget.credit
    if (this.nativeBudget) invariant(credit && credit.bytes >= plan.additionalBytes,
      'Native mesh production is not credited')
    const bytes = maximumBytes === undefined ? plan.additionalBytes : maximumBytes
    const pointer = this.alloc(4)
    let complete = false
    try {
      for (;;) {
        invariant(this.context && packet.nativePlan === plan, 'Mesh production was cancelled')
        const status = this.nativeCall('terra_step_mesh_frame', this.context, plan.id, bytes, pointer)
        if (status !== STATUS_OK) {
          const error = statusError('terra_step_mesh_frame', status, this.lastError())
          if (status === 9) error.requests = this.getRequests()
          throw error
        }
        complete = Boolean(this.module.refreshMemory().dataView.getUint32(pointer, true))
        if (complete) {
          plan.produced = true
          return packet
        }
        yield
      }
    } finally {
      this.free(pointer)
      if (!complete) {
        this.discardMeshPlan(plan)
        if (packet.nativePlan === plan) packet.nativePlan = null
      }
    }
  }

  discardMeshPlan(plan) {
    if (plan && this.context) requireStatus(this.nativeCall('terra_discard_mesh_plan', this.context, plan.id),
      'terra_discard_mesh_plan', [STATUS_OK, 2])
  }

  advanceTerrain(lodThreshold, options) {
    return this.heightBudget ? this.heightWork(() => this.advanceTerrainRaw(lodThreshold, options))
      : this.advanceTerrainRaw(lodThreshold, options)
  }

  advanceTerrainRaw(lodThreshold, options) {
    const pointer = this.alloc(this.incrementalLayout.state)
    try {
      this.module.refreshMemory().dataView.setUint32(pointer, this.incrementalLayout.state, true)
      this.runTerrainStep('terra_advance_terrain', lodThreshold, options, pointer)
      return this.readUpdateState(pointer, false)
    } finally { this.free(pointer) }
  }

  runTerrainStep(method, lodThreshold, options, progress = 0) {
    const value = options || {}
    if (value.meshBudgetBytes) {
      requireStatus(this.module.call('terra_set_terrain_mesh_budget', this.context,
        value.meshBudgetBytes), 'terra_set_terrain_mesh_budget')
    }
    const changes = value.maximumChangeCount === undefined ? 32 : value.maximumChangeCount
    const priorities = value.maximumPriorityUpdateCount === undefined
      ? 256 : value.maximumPriorityUpdateCount
    const milliseconds = value.maximumElapsedMs === undefined ? 4 : value.maximumElapsedMs
    const nodes = value.maximumNodeCount === undefined ? 0 : value.maximumNodeCount
    const meshBytes = value.maximumMeshBytes === undefined ? 0 : value.maximumMeshBytes
    invariant(Number.isInteger(changes) && changes >= 0 && changes <= 0xffffffff &&
      Number.isInteger(priorities) && priorities >= 0 && priorities <= 0xffffffff &&
      Number.isFinite(milliseconds) && milliseconds >= 0 &&
      Number.isInteger(nodes) && nodes >= 0 && nodes <= 65536 &&
      Number.isInteger(meshBytes) && meshBytes >= 0 && meshBytes <= 0xffffffff,
    'Incremental update budget is invalid')
    const pointer = this.alloc(this.incrementalLayout.budget)
    try {
      const view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.incrementalLayout.budget, true)
      view.setUint32(pointer + 4, 2, true)
      view.setUint32(pointer + 8, changes, true)
      view.setUint32(pointer + 12, priorities, true)
      view.setFloat64(pointer + 16, milliseconds, true)
      view.setUint32(pointer + 24, nodes, true)
      view.setUint32(pointer + 28, meshBytes, true)
      view.setUint32(pointer + 32, Number(Boolean(value.coarseningOnly)), true)
      const status = this.nativeCall(method, this.context, lodThreshold, pointer, progress)
      if (status !== STATUS_OK) {
        const error = statusError(method, status, this.lastError())
        if (status === 9) error.requests = this.getRequests()
        throw error
      }
    } finally {
      this.free(pointer)
    }
  }

  getUpdateState() {
    const pointer = this.alloc(this.incrementalLayout.state)
    try {
      let view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.incrementalLayout.state, true)
      requireStatus(this.module.call('terra_get_update_state', this.context,
        pointer), 'terra_get_update_state')
      return this.readUpdateState(pointer)
    } finally {
      this.free(pointer)
    }
  }

  readUpdateState(pointer, published = true) {
    const view = this.module.refreshMemory().dataView
    return {
      sequence: readU64(view, pointer + 8),
      modelRevision: readU64(view, pointer + 16),
      meshBytes: readU64(view, pointer + 24),
      decodedRecordBytes: readU64(view, pointer + 32),
      maximumMeshBytes: readU64(view, pointer + 40),
      priorityUpdateCount: view.getUint32(pointer + 48, true),
      pendingPriorityUpdateCount: view.getUint32(pointer + 52, true),
      budgetExhausted: view.getUint32(pointer + 56, true) !== 0,
      topologyChangeCount: view.getUint32(pointer + 60, true),
      heightBytes: readU64(view, pointer + 64),
      heightBuildCount: view.getUint32(pointer + 72, true),
      requestedLodThreshold: view.getFloat32(pointer + 80, true),
      feasibleLodThreshold: view.getFloat32(pointer + 84, true),
      topologyNodeCount: view.getUint32(pointer + 88, true),
      maximumTopologyNodeCount: view.getUint32(pointer + 92, true),
      limitedByCapacity: view.getUint32(pointer + 96, true) !== 0,
      pendingMeshGroups: view.getUint32(pointer + 100, true),
      achievedLodError: published
        ? this.module.call('terra_get_terrain_error', this.context) : null,
      noDataRecordCount: this.module.call('terra_get_no_data_count', this.context)
    }
  }

  getMeshResources(planId) {
    invariant(this.incrementalLayout, 'Incremental mesh API is unavailable')
    const buffer = this.copyVector(planId ? 'terra_get_prepared_mesh_resources' : 'terra_get_mesh_resources',
      this.incrementalLayout.mesh, planId ? [planId] : [])
    const view = new DataView(buffer)
    const result = []
    for (let offset = 0; offset < buffer.byteLength; offset += this.incrementalLayout.mesh) {
      const adapter = this.primaryImagery && this.primaryImagery.adapter || this.imageryAdapter
      const draw = adapter.prepareDraw(readDraw(view, offset + 24))
      draw.resourceId = view.getUint32(offset + 4, true)
      draw.positionFloatCount = view.getUint32(offset + 8, true)
      draw.textureFloatCount = view.getUint32(offset + 12, true)
      draw.textureResourceId = view.getUint32(offset + 16, true) + view.getUint32(offset + 20, true) * 4294967296
      invariant(draw.resourceId > 0 &&
        Number.isSafeInteger(draw.textureResourceId) && draw.textureResourceId > 0 &&
        draw.positionFloatCount === draw.vertexCount * 3 &&
        draw.textureFloatCount === draw.vertexCount * 2,
      'Incremental mesh descriptor is invalid')
      result.push(draw)
    }
    return result
  }

  borrowMeshResource(draw) {
    return require('./borrowed_mesh').borrowMesh(this, draw)
  }

  copyMeshResource(draw) {
    return {resourceId: draw.resourceId, textureResourceId: draw.textureResourceId,
      positions: this.copyMeshPositions(draw), textureUv: this.copyMeshUv(draw)}
  }

  copyMeshPositions(draw) { return this.copyMeshView(draw, 'terra_get_mesh_position_view', draw.positionFloatCount) }
  copyMeshUv(draw) { return this.copyMeshView(draw, 'terra_get_mesh_texture_view', draw.textureFloatCount) }

  copyMeshView(draw, name, count) {
    invariant(this.incrementalLayout && draw &&
      Number.isInteger(draw.resourceId) && draw.resourceId > 0 &&
      draw.resourceId <= 0xffffffff, 'Mesh resource ID is invalid')
    const pointer = this.module.call(name, this.context, draw.resourceId)
    const byteLength = count * 4
    const memory = this.module.refreshMemory().bytes
    invariant(Number.isSafeInteger(byteLength) && byteLength > 0 &&
      pointer > 0 && pointer + byteLength <= memory.byteLength,
    `${name} returned an invalid mesh view`)
    return new Float32Array(memory.slice(pointer, pointer + byteLength).buffer)
  }

  presentFrame(sequence) {
    this.meshReceipt('terra_present_frame', sequence)
  }

  retainMeshes(sequence, draws) {
    const ids = Array.from(new Set(draws.map(draw => draw.resourceId)))
    invariant(
      ids.every(id => Number.isInteger(id) && id > 0 && id <= 0xffffffff),
    'Mesh retention IDs are invalid')
    this.meshReceipt('terra_retain_meshes', sequence, ids.slice().sort((a, b) => a - b))
  }

  meshReceipt(name, sequence, ids = []) {
    invariant(Number.isSafeInteger(sequence) && sequence > 0,
      'Frame receipt sequence is invalid')
    const pointer = this.alloc(this.incrementalLayout.receipt + ids.length * 4)
    try {
      const view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.incrementalLayout.receipt, true)
      view.setUint32(pointer + 4, 2, true)
      view.setUint32(pointer + 8, sequence % 4294967296, true)
      view.setUint32(pointer + 12, Math.floor(sequence / 4294967296), true)
      const idPointer = pointer + this.incrementalLayout.receipt
      ids.forEach((id, i) => view.setUint32(idPointer + i * 4, id, true))
      requireStatus(this.nativeCall(name, this.context, pointer, idPointer, ids.length), name)
    } finally {
      this.free(pointer)
    }
  }

  getFrame() {
    const pointer = this.alloc(this.layout.frame)
    try {
      let view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.frame, true)
      requireStatus(this.module.call('terra_get_frame', this.context, pointer),
        'terra_get_frame')
      return this.readFrame(pointer)
    } finally {
      this.free(pointer)
    }
  }

  readFrame(pointer) {
    const view = this.module.refreshMemory().dataView
    const projectionView = new Float64Array(16)
    for (let index = 0; index < projectionView.length; ++index) {
      projectionView[index] = view.getFloat64(pointer + 64 + index * 8, true)
    }
    return {
      sequence: readU64(view, pointer + 8),
      decisionsComplete: view.getUint32(pointer + 16, true) !== 0,
      patchCount: view.getUint32(pointer + 20, true),
      requestCount: view.getUint32(pointer + 24, true),
      loadedRecordCount: view.getUint32(pointer + 28, true),
      failedRecordCount: view.getUint32(pointer + 32, true),
      cameraPosition: [
        view.getFloat64(pointer + 40, true),
        view.getFloat64(pointer + 48, true),
        view.getFloat64(pointer + 56, true)
      ],
      projectionView,
      drawCount: view.getUint32(pointer + 192, true),
      vertexCount: view.getUint32(pointer + 196, true),
      positionFloatCount: view.getUint32(pointer + 200, true),
      textureFloatCount: view.getUint32(pointer + 204, true),
      expectedDrawCount: view.getUint32(pointer + 208, true),
      omittedDrawCount: view.getUint32(pointer + 212, true),
      coverageDrawCount: view.getUint32(pointer + 216, true),
      coverageComplete: view.getUint32(pointer + 220, true) !== 0
    }
  }

  heightQueryCall(method, args) {
    const pointer = this.alloc(this.layout.heightQuery)
    try {
      this.module.refreshMemory().dataView.setUint32(pointer, this.layout.heightQuery, true)
      requireStatus(this.module.call(method, this.context, ...args, pointer), method)
      const view = this.module.refreshMemory().dataView, sample = pointer + 24
      const available = view.getUint32(sample + 8, true) !== 0
      return {id: view.getUint32(pointer + 8, true), state: view.getUint32(pointer + 12, true),
        reasons: view.getUint32(pointer + 16, true),
        payloadBytes: readU64(view, pointer + 88), peakBytes: readU64(view, pointer + 96),
        maximumBytes: readU64(view, pointer + 104),
        sample: {available, heightMeters: available ? view.getFloat64(sample + 40, true) : null,
          sampleSpacingMeters: available ? view.getFloat64(sample + 48, true) : null,
          level: available ? view.getUint32(sample + 16, true) : null,
          dataLevel: available ? view.getUint32(sample + 32, true) : null,
          revision: readU64(view, sample + 56)}}
    } finally { this.free(pointer) }
  }

  beginHeightQuery(options) {
    return this.heightQueryCall('terra_begin_height_query', [options.u, options.v,
      options.sampleSpacingMeters, options.maximumLevel, options.maximumBytes])
  }
  stepHeightQuery(id, maximumWork = 32) {
    const result = this.heightQueryCall('terra_step_height_query', [id, maximumWork])
    const pointer = this.alloc(8 * this.layout.request + 4)
    try {
      const count = pointer + 8 * this.layout.request
      requireStatus(this.module.call('terra_get_height_query_requests', this.context, id, pointer, 8, count),
        'terra_get_height_query_requests')
      const view = this.module.refreshMemory().dataView
      result.requests = []
      for (let i = 0; i < view.getUint32(count, true); ++i) {
        const offset = pointer + i * this.layout.request
        result.requests.push({kind: view.getUint32(offset + 4, true), key: readKey(view, offset + 8)})
      }
      return result
    } finally { this.free(pointer) }
  }
  submitHeightQueryRecord(id, kind, key, bytes) {
    bytes = terrainRecordBytes(this.manifest, kind, bytes)
    const pointer = this.alloc(this.layout.key + bytes.byteLength)
    try {
      const memory = this.module.refreshMemory()
      writeKey(memory.dataView, pointer, key)
      memory.bytes.set(bytes, pointer + this.layout.key)
      requireStatus(this.module.call('terra_submit_height_query_record', this.context, id, kind, pointer,
        pointer + this.layout.key, bytes.byteLength), 'terra_submit_height_query_record')
    } finally { this.free(pointer) }
  }
  heightQueryUnavailable(id, kind, key, failed) {
    const pointer = this.alloc(this.layout.key)
    try {
      writeKey(this.module.refreshMemory().dataView, pointer, key)
      requireStatus(this.module.call('terra_height_query_unavailable', this.context, id, kind, pointer,
        failed ? 1 : 0), 'terra_height_query_unavailable')
    } finally { this.free(pointer) }
  }
  endHeightQuery(id) {
    requireStatus(this.module.call('terra_end_height_query', this.context, id), 'terra_end_height_query')
  }
  getHeightQueryRegion(id, maximumValues) {
    invariant(Number.isSafeInteger(maximumValues) && maximumValues > 0 && maximumValues <= 33153,
      'Invalid height region receiver credit')
    const pointer = this.alloc(this.layout.heightRegion + 4 + maximumValues * 4)
    try {
      let view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.heightRegion, true)
      const count = pointer + this.layout.heightRegion, values = count + 4
      requireStatus(this.module.call('terra_get_height_query_region', this.context, id,
        pointer, values, maximumValues, count), 'terra_get_height_query_region')
      view = this.module.refreshMemory().dataView
      const length = view.getUint32(count, true)
      if (!length) return null
      return {dimension: view.getUint32(pointer + 8, true),
        corners: Array.from({length: 9}, (_, i) => view.getFloat64(pointer + 16 + i * 8, true)),
        geometrySpacingMeters: view.getFloat64(pointer + 88, true),
        heightScale: view.getFloat64(pointer + 96, true),
        heights: new Int32Array(this.module.refreshMemory().bytes.buffer, values, length).slice()}
    } finally { this.free(pointer) }
  }

  sampleTerrain(u, v) {
    const pointer = this.alloc(this.layout.terrainSample)
    try {
      let view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.terrainSample, true)
      requireStatus(this.module.call('terra_sample_terrain',
        this.context, u, v, pointer), 'terra_sample_terrain')
      view = this.module.refreshMemory().dataView
      const available = view.getUint32(pointer + 8, true) !== 0
      return {status: available ? 'available' : 'unavailable', source: 'cbdam-cache',
        heightMeters: available ? view.getFloat64(pointer + 40, true) : null,
        sampleSpacingMeters: available ? view.getFloat64(pointer + 48, true) : null,
        level: available ? view.getUint32(pointer + 16, true) : null,
        dataLevel: available ? view.getUint32(pointer + 32, true) : null,
        revision: readU64(view, pointer + 56)}
    } finally { this.free(pointer) }
  }

  getCameraSnapshot() {
    const pointer = this.alloc(this.layout.cameraSnapshot)
    try {
      let view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.cameraSnapshot, true)
      requireStatus(this.module.call('terra_get_camera_snapshot',
        this.context, pointer), 'terra_get_camera_snapshot')
      view = this.module.refreshMemory().dataView
      const projectionView = new Float64Array(16)
      for (let index = 0; index < projectionView.length; ++index) {
        projectionView[index] = view.getFloat64(
          pointer + 32 + index * 8, true)
      }
      return {
        cameraPosition: [
          view.getFloat64(pointer + 8, true),
          view.getFloat64(pointer + 16, true),
          view.getFloat64(pointer + 24, true)
        ],
        projectionView
      }
    } finally {
      this.free(pointer)
    }
  }

  getRequests() {
    const buffer = this.copyVector('terra_get_requests', this.layout.request)
    const view = new DataView(buffer)
    const result = []
    for (let offset = 0; offset < buffer.byteLength; offset += this.layout.request) {
      result.push({
        kind: view.getUint32(offset + 4, true),
        key: readKey(view, offset + 8)
      })
    }
    return result
  }

  getIndices(maximumCount) {
    return new Uint16Array(this.copyVector('terra_get_index_buffer', 2, [], maximumCount))
  }

  submitRecord(kind, key, bytes, credit) {
    bytes = terrainRecordBytes(this.manifest, kind, bytes)
    const dimension = this.manifest.patchDimension + (kind === 1 ? 1 : 0)
    return this.produceRecord(4 * dimension * dimension, credit,
      () => this.submitRecordInput(kind, key, bytes))
  }

  submitRecordInput(kind, key, bytes) {
    const keyPointer = this.alloc(this.layout.key + bytes.byteLength)
    const dataPointer = keyPointer + this.layout.key
    try {
      let memory = this.module.refreshMemory()
      writeKey(memory.dataView, keyPointer, key)
      memory.bytes.set(bytes, dataPointer)
      requireStatus(this.nativeCall('terra_submit_record', this.context, kind,
        keyPointer, dataPointer, bytes.byteLength), 'terra_submit_record')
    } finally {
      this.free(keyPointer)
    }
  }

  failRecord(kind, key) {
    const pointer = this.alloc(this.layout.key)
    try {
      writeKey(this.module.refreshMemory().dataView, pointer, key)
      requireStatus(this.module.call('terra_fail_record', this.context, kind,
        pointer), 'terra_fail_record')
    } finally {
      this.free(pointer)
    }
  }

  noDataRecord(key) {
    const pointer = this.alloc(this.layout.key)
    try {
      writeKey(this.module.refreshMemory().dataView, pointer, key)
      requireStatus(this.nativeCall('terra_no_data_record', this.context, pointer), 'terra_no_data_record')
    } finally { this.free(pointer) }
  }

  retryRecord(kind, key) {
    const pointer = this.alloc(this.layout.key)
    try {
      writeKey(this.module.refreshMemory().dataView, pointer, key)
      requireStatus(this.module.call('terra_retry_record', this.context, kind,
        pointer), 'terra_retry_record')
    } finally {
      this.free(pointer)
    }
  }

  memoryBytes() {
    if (this.module && typeof this.module.memoryBytes === 'function') {
      return this.module.memoryBytes()
    }
    if (this.module && this.module.exports && this.module.exports.memory) {
      return this.module.exports.memory.buffer.byteLength
    }
    return 0
  }

  copyVector(functionName, elementSize, prefix = [], maximumCount = Infinity) {
    const countPointer = this.alloc(4)
    try {
      let memory = this.module.refreshMemory()
      memory.dataView.setUint32(countPointer, 0, true)
      const status = this.module.call(functionName, this.context, ...prefix, 0, 0,
        countPointer)
      requireStatus(status, `${functionName} sizing`,
        [STATUS_OK, STATUS_BUFFER_TOO_SMALL])
      memory = this.module.refreshMemory()
      const count = memory.dataView.getUint32(countPointer, true)
      invariant(count <= maximumCount, 'Native vector exceeds its credited size')
      if (count === 0) {
        return new ArrayBuffer(0)
      }
      const byteLength = count * elementSize
      const pointer = this.alloc(byteLength)
      try {
        requireStatus(this.module.call(functionName, this.context, ...prefix, pointer,
          count, countPointer), functionName)
        memory = this.module.refreshMemory()
        return memory.bytes.slice(pointer, pointer + byteLength).buffer
      } finally {
        this.free(pointer)
      }
    } finally {
      this.free(countPointer)
    }
  }

  destroy() {
    if(this.destroying||this.teardownComplete)return
    this.destroyed=true;this.destroying=true
    const cleanup=new Cleanup(),budgets=[this.nativeBudget,this.recordBudget,this.heightBudget,
      this.imageryInputBudget,this.imageryReferenceBudget,this.imageryOutputBudget].filter(Boolean)
    try {
      for(const budget of budgets)cleanup.run(()=>budget.retire())
      cleanup.run(()=>this.invalidateImageryPlanners())
      cleanup.run(()=>this.closeNativeSurfaceOwners())
      for(const owner of Array.from(this.imageryScratchOwners))cleanup.run(()=>owner.destroy())
      this.activeHeightWork=null
      for(const pointer of Array.from(this.nativeAllocations.keys()))cleanup.run(()=>this.free(pointer))
      if(this.context) {
        try {this.module.call('terra_destroy',this.context)}
        catch(error){this.nativeTerminationFailed=true;this.nativeTerminationError=error}
        finally {this.context=0} // Invalidates borrowed views even after a trap.
      }
      if(this.nativeTerminationFailed||this.allocationFailed||this.nativeAllocations.size) {
        // A context delete cannot confirm a separately allocated buffer whose
        // free trapped. Retain all producer credit until external termination;
        // repeated destroy must not retry a possibly completed native delete.
        const failure=this.nativeTerminationFailed?this.nativeTerminationError:
          this.allocationFailed?this.allocationFailure:this.nativeAllocations.values().next().value.error
        cleanupAfterError(failure,()=>cleanup.finish())
      }
      let budgetsClosed=true
      for(const budget of budgets)cleanup.run(()=>{
        try {budget.close()}catch(error){budgetsClosed=false;throw error}
      })
      this.teardownComplete=budgetsClosed
      cleanup.finish()
    }finally{this.destroying=false}
  }
}

module.exports = { TerraAbi, ABI_LAYOUT, STATUS_OK, STATUS_BUFFER_TOO_SMALL }
