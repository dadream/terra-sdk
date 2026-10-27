const assert = require('assert')

// Real runtime orchestration, with an immutable pending output and a finite
// logical target. Native snapshot/height ownership is checked in Wasm too.
module.exports = async function verifyModelWork({createRuntime, FakeAbi, settle}) {
  const abi = new FakeAbi(), rounds = []
  let model = 1, target = 1, copied = 0
  abi.getRequests = () => []
  const updateStep = abi.updateStep.bind(abi)
  abi.updateStep = (...args) => ({...updateStep(...args), decisionsComplete: model >= target})
  abi.copyMeshResource = () => { ++copied; assert.fail('Logical work allocated a mesh copy') }
  const progress = changes => ({modelRevision: model, topologyChangeCount: changes,
    pendingPriorityUpdateCount: 0, budgetExhausted: model < target, limitedByCapacity: false})
  abi.getUpdateState = () => progress(0)
  abi.advanceTerrain = (_, budget) => {
    const changes = Math.min(8, budget.maximumChangeCount, target - model)
    model += changes; rounds.push(budget.maximumChangeCount)
    return progress(changes)
  }
  const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  let ack
  try {
    await settle(3)
    runtime.frameClock.work.clear()
    const shown = runtime.meshFrames.presented, frame = runtime.lastFrame
    const arrays = abi.updateCount, bytes = runtime.resourceLedger.bytes
    renderer.terrainRefinementDemand = () => null
    target = 97; rounds.length = 0
    runtime.beginTerrainPreparation({frame: {sequence: frame.sequence + 1},
      selectionViewRevision: runtime.cameraRevision, updateState: progress(0)})
    assert.strictEqual(runtime.terrainUpdateBudget().maximumChangeCount, 0,
      'Unknown imagery pricing authorized physical selection growth')
    for (let i = 0; i < 100 && model < target; ++i) await settle()
    assert.strictEqual(model, 97, 'Unknown image pricing stopped independent logical model rounds')
    assert(rounds.length >= 12 && rounds.every(value => value <= 32),
      'Continuous model work enlarged a native round')
    assert.strictEqual(runtime.meshFrames.presented, shown)
    assert.strictEqual(runtime.lastFrame, frame)
    assert.strictEqual(abi.updateCount, arrays, 'Logical progress materialized intermediate frames')
    assert.strictEqual(copied, 0)
    assert.strictEqual(runtime.resourceLedger.bytes, bytes, 'Logical progress allocated unpriced physical output')
    const idleRounds = rounds.length
    await settle(5)
    assert.strictEqual(rounds.length, idleRounds, 'Converged model work polled for an image receipt')
    await runtime.finishTerrainPreparation()

    runtime.lastFrame = {...frame, decisionsComplete: false}
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    await runtime.refresh(); await settle(5)
    assert.strictEqual(runtime.lastSurface.updateState.modelRevision, 97,
      'Publication replayed intermediate logical targets')
    assert.strictEqual(abi.updateCount, arrays + 1)
    // Missing data can leave a physically incomplete cut even though native
    // model work is idle. It must await an input change, not publish in a loop.
    runtime.lastFrame = {...runtime.lastFrame, decisionsComplete: false}
    const accepted = abi.updateCount
    await runtime.refresh(); await settle(5)
    const quiet = rounds.length
    await settle(5)
    assert.strictEqual(rounds.length, quiet, 'Idle model scheduled its own input change')
    assert.strictEqual(abi.updateCount, accepted, 'Idle unpriced model republished equivalent arrays')

    const sourceRevision = runtime.terrainRecordRevision
    assert.strictEqual(runtime.terrainRecordChanged({}), false)
    assert.strictEqual(runtime.terrainRecordRevision, sourceRevision, 'A retired source invalidated the model')
    abi.retryRecord = () => new Promise(resolve => {ack = resolve})
    runtime.retryTerrainRecord({kind: 1, key: {}})
    assert.strictEqual(runtime.terrainRecordRevision, sourceRevision, 'Model input changed before native acknowledgement')
    ack(); ack = null; await settle()
    assert.strictEqual(runtime.terrainRecordRevision, sourceRevision + 1)
    runtime.cancelTerrainRefresh()
    target = 113
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    await runtime.refresh(); await settle(8)
    assert(rounds.length > quiet, 'Acknowledged data did not wake the idle model')
    assert.strictEqual(model, target)
    assert(rounds.every(value => value <= 32))

    const displayed = runtime.meshFrames.presented, retained = runtime.resourceLedger.bytes
    let refusals = 0
    abi.advanceTerrain = () => {
      ++refusals
      throw Object.assign(new Error('Controlled height production refusal'), {status: 9})
    }
    runtime.beginTerrainPreparation({frame: {sequence: runtime.lastFrame.sequence + 1},
      selectionViewRevision: runtime.cameraRevision, updateState: progress(0)})
    await settle(6)
    assert.strictEqual(refusals, 1, 'Unfunded preparation repeatedly attempted height production')
    assert.strictEqual(runtime.meshFrames.presented, displayed, 'Model refusal retired the displayed cut')
    assert.strictEqual(runtime.resourceLedger.bytes, retained)
    const wait = runtime.terrainModel.refusal
    assert(wait && !runtime.terrainModel.needsAdvance(wait.input, wait.view, wait.availability))
    assert(runtime.terrainModel.needsAdvance(wait.input, wait.view, wait.availability + 1),
      'Real ownership release did not reopen a refused idle model')
    assert(runtime.state().diagnostics.some(value => value.kind === 'terrain_model_capacity_pending'))
    assert(!runtime.state().diagnostics.some(value => value.kind === 'terrain_preparation_advance_failed'))
    await settle(5)
    assert.strictEqual(refusals, 1)
  } finally {
    if (ack) ack()
    await runtime.finishTerrainPreparation(); runtime.destroy()
  }
  assert.strictEqual(runtime.resourceLedger.bytes, 0)
  await verifyDataOnlyWake({createRuntime, FakeAbi, settle})
  console.log('Terrain model clock: unpriced progress, bounded rounds, coalesced publication and data-driven idle wake passed')
}

