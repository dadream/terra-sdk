// Runs only when explicitly injected by the bounded evidence runner. The normal
// demo never starts automation or extra data traffic on its own.
void (async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const deadline = performance.now() + 45000
  // Observe the test's existing traffic. Keep bounded numeric samples only;
  // source URLs may contain credentials and must never enter the evidence.
  const network = new Map()
  const observer = new PerformanceObserver(list => {
    list.getEntries().forEach(entry => {
      const path = new URL(entry.name, location.href).pathname
      const kind = path.includes('/imagery/') ? 'imagery' :
        path.includes('/terrain/') || path.includes('/datasets/') ? 'terrain' : 'other'
      if (!network.has(kind)) network.set(kind, {count: 0, transferBytes: 0,
        statusUnknown: 0, httpErrors: 0, samples: []})
      const bucket = network.get(kind)
      ++bucket.count
      bucket.transferBytes += entry.transferSize
      if (!entry.responseStatus) ++bucket.statusUnknown
      else if (entry.responseStatus >= 400) ++bucket.httpErrors
      const sample = {durationMs: entry.duration,
        requestToFirstByteMs: entry.responseStart > 0 ? entry.responseStart - entry.requestStart : null,
        queuedMs: entry.requestStart > 0 ? entry.requestStart - entry.startTime : null}
      if (bucket.samples.length < 2048) bucket.samples.push(sample)
      else bucket.samples[(bucket.count - 1) % 2048] = sample
    })
  })
  observer.observe({type: 'resource', buffered: true})
  let demo
  try {
    while (performance.now() < deadline) {
      demo = window.__terraProductDemo
      if (demo && demo.viewer.getState().renderer.draws.submitted > 0) break
      await wait(100)
    }
    if (!demo || !demo.viewer.getState().renderer.draws.submitted) throw new Error('Deployed demo did not render')
    document.getElementById('debug-toggle').click()
    const reports = [], result = document.createElement('pre')
    result.id = 'navigation-evidence'; result.hidden = true
    document.body.appendChild(result)
    const selected = new URLSearchParams(location.search).get('testScenario')
    const names = selected ? [selected] : ['roam', 'flight', 'oblique']
    for (const name of names) {
      document.getElementById('scenario-name').value = name
      const report = await demo.runScenario(name)
      reports.push(report)
      result.textContent = JSON.stringify({schema: 'terra.deployed-navigation-evidence.v4', reports})
      if (!report || report.schema !== 'terra.navigation-evidence.v4' || report.status !== 'complete' ||
          report.preparation.status !== 'stable' || report.settlement.status !== 'stable' ||
          !report.preparation.final.quality.targetMet || !report.settlement.final.quality.targetMet ||
          report.preparation.final.gpu.pending || report.settlement.final.gpu.pending ||
          JSON.stringify(report.finalView) !== JSON.stringify(report.settlement.final.view)) {
        throw new Error(name + ': endpoint conditioning failed')
      }
      if (!report || report.blankSamples || report.missingSamples ||
          report.performance.runtime.frameCoordinator.submit.count < 4) throw new Error(name + ': deployed navigation coverage failed')
      if (!report.performance.runtime.fullUpdate.count || !report.terrainPublicationCount || !report.terrainMeshChangeCount) {
        throw new Error(name + ': terrain updates starved during deployed navigation')
      }
    }
    result.textContent = JSON.stringify({schema: 'terra.deployed-navigation-evidence.v4', reports,
      endpointObservedBeforeRestore: true, comparison: 'live network and retained caches; not a fixed-workload benchmark'})
    const panel = document.getElementById('scenario-controls')
    if (panel.hidden || document.getElementById('scenario-report').disabled) throw new Error('Scenario controls did not complete')
    demo.viewer.pause()
    document.documentElement.dataset.terraEvidenceStatus = 'passed'
  } catch (error) {
    document.documentElement.dataset.terraEvidenceStatus = 'failed'
    document.body.dataset.navigationError = error.message
    if (demo) {
      const runtime = demo.viewer.runtime, renderer = runtime && runtime.renderer
      const details = document.createElement('pre')
      details.id = 'navigation-failure'; details.hidden = true
      details.textContent = JSON.stringify({report: error.report || null,
        failureReportAvailable: !document.getElementById('scenario-report').disabled,
        controlsIdle: !document.getElementById('scenario-run').disabled && document.getElementById('scenario-stop').disabled,
        phaseLabel: (document.getElementById('scenario-status') || {}).textContent,
        state: demo.viewer.getState(), runtime: runtime && {
        refreshing: runtime.refreshing, refreshPending: runtime.refreshPending,
        interactionActive: runtime.interactionActive, cameraPreviewDirty: runtime.cameraPreviewDirty,
        presentingSequence: runtime.presentingSequence,
        candidateSequence: runtime.meshFrames.candidate && runtime.meshFrames.candidate.frame.sequence,
        workerPending: Array.from(runtime.abi.pending || [], ([id, job]) => ({id, type: job.type})),
        rendererSequence: renderer.current && renderer.current.frame.sequence,
        displaySequence: renderer.displaySurface && renderer.displaySurface.current.frame.sequence,
        submittedSequence: renderer.submittedSequence,
        uploadQueue: renderer.uploadQueue.length
      }})
      document.body.appendChild(details)
    }
    if (demo) demo.viewer.pause()
  } finally {
    observer.disconnect()
    const summaries = {}
    const quantiles = values => {
      const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
      const at = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null
      return {count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1)}
    }
    network.forEach((bucket, kind) => {
      summaries[kind] = {count: bucket.count, transferBytes: bucket.transferBytes,
        statusUnknown: bucket.statusUnknown, httpErrors: bucket.httpErrors,
        retainedSamples: bucket.samples.length,
        durationMs: quantiles(bucket.samples.map(sample => sample.durationMs)),
        requestToFirstByteMs: quantiles(bucket.samples.map(sample => sample.requestToFirstByteMs)),
        queuedMs: quantiles(bucket.samples.map(sample => sample.queuedMs))}
    })
    const details = document.createElement('pre')
    details.id = 'navigation-network'; details.hidden = true
    details.textContent = JSON.stringify({scope: 'window resource timings, including buffered entries', summaries})
    document.body.appendChild(details)
  }
})()
