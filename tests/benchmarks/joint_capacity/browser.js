'use strict'

const report = {schema:'terra.joint-capacity.v1', status:'running', steps:[], errors:[],
  sdkProductAccepted:false,
  scope:'Canonical route or prefix, public Worker and actual WebGL. Verified offline terrain, nominal Tianditu grid and one local PNG; no live source or device performance acceptance.'}
const output = document.getElementById('report')
let lastProgress = -Infinity
function save(final = false) {
  if (!final && performance.now() - lastProgress < 1000) return
  lastProgress = performance.now()
  // Never lay out/render multi-megabyte lease graphs during a timed sample.
  // CDP polls this element too; expose bounded progress until collection ends.
  output.textContent = JSON.stringify(final ? report : {status:report.status,
    current:report.current, completed:report.steps.map(step => ({id:step.id,
      settled:step.settled, durationMs:step.durationMs, quality:step.quality}))})
}
const check = (value, message) => {if (!value) throw new Error(message)}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let viewer, presentation, terrain, canvas

async function main() {
  const [test, catalogue, payload] = await Promise.all(['case.json','terrain.json','terrain.bin'].map(
    file => fetch(file).then(response => file.endsWith('.bin') ? response.arrayBuffer() : response.json())))
  const {config, poses, dataset, options} = test, sdk = window.TerraWebSdk
  const ownership = window.TerraJointOwnership, visibility = window.TerraJointVisibility
  report.case = test.case; report.options = options; report.canonicalPoseCount = test.canonicalPoseCount
  report.acceptanceSeconds = test.acceptanceSeconds; report.poses = poses
  dataset.textures[0].url_template = location.origin + '/tile.png?z={z}&x={x}&y={y}'
  terrain = window.TerraNavigationTerrain.create(catalogue, payload, sdk.common.fnv1a64)
  canvas = document.createElement('canvas'); canvas.width = config.viewport.width; canvas.height = config.viewport.height
  presentation = window.TerraCanvasPresentation.mount(canvas, config.viewport)
  try {
    viewer = await sdk.viewer.TerraViewer.create({mode:'globe', canvas, dataset, request:terrain.request,
      serviceOrigin:'https://terrain.example', wasmUrl:location.origin + '/terra_sdk.wasm',
      workerUrl:location.origin + '/terra_worker.js', initialView:poses[0], viewport:config.viewport,
      verticalFovRadians:config.verticalFovRadians, terrainPixelError:config.terrainPixelError,
      imageryPixelError:config.imageryPixelError,
      ...visibility.viewerOptions(options.visibility),
      ...(options.useSdkDefaults ? {} : {maximumTerrainMeshBytes:options.terrainMeshBytes,
        maximumResourceBytes:options.managedBytes}),
      onDiagnostic(kind, detail) {
        if (['frame_callback_failed','imagery_refresh_failed','runtime_refresh_failed',
          'terrain_worker_failed','terrain_advance_failed',
          'webgl_allocation_failed','webgl_context_restore_failed'].includes(kind)) report.errors.push({kind, detail})
      }})
    const runtime = viewer.runtime, gl = runtime.renderer.gl, extension = gl.getExtension('WEBGL_debug_renderer_info')
    report.effectiveCapacity = {terrainMeshBytes:runtime.resourcePolicy.maximumTerrainMeshBytes,
      managedBytes:runtime.resourcePolicy.maximumResourceBytes}
    check(report.effectiveCapacity.terrainMeshBytes === options.terrainMeshBytes &&
      report.effectiveCapacity.managedBytes === options.managedBytes, 'Effective SDK capacities differ from the expected profile')
    report.renderer = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    check(runtime.abi.worker, 'Public entry did not use Worker')
    const read = () => window.TerraVerticalScaleProbe.read(viewer)
    const quality = observation => window.TerraVerticalScaleBenchmark.quality(observation.state)
    const terminal = q => q.current && q.covered && q.terrainMet && (q.terminal === 'ready' ||
      q.terminal === 'data-limited' && q.reasons.length === 1 && q.reasons[0] === 'source-level')
    for (const pose of poses) {
      viewer.camera.setView(pose)
      const start = performance.now(), timeline = []
      let stableAt = null, settled = false, observation, q, cameraCheck, peak = 0, lastSample = -5000
      let acceptanceSnapshot = null
      do {
        await sleep(100); observation = read(); q = quality(observation)
        const elapsedMs = performance.now() - start
        check(observation.configuration.viewport.physicalWidth === config.viewport.width &&
          observation.configuration.viewport.physicalHeight === config.viewport.height, 'Viewport differs')
        peak = Math.max(peak, observation.metrics.managedBytes)
        check(peak <= options.managedBytes, 'Joint managed budget exceeded')
        if (runtime.lastError) {
          const error = runtime.lastError
          report.runtimeError = {message:error.message || String(error), stack:error.stack, status:error.status}
        }
        check(!runtime.lastError && !report.errors.length, 'Runtime failed')
        terrain.assertComplete()
        const actual = runtime.abi.getCameraSnapshot(), expected = pose.expectedCamera
        cameraCheck = {
          positionErrorMeters:Math.max(...expected.cameraPosition.map((value, i) => Math.abs(value - actual.cameraPosition[i]))),
          projectionViewRelativeError:Math.max(...expected.projectionView.map((value, i) =>
            Math.abs(value - actual.projectionView[i]) / Math.max(1, Math.abs(value))))}
        const aligned = cameraCheck.positionErrorMeters <= 1e-6 && cameraCheck.projectionViewRelativeError <= 1e-10
        if (aligned && terminal(q)) {if (stableAt === null) stableAt = performance.now()} else stableAt = null
        settled = stableAt !== null && performance.now() - stableAt >= 500
        const sample = {elapsedMs, quality:q, metrics:observation.metrics,
          reclamation:runtime.resourceLedger.reclamation.stats(), rpc:Array.from(runtime.abi.pending.values(), v => v.type)}
        if (elapsedMs - lastSample >= 5000) {
          timeline.push({...sample, performance:observation.state.performance,
            rendererPerformance:observation.state.renderer.performance,
            transition:observation.state.renderer.transition})
          lastSample = elapsedMs
        }
        if (!acceptanceSnapshot && elapsedMs >= 30000) acceptanceSnapshot = sample
        report.current = {id:pose.id, ...sample, cameraCheck}; save()
        if (settled) break
      } while (performance.now() - start < options.observationSeconds * 1000)
      const durationMs = performance.now() - start, snapshot = ownership.read(runtime)
      const keys = observation.sets.terrain, reference = pose.reference.visibleKeys
      const nativeRequired = runtime.meshFrames.presented ? window.TerraNativeResidency(runtime.meshFrames.presented.draws) : null
      const step = {id:pose.id, settled, durationMs, withinOriginalDeadline:settled && durationMs <= 30000,
        acceptanceSnapshot, cameraCheck, quality:q, sampledPeakBytes:peak, final:observation,
        ownership:snapshot, evictionClosure:ownership.analyze(snapshot), nativeRequired,
        visibility:visibility.read(runtime),
        timeline, referenceComparison:{nodes:observation.metrics.terrainNodes, referenceNodes:pose.reference.nodes,
          extra:keys.filter(key => !reference.includes(key)), missing:reference.filter(key => !keys.includes(key))}}
      report.steps.push(step); save()
      if (!settled) break
    }
    report.routePrefixCompleted = report.steps.length === poses.length && report.steps.every(step => step.settled)
    report.withinOriginalDeadline = report.routePrefixCompleted && report.steps.every(step => step.withinOriginalDeadline)
    report.fullRouteCompleted = report.routePrefixCompleted && poses.length === test.canonicalPoseCount
    // Only after every primary sample. This uses existing production Native
    // cache reclamation; no forced renderer release or pause changes ownership.
    if (report.routePrefixCompleted) {
      const before = ownership.read(runtime), frame = runtime.meshFrames.presented
      const required = window.TerraNativeResidency(frame.draws), beforeSets = read().sets
      const nativeBefore = runtime.abi.nativeBudget.actual
      const releasedBytes = await runtime.abi.send({type:'trim-native', needed:nativeBefore})
      await sleep(500)
      const after = ownership.read(runtime), afterObservation = read()
      report.finalNativeTrim = {required, beforeBytes:nativeBefore, releasedBytes,
        afterBytes:runtime.abi.nativeBudget.actual, before, after,
        afterEvictionClosure:ownership.analyze(after),
        sameFrame:frame === runtime.meshFrames.presented,
        sameSets:JSON.stringify(beforeSets) === JSON.stringify(afterObservation.sets),
        quality:quality(afterObservation),
        note:'Native mesh cache only; no claim that all remaining shared allocations are required or that pixels were compared'}
      if (options.reclaimIdle) {
        const capture = async () => {
          let result
          await window.TerraReadback(runtime.renderer, {accept:() => {
            const width = canvas.width, height = canvas.height, bytes = new Uint8Array(width * height * 4)
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
            let hash = 0x811c9dc5
            const colors = new Set()
            for (let i = 0; i < bytes.length; ++i) {hash ^= bytes[i]; hash = Math.imul(hash, 0x01000193)}
            for (let i = 0; i < bytes.length; i += 212) colors.add(bytes.subarray(i, i + 3).join(','))
            result = {bytes, summary:{width, height, fnv1a32:hash >>> 0, sampledColorCount:colors.size}}
            return true
          }})
          return result
        }
        report.idleReclamation = await window.TerraJointReclamation.run({runtime,
          snapshot:() => ownership.read(runtime), analyze:ownership.analyze,
          observation:read, quality, capture, waitIdle:async () => {
            const started = performance.now()
            while (!terminal(quality(read())) && performance.now() - started < 2000) await sleep(20)
            return performance.now() - started
          }, publish:value => {report.idleReclamation = value}})
      }
    }
    report.status = 'collected'
  } finally {
    if (viewer) {
      const started = performance.now(); report.beforeDestroy = ownership.read(viewer.runtime)
      viewer.destroy()
      if (viewer.runtime.abi.termination) await viewer.runtime.abi.termination
      while (viewer.runtime.resourceLedger.bytes && performance.now() - started < 2000) await sleep(20)
      report.afterProducerDrain = {elapsedMs:performance.now() - started, ...ownership.read(viewer.runtime)}
    }
    if (presentation) presentation.release()
    report.cleanup = {runtimeDestroyed:!viewer || viewer.runtime.destroyed,
      managedBytes:viewer ? viewer.runtime.resourceLedger.bytes : 0,
      workerTerminated:!viewer || Boolean(viewer.runtime.abi.termination), canvasRemoved:!canvas.isConnected}
    report.terrain = terrain.stats(); save(true)
  }
  check(report.cleanup.managedBytes === 0 && report.cleanup.workerTerminated, 'Incomplete cleanup')
  document.documentElement.dataset.terraStatus = 'passed'; save(true)
}
main().catch(error => {
  report.status = 'failed'; report.error = error.stack || String(error); save(true)
  document.documentElement.dataset.terraStatus = 'failed'
})
