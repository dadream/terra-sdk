// Injected only by the explicit bounded benchmark command. The application
// never imports this file and never initiates benchmark traffic automatically.
void (async function () {
  'use strict'
  const options = window.terraScaleOptions
  const pre = document.createElement('pre'); pre.id = 'terra-scale-evidence'; pre.hidden = true
  document.body.appendChild(pre)
  const controller = new AbortController()
  const abort = () => controller.abort()
  window.addEventListener('pagehide', abort, {once:true})
  const observer = new PerformanceObserver(list => record(list.getEntries()))
  let demo, report, activeNetwork
  const record = entries => {
    if (!activeNetwork) return
    for (const entry of entries) {
      const pathname = new URL(entry.name, location.href).pathname
      const kind = pathname.includes('/imagery/') ? 'imagery' :
        pathname.includes('/datasets/') || pathname.includes('/terrain/') ? 'terrain' : null
      if (!kind) continue
      const bucket = activeNetwork[kind]
      ++bucket.completed; bucket.transferBytes += entry.transferSize
      bucket.encodedBodyBytes += entry.encodedBodySize
      bucket.durationMs += entry.duration; bucket.maximumDurationMs = Math.max(bucket.maximumDurationMs, entry.duration)
      if (!entry.responseStatus) ++bucket.statusUnknown
      else if (entry.responseStatus >= 400) ++bucket.httpErrors
    }
  }
  const save = value => { pre.textContent = JSON.stringify(value) }
  try {
    const deadline = performance.now() + 45000
    while (performance.now() < deadline) {
      demo = window.__terraProductDemo
      if (demo && demo.viewer.getState().renderer.draws.submitted > 0) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!demo || !demo.viewer.getState().renderer.draws.submitted) throw new Error('Demo startup timed out')
    const viewer = demo.viewer
    viewer.camera.cancelAnimation(); viewer.interaction.cancel()
    const longitudeDegrees = options.longitude, latitudeDegrees = options.latitude
    let heightMeters = options.height, heightQuery = null
    if (heightMeters === undefined) {
      heightQuery = await viewer.queryTerrain([longitudeDegrees, latitudeDegrees],
        {sampleSpacingMeters:10, timeoutMs:30000, signal:controller.signal})
      if (!heightQuery.available || !Number.isFinite(heightQuery.heightMeters))
        throw new Error('Target ground height unavailable; provide a verified --height')
      heightMeters = heightQuery.heightMeters
    }
    const target = {longitudeDegrees, latitudeDegrees, heightMeters}
    const read = () => window.TerraVerticalScaleProbe.read(viewer)
    const configuration = read().configuration
    const samples = window.TerraVerticalScaleBenchmark.scales(configuration,
      options.maximumLevel === undefined ? configuration.maximumInternalLevel : options.maximumLevel)
    const hashes = {}
    for (const name of ['terra_browser_bundle.js','terra_worker.js','terra_sdk.wasm']) {
      const response = await fetch('/assets/' + name)
      if (!response.ok) throw new Error('Cannot fingerprint running SDK asset: ' + name)
      const bytes = await response.arrayBuffer()
      hashes[name] = {bytes:bytes.byteLength, sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2,'0')).join('')}
    }
    observer.observe({type:'resource', buffered:false})
    report = await window.TerraVerticalScaleBenchmark.run(viewer, {
      configuration, target, samples, read, timeoutMs:options.timeoutMs,
      signal:controller.signal,
      onStage(row) {
        record(observer.takeRecords())
        const bucket = () => ({completed:0, transferBytes:0, encodedBodyBytes:0, durationMs:0,
          maximumDurationMs:0, httpErrors:0, statusUnknown:0})
        row.network = activeNetwork = {terrain:bucket(), imagery:bucket()}
        document.body.dataset.benchmarkStage = row.direction + ':' + row.id
      },
      onStep(row, current) {
        record(observer.takeRecords())
        current.assets = hashes; current.heightQuery = heightQuery
        current.networkScope = 'Resource completions during each stage, including earlier requests; browser ResourceTiming bytes only'
        save(current)
      }
    })
    save(report)
    // Terminal means collection completed; the command separately evaluates
    // target success and set differences. A limited sample is never a pass.
    document.documentElement.dataset.terraEvidenceStatus = 'passed'
  } catch (error) {
    report = error.report || {schema:'terra.vertical-scale-benchmark.v1',status:'failed',error:error.message,steps:[]}
    save(report)
    document.documentElement.dataset.terraEvidenceStatus = 'failed'
  } finally {
    record(observer.takeRecords()); observer.disconnect(); controller.abort()
    window.removeEventListener('pagehide', abort)
    if (demo) demo.destroy()
    if (report) {report.viewerDestroyed = Boolean(demo); save(report)}
  }
})()
