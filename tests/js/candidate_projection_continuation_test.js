const assert = require('assert')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = async function verifyCandidateProjection() {
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
  const packet = (sequence, ids) => ({frame:{sequence,...snapshot},
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
    throw new Error('Candidate projection fixture failed to progress')
  }
  try {
    host.frames.presented=packet(1,[1,2])
    await until(request(1),()=>steps.get(1)>0)
    const original=host.imageryJob
    // The old frame no longer owns mesh 2. Its active snapshot still does.
    resources.get(2).ownership.retire()
    assert(!freed.includes(2))
    host.pendingMesh={planId:2,prepared:{surface:packet(2,[1,3])}}
    await until(request(2,2),()=>Boolean(host.imageryTask))
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
      host.pendingMesh={planId:revision,prepared:{surface:packet(revision,[1,3])}}
      const reply=await host.handle(request(revision,revision))
      assert.strictEqual(host.imageryTask,nativeInput,'A metadata-only publication restarted native imagery input')
      assert.strictEqual(reply.modelRevision,revision,'Retained planning returned obsolete publication metadata')
      assert.strictEqual(host.imageryJob,original)
      assert.deepStrictEqual(inputs,[[1,3]])
      assert.deepStrictEqual(cancelled,[])
    }
    // Retarget during native input. Its cut is obsolete, while the completed
    // projection of shared mesh 1 remains valid for the next candidate.
    resources.get(3).ownership.retire()
    // Late group selection changes membership within the SAME candidate ID.
    host.pendingMesh={planId:5,prepared:{surface:packet(5,[1,4])}}
    const result=await until(request(5,5),value=>value.candidateReady)
    assert.deepStrictEqual(cancelled,[[1,3]],'Obsolete native input was retained or resumed')
    assert.deepStrictEqual(result.imageryPlan.draws.map(draw=>draw.resourceId),[1,4])
    assert.strictEqual(starts.get(1),1,'Completed shared projection was recomputed')
    assert.strictEqual(starts.get(3),1)
    assert.strictEqual(starts.get(4),1,'New terrain reused another mesh projection')
    assert(freed.includes(3))
    assert(!freed.includes(1) && !freed.includes(4),'Candidate evaluation released live mesh inputs')
    host.pendingMesh={planId:6,prepared:{surface:packet(6,[1,4])}}
    const reused=await host.handle(request(6,6))
    assert(reused.candidateReady,'Metadata-only publication lost a completed cut')
    assert.strictEqual(reused.modelRevision,6)
    assert.deepStrictEqual(inputs,[[1,3],[1,4]],'Completed immutable cut was planned again for unrelated topology')

    // A private mesh production must reach its first usable imagery cut even
    // while camera input keeps invalidating the displayed-view planner. Its
    // immutable projection may be old; its receipt must never claim otherwise.
    host.clearPlanning(); host.measurementHistory.clear()
    starts.clear(); steps.clear(); inputs.length=cancelled.length=0
    host.observeView({...view,revision:100})
    host.pendingMesh={planId:7,prepared:{surface:packet(7,[1,4])}}
    await until({...request(7,7),viewRevision:100},()=>steps.get(1)>0)
    const producing=host.imageryJob
    let ready, latest
    for(let i=0;i<100;++i) {
      latest={...view,revision:101+i,camera:{distance:i%2 ? 100 : 10000,yawRadians:i*0.3}}
      host.observeView(latest)
      const value=await host.handle({...request(7,7),viewRevision:latest.revision})
      if(value.candidateReady) {ready=value;break}
      assert.strictEqual(host.imageryJob,producing,
        'Continuous camera input restarted private candidate production before usable coverage')
    }
    assert(ready,'Moving-camera candidate never reached a complete admitted imagery cut')
    assert.strictEqual(ready.viewRevision,100,'Candidate relabeled old-camera measurements as current')
    assert.strictEqual(starts.get(1),1,'Camera churn repeated candidate projection')
    assert.strictEqual(starts.get(4),1)
    assert.deepStrictEqual(cancelled,[],'Camera churn cancelled already funded native input')
    // Once published, ordinary imagery planning follows the newest camera.
    host.frames.presented=host.pendingMesh.prepared.surface
    host.pendingMesh=null
    const current=await until({...request(7),viewRevision:latest.revision},
      value=>value.imageryPlan && value.imageryPlan.quality.planningComplete)
    assert.strictEqual(current.viewRevision,latest.revision,
      'Completed candidate froze subsequent displayed-view imagery refinement')
  } finally {
    host.clearPlanning()
    resources.forEach(resource=>resource.ownership.retire())
    Date.now=clock;surface.surfaceMeasurements=measure
  }
  assert.strictEqual(ledger.bytes,0,'Candidate retargeting retained mesh ownership')
  console.log('Candidate cut changes retain shared projection progress and retire obsolete inputs')
}

if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
