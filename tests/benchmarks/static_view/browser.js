'use strict'
const report = {schema:'terra.static-view.v1', status:'running', sdkProductAccepted:false,
  samples:[], errors:[], rpc:{}, postCreation:{plans:0, meshes:0},
  scope:'Cold fixed view, public entry and actual WebGL; verified offline terrain and one PNG. RPC wall sums overlap and are not critical-path CPU time.'}
const output = document.getElementById('report'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (value, message) => {if (!value) throw new Error(message)}
function save(final = false) {
  output.textContent = JSON.stringify(final ? report : {status:report.status, backend:report.backend,
    postCreation:report.postCreation, sample:report.samples[report.samples.length - 1]})
}
let viewer, presentation, terrain
async function main() {
  const [test, catalogue, payload] = await Promise.all(['case.json','terrain.json','terrain.bin'].map(
    p => fetch(p).then(r => p.endsWith('.bin') ? r.arrayBuffer() : r.json())))
  const {config, dataset, options} = test, sdk = window.TerraWebSdk
  const backend = new URL(location.href).searchParams.get('backend')
  check(['worker','direct'].includes(backend), 'Unknown execution backend')
  report.backend = backend; report.configuration = config; report.observationSeconds = options.observationSeconds
  dataset.textures[0].url_template = location.origin + '/tile.png?z={z}&x={x}&y={y}'
  terrain = window.TerraNavigationTerrain.create(catalogue, payload, sdk.common.fnv1a64)
  const canvas = document.createElement('canvas')
  canvas.width = config.viewport.width; canvas.height = config.viewport.height
  try {
    presentation = window.TerraCanvasPresentation.mount(canvas, config.viewport)
    // Both entries fetch/compile the same Wasm inside timed viewer creation.
    const start = performance.now()
    viewer = await sdk.viewer.TerraViewer.create({mode:'globe', canvas, dataset, request:terrain.request,
      serviceOrigin:'https://terrain.example', wasmUrl:location.origin + '/terra_sdk.wasm',
      workerUrl:backend === 'worker' ? location.origin + '/terra_worker.js' : undefined,
      initialView:config.view, viewport:config.viewport, verticalFovRadians:config.verticalFovRadians,
      terrainPixelError:config.terrainPixelError, imageryPixelError:config.imageryPixelError, ...options.capacity,
      onDiagnostic(kind, detail) {
        if (['frame_callback_failed','imagery_refresh_failed','runtime_refresh_failed','terrain_worker_failed',
          'terrain_advance_failed','webgl_allocation_failed','webgl_context_restore_failed'].includes(kind))
          report.errors.push({kind, detail})
      }})
    const runtime = viewer.runtime, renderer = runtime.renderer, gl = renderer.gl
    report.decoderTasks = {configured:renderer.textures.maximumPreparationTasks}
    if (options.decodeTasks !== undefined) {
      check(options.decodeTasks <= renderer.textures.maximumPreparationTasks, 'Diagnostic cap exceeds the configured decoder count')
      renderer.textures.maximumPreparationTasks = options.decodeTasks
    }
    report.decoderTasks.effective = renderer.textures.maximumPreparationTasks
    check(Boolean(runtime.abi.isWorker) === (backend === 'worker'), 'Wrong execution backend')
    report.effectiveCapacity = {...config.expectedCapacity, ...options.capacity}
    for (const [key, value] of Object.entries(report.effectiveCapacity))
      check(runtime.resourcePolicy[key === 'maximumPartitionBytes' ? 'partitionCacheBytes' : key] === value,
        'SDK effective capacity differs from the requested/default value: ' + key)
    const extension = gl.getExtension('WEBGL_debug_renderer_info')
    report.renderer = gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
    report.createdMs = performance.now() - start
    const restores = [], wrap = (object, name, fn) => {
      const original = object[name]; object[name] = function(...args) {return fn.call(this, original, args)}
      restores.push(() => {object[name] = original})
    }
    wrap(renderer, 'setMeshFrame', function(fn, args) {
      report.postCreation.firstCompleteForLastMeshMs = null
      const value = fn.apply(this, args); ++report.postCreation.meshes
      report.postCreation.lastMeshMs = performance.now() - start; return value
    })
    wrap(renderer, 'setImageryPlan', function(fn, args) {
      const value = fn.apply(this, args)
      if (!value) return value
      ++report.postCreation.plans
      if (args[1].quality.planningComplete && args[1].quality.cameraCurrent !== false) {
        const elapsed = performance.now() - start
        report.postCreation.lastCompletePlanMs = elapsed
        if (report.postCreation.firstCompleteForLastMeshMs == null)
          report.postCreation.firstCompleteForLastMeshMs = elapsed
      }
      return value
    })
    if (runtime.abi.isWorker) wrap(runtime.abi, 'send', function(fn, args) {
      const before = performance.now(), message = args[0]
      return fn.apply(this, args).then(value => {
        const kind = message.type + (message.type === 'imagery' ? ':' +
          (['input','reference','output'].find(k => value && value[k + 'Work']) || 'other') : '')
        const row = report.rpc[kind] || (report.rpc[kind] = {count:0, wallMs:0})
        ++row.count; row.wallMs += performance.now() - before; return value
      })
    })
    const pipeline = options.tracePipeline ? window.TerraStaticPipeline.installPipelineTrace(
      renderer, () => performance.now() - start) : null
    if (pipeline) report.pipeline = pipeline.trace
    try {
      let stable = null, last = -1000, identity = null
      for (;;) {
        await sleep(100); terrain.assertComplete()
        if (pipeline) pipeline.sample()
        const state = viewer.getState(), q = window.TerraVerticalScaleBenchmark.quality(state)
        check(!runtime.lastError && !report.errors.length, 'Runtime failure')
        check(JSON.stringify(state.view) === JSON.stringify(config.view), 'Camera changed')
        check(!state.resourceMemory.overBudgetBytes, 'Managed resource limit exceeded')
        const elapsed = performance.now() - start, selection = state.terrainSelection
        const next = JSON.stringify([selection.presentedSequence, selection.presentedModelRevision,
          selection.desiredViewRevision, selection.presentedViewRevision])
        if (q.terminal !== 'ready' || next !== identity) stable = null
        identity = next
        if (q.terminal === 'ready' && stable === null) stable = elapsed
        if (elapsed - last >= 1000) {
          report.samples.push({timeMs:elapsed, quality:q, terrainNodes:state.resources.topologyNodeCount,
            targetImages:state.renderer.textures.targetDesired, activeImages:state.renderer.textures.active,
            queuedImages:state.renderer.textures.queued, managedBytes:state.resourceMemory.bytes,
            highWaterBytes:state.resourceMemory.highWaterBytes})
          last = elapsed; save()
        }
        if (elapsed >= config.acceptanceMs && !report.atDeadline) report.atDeadline = {timeMs:elapsed, quality:q}
        if (stable !== null && elapsed - stable >= config.stableMs) {report.settled = true; break}
        if (elapsed >= options.observationSeconds * 1000) {report.settled = false; break}
      }
      report.durationMs = performance.now() - start
      report.withinOriginalDeadline = report.settled && report.durationMs <= config.acceptanceMs
      report.final = window.TerraVerticalScaleProbe.read(viewer)
      report.quality = window.TerraVerticalScaleBenchmark.quality(report.final.state)
      report.status = 'collected'
    } finally {
      if (pipeline) pipeline.close()
      restores.reverse().forEach(restore => restore())
    }
  } finally {
    if (viewer) {
      viewer.destroy()
      if (viewer.runtime.abi.termination) await viewer.runtime.abi.termination
      const deadline = performance.now() + 2000
      while (viewer.runtime.resourceLedger.bytes && performance.now() < deadline) await sleep(20)
    }
    if (presentation) presentation.release()
    report.terrain = terrain.stats()
    report.cleanup = {runtimeDestroyed:!viewer || viewer.runtime.destroyed,
      managedBytes:viewer ? viewer.runtime.resourceLedger.bytes : 0,
      producerStopped:!viewer || (report.backend === 'worker' ? Boolean(viewer.runtime.abi.termination) : viewer.runtime.abi.destroyed),
      canvasRemoved:!canvas.isConnected}
    save(true)
  }
  check(report.cleanup.managedBytes === 0 && report.cleanup.producerStopped, 'Incomplete producer cleanup')
  document.documentElement.dataset.terraStatus = 'passed'
}
main().catch(error => {
  report.status = 'failed'; report.error = error.stack || String(error); save(true)
  document.documentElement.dataset.terraStatus = 'failed'
})
