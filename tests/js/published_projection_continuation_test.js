const assert = require('assert')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = async function verifyPublishedProjection() {
  const clock = Date.now, measure = surface.surfaceMeasurements
  const ledger = new ResourceLedger(64), host = new TerrainWorkerHost()
  const starts = new Map(), steps = new Map(), freed = [], inputs = [], cancelled = []
  let now = 0
  Date.now = () => now
  surface.surfaceMeasurements = function* (model, origin, context, conservative) {
    if (conservative) return {visible:true, pixelsPerUv:Infinity, regions:[], refinable:false}
    const id = model.id
    starts.set(id, (starts.get(id) || 0) + 1)
    for (let i=0; i<8; ++i) {
      steps.set(id, (steps.get(id) || 0) + 1); now += 5; yield
    }
    return {visible:true, pixelsPerUv:64, regions:[], refinable:false}
  }
  const resources = new Map([1,2,3,4].map(id => [id,
    ownPayload({model:{id, bounds:{}, hull:[]}}, ledger.reserve('fixture-mesh',8),8,()=>freed.push(id))]))
  const snapshot = {projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}
  const packet = (sequence, ids) => ({frame:{sequence,decisionsComplete:true,...snapshot},
    draws:ids.map(resourceId => ({resourceId, origin:[0,0,0], flags:0,
      textureNode:{level:0, root:0, row:0, column:0}})),
    resources:new Map(ids.map(id=>[id,resources.get(id)])),
    meshIdentity:ids.join(','), updateState:{modelRevision:sequence}})
  const view = {revision:1, snapshot, camera:{distance:100}, viewport:{width:400,height:400,fovRadians:1}}
  const imagery = {descriptor:{kind:'global-geodetic', matrix_level_offset:1,
    minimum_level:0, maximum_level:8, tile_size:256, level_zero_columns:2,
    level_zero_rows:1, bounds:[[-180,-90],[180,90]]}, maximumTextures:16, targetPixelError:1.25}
  host.manifest = {radius:6378000}
  host.observeView(view)
  host.abi = {createImageryTask(draws) {
    const ids=draws.map(draw=>draw.resourceId); inputs.push(ids)
    return new CooperativeTask((function* () {
      let finished=false
      try {
        for (let i=0; i<4; ++i) {now+=5;yield}
        finished=true
        return {draws, levels:new Set(), quality:{planningComplete:true, meetsTarget:true, coverageGuaranteed:true}}
      } finally {if(!finished) cancelled.push(ids)}
    })(), 8, () => now)
  }}
  const request = (sequence, planId) => ({...view,type:'imagery',viewRevision:1,sequence,planId,imagery})
  const until = async (message, condition) => {
    for (let i=0;i<100;++i) {const value=await host.handle(message);if(condition(value))return value}
    throw new Error('Published projection fixture failed to progress')
  }
  try {
    host.frames.presented=packet(1,[1,2])
    await until(request(1),()=>steps.get(1)>0)
    const original=host.imageryJob
    // The old frame no longer owns mesh 2. Its active snapshot still does.
    resources.get(2).ownership.retire()
    assert(!freed.includes(2))
    host.frames.presented=packet(2,[1,3])
    for (const pending of ['pendingMeshGroups','pendingPriorityUpdateCount']) {
      host.frames.presented.updateState[pending]=1
      await host.handle(request(2))
      assert.strictEqual(host.imageryJob.result.meshIdentity,'1,2',
        'Unfinished terrain decisions interrupted the progressing cut')
      host.frames.presented.updateState[pending]=0
    }
    await until(request(2),()=>Boolean(host.imageryTask))
    assert.strictEqual(starts.get(1),1,'A surviving mesh restarted its partial projection')
    assert.strictEqual(steps.get(1),8,'A surviving projection repeated already completed slices')
    assert.strictEqual(host.imageryJob,original,'Local topology change replaced the whole projection epoch')
    assert(freed.includes(2),'Removed terrain retained the old whole-cut snapshot loan')
    assert(!starts.has(2),'Removed terrain was still measured')
    assert.deepStrictEqual(inputs,[[1,3]],'Old-cut inputs reached native planning')
    // Global CBDAM revision can change outside this immutable visible cut.
    // Metadata must advance without cancelling this cut's in-flight input.
    const nativeInput=host.imageryTask
    for (let revision=3;revision<=5;++revision) {
      host.frames.presented=packet(revision,[1,3])
      const reply=await host.handle(request(revision))
      assert.strictEqual(host.imageryTask,nativeInput,'A metadata-only publication restarted native imagery input')
      assert.strictEqual(reply.modelRevision,revision,'Retained planning returned obsolete publication metadata')
      assert.strictEqual(host.imageryJob,original)
      assert.deepStrictEqual(inputs,[[1,3]])
      assert.deepStrictEqual(cancelled,[])
    }
    // Retarget during native input. Its cut is obsolete, while the completed
    // projection of shared mesh 1 remains valid for the latest published cut.
    resources.get(3).ownership.retire()
    // A later published cut supersedes the obsolete native input.
    host.frames.presented=packet(6,[1,4])
    const result=await until(request(6),value=>value.imageryPlan && value.imageryPlan.quality.planningComplete)
    assert.deepStrictEqual(cancelled,[[1,3]],'Obsolete native input was retained or resumed')
    assert.deepStrictEqual(result.imageryPlan.draws.map(draw=>draw.resourceId),[1,4])
    assert.strictEqual(starts.get(1),1,'Completed shared projection was recomputed')
    assert.strictEqual(starts.get(3),1)
    assert.strictEqual(starts.get(4),1,'New terrain reused another mesh projection')
    assert(freed.includes(3))
    assert(!freed.includes(1) && !freed.includes(4),'Published refinement released live mesh inputs')
  } finally {
    host.clearPlanning(); host.measurementHistory.clear()
    resources.forEach(resource=>resource.ownership.retire())
    Date.now=clock;surface.surfaceMeasurements=measure
  }
  assert.strictEqual(ledger.bytes,0,'Published retargeting retained mesh ownership')
  console.log('Published terrain keeps shared projection progress, retires obsolete input and fits the latest cut')
}

if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
