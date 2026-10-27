const assert = require('assert')
const scenarios = require('../../apps/site/demo/navigation_scenarios')

function fixture() {
  let now = 0, next = 0, view = { mode: 'globe', target: {longitudeDegrees: 0, latitudeDegrees: 0}, rangeMeters: 12000000 }
  let phase
  const frames = new Map(), timers = new Map(), calls = [], phases = []
  const state = {terrain: {active: 0, queued: 0}, resources: {budgetExhausted: false, pendingMeshGroups: 0, pendingPriorityUpdateCount: 0},
    terrainSelection: {submitted: {submissions: 1, partialSubmissions: 0, meshRevision: 1}, desiredViewRevision: 1, preparedViewRevision: 1, presentedViewRevision: 1, presentedSequence: 1, presentedModelRevision: 1},
    work: {pendingAnimations: 0, pendingInputs: 0, pendingWork: 0, pendingRender: false},
    transition: {gpuSubmission: {pending: false}, handoff: {phase: 'presented'}, partitions: {queuedCells: 0, uploading: 0, activeMs: 0}},
    quality: {covered: true, quiescent: true, terrainSelectionCurrent: true, ready: true, missingCount: 0, targetMet: true, resolvedMaxPixelError: 1.2, limitationReasons: []}}
  const signal = { aborted: false, callbacks: new Set(),
    addEventListener(type, callback) { this.callbacks.add(callback) },
    removeEventListener(type, callback) { this.callbacks.delete(callback) },
    abort() { this.aborted = true; for (const callback of this.callbacks) callback() } }
  const viewer = {
    camera: {
      getView() { return JSON.parse(JSON.stringify(view)) },
      setView(value) { view = value; calls.push('view') },
      cancelAnimation() { calls.push('cancel') },
      flyTo() { calls.push('flight') },
      startOrbit() { calls.push('orbit') }
    },
    diagnostics: { reset() { calls.push('reset') }, snapshot() { return { phase } } },
    getState() { return JSON.parse(JSON.stringify({ radiusMeters: 6371000, datasetId: 'fixture', imageryId: 'fixture', view,
      budget: {physicalWidth: 640, physicalHeight: 360}, performance: {wasmMemoryBytes: 42, frameCoordinator: state.work},
      terrain: state.terrain, resources: state.resources, terrainSelection: state.terrainSelection,
      cameraGround: {demand: state.ground, appliedDemandRevision: state.appliedDemandRevision},
      renderer: {draws: {submitted: 4}, textures: {bytes: 21, reservedBytes: 5, pipelineBytes: 11},
        quality: state.quality, transition: state.transition} })) }
  }
  return { viewer, frames, timers, calls, phases, state, signal, options: { durationMs: 500, conditioningTimeoutMs: 1000, signal,
    now: () => now, requestFrame(callback) { const id = ++next; frames.set(id, callback); return id },
    cancelFrame(id) { frames.delete(id) }, setTimer(callback) { const id = ++next; timers.set(id, callback); return id },
    clearTimer(id) { timers.delete(id) }, onPhase(name) { phase = name; phases.push(name) } },
    async frame() { now += 100; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now));
      for (let i = 0; i < 4; ++i) await Promise.resolve() },
    async until(name) { for (let i = 0; i < 30 && phase !== name; ++i) await this.frame(); assert.strictEqual(phase, name) },
    clean() { assert.strictEqual(frames.size, 0); assert.strictEqual(timers.size, 0); assert.strictEqual(signal.callbacks.size, 0) } }

}

