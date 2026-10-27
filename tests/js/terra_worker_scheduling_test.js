const {WORKER_PROTOCOL}=require('../../adapters/wasm/worker_protocol')
const nativeFixture = require('./reference/native_mesh_fixture')
const assert = require('assert')
const { install, TerrainWorkerHost } = require('./reference/measurement_host_fixture')
const surfacePlan = require('../../sdk/js/terrain/terra_surface_plan')
const { TerrainEpoch } = require('../../sdk/js/terrain/terra_terrain_epoch')
const { CooperativeTask } = require('../../sdk/js/runtime/cooperative_task')
const { SurfaceMeasurementCache } = require('../../sdk/js/terrain/surface_measurement_cache')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {MeasurementReceiver}=require('../../adapters/wasm/measurement_transport')
const {MeasurementDeliveryClient}=require('../../adapters/wasm/measurement_delivery_client')
const {releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')


// Exercise both production transfer phases in fixtures that focus on scheduling.
async function publish(send, message, indexBudget) {
  const selected = await send(message)
  if (message.type !== 'step') return selected
  const indexCredit = indexBudget && indexBudget.begin(selected.indexProducerBytes)
  try {
  if (selected.boundaryBytes) await send({type: 'replacement', planId: selected.nativePlan.id, maximumNativeBytes: selected.nativePlan.additionalBytes, maximumBytes: selected.boundaryBytes})
  for (let i = 0; i < 10000; ++i) {
    const result = await send({type: 'materialize', residentTextureIds: [], sequence: selected.sequence, planId: selected.nativePlan.id,
      maximumNativeBytes: selected.nativePlan.additionalBytes, maximumIndexBytes: selected.indexProducerBytes})
    if (!result.pending) {
      result.updateState = (await send({type:'commit-mesh', planId:selected.nativePlan.id})).updateState
      return result
    }
  }
  throw new Error('Mesh fixture did not finish its production slices')
  } finally {if (indexCredit) indexBudget.finish(indexCredit)}
}
const handle = (host, message) => publish(value => host.handle(value), message)

function testMeasurementHistory() {
  const cache = new SurfaceMeasurementCache(480, 2)
  const value = {pixelsPerUv: 256, visible: true, centerDistance: 0, refinable:true,
    bounds: {minimumU: 0, maximumU: 1, minimumV: 0, maximumV: 1}, regions: require('./reference/measurement_production').managedRows([{}])}
  const resources = new Map([[1, true], [2, true], [3, true]])
  cache.remember('a', new Map([[1, value]]), resources)
  cache.remember('b', new Map([[2, value]]), resources)
  const loan = cache.acquire('a'), borrowed=loan.values
  assert.strictEqual(borrowed.get(1).refinable,true,'History lost measurement precision metadata')
  cache.remember('c', new Map([[3, value]]), resources)
  assert.strictEqual(cache.acquire('b'), null, 'A history read did not protect the recently reused view')
  assert.strictEqual(cache.stats().numericPayloadBytes, 480)
  assert.strictEqual(cache.stats().views, 2)
  const before = cache.stats()
  assert.throws(() => cache.remember('bad', new Map([[1, {model: {positions: new Float32Array(3)}}]]), resources), /cannot own/)
  assert.deepStrictEqual(cache.stats(), before, 'Rejected model ownership mutated history')
  cache.remember('d', new Map([[3, value]]), new Map([[3, true]]))
  assert.strictEqual(cache.acquire('a'), null, 'Retired content remained in the reusable history')
  assert.strictEqual(borrowed.get(1).regions, value.regions, 'History retirement invalidated active immutable measurements')
  const active = new Map([[1, value], [2, value], [3, value]])
  value.debugGeometry = {positions: new Float32Array(300)}
  cache.remember('large', active, resources)
  const large=cache.acquire('large')
  assert.strictEqual(large.values.size, 2, 'An oversized view escaped the history payload limit')
  assert(!('debugGeometry' in large.values.get(1)), 'History retained a caller-owned mesh through extra metadata')
  assert.strictEqual(active.size, 3, 'History admission changed the active exact measurement')
  cache.remember('bounded', new Map([[1, Object.assign({}, value, {conservative: true})]]), resources)
  assert.strictEqual(cache.acquire('bounded'), null, 'Conservative bounds were cached as exact measurements')
  for (let i = 0; i < 100; ++i) {
    cache.remember(String(i), active, resources)
    assert(cache.stats().numericPayloadBytes <= 480 && cache.stats().views <= 2)
  }
  cache.clear()
  loan.release();large.release()
  assert.strictEqual(value.regions.references,0,'Numeric cache loans survived all owners')
  assert.strictEqual(cache.stats().numericPayloadBytes, 0)
  assert.strictEqual(cache.stats().entries, 0)
}

async function main() {
  await require('./imagery_stream_receipt_test')()
  require('./borrowed_mesh_test')()
  require('./measurement_rows_test')()
  await require('./measurement_transport_test')()
  testMeasurementHistory()
  await require('./terrain_visibility_test')()
  require('./measurement_refinement_test')()
  await require('./worker_turn_test')()
  await require('./partition_plan_batch_contract')()
  await require('./imagery_settlement_test')()
  await require('./candidate_projection_continuation_test')()
  await require('./published_projection_continuation_test')()
  await require('./stale_projection_coverage_contract')()
  await require('./measurement_priority_contract')()
  await require('./candidate_group_reselection_test')()
  await require('./stage_credit_test')()
  await require('./imagery_measurement_demand_test')()
  await require('./imagery_normalization_order_test')()
  await require('./imagery_rebuild_demand_test')()
  await require('./imagery_priced_demand_test')()
  await require('./imagery_input_scheduling_test')()
  await require('./imagery_policy_rebase_test')()
  await require('./imagery_admission_continuation_test')()
  await require('./imagery_credit_turn_test')()
  require('./imagery_reference_batch_test')()
  await require('./mesh_production_scheduling_test')()
  await require('./mesh_preparation_scheduling_test')()
  // These scheduling fixtures deliberately need exact, resumable work. An
  // inconclusive near-plane bound must not take the safe-bound fast path.
  surfacePlan.surfaceMeasurements = function* (...args) {
    const measured = yield* productionMeasurements(...args)
    if (args[3]) measured.pixelsPerUv = Infinity
    return measured
  }
  const epoch = new TerrainEpoch()
  const desired = revision => ({viewRevision: revision, threshold: 1,
    camera: {longitudeDegrees: revision}, viewport: {width: 100, height: 100, fovRadians: 1}})
  for (let i = 1; i <= 512; ++i) {
    const selection = epoch.begin(desired(i))
    assert.strictEqual(selection.viewRevision, 1, 'Continuous input restarted an unfinished priority scan')
    epoch.finish({pendingPriorityUpdateCount: 512 - i})
  }
  assert.strictEqual(epoch.begin(desired(513)).viewRevision, 513,
    'A finished epoch replayed intermediate pointer events instead of the latest view')
  epoch.clear()
  const resized = Object.assign({}, desired(515), {revision: 515, viewport: {width: 200, height: 100, fovRadians: 1}})
  assert.strictEqual(epoch.begin(desired(514), resized).viewRevision, 514,
    'A queued threshold was combined with an incompatible resized viewport')
  const events = [], responses = new Map()
  let nextId = 1, entered, planning = 0, begun = 0
  const abi = {
    incrementalLayout: true, imageryLayout: true,
    setViewport() {}, setCamera() {}, setGlobeTarget() {}, loadManifest() {},
    ...nativeFixture,
    prepareMeshFrame(threshold, budget) {
      const frame = this.updateStep(threshold, budget)
      return {frame, updateState: this.getUpdateState(), draws: this.getMeshResources().map(nativeFixture.meshDraw),
        nativePlan: {id: 1, residentBytes: 0, additionalBytes: 0, reclaimableBytes: 0, maximumBytes: 67108864}}
    },
    materializeMeshFrame(packet) { packet.nativePlan = null },
    discardMeshPlan() {},
    replacementWorkBytes() { return 128 },
    createReplacementTask() { return {async run() { return {groups: []} }, cancel() {}} },
    updateStep() { return { sequence: 1, projectionView: new Float64Array([
      1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]), cameraPosition: [0,0,2] } },
    getUpdateState: () => ({ modelRevision: 1 }),
    advanceTerrain() { events.push('advance'); return {pendingPriorityUpdateCount: 0} },
    getMeshResources: () => [{ resourceId: 1, vertexCount: 3, flags: 0, firstIndex: 0, indexCount: 3,
      origin: [0,0,0], textureNode: {level: 0, root: 0, row: 0, column: 0}, texture: { level: 0, matrix: 0, row: 0, column: 0 } }],
    copyMeshResource: draw => ({ resourceId: draw.resourceId, positions: new Float32Array([0,0,0,1,0,0,0,1,0]),
      textureUv: new Float32Array([0,0,1,0,0,1]) }),
    getIndices: () => new Uint16Array([0,2,1]), getRequests: () => [], memoryBytes: () => 0,
    presentFrame() { events.push('receipt') },
    submitRecord() { events.push('data') },
    async planImageryAsync(draws, measure, options) {
      assert.strictEqual(options.detached, true, 'Worker CPU snapshots must not require a live Native mesh registry entry')
      if (!options.continuation) ++begun
      if (++planning > 1) {
        events.push('planning')
        entered()
        await options.yieldWork()
        await options.yieldWork()
      }
      events.push('planned')
      return { draws, levels: new Set(), quality: { planningComplete: true } }
    }
  }
  let onProgress
  const rawReceiver=new MeasurementReceiver(new ResourceLedger())
  const rawDelivery=new MeasurementDeliveryClient(rawReceiver,{
    post:message=>scope.onmessage({data:message}),fatal:error=>{throw error}
  })
  const scope = { postMessage(message) {
    if(message.mirrorWork){rawDelivery.quote(message.id,message.mirrorWork);return}
    if(message.measurementReset)rawReceiver.clear()
    if(message.mirrorReceipt) {
      const delivered=rawDelivery.receive(message.id,message.mirrorReceipt,message.value&&message.value.measurements)
      if(delivered.values)message.value.measurements=delivered.values
    }
    // These scheduler-only consumers inspect plan metadata, not row payloads.
    if(message.value)releaseMeasurements(message.value.measurements)
    if (message.progress) { if (onProgress) onProgress(message); return }
    const response = responses.get(message.id)
    responses.delete(message.id)
    if (message.error) response.reject(new Error(message.error))
    else response.resolve(message.value)
  } }
  install(scope, { abi })
  function rawSend(message) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      responses.set(id, { resolve, reject })
      scope.onmessage({ data: Object.assign({ id }, message) })
    })
  }
  const send = message => publish(rawSend, message)
  async function planUntilDone(message) {
    let result
    for (let i = 0; i < 100; ++i) {
      result = await send(message)
      if (!result.pending && !result.continuation) return result
    }
    throw new Error('Worker fixture planning did not finish')
  }
  await assert.rejects(send({type: 'initialize', protocol: 'terra.worker.v22'}), /protocol mismatch/)
  await send({ type: 'initialize', protocol: WORKER_PROTOCOL })
  // Tests inject a ready ABI; production initializes this from loadManifest.
  await send({type: 'call', recordCreditBytes: 0, method: 'loadManifest', args: [{radius: 6378000}]})
  scope.onmessage({ data: { type: 'view', revision: 1 } })
  const imagery = { descriptor: { kind: 'global-geodetic', matrix_level_offset: 0, maximum_level: 8, minimum_level: 0,
    tile_size: 256, level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180,-90],[180,90]] }, maximumTextures: 32 }
  const view = { camera: { longitudeDegrees: 0, latitudeDegrees: 0 },
    viewport: { width: 100, height: 100 }, viewRevision: 1 }
  await send(Object.assign({ type: 'step', threshold: 1, budget: {}, residentIds: [], imagery }, view))
  assert.strictEqual(planning, 0, 'Terrain I/O must be published before imagery planning')
  await planUntilDone(Object.assign({ type: 'imagery', sequence: 1, imagery }, view))
  let started = new Promise(resolve => { entered = resolve })
  const update = planUntilDone(Object.assign({ type: 'imagery', sequence: 1,
    imagery: Object.assign({}, imagery, { maximumTextures: 64 }) }, view))
  await started
  const receipt = send({ type: 'present', sequence: 1 })
  const data = send({ type: 'call', recordCreditBytes: 0, method: 'submitRecord', args: [] })
  await Promise.all([receipt, data, update])
  assert(events.indexOf('receipt') < events.lastIndexOf('planned'), 'Receipt waited for the whole imagery job')
  assert(events.indexOf('data') < events.lastIndexOf('planned'), 'Data arrival waited for the whole imagery job')
  started = new Promise(resolve => { entered = resolve })
  const stale = planUntilDone(Object.assign({ type: 'imagery', sequence: 1,
    imagery: Object.assign({}, imagery, { maximumTextures: 128 }) }, view))
  await started
  scope.onmessage({ data: { type: 'view', revision: 2 } })
  const partitions = send({type: 'partition', maximumBytes: 8 * 1024 * 1024, resourceId: 1, viewRevision: 1,
    cells: [{key: 'all', bounds: {minimumU: 0, maximumU: 1, minimumV: 0, maximumV: 1}}]})
  const completed = await stale
  assert.strictEqual(completed.superseded, undefined, 'Pointer movement cancelled a started imagery snapshot')
  assert.strictEqual(completed.viewRevision, 1, 'A completed old snapshot was mislabeled as the new view')
  assert((await partitions).length > 0, 'Pointer movement cancelled immutable texture partitions')
  scope.onmessage({data: Object.assign({type: 'view', revision: 2}, view)})
  const latestTerrain = await send(Object.assign({type: 'step', threshold: 1, budget: {}, residentIds: []}, view))
  assert.strictEqual(latestTerrain.selectionViewRevision, 2,
    'Queued terrain work must start from the latest camera instead of being discarded')
  await send({type: 'present', sequence: latestTerrain.frame.sequence})
  assert.strictEqual(responses.size, 0)
  const createPartitionTask = surfacePlan.createPartitionTask
  const createPartitionPlanTask = surfacePlan.createPartitionPlanTask
  let closed = 0
  surfacePlan.createPartitionTask = () => new CooperativeTask((function* () {
    try { for (let i = 0; i < 256; ++i) yield; return ['complete'] }
    finally { ++closed }
  })())
  surfacePlan.createPartitionPlanTask = surfacePlan.createPartitionTask
  try {
    const order = []
    const longPartition = send({type: 'partition', maximumBytes: 8 * 1024 * 1024, resourceId: 1, cells: []})
      .then(result => { order.push('partition'); assert.deepStrictEqual(result, ['complete']) })
    const terrain = send(Object.assign({type: 'step', threshold: 1, budget: {}, residentIds: []}, view))
      .then(() => order.push('terrain'))
    const advance = send(Object.assign({type: 'advance', threshold: 1, budget: {}}, view))
      .then(result => { assert.strictEqual(result.frame, undefined); order.push('advance') })
    const images = planUntilDone(Object.assign({type: 'imagery', sequence: 1,
      imagery: Object.assign({}, imagery, {maximumTextures: 256})}, view, {viewRevision: 2}))
      .then(result => { assert(!result.superseded); order.push('imagery') })
    await Promise.all([longPartition, terrain, images, advance])
    assert(order.indexOf('terrain') < order.indexOf('partition'), 'Terrain waited for a whole partition task')
    assert(order.indexOf('imagery') < order.indexOf('partition'), 'Imagery waited for a whole partition task')
    assert(order.indexOf('advance') < order.indexOf('partition'), 'Model advancement waited for a whole partition task')
    onProgress = message => {
      scope.onmessage({data: {type: 'cancel-partition', id: message.id}})
    }
    const cancelled = await send({type: 'partition', maximumBytes: 8 * 1024 * 1024, resourceId: 1, cells: []})
    assert.strictEqual(cancelled.superseded, true, 'Cancellation published an empty partition as ready')
    assert.strictEqual(closed, 2, 'Cancellation retained a suspended partition iterator')
    let manifestReload
    onProgress = () => {
      onProgress = null
      manifestReload = send({type: 'call', recordCreditBytes: 0, method: 'loadManifest', args: [{radius: 6378000}]})
    }
    const obsolete = await send({type: 'partition', maximumBytes: 8 * 1024 * 1024, resourceId: 1, cells: []})
    await manifestReload
    assert.strictEqual(obsolete.superseded, true, 'A dataset replacement resumed old partition work')
    assert.strictEqual(closed, 3)
    assert.strictEqual(responses.size, 0)
    await send(Object.assign({type: 'step', threshold: 1, budget: {}, residentIds: []}, view))
    const planOrder = []
    const costPlan = send({type: 'partition-plan', resourceId: 1, cells: []})
      .then(value => { assert.deepStrictEqual(value, ['complete']); planOrder.push('plan') })
    const planReceipt = send({type: 'present', sequence: 1}).then(() => planOrder.push('receipt'))
    await Promise.all([costPlan, planReceipt])
    assert.deepStrictEqual(planOrder, ['receipt', 'plan'], 'Cost planning blocked display receipts')
    onProgress = message => scope.onmessage({data: {type: 'cancel-partition', id: message.id}})
    assert.strictEqual((await send({type: 'partition-plan', resourceId: 1, cells: []})).superseded, true)
    assert.strictEqual(closed, 5, 'Cost cancellation retained its suspended iterator')
    onProgress = () => {
      onProgress = null
      manifestReload = send({type: 'call', recordCreditBytes: 0, method: 'loadManifest', args: [{radius: 6378000}]})
    }
    assert.strictEqual((await send({type: 'partition-plan', resourceId: 1, cells: []})).superseded, true)
    await manifestReload
    assert.strictEqual(closed, 6, 'Dataset replacement retained cost planning')
    assert.strictEqual(responses.size, 0)
  } finally {
    surfacePlan.createPartitionTask = createPartitionTask
    surfacePlan.createPartitionPlanTask = createPartitionPlanTask
    onProgress = null
  }
  planning = 0
  const host = new TerrainWorkerHost({ abi })
  async function planHost(message) {
    for (let i = 0; i < 100; ++i) {
      const result = await handle(host, message)
      if (!result.pending && !result.continuation) return result
    }
    throw new Error('Host fixture planning did not finish')
  }
  await assert.rejects(handle(host, {type: 'initialize'}), /protocol mismatch/)
  await assert.rejects(handle(host, {type: 'initialize', protocol: 'terra.worker.v2'}), /protocol mismatch/)
  await assert.rejects(handle(host, {type: 'initialize', protocol: 'terra.worker.v3'}), /protocol mismatch/)
  await assert.rejects(handle(host, {type: 'initialize', protocol: 'terra.worker.v4'}), /protocol mismatch/)
  await assert.rejects(handle(host, {type: 'initialize', protocol: 'terra.worker.v10'}), /protocol mismatch/)
  assert.strictEqual(host.abi, null, 'Protocol mismatch allocated a native owner')
  await handle(host, { type: 'initialize', protocol: WORKER_PROTOCOL })
  await handle(host, {type: 'call', recordCreditBytes: 0, method: 'loadManifest', args: [{radius: 6378000}]})
  await handle(host, Object.assign({ type: 'step', threshold: 1, budget: {}, residentIds: [], imagery }, view))
  await planHost(Object.assign({type: 'imagery', sequence: 1, imagery}, view))
  assert(host.imageryMeasurements.size > 0)
  const measured = host.imageryMeasurements
  measured.forEach(value => {
    assert(!('model' in value), 'Projection measurement retained the complete terrain model')
    assert(value.bounds && value.hull, 'Model-free measurement lost its coverage envelope')
  })
  const beginCount = begun
  await planHost(Object.assign({ type: 'imagery', sequence: 1,
    imagery: Object.assign({}, imagery, { admissionRevision: 1 }) }, view))
  assert.strictEqual(host.imageryMeasurements, measured, 'Resource admission invalidated unchanged screen measurements')
  assert.strictEqual(begun, beginCount, 'Resource admission recopied unchanged native demand')
  host.publishedMeasurements.clear()
  assert.strictEqual(host.exportMeasurements(measured).length, measured.size)
  assert.strictEqual(host.exportMeasurements(measured).length, 0,
    'An unchanged continuation retransferred its projective regions')
  const revised = new Map(measured)
  revised.set(1, Object.assign({}, measured.get(1), {pixelsPerUv: 2048}))
  assert.deepStrictEqual(host.exportMeasurements(revised).map(value => value.resourceId), [1],
    'A changed measurement was omitted from the Worker delta')
  await handle(host, { type: 'discard', sequence: 1 })
  assert.strictEqual(host.imageryMeasurements, null, 'Discarded imagery planning retained mesh resources')
  assert.strictEqual(host.imagerySourceDraws, null)
  assert.strictEqual(await handle(host, {type: 'partition', maximumBytes: 8 * 1024 * 1024, resourceId: 99, cells: []}), null,
    'Retired Worker resources must allow partitioning the retained renderer model')
  const restored = measured.get(1)
  planning = 0
  await handle(host, Object.assign({ type: 'step', threshold: 1, budget: {}, residentIds: [], imagery }, view))
  await planHost(Object.assign({type: 'imagery', sequence: 1, imagery}, view))
  assert.strictEqual(host.imageryMeasurements.get(1).regions, restored.regions,
    'Returning to an exact cached view remeasured immutable geometry')
  await handle(host, { type: 'present', sequence: 1 })
  let batches = 0, receipts = 0
  abi.getUpdateState = () => ({ modelRevision: 1, budgetExhausted: ++batches < 5 })
  abi.presentFrame = () => { ++receipts }
  await handle(host, Object.assign({ type: 'step', threshold: 1, budget: {}, residentIds: [1], imagery }, view))
  assert.strictEqual(batches, 1, 'One terrain RPC must return after its bounded selection')
  assert.strictEqual(receipts, 0, 'Background continuation falsely acknowledged GPU presentation')
  await handle(host, {type: 'present', sequence: 1})
  while (batches < 5) {
    await handle(host, Object.assign({type: 'step', threshold: 1, budget: {}, residentIds: [1], imagery}, view))
    await handle(host, {type: 'present', sequence: 1})
  }
  const retainedMeasurement = host.imageryMeasurements.get(1)
  abi.getUpdateState = () => ({modelRevision: 2, budgetExhausted: false})
  await handle(host, Object.assign({type: 'step', threshold: 1, budget: {}, residentIds: [1], imagery}, view))
  assert.strictEqual(host.imageryMeasurements.get(1), retainedMeasurement,
    'Refinement elsewhere invalidated an unchanged mesh screen measurement')
  let absentCalls = 0
  abi.noDataRecord = () => { ++absentCalls }
  await handle(host, {type: 'call', method: 'noDataRecord', args: [{}]})
  assert.strictEqual(absentCalls, 1, 'Confirmed missing detail must reach the native owner')
  await handle(host, {type: 'present', sequence: 1})
  host.clearPlanning()
  host.measurementHistory.clear()
  const clock = Date.now, measure = surfacePlan.surfaceMeasurements
  let ticks = 0, visits = 0, pending = 0
  const projectionMatrices = []
  try {
    Date.now = () => ++ticks
    surfacePlan.surfaceMeasurements = function* (...args) {
      if (!args[3]) {
        projectionMatrices.push(args[2].matrix[0])
        for (let i = 0; i < 50; ++i) { ++visits; yield }
      }
      return yield* measure(...args)
    }
    let plan
    const snapshot = {projectionView: new Float64Array([2,0,0,0,0,2,0,0,0,0,1,0,0,0,0,1]),
      cameraPosition: [0,0,2]}
    let latestView = Object.assign({}, view, {snapshot})
    do {
      plan = await handle(host, Object.assign({type: 'imagery', sequence: 1, imagery}, latestView))
      if (plan.pending || plan.continuation) {
        ++pending
        ticks += 200 // Time waiting between RPCs must not retire pure-pan work.
        latestView = Object.assign({}, view, {viewRevision: pending + 1,
          camera: {longitudeDegrees: pending, latitudeDegrees: 0}})
        host.latestViewRevision = latestView.viewRevision
        abi.getUpdateState = () => ({modelRevision: pending + 2})
        await handle(host, Object.assign({type: 'step', threshold: 1, budget: {}, residentIds: [1]}, latestView))
        await handle(host, {type: 'present', sequence: 1})
        host.discardFailedStep()
        await handle(host, {type: 'call', recordCreditBytes: 0, method: 'submitRecord', args: []})
      }
      assert(pending < 100, 'Measurement continuation restarted instead of retaining progress')
    } while (plan.pending || plan.continuation)
    assert(pending > 2, 'A long near-surface measurement must return between time slices')
    assert.strictEqual(visits, 50, 'Continuation repeated already measured work')
    assert(plan.cameraPlanAgeMs > 1000, 'The pan fixture must outlive the former age cutoff')
    assert.strictEqual(plan.viewRevision, view.viewRevision)
    assert.deepStrictEqual(projectionMatrices, [2],
      'Imagery used the old terrain camera or restarted its snapshot after movement')
    assert.strictEqual(host.imageryJob, null, 'Completed snapshot retained an extra terrain cut')
  } finally { Date.now = clock; surfacePlan.surfaceMeasurements = measure }
  host.latestViewRevision = view.viewRevision
  let priorities = 0
  abi.getUpdateState = () => ({modelRevision: 2, pendingPriorityUpdateCount: Math.max(0, 40 - ++priorities)})
  let publications = 0
  while (priorities < 40) {
    const packet = await handle(host, Object.assign({type: 'step', threshold: 1, budget: {}, residentIds: [1]}, view))
    await handle(host, {type: 'present', sequence: packet.frame.sequence})
    ++publications
    assert(publications < 45, 'Incomplete priorities prevented subsequent terrain advancement')
  }
  assert(publications > 1, 'The priority fixture must span more than one publication')
  const streaming = new TerrainWorkerHost({abi: Object.assign({}, abi, {
    getUpdateState: () => ({modelRevision: 1}),
    getMeshResources: () => Array.from({length: 8}, (_, i) => ({resourceId: i + 1, vertexCount: 3,
      flags: 0, firstIndex: 0, indexCount: 3, origin: [0,0,0],
      textureNode: {level: 1, root: Math.floor(i/2), row: 0, column: i}, texture: {level: 2, matrix: 2, row: 0, column: i}}))
  })})
  await handle(streaming, {type: 'initialize', protocol: WORKER_PROTOCOL})
  await handle(streaming, {type: 'call', recordCreditBytes: 0, method: 'loadManifest', args: [{radius: 6378000}]})
  await handle(streaming, Object.assign({type: 'step', threshold: 1, budget: {}, residentIds: []}, view))
  const realClock = Date.now
  try {
    let now = 0, preview
    Date.now = () => ++now
    for (let i = 0; i < 30; ++i) {
      preview = await handle(streaming, Object.assign({type: 'imagery', sequence: 1,
        imagery: Object.assign({}, imagery, {maximumTextures: 3,
          descriptor: Object.assign({}, imagery.descriptor, {maximum_level: 0, tile_size: 1})})}, view))
      if (preview.imageryPlan && preview.imageryPlan.quality.measurementPending) break
    }
    assert(preview.continuation, 'Measured regions waited for the whole view before publishing demand')
    assert(streaming.measurementJob && streaming.measurementJob.measured.size < 8)
    assert(preview.imageryPlan.draws.length > 0)
    assert(preview.imageryPlan.draws.every(draw => !draw.imageryClipCell &&
      draw.texture.level <= draw.sourceTexture.level), 'Measurement preview required new terrain partitions')
    assert(preview.imageryPlan.draws.every(draw => draw.texture.level === 0),
      'Measurement preview requested imagery beyond the source maximum level')
    assert(new Set(preview.imageryPlan.draws.map(draw => JSON.stringify(draw.texture))).size <= 3)
  } finally { Date.now = realClock; streaming.clearPlanning() }
  let cutRevision = 1, retiredGenerator = false, retiredModel
  const target = id => ({resourceId:id,vertexCount:3,flags:0,firstIndex:0,indexCount:3,
    origin:[0,0,0],textureNode:{level:0,root:0,row:0,column:0},texture:{level:1,matrix:1,row:0,column:0}})
  const retiring = new TerrainWorkerHost({abi:Object.assign({},abi,{
    getUpdateState:()=>({modelRevision:cutRevision}),
    getMeshResources:()=>cutRevision===1 ? [target(1)] :
      [Object.assign(target(1),{flags:1}),target(cutRevision)],
    planImageryAsync:async draws=>({draws,levels:new Set(),quality:{planningComplete:true}})
  })})
  await handle(retiring, {type:'initialize', protocol:WORKER_PROTOCOL})
  await handle(retiring, {type:'call',recordCreditBytes: 0, method: 'loadManifest',args:[{radius:6378000}]})
  await handle(retiring, Object.assign({type:'step',threshold:1,budget:{},residentIds:[]},view))
  retiredModel=retiring.frames.resources.get(1).model
  try {
    let now=0
    Date.now=()=>++now
    surfacePlan.surfaceMeasurements=function* (...args) {
      if (args[3]) return yield* measure(...args)
      try {
        for(let i=0;i<20;++i) yield
        return Object.assign(yield* measure(...args),{pixelsPerUv:args[0]===retiredModel?1234:5678})
      } finally {if(args[0]===retiredModel)retiredGenerator=true}
    }
    const request=Object.assign({type:'imagery',sequence:1,imagery},view)
    while(!retiring.measurementJob || !retiring.measurementJob.work) await handle(retiring, request)
    await handle(retiring, {type:'present',sequence:1})
    cutRevision=2
    await handle(retiring, Object.assign({type:'step',threshold:1,budget:{},residentIds:[]},view))
    let completed
    for(let i=0;i<100;++i) {
      completed=await handle(retiring, request)
      if(!completed.pending&&!completed.continuation)break
      await handle(retiring, {type:'present',sequence:1})
      ++cutRevision
      await handle(retiring, Object.assign({type:'step',threshold:1,budget:{},residentIds:[]},view))
    }
    assert(!completed.pending && !completed.continuation,
      'Continuous terrain publication starved an immutable imagery snapshot')
    assert.strictEqual(completed.modelRevision,1,'A completed snapshot was labeled as the current terrain')
    assert(cutRevision>2,'The fixture must replace terrain during multiple measurement slices')
    assert(retiring.frames.resources.has(1),'The retired target must remain resident as coverage')
    assert(retiredGenerator,'The completed old measurement kept its generator')
    assert.strictEqual(retiring.imageryMeasurements.get(1).pixelsPerUv,1234)
    assert.strictEqual(retiring.imageryJob,null,'A completed snapshot retained its old meshes')
    for(let i=0;i<100;++i) {
      completed=await handle(retiring, request)
      if(!completed.pending&&!completed.continuation)break
    }
    assert(!completed.pending && !completed.continuation)
    assert.strictEqual(completed.modelRevision,cutRevision,'The next snapshot failed to adopt current terrain')
    assert.strictEqual(retiring.imageryMeasurements.get(cutRevision).pixelsPerUv,5678,
      'A retained coverage resource attributed its measurement to a new target')
  } finally {Date.now=realClock;surfacePlan.surfaceMeasurements=measure;retiring.clearPlanning()}
  surfacePlan.surfaceMeasurements = productionMeasurements
  const nativeContinuations = []
  const refining = new TerrainWorkerHost({abi: Object.assign({}, abi, {
    getUpdateState: () => ({modelRevision: 1}),
    async planImageryAsync(draws, measure, options) {
      nativeContinuations.push(options.continuation)
      return {draws, levels: new Set(), quality: {planningComplete: nativeContinuations.length >= 3}}
    }
  })})
  await handle(refining, {type: 'initialize', protocol: WORKER_PROTOCOL})
  await handle(refining, {type: 'call', recordCreditBytes: 0, method: 'loadManifest', args: [{radius: 6378000}]})
  await handle(refining, Object.assign({type: 'step', threshold: 1, budget: {}, residentIds: []}, view))
  let refined
  for (let i = 0; i < 100; ++i) {
    refined = await handle(refining, Object.assign({}, view, {type: 'imagery', sequence: 1, imagery,
      viewRevision: i + 1, camera: {longitudeDegrees: i, latitudeDegrees: 0}}))
    if (refined.imageryPlan && refined.imageryPlan.quality.planningComplete === false) {
      assert(refined.continuation && refining.imageryJob,
        'An unfinished Native round retired the persistent camera snapshot')
    }
    if (!refined.pending && !refined.continuation) break
  }
  assert(refined.imageryPlan.quality.planningComplete, 'Native refinement never completed during pan')
  assert.deepStrictEqual(nativeContinuations, [false, true, true],
    'Pointer movement restarted Native demand between refinement rounds')
  assert.strictEqual(refined.viewRevision, view.viewRevision)
  assert.strictEqual(refining.imageryJob, null)
  const zoom = new TerrainWorkerHost({abi: Object.assign({}, abi, {
    getUpdateState: () => ({modelRevision:1}),
    planImageryAsync: async draws => ({draws,levels:new Set(),quality:{planningComplete:true}})
  })})
  await handle(zoom, {type:'initialize', protocol:WORKER_PROTOCOL})
  await handle(zoom, {type:'call',recordCreditBytes: 0, method: 'loadManifest',args:[{radius:6378000}]})
  zoom.manifest = {radius:6371000}
  await handle(zoom, Object.assign({type:'step',threshold:1,budget:{},residentIds:[]},view))
  const precise = surfacePlan.surfaceMeasurements, clockBeforeZoom = Date.now
  try {
    let now = 0, obsoleteVisits = 0, coarseVisits = 0
    Date.now = () => ++now
    surfacePlan.surfaceMeasurements = function* (...args) {
      if (!args[3] && args[2].matrix[0] === 2) {
        for (let i=0;i<50;++i) { ++obsoleteVisits; yield }
      }
      if (!args[3] && args[2].matrix[0] === 0.00001) {
        for (let i=0;i<50;++i) { ++coarseVisits; yield }
      }
      const measured = yield* precise(...args)
      // Force an inconclusive conservative bound so this fixture exercises the
      // persistent exact generator even for its tiny global-view triangle.
      if (args[3] && [2, 0.00001].includes(args[2].matrix[0])) measured.pixelsPerUv = Infinity
      return measured
    }
    const request = (revision,range,scale) => Object.assign({},view,{
      type:'imagery',sequence:1,imagery,viewRevision:revision,
      camera:{distance:range,longitudeDegrees:0,latitudeDegrees:0},
      snapshot:{projectionView:new Float64Array([scale,0,0,0,0,scale,0,0,0,0,1,0,0,0,0,1]),
        cameraPosition:[0,0,range]}})
    await handle(zoom, request(1,100,2))
    await handle(zoom, request(1,100,2))
    assert(obsoleteVisits>0 && obsoleteVisits<50)
    const beforeZoom = obsoleteVisits
    zoom.latestViewRevision=2
    zoom.latestView=Object.assign(request(2,1e8,0.00001),{type:'view',revision:2})
    const global = await handle(zoom, request(1,100,2))
    assert.strictEqual(global.viewRevision,2,'Global coverage waited for obsolete near-ground work')
    assert(global.continuation && global.imageryPlan.quality.coarsening)
    assert.strictEqual(obsoleteVisits,beforeZoom,'Scale change continued obsolete triangle measurement')
    assert(global.measurements.every(m=>m.pixelsPerUv===Infinity),'New coverage used the old projection')
    await handle(zoom, {type:'present',sequence:1})
    zoom.abi.getUpdateState = () => ({modelRevision:2})
    zoom.abi.getMeshResources = () => abi.getMeshResources().map(draw => Object.assign({},draw,{resourceId:99}))
    await handle(zoom, Object.assign(request(2,1e8,0.00001), {type:'step',threshold:1,budget:{},residentIds:[],
      camera:{distance:1e8,longitudeDegrees:0,latitudeDegrees:0}}))
    await handle(zoom, {type:'present',sequence:1})
    await handle(zoom, request(2,1e8,0.00001))
    assert(coarseVisits>0 && coarseVisits<50, 'The coarse fixture must have unfinished exact work')
    assert(!zoom.frames.resources.has(1))
    assert(zoom.imageryJob.result.resources.has(1) && zoom.measurementJob.meshIdentity==='1' &&
      zoom.imageryJob.result.updateState.modelRevision===1,
      'Coarsening chased replacement models and reset its persistent measurement batch')
    let finished
    for (let i=0;i<100;++i) {
      finished=await handle(zoom, request(2,1e8,0.00001))
      if (!finished.pending && !finished.continuation) break
    }
    assert(finished.imageryPlan.quality.planningComplete)
    assert.strictEqual(zoom.imageryJob,null)
    const currentCut=await handle(zoom, request(2,1e8,0.00001))
    assert(currentCut.imageryPlan.quality.coarsening,
      'Finishing an older mesh lost coarse intent before measuring the current cut')
    assert.strictEqual(zoom.imageryJob.result.updateState.modelRevision,2)
    zoom.latestViewRevision=3
    zoom.latestView=Object.assign(request(3,2.5e8,0.000004),{type:'view',revision:3})
    await handle(zoom, request(3,2.5e8,0.000004))
    now += 170
    const tail = await handle(zoom, request(3,2.5e8,0.000004))
    assert.strictEqual(tail.viewRevision,3,'A stopped 2.5x zoom tail retained the obsolete camera epoch')
    assert(tail.imageryPlan.quality.coarsening)
    assert(tail.measurements.every(m=>m.pixelsPerUv<global.measurements[0].pixelsPerUv),
      'Tail coarsening retained obsolete screen-space measurements')
    zoom.latestViewRevision=4
    zoom.latestView=Object.assign(request(4,100,2),{type:'view',revision:4})
    const reversed = await handle(zoom, request(4,100,2))
    assert.strictEqual(reversed.viewRevision,4,'A zoom reversal completed the wrong camera epoch')
    assert.strictEqual(reversed.imageryPlan.quality.coarsening,false)
  } finally {Date.now=clockBeforeZoom;surfacePlan.surfaceMeasurements=precise;zoom.clearPlanning()}
  const economical = new TerrainWorkerHost({abi: Object.assign({}, abi, {
    getMeshResources:()=>[target(1),target(2),target(3)],
    planImageryAsync: async (draws,measureDraw) => ({draws:draws.map(draw=>{
      if(draw.resourceId===3 && budgetLimit && exactVisits<2) unchanged=measureDraw(draw)
      return Object.assign({},draw,
        {imageryPixelError:draw.resourceId===1 && (genuineLimit || (budgetLimit||levelLimit)&&exactVisits<2)?2:0.1})}),
      levels:new Set(),quality:{planningComplete:true,targetPixelError:1.25,spatialCut:true,coverageGuaranteed:true,
      limitedByBudget: genuineLimit || budgetLimit && exactVisits<2, limitedByLevel: levelLimit && exactVisits<2,
      meetsTarget: !genuineLimit && (!(budgetLimit || levelLimit) || exactVisits>=2)}})
  })})
  let exactVisits = 0, budgetLimit = false, levelLimit = false, genuineLimit = false, unchanged, preciseVisits = 0
  await handle(economical, {type:'initialize', protocol:WORKER_PROTOCOL})
  await handle(economical, {type:'call',recordCreditBytes: 0, method: 'loadManifest',args:[{radius:6378000}]})
  await handle(economical, Object.assign({type:'step',threshold:1,budget:{},residentIds:[]},view))
  economical.imageryScale = 1
  const {TerraWebGlRenderer} = require('../../adapters/webgl/terra_webgl_renderer')
  const policy = Object.create(TerraWebGlRenderer.prototype)
  let planningChanges = 0
  Object.assign(policy, {mode:'texture',current:{},cameraVersion:1,interactionActive:true,
    options:{onImageryPlanningChange:() => {++planningChanges}},
    textures:{targetCapacity:() => 64},sourceUvScale:() => 1,requestRender(){}})
  const coarseRequest = revision => Object.assign({},view,{type:'imagery',sequence:1,
    imagery:{...imagery,refineBounds:policy.imageryPlanningOptions().refineBounds},
    viewRevision:revision,camera:{distance:1e8*revision},
    snapshot:{projectionView:new Float64Array([0.00001/revision,0,0,0,0,0.00001/revision,0,0,0,0,1,0,0,0,0,1]),
      cameraPosition:[0,0,1e8]}})
  const preciseModel=economical.frames.resources.get(3).model
  surfacePlan.surfaceMeasurements = function* (...args) {
    // A domain subset borrows its immutable owner's getters through a prototype
    // overlay. Attribute that work to the same mesh, not an unrelated resource.
    const preciseOwner=args[0]===preciseModel || Object.getPrototypeOf(args[0])===preciseModel
    if (!args[3]) {if(preciseOwner)++preciseVisits;else ++exactVisits}
    const measured=yield* precise(...args)
    // Even a finite bound larger than source-tile SSE may drive a finer Native
    // target; conservative budget/level limits must trigger the exact fallback.
    if (args[3]) measured.pixelsPerUv=preciseOwner?Infinity:500
    return measured
  }
  try {
    const continuations=[]
    const finish = async request => {
      for (let i=0;i<100;++i) {
        const plan=await handle(economical, request)
        if (plan.imageryPlan && plan.imageryPlan.quality.demandReady && plan.continuation) continuations.push(plan)
        if (!plan.pending && !plan.continuation) return plan
      }
      throw new Error('Conservative measurement fixture did not converge')
    }
    const safe=await finish(coarseRequest(1))
    assert(safe.imageryPlan.quality.planningComplete && safe.imageryPlan.quality.meetsTarget)
    assert.strictEqual(exactVisits,0,'SSE-safe upper bounds rescanned oversampled triangles')
    assert.strictEqual(preciseVisits,1,'An infinite near-plane bound skipped exact clipping')
    assert.strictEqual(safe.imageryPlan.quality.refinableMeasurementCount,3)
    policy.setInteractionActive(false)
    assert.strictEqual(planningChanges,1,'Stopping interaction did not schedule final demand measurement')
    const economicalSafe=await finish(coarseRequest(1))
    assert(economicalSafe.imageryPlan.quality.meetsTarget && exactVisits>0,
      'A stationary passing cut depended on memory pressure to normalize its demand')
    assert.strictEqual(economicalSafe.imageryPlan.quality.refinableMeasurementCount,0)
    assert.strictEqual(preciseVisits,2,'Shared pressure did not tighten the remaining shallow bound exactly once')
    const tightenedVisits=exactVisits
    await finish({...coarseRequest(1),imagery:{...imagery,refineBounds:true}})
    assert.strictEqual(exactVisits,tightenedVisits,'Repeated pressure rescanned tightened measurements')
    assert.strictEqual(preciseVisits,2)
    policy.setInteractionActive(true)
    exactVisits=0
    budgetLimit=true
    continuations.length=0
    const fitted=await finish(coarseRequest(2))
    assert(continuations.some(value=>!value.candidateReady && !value.imageryPlan.quality.planningComplete &&
      value.measurements.length===3),
    'Published terrain waited for all exact measurements before exposing its complete fitted continuation')
    assert(exactVisits>0,'Conservative capacity limits did not trigger exact measurement')
    assert.strictEqual(exactVisits,2,'Shared quota was accepted without verifying a nonfailing overestimate')
    assert.strictEqual(economical.imageryMeasurements.get(3),unchanged,
      'Budget fallback discarded an already exact measurement')
    assert(fitted.imageryPlan.quality.meetsTarget && !fitted.imageryPlan.quality.limitedByBudget,
      'An overestimated upper bound was reported as final precision limitation')
    budgetLimit=false; levelLimit=true; exactVisits=0
    const levelFitted=await finish(coarseRequest(3))
    assert(exactVisits>0 && levelFitted.imageryPlan.quality.meetsTarget &&
      !levelFitted.imageryPlan.quality.limitedByLevel,
      'A conservative level limit was reported before exact clipping')
    levelLimit=false; genuineLimit=true; exactVisits=0
    const limited=await finish(coarseRequest(4))
    assert(limited.imageryPlan.quality.planningComplete && limited.imageryPlan.quality.limitedByBudget &&
      !limited.imageryPlan.quality.meetsTarget,'Genuine capacity limits must remain visible')
    assert.strictEqual(exactVisits,4,'A genuine limit must finish both measurement tiers exactly once')
    assert.strictEqual(economical.coarseningRevision,4,
      'Completing one mesh cut lost coarse intent before later terrain batches')
    const pan=await handle(economical, Object.assign(coarseRequest(5),{
      camera:coarseRequest(4).camera,snapshot:coarseRequest(4).snapshot}))
    if (pan.imageryPlan) assert(!pan.imageryPlan.quality.coarsening,'Pure pan inherited a completed coarse epoch')
    assert.strictEqual(economical.coarseningRevision,null)
  } finally {surfacePlan.surfaceMeasurements=precise;economical.clearPlanning()}
  let backgroundRounds=0, queued=false, yields=0
  const autonomous=new TerrainWorkerHost({abi:Object.assign({},abi,{
    getUpdateState:()=>({modelRevision:1}),getMeshResources:()=>[target(1)],
    planImageryAsync:async draws=>({draws,levels:new Set(),
      quality:{planningComplete:++backgroundRounds>=40, meetsTarget:backgroundRounds>=40}})
  })})
  await handle(autonomous, {type:'initialize', protocol:WORKER_PROTOCOL})
  await handle(autonomous, {type:'call',recordCreditBytes: 0, method: 'loadManifest',args:[{radius:6378000}]})
  await handle(autonomous, Object.assign({type:'step',threshold:1,budget:{},residentIds:[]},view))
  autonomous.yieldWork=async()=>{++yields;return !queued || autonomous.imageryJob.coarsening}
  try {
    let now=0
    Date.now=()=>++now
    const request=Object.assign({type:'imagery',sequence:1,imagery},view)
    const first=await handle(autonomous, request)
    assert(first.continuation && first.imageryPlan.quality.measurementPending,
      'Background batching delayed the first usable coverage demand')
    assert.strictEqual(backgroundRounds,0)
    await handle(autonomous, request)
    assert(backgroundRounds>1 && backgroundRounds<40,
      'Each background slice still required a main-thread render/RPC round trip')
    queued=true
    let before=backgroundRounds, yieldedBefore=yields
    await handle(autonomous, request)
    assert(backgroundRounds-before<=1 && yields-yieldedBefore<=1,
      'Background batching ignored queued terrain/partition work')
    autonomous.imageryJob.coarsening=true
    before=backgroundRounds
    const unfinishedCoarse=await handle(autonomous, request)
    assert(unfinishedCoarse.pending && !unfinishedCoarse.imageryPlan,
      'An unfinished coarse root cut replaced useful measurement demand')
    assert(backgroundRounds-before>1 && backgroundRounds<40,
      'Same-view terrain polling starved the bounded coarse turn')
    queued=false
    autonomous.latestViewRevision=view.viewRevision+1
    before=backgroundRounds
    await handle(autonomous, request)
    assert(backgroundRounds-before<=1,'A new camera waited for the whole background batch')
    autonomous.latestViewRevision=view.viewRevision
    let complete
    for(let i=0;i<100;++i){
      complete=await handle(autonomous, request)
      if(!complete.pending&&!complete.continuation)break
    }
    assert(complete.imageryPlan.quality.planningComplete && backgroundRounds===40)
  } finally {Date.now=clockBeforeZoom;autonomous.clearPlanning()}
  // One RPC must make progress to completion without main-thread polling.
  const { TerrainWorkerClient } = require('../../adapters/wasm/terra_worker_client')
  let streamRounds = 0, targetRounds = 60, progressCount = 0, dataAt = null
  const streamAbi = Object.assign({}, abi, {
    getUpdateState: () => ({modelRevision: 1}), getMeshResources: () => [target(1)],
    submitRecord() { dataAt = streamRounds },
    async planImageryAsync(draws) {
      return {draws, levels: new Set(), quality: {
        planningComplete: ++streamRounds >= targetRounds, meetsTarget: streamRounds >= targetRounds}}
    }
  })
  const ports = new Set()
  let channelCount = 0
  class ObservedChannel {
    constructor() {
      ++channelCount
      const channel = new (require('worker_threads').MessageChannel)()
      for (const name of ['port1', 'port2']) {
        const port = this[name] = channel[name], close = port.close.bind(port)
        ports.add(port)
        port.close = () => { ports.delete(port); close() }
      }
    }
  }
  let measurementPackets = 0, ownershipPackets = 0, lastMeasurementBytes = null
  const streamScope = {MessageChannel: ObservedChannel,
    postMessage: (message, transfer) => {
      if (message.type === 'native-ownership') ++ownershipPackets
      if (message.value && message.value.measurements) {
        ++measurementPackets
        const buffers=message.value.measurements.buffers
        lastMeasurementBytes = buffers.reduce((n,data)=>n+data.byteLength,0)
        assert(buffers.every(data=>data instanceof Uint8Array))
        assert.strictEqual(lastMeasurementBytes % 176,0,'Installed Worker sent a partial canonical row')
        assert(buffers.every(data=>transfer.includes(data.buffer)), 'Installed Worker cloned its region buffer')
      }
      streamWorker.onmessage({data: message})
    }}
  const streamWorker = {postMessage: message => streamScope.onmessage({data: message}), terminate() {}}
  install(streamScope, {abi: streamAbi})
  const client = new TerrainWorkerClient(streamWorker, {})
  const streamLedger=new ResourceLedger(),snapshots=[]
  client.setResourceLedger(streamLedger)
  try {
    await client.send({type: 'initialize', protocol: WORKER_PROTOCOL})
    await client.send({type: 'call',recordCreditBytes: 0, method: 'loadManifest',args: [{radius:6378000}]})
    await publish(message => client.send(message), Object.assign({type: 'step', threshold: 1, budget: {}, residentIds: []}, view), client.indexBudget)
    const request = Object.assign({type: 'imagery', sequence: 1, imagery, stream: true}, view)
    let control
    const result = await client.send(request, [], () => {
      if (++progressCount === 1) control = client.send({type: 'call', recordCreditBytes: 0, method: 'submitRecord', args: []})
    })
    snapshots.push(result.measurements)
    await control
    assert(result.imageryPlan.quality.planningComplete && streamRounds === 60)
    assert(measurementPackets > 0 && Array.isArray(result.measurements),
      'Installed Worker/client did not use the numeric measurement transport')
    const repeated = await client.send(request)
    snapshots.push(repeated.measurements)
    assert.deepStrictEqual(repeated.measurements, result.measurements)
    assert.strictEqual(lastMeasurementBytes, 0, 'Completed immutable snapshot retransmitted projection regions')
    repeated.measurements.forEach((value, i) => assert.strictEqual(value.regions, result.measurements[i].regions))
    assert(progressCount > 1 && dataAt < 60, 'Streaming monopolized Worker data/control processing')
    const completed = streamRounds
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.strictEqual(streamRounds, completed, 'Completed stream kept computing while idle')
    assert(channelCount > 0, 'Worker ignored the available task dispatcher')
    assert.strictEqual(ports.size, 0, 'Idle Worker retained dispatch ports')
    targetRounds = 10000
    const cancelled = await client.send(Object.assign({}, request, {
      imagery: Object.assign({}, imagery, {maximumTextures: 96})}), [], () => client.cancelImagery())
    assert.strictEqual(cancelled.superseded, true)
    const stopped = streamRounds
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.strictEqual(streamRounds, stopped, 'Cancelled stream kept running after pause')
    assert.strictEqual(client.pending.size, 0)
    assert(ownershipPackets > 0, 'Idle cancellation omitted its Native ownership report')
    assert.strictEqual(ports.size, 0, 'Cancelled stream retained dispatch ports')
    // An obsolete visibility reply ends its RPC, but its projection iterator
    // belongs to the next compatible demand. A pause must still release it.
    await client.send({type:'call',recordCreditBytes: 0, method: 'loadManifest',args:[{radius:6378000}]})
    await publish(message=>client.send(message),Object.assign({type:'step',threshold:1,budget:{},residentIds:[]},view),client.indexBudget)
    const beforeMeasurements=surfacePlan.surfaceMeasurements, beforeClock=Date.now
    let projectionStarts=0, projectionAborts=0, clock=beforeClock()
    surfacePlan.surfaceMeasurements=function* (...args) {
      ++projectionStarts
      let finished=false
      try {
        for(let i=0;i<20;++i)yield
        const value=yield* beforeMeasurements(...args);finished=true;return value
      } finally {if(!finished)++projectionAborts}
    }
    Date.now=()=>clock+=5
    const evidence={schema:'terra.terrain-visibility.v2',revision:1,hidden:[]}
    const nextImagery={...imagery,visibility:evidence}
    try {
      const rebased=await client.send(request,[],()=>client.cancelImagery(imagery,nextImagery))
      assert(rebased.superseded && projectionStarts===1 && projectionAborts===0,
        'Visibility stream cancellation discarded suspended projection work')
      const suspended=await client.send({...request,imagery:nextImagery},[],()=>client.suspendImagery())
      assert(suspended.superseded && projectionStarts===1 && projectionAborts===0,
        'Candidate preparation discarded the suspended projection iterator')
      const paused=await client.send({...request,imagery:nextImagery},[],()=>client.cancelImagery())
      assert(paused.superseded && projectionStarts===1 && projectionAborts===1,
        'Pause did not release the retained projection iterator')
      await client.send({type:'call',recordCreditBytes: 0, method: 'loadManifest',args:[{radius:6378000}]})
      await publish(message=>client.send(message),Object.assign({type:'step',threshold:1,budget:{},residentIds:[]},view),client.indexBudget)
      await client.send(request,[],()=>client.cancelImagery(imagery,nextImagery))
      assert.strictEqual(client.pending.size,0)
      client.cancelImagery()
      await new Promise(resolve=>setTimeout(resolve,20))
      assert(projectionStarts===2 && projectionAborts===2,
        'Idle rebased work survived pause because its RPC had already ended')
    } finally {surfacePlan.surfaceMeasurements=beforeMeasurements;Date.now=beforeClock}
    await new Promise(resolve=>setTimeout(resolve,20))
    assert.strictEqual(ports.size,0,'Rebased/paused stream retained dispatcher ports')
    let attempts = 0
    streamAbi.planImageryAsync = async draws => {
      if (++attempts > 1) throw new Error('Injected planning failure')
      return {draws, levels: new Set(), quality: {planningComplete: false}}
    }
    await assert.rejects(client.send(Object.assign({}, request, {
      imagery: Object.assign({}, imagery, {maximumTextures: 128})})), /Injected planning failure/)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.strictEqual(ports.size, 0, 'Failed stream retained dispatch ports')
  } finally {
    for(const snapshot of snapshots)releaseMeasurements(snapshot)
    rawDelivery.stopped();rawReceiver.clear()
    await client.destroy();for (const port of ports) port.close()
  }
  assert.strictEqual(streamLedger.bytes,0,'Worker fixture left an occupied host mirror')
  console.log('Worker checkpoints, receipt priority, and latest-camera contracts passed.')
}
const deadline = setTimeout(() => {console.error('Worker scheduling test did not finish'); process.exit(1)}, 10000)
const productionMeasurements = surfacePlan.surfaceMeasurements
main().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(() => {
  surfacePlan.surfaceMeasurements = productionMeasurements
  clearTimeout(deadline)
})
