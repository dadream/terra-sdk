(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraVerticalScaleBenchmark = factory()
})(typeof self === 'undefined' ? this : self, function () {
  'use strict'

  function requireValue(value, message) { if (!value) throw new Error(message) }

  // The local tangent-plane scale is a sampling convention, not a replacement
  // for the SDK's sphere visibility, CBDAM closure or projective imagery SSE.
  // Eight-root geodetic tiles span pi/2 radians vertically at depth zero.
  function scales(config, maximumLevel = config.maximumInternalLevel) {
    requireValue(Number.isInteger(maximumLevel) && maximumLevel >= 0 &&
      maximumLevel <= config.maximumInternalLevel, 'Invalid benchmark maximum level')
    for (const key of ['radiusMeters', 'cssHeight', 'tileSize', 'imageryPixelError', 'globalRangeMeters'])
      requireValue(Number.isFinite(config[key]) && config[key] > 0, 'Invalid scale parameter: ' + key)
    requireValue(config.fovRadians > 0 && config.fovRadians < Math.PI, 'Invalid vertical FOV')
    const rootRange = config.radiusMeters * Math.PI / 2 * config.cssHeight /
      (2 * config.tileSize * config.imageryPixelError * Math.tan(config.fovRadians / 2))
    const result = [{id:'global', level:null, rangeMeters:config.globalRangeMeters}]
    for (let level = 0; level <= maximumLevel; ++level) {
      const rangeMeters = rootRange / 2 ** level
      // A global endpoint replaces coarser tangent-plane samples outside the
      // supported camera range. Report these skipped levels in configuration.
      if (rangeMeters >= config.globalRangeMeters) continue
      requireValue(rangeMeters >= config.minimumRangeMeters, 'Finest sample is outside camera range')
      result.push({id:'level-' + level, level, rangeMeters})
    }
    requireValue(result.length > 1, 'No local scale below the global endpoint')
    return result
  }

  function quality(state) {
    const r = state.renderer || {}, q = r.quality || {}, t = r.textures || {}
    const s = state.terrainSelection || {}, resource = state.resources || {}
    const transition = r.transition || {}, work = state.performance && state.performance.frameCoordinator || {}
    const current = s.desiredViewRevision !== undefined &&
      s.desiredViewRevision === s.preparedViewRevision && s.desiredViewRevision === s.presentedViewRevision &&
      q.cameraCurrent === true && q.terrainSelectionCurrent === true
    const terrainErrorMet = Number.isFinite(resource.achievedLodError) &&
      Number.isFinite(resource.requestedLodThreshold) &&
      resource.achievedLodError <= resource.requestedLodThreshold * 1.001
    const imageryErrorMet = Number.isFinite(q.resolvedMaxPixelError) &&
      Number.isFinite(q.targetPixelError) && q.resolvedMaxPixelError <= q.targetPixelError * 1.001
    const terrainMet = current && q.geometryTargetComplete === true && terrainErrorMet && !resource.limitedByCapacity
    const imageryMet = current && q.targetMet === true && imageryErrorMet
    const covered = current && q.covered === true && (r.draws || {}).submitted > 0 && q.missingCount === 0
    const busy = []
    if (!current) busy.push('view')
    if ((state.terrain || {}).active || (state.terrain || {}).queued || t.active || t.queued) busy.push('requests')
    if (resource.pendingMeshGroups || resource.pendingPriorityUpdateCount || resource.budgetExhausted) busy.push('terrain')
    if (q.planningComplete === false || q.measurementPending || q.visibilityProofsPending || q.interactionActive) busy.push('imagery')
    if (!transition.gpuSubmission || transition.gpuSubmission.pending) busy.push('gpu')
    if (!transition.handoff || transition.handoff.phase !== 'presented') busy.push('handoff')
    const partitions = transition.partitions || {}
    if (partitions.queuedCells || partitions.uploading || partitions.activeMs) busy.push('partitions')
    if (work.pendingAnimations || work.pendingInputs || work.pendingWork || work.pendingRender) busy.push('frame')
    const reasons = (q.limitationReasons || []).slice()
    if (resource.limitedByCapacity && !reasons.includes('terrain-budget')) reasons.push('terrain-budget')
    // The failure registry can retain entries unrelated to this view. Only a
    // current dependency failure proves that data prevents convergence.
    if (t.blockedByFailure) reasons.push('image-failure')
    const limited = reasons.some(reason => /budget|memory|capacity/.test(reason)) ? 'capacity-limited' :
      reasons.some(reason => /source-level|data|failure/.test(reason)) ? 'data-limited' : null
    const idle = busy.length === 0
    const diagnosticMismatch = current && covered && idle && terrainMet && imageryMet &&
      q.resourceStable === true && !limited && q.settled === false
    if (diagnosticMismatch) reasons.push('settlement-diagnostic')
    return {current, covered, terrainMet, imageryMet, busy, reasons,
      recordedImageFailures:t.failed || 0, currentImageFailure:Boolean(t.blockedByFailure),
      terminal: covered && idle && terrainMet && imageryMet && q.settled === true ? 'ready' :
        current && idle && limited ? limited : diagnosticMismatch ? 'diagnostic-inconsistent' : null}
  }

  function sameView(a, b) {
    return a && b && a.mode === b.mode &&
      ['rangeMeters', 'headingDegrees', 'tiltDegrees'].every(key =>
        Math.abs(a[key] - b[key]) <= 1e-8 * Math.max(1, Math.abs(b[key]))) &&
      ['longitudeDegrees', 'latitudeDegrees', 'heightMeters'].every(key =>
        Math.abs(a.target[key] - b.target[key]) <= 1e-8 * Math.max(1, Math.abs(b.target[key])))
  }

  function timings(before, after) {
    const result = {}
    for (const group of ['runtime', 'renderer']) for (const [name, last] of Object.entries(after[group] || {})) {
      if (!last || !Number.isFinite(last.count) || !Number.isFinite(last.averageMs)) continue
      const first = before[group] && before[group][name] || {count:0, averageMs:0}
      const count = last.count - first.count
      result[group + '.' + name] = {count,
        instrumentedElapsedMs: last.averageMs * last.count - first.averageMs * first.count,
        lifetimeMaximumMs:last.maximumMs}
    }
    return result
  }

  function compare(down, up) {
    const sets = {}
    for (const name of Object.keys(down.final.sets)) {
      const a = new Set(down.final.sets[name]), b = new Set(up.final.sets[name])
      sets[name] = {down:a.size, up:b.size, onlyDown:[...a].filter(key => !b.has(key)),
        onlyUp:[...b].filter(key => !a.has(key))}
    }
    return {id:down.id, bothReady:down.status === 'ready' && up.status === 'ready',
      sameView:sameView(down.view, up.view), sets,
      sameSets:Object.values(sets).every(set => !set.onlyDown.length && !set.onlyUp.length),
      downMs:down.durationMs, upMs:up.durationMs,
      downBytes:down.final.metrics.managedBytes, upBytes:up.final.metrics.managedBytes}
  }

  async function run(viewer, options) {
    const {read, configuration, target, samples} = options
    const now = options.now || (() => performance.now())
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs
    const stableMs = options.stableMs === undefined ? 500 : options.stableMs
    const intervalMs = options.intervalMs === undefined ? 100 : options.intervalMs
    requireValue(timeoutMs > stableMs && stableMs >= intervalMs && intervalMs > 0, 'Invalid benchmark timing')
    requireValue(samples.length >= 2 && samples.every((sample, i) => Number.isFinite(sample.rangeMeters) &&
      sample.rangeMeters > 0 && (!i || sample.rangeMeters < samples[i-1].rangeMeters)), 'Invalid descending scales')
    const report = {schema:'terra.vertical-scale-benchmark.v1', status:'running', configuration,
      target, samples, timeoutMs, stableMs, intervalMs, steps:[], comparisons:[],
      scaleScope:'Nominal local tangent-plane scales; global replaces coarser samples; actual selected levels are measured separately',
      timingScope:'Per-stage wall time; instrumented sections may overlap and include RPC waits; not exclusive CPU time',
      peakScope:'Per-stage sampled peak is a lower bound; ledger high-water covers tracked lifetime allocations, not total browser or GPU memory',
      setScope:'Published terrain fragments and planned imagery cells, not an independent canonical target oracle',
      cacheScope:'Fresh browser may contain demo startup data; all stage caches retained, never cleared between directions'}
    const guard = JSON.stringify(configuration)
    try {
      viewer.camera.cancelAnimation()
      const route = samples.map(sample => ({...sample, direction:'down'})).concat(
        samples.slice(0, -1).reverse().map(sample => ({...sample, direction:'up'})))
      for (const sample of route) {
        if (options.signal && options.signal.aborted) throw new Error('Benchmark cancelled')
        const view = {schema:'terra.view-state.v2', mode:'globe', target:{...target},
          rangeMeters:sample.rangeMeters, headingDegrees:0, tiltDegrees:0}
        const row = {...sample, view, status:'running', durationMs:0,
          firstCoverageMs:null, terrainTargetMs:null, imageryTargetMs:null, sampledPeakBytes:0,
          sampledPeakWasmBytes:0, samples:0, transitions:[]}
        report.steps.push(row)
        const before = viewer.diagnostics.snapshot(), start = now()
        if (options.onStage) options.onStage(row)
        viewer.camera.setView(view)
        let identity = null, stableAt = null, previousState = null
        for (;;) {
          if (options.signal && options.signal.aborted) throw new Error('Benchmark cancelled')
          const observation = read(), state = observation.state
          requireValue(JSON.stringify(observation.configuration) === guard, 'Dataset, source, viewport or precision configuration changed')
          requireValue(sameView(state.view, view), 'Benchmark camera changed or was constrained')
          requireValue(!state.error && !state.contextLost && !state.paused, state.error || 'Viewer became unavailable')
          const elapsed = now() - start, status = quality(state)
          row.durationMs = elapsed; ++row.samples
          row.sampledPeakBytes = Math.max(row.sampledPeakBytes, observation.metrics.managedBytes)
          row.sampledPeakWasmBytes = Math.max(row.sampledPeakWasmBytes, observation.metrics.wasmBytes)
          row.final = observation; row.quality = status
          if (status.covered && row.firstCoverageMs === null) row.firstCoverageMs = elapsed
          if (status.terrainMet && row.terrainTargetMs === null) row.terrainTargetMs = elapsed
          if (status.imageryMet && row.imageryTargetMs === null) row.imageryTargetMs = elapsed
          const currentState = JSON.stringify([status.terminal, status.busy, status.reasons])
          if (currentState !== previousState && row.transitions.length < 128)
            row.transitions.push({atMs:elapsed, terminal:status.terminal, busy:status.busy, reasons:status.reasons})
          previousState = currentState
          const selection = state.terrainSelection || {}
          const key = JSON.stringify([status.terminal, selection.presentedSequence, selection.presentedModelRevision,
            observation.sets, observation.metrics.workingMeshBytes])
          if (!status.terminal || key !== identity) stableAt = null
          identity = key
          if (status.terminal && stableAt === null) stableAt = elapsed
          if (stableAt !== null && elapsed - stableAt >= stableMs) {row.status = status.terminal; break}
          if (elapsed >= timeoutMs) {row.status = 'timeout'; break}
          await sleep(intervalMs)
        }
        row.timings = timings(before, viewer.diagnostics.snapshot())
        if (options.onStep) await options.onStep(row, report)
      }
      for (const up of report.steps.filter(row => row.direction === 'up'))
        report.comparisons.push(compare(report.steps.find(row => row.direction === 'down' && row.id === up.id), up))
      report.status = 'complete'
      report.allTargetsMet = report.steps.every(row => row.status === 'ready')
      report.sameEndpointSets = report.comparisons.every(row => row.sameView && row.sameSets)
      return report
    } catch (error) {
      report.status = options.signal && options.signal.aborted ? 'cancelled' : 'failed'
      report.error = error.message; error.report = report
      throw error
    }
    // The owner destroys its test-only viewer/browser. Do not restore a camera
    // here: that would launch unmeasured traffic after the final observation.
  }
  return {scales, quality, sameView, timings, compare, run}
})