async function main() {
  for (const name of scenarios.names) {
    const f = fixture(), original = f.viewer.camera.getView()
    const pending = scenarios.run(f.viewer, name, f.options)
    await f.until('motion')
    assert.deepStrictEqual(f.calls.slice(0, 3), ['cancel', 'view', 'reset'])
    await f.until('settlement')
    assert.notDeepStrictEqual(f.viewer.camera.getView(), original, 'restored before endpoint observation')
    await f.until('complete')
    const report = await pending
    assert.strictEqual(report.schema, 'terra.navigation-evidence.v4')
    assert.strictEqual(report.blankSamples, 0)
    assert.strictEqual(report.samples.length, 5)
    assert.strictEqual(report.maximumWasmBytes, 42)
    assert.strictEqual(report.maximumTextureBytes, 21)
    assert.strictEqual(report.maximumTextureReservedBytes, 5)
    assert.strictEqual(report.maximumTexturePipelineBytes, 11)
    assert.strictEqual(report.maximumTextureAccountedBytes, 37,
      'Navigation peak omitted separately owned production credit or counted it twice')
    assert.strictEqual(report.durationMs, 500)
    assert.strictEqual(report.performance.phase, 'motion')
    assert.strictEqual(report.preparation.status, 'stable')
    assert.strictEqual(report.settlement.status, 'stable')
    assert.deepStrictEqual(report.settlement.final.view, report.finalView)
    assert.deepStrictEqual(f.viewer.camera.getView(), original)
    assert.deepStrictEqual(f.phases, ['preparation','motion','settlement','complete'])
    f.clean()
  }
  // Mixed geometry may be retained between whole-model publications. Count its
  // actual submissions, including multiple receipts between sampled frames.
  {
    const f = fixture(), pending = scenarios.run(f.viewer, 'oblique', f.options)
    await f.until('motion')
    const submitted = f.state.terrainSelection.submitted
    submitted.submissions += 3; submitted.partialSubmissions += 3; submitted.meshRevision += 2
    await f.frame()
    // A camera/imagery redraw can produce a receipt without new terrain.
    ++submitted.submissions
    await f.until('complete')
    const report = await pending
    assert.strictEqual(report.terrainPublicationCount, 4)
    assert.strictEqual(report.terrainPartialPublicationCount, 3)
    assert.strictEqual(report.terrainFullPublicationCount, 0)
    assert.strictEqual(report.terrainMeshChangeCount, 2)
    f.clean()
  }
  // Neither motion nor metric reset may begin while old GPU/model work remains.
  for (const block of ['gpu', 'model', 'view', 'ground', 'clearance']) {
    const f = fixture()
    if (block === 'gpu') f.state.transition.gpuSubmission.pending = true
    if (block === 'model') f.state.resources.pendingMeshGroups = 1
    if (block === 'view') f.state.terrainSelection.presentedViewRevision = 0
    if (block === 'ground') f.state.ground = {active: true, pending: true, eye: {status: 'pending'}}
    if (block === 'clearance') {
      f.state.ground = {active: true, pending: false, revision: 2, eye: {status: 'limited'}, front: {status: 'limited'}}
      f.state.appliedDemandRevision = 1
    }
    const running = scenarios.run(f.viewer, 'flight', f.options)
    for (let i = 0; i < 4; ++i) await f.frame()
    assert(!f.calls.includes('reset') && !f.calls.includes('flight'))
    f.state.transition.gpuSubmission.pending = false
    f.state.resources.pendingMeshGroups = 0
    f.state.terrainSelection.presentedViewRevision = 1
    f.state.terrainSelection.presentedSequence = 20
    f.state.ground = {active: true, pending: false, eye: {status: 'limited'}, front: {status: 'limited'}}
    f.state.appliedDemandRevision = undefined
    await f.until('complete')
    const report = await running
    assert.strictEqual(report.terrainPublicationCount, 0, 'preparation counted as moving work')
    assert(report.preparation.durationMs > 500)
    f.clean()
  }
  const limited = fixture()
  limited.state.quality.ready = false
  limited.state.quality.limitationReasons = ['terrain-budget']
  const reportPromise = scenarios.run(limited.viewer, 'roam', limited.options)
  await limited.until('complete')
  const report = await reportPromise
  assert.strictEqual(report.preparation.targetReady, false)
  assert.strictEqual(report.limitedSamples, report.samples.length)
  assert.deepStrictEqual(report.settlement.limitationReasons, ['terrain-budget'])
  limited.clean()

  for (const stopAt of ['preparation', 'motion', 'settlement']) {
    const f = fixture(), pending = scenarios.run(f.viewer, 'flight', f.options)
    const rejected = assert.rejects(pending, error => error.report.status === 'cancelled' && error.report.failedPhase === stopAt)
    await f.until(stopAt)
    await assert.rejects(scenarios.run(f.viewer, 'flight', f.options), /already running/)
    const stale = [...f.frames.values()]
    f.signal.abort(); await rejected
    stale.forEach(callback => callback())
    f.clean()
  }
  for (const problem of ['timeout', 'clock', 'snapshot', 'configuration']) {
    const f = fixture()
    f.state.quality.targetMet = false
    const pending = scenarios.run(f.viewer, 'roam', f.options)
    const rejected = assert.rejects(pending, error => error.report.status === 'failed' && error.report.failedPhase === 'preparation')
    if (problem === 'clock') [...f.timers.values()][0]()
    else if (problem === 'configuration') { const original = f.viewer.getState; f.viewer.getState = () => Object.assign(original(), {imageryId: 'different'}); await f.frame() }
    else if (problem === 'snapshot') { f.viewer.getState = () => { throw new Error('Injected snapshot failure') }; await f.frame() }
    else for (let i = 0; i < 10; ++i) await f.frame()
    await rejected
    assert(!f.calls.includes('reset'))
    f.clean()
  }
  const endpoint = fixture()
  const pending = scenarios.run(endpoint.viewer, 'oblique', endpoint.options)
  const rejected = assert.rejects(pending, error => error.report.failedPhase === 'settlement' && error.report.settlement.status === 'timeout')
  await endpoint.until('settlement')
  endpoint.state.quality.targetMet = false
  for (let i = 0; i < 10; ++i) await endpoint.frame()
  await rejected; endpoint.clean()
  console.log('Conditioned navigation endpoints, phase isolation, limitations, timeouts and cancellation cleanup passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