async function verifyDataOnlyWake({createRuntime, FakeAbi, settle}) {
  const abi = new FakeAbi(), update = abi.updateStep.bind(abi)
  let missing = true, ack
  abi.getRequests = () => []
  abi.updateStep = (...args) => ({...update(...args), decisionsComplete: !missing})
  abi.noDataRecord = () => new Promise(resolve => {ack = () => {missing = false; resolve()}})
  const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  try {
    renderer.terrainRefinementDemand = () => null
    runtime.terrainUpdateBudget()
    await settle(10)
    const publications = abi.updateCount, model = runtime.lastSurface.updateState.modelRevision
    const request = {kind: 2, key: {level: 1, i: 0, j: 0, k: 0}}
    runtime.desiredRequests.set('sparse', request)
    runtime.handleTerrainFailure('sparse', request, runtime.cameraRevision, {noData: true})
    assert.strictEqual(runtime.lastFrame.decisionsComplete, false)
    ack(); ack = null; await settle(15)
    assert.strictEqual(runtime.lastFrame.decisionsComplete, true,
      'Acknowledged NoData without topology changes left the published frame incomplete')
    assert.strictEqual(runtime.lastSurface.updateState.modelRevision, model)
    assert.strictEqual(abi.updateCount, publications + 1, 'Data-only completion did not coalesce into one publication')
    await settle(5)
    assert.strictEqual(abi.updateCount, publications + 1, 'Data-only completion kept republishing')
  } finally {if (ack) ack(); runtime.destroy()}
  assert.strictEqual(runtime.resourceLedger.bytes, 0)
}
