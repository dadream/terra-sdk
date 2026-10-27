const assert = require('assert')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')

module.exports = async function () {
  const host = new TerrainWorkerHost({}), clock = Date.now
  let now = 0, closed = 0
  Date.now = () => now
  host.abi = {}
  host.manifest = {radius: 6378000}
  const snapshot = {projectionView: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}
  host.frames.presented = {frame: {sequence:1, ...snapshot}, draws:[], resources:new Map(),
    updateState:{modelRevision:1}, meshIdentity:'same'}
  host.planImagery = async () => ({pending:true})
  const view = revision => ({type:'view', revision, snapshot,
    camera:{distance:1000, longitudeDegrees:revision*1e-7, latitudeDegrees:0},
    viewport:{height:360, width:640, fovRadians:1}})
  const plan = () => host.handle({sequence:1, imagery:{descriptor:{}},
    viewRevision:host.latestViewRevision, ...host.latestView, type:'imagery'})
  try {
    host.observeView(view(1))
    await plan()
    const first = host.imageryJob
    host.measurementJob = {draws:[], measured:new Map(), work:{return(){++closed}}}
    // Continuous movement must keep useful work, even across many revisions.
    for (let revision=2; revision<=25; ++revision) {
      now += 30; host.observeView(view(revision)); await plan()
      assert.strictEqual(host.imageryJob, first, 'Small continuous input restarted projection')
    }
    const changedAt = host.latestViewAt
    now += 159; host.observeView(view(25)); host.observeView(view(24)); await plan()
    assert.strictEqual(host.latestViewAt, changedAt, 'Duplicate/stale notifications postponed settlement')
    assert.strictEqual(host.imageryJob, first)
    ++now
    const result = await plan(), settled = host.imageryJob
    assert.notStrictEqual(settled, first, 'A quiet current view waited for obsolete projection to finish')
    assert.strictEqual(settled.viewRevision, 25)
    assert.strictEqual(result.viewRevision, 25)
    assert.strictEqual(result.settledRebases, 1)
    assert.strictEqual(closed, 1, 'Obsolete projection iterator retained borrowed inputs')
    host.measurementJob = {draws:[], measured:new Map(), work:{return(){++closed}}}
    for (let revision=2; revision<=30; ++revision) {
      now += 200; host.frames.presented.updateState = {modelRevision:revision}
      await plan()
      assert.strictEqual(host.imageryJob, settled, 'Same-view terrain work repeatedly rebased projection')
    }
    assert.strictEqual(host.imagerySettledRebases, 1)
    assert.strictEqual(closed, 1)
    // Input slower than the quiet interval must not cancel every replacement
    // before it can publish. Only one quiet rebase is allowed in this chain.
    for (let revision=26; revision<=40; ++revision) {
      host.observeView(view(revision)); now += 200; await plan()
      assert.strictEqual(host.imageryJob, settled, 'Intermittent small input starved the replacement')
    }
    assert.strictEqual(host.imagerySettledRebases, 1)
    // A large scale jump remains allowed to abandon this now-useless view.
    host.observeView({...view(41), camera:{...view(41).camera, distance:100000}})
    await plan()
    assert.notStrictEqual(host.imageryJob, settled, 'Progress protection blocked a large scale change')
    assert.strictEqual(host.imageryJob.viewRevision, 41)
    assert.strictEqual(closed, 2)
    host.clearPlanning()
    const surface={...host.frames.presented,frame:{...snapshot,sequence:2}}
    host.pendingMesh={planId:7,prepared:{surface,accept() {
      host.frames.candidate=surface
      return surface.updateState
    }}}
    let continuation
    host.planImagery=async () => {
      if (!continuation) continuation=host.imageryJob
      else assert.strictEqual(host.imageryJob,continuation,'Publication restarted its accepted imagery task')
      const privateJob=Boolean(host.imageryJob.planId)
      return {candidateReady:privateJob,continuation:privateJob,
        imageryPlan:{draws:[],quality:{planningComplete:!privateJob}}}
    }
    const request={...host.latestView,type:'imagery',sequence:2,viewRevision:41,imagery:{descriptor:{}}}
    const admitted=await host.handle({...request,planId:7})
    assert(admitted.candidateReady && admitted.continuation)
    await host.handle({type:'commit-mesh',planId:7})
    assert.strictEqual(continuation.planId,0)
    assert.strictEqual(continuation.message.planId,undefined)
    // Re-publishing the same immutable terrain while precision is incomplete
    // must not restart measurement, fitting or native input production.
    let discarded = 0
    const work = {return() { ++discarded }}
    host.measurementJob = {draws:[], measured:new Map(), work}
    for (let sequence=3; sequence<=6; ++sequence) {
      const successor={...surface,frame:{...snapshot,sequence}}
      host.pendingMesh={planId:sequence+10,prepared:{surface:successor,accept() {
        host.frames.candidate=successor
        return successor.updateState
      }}}
      const next=await host.handle({...request,sequence,planId:sequence+10})
      assert(next.candidateReady && next.continuation)
      assert.strictEqual(host.imageryJob,continuation,'An unchanged terrain publication restarted refinement')
      assert.strictEqual(host.measurementJob.work,work)
      assert.strictEqual(discarded,0)
      await host.handle({type:'commit-mesh',planId:sequence+10})
    }
    const finished=await host.handle({...request,sequence:6})
    assert(finished.imageryPlan.quality.planningComplete)
    assert.strictEqual(host.imageryJob,null,'Completed continuation retained its mesh loans')
    host.clearPlanning()
    host.planImagery=async () => ({pending:true})
    for (const change of ['source','budget','view']) {
      await host.handle({...request,sequence:6})
      const original=host.imageryJob
      const successor={...surface,frame:{...snapshot,sequence:7},
        meshIdentity:surface.meshIdentity, updateState:surface.updateState}
      host.pendingMesh={planId:20,prepared:{surface:successor}}
      const imagery=change==='source' ? {descriptor:{id:'another'}} :
        change==='budget' ? {...request.imagery,maximumTextures:1} : request.imagery
      if (change==='view') host.observeView({...host.latestView,revision:42})
      await host.handle({...request,imagery,sequence:7,planId:20})
      assert.notStrictEqual(host.imageryJob,original,`${change} change reused an incompatible candidate job`)
      host.clearPlanning()
    }
  } finally {host.clearPlanning(); Date.now = clock}
  assert.strictEqual(closed, 2)
  console.log('Quiet latest-view adoption, continuous input progress and same-view terrain reuse passed')
}
