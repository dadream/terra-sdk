const {WORKER_PROTOCOL}=require('../../adapters/wasm/worker_protocol')
const partitionSurface = require('../js/reference/partition_surface')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { Worker } = require('worker_threads')
const { TerrainWorkerClient } = require('../../adapters/wasm/terra_worker_client')
const { MeshFrames } = require('../../sdk/js/terrain/terra_mesh_frames')
const { TerraAbi, TerraGlobeRuntime, REQUEST_ROOT } = require('../../adapters/wasm/terra_globe_runtime')
const common = require('../../sdk/js/core/terra_globe_common')
const loader = require('../../adapters/wasm/terra_wasm')
const surfacePlan = require('../../sdk/js/terrain/terra_surface_plan')
const {MeasurementRows,releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')

async function main() {
  assert(process.argv[2], 'A Wasm build path is required')
  const wasmBytes = fs.readFileSync(process.argv[2])
  const hostPath = path.resolve(__dirname, '../../adapters/wasm/terra_worker_host.js')
  const thread = new Worker(`
    const { parentPort, MessageChannel } = require('worker_threads')
    let memory
    const instantiate=WebAssembly.instantiate.bind(WebAssembly)
    WebAssembly.instantiate=async(...args)=>{
      const loaded=await instantiate(...args);memory=(loaded.instance||loaded).exports.memory
      return loaded
    }
    const scope = { MessageChannel, postMessage(value,transfer) {
      if(value.type!=='fatal')require('assert').strictEqual(value.memoryBytes,memory?memory.buffer.byteLength:0,
        'Worker ownership differs from actual Wasm capacity')
      parentPort.postMessage(value,transfer)
    } }
    require(${JSON.stringify(hostPath)}).install(scope)
    parentPort.on('message', value => scope.onmessage({ data: value }))
  `, { eval: true })
  const adapter = { postMessage: (value, transfer) => thread.postMessage(value, transfer),
    terminate: () => thread.terminate() }
  thread.on('message', value => {
    adapter.onmessage({data:value})
    if(!client.destroyed&&value.type!=='fatal')assert.strictEqual(client.memoryBytes(),value.memoryBytes,
      'Received ownership did not update client memory immediately')
  })
  thread.on('error', error => adapter.onerror(error))
  const client = new TerrainWorkerClient(adapter)
  let oracle = null
  const manifest = { formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
    heightScale: 0.001953125, minimumU: -180, minimumV: -90,
    maximumU: 180, maximumV: 90, radius: 6378000,
    texture: { kind: 'global-geodetic', matrix_level_offset: 0, maximum_level: 8, minimum_level: 0,
      tile_size: 256, level_zero_columns: 2, level_zero_rows: 1,
      bounds: [[-180, -90], [180, 90]] } }
  const frames = new MeshFrames()
  let runtime = null
  let nativeRuntime = null
  const snapshots=new Set()
  try {
    oracle = new TerraAbi(await loader.instantiateTerraWasmBytes(wasmBytes))
    const bytes = new Uint8Array(wasmBytes).buffer
    client.wasmBytes = bytes.slice(0)
    await client.send({ type: 'initialize', protocol: WORKER_PROTOCOL, bytes }, [bytes])
    assert.strictEqual(bytes.byteLength, 0, 'Initialization must transfer ownership')
    await require('./height_credit_contract')(oracle, manifest, false)
    await require('./height_credit_contract')(client, manifest, true)
    await require('./native_record_contract')(oracle, manifest, false)
    await require('./native_record_contract')(client, manifest, true)
    const directQuery = await require('./height_query_contract')(oracle)
    const workerQuery = await require('./height_query_contract')(client, true)
    for (const name of ['heightMeters', 'sampleSpacingMeters', 'level', 'dataLevel'])
      assert.strictEqual(workerQuery[name], directQuery[name], 'Height query Worker parity: ' + name)
    await require('./shared_transfer_contract')(oracle, false)
    await require('./shared_transfer_contract')(client, true, frames.ledger)
    await require('./prepared_uv_contract').bootstrapWorker(client, manifest, fs.readFileSync(path.join(__dirname,
      '../../testdata/miniprogram/golden/globe_root_0_record.bin')), frames.ledger)
    const verifyRetention = require('./mesh_retention_contract')
    await verifyRetention(oracle, false)
    await verifyRetention(client, true, frames.ledger)
    const verifyGroups = require('./mesh_group_contract')
    await verifyGroups(oracle, false)
    await verifyGroups(client, true, frames.ledger)
    await verifyGroups(oracle, false, undefined, true)
    await verifyGroups(client, true, frames.ledger, true)
    await require('./candidate_imagery_contract')(client, manifest, fs.readFileSync(path.join(__dirname,
      '../../testdata/miniprogram/golden/globe_root_0_record.bin')))
    await require('./local_candidate_imagery_contract')(oracle, manifest, fs.readFileSync(path.join(__dirname,
      '../../testdata/miniprogram/golden/globe_root_0_record.bin')))
    await require('./terrain_empty_receipt_contract')(wasmBytes)
    await require('./terrain_world_admission_contract')(wasmBytes)
    await require('./native_imagery_recovery_contract')(wasmBytes)
    await require('./ordered_handoff_contract')(wasmBytes)
    await require('./completed_measurement_cache_contract')(wasmBytes)
    await client.loadManifest(manifest)
    oracle.loadManifest(manifest)
    // The funded 256-row bridge page survives a dataset reset. Equality to
    // that exact page excludes any retained dataset/model/row allocation.
    assert.strictEqual(client.imageryPayloadBytes(), 256 * 176 + 4,
      'Manifest replacement retained imagery beyond its persistent bridge page')
    assert.strictEqual(client.imageryInputPayloadBytes(), 256 * 176 + 4)
    client.setViewport(1280, 720, Math.PI / 6)
    oracle.setViewport(1280, 720, Math.PI / 6)
    const views = [
      { distance: 28000000 - manifest.radius, tiltRadians: 0, yawRadians: 0, longitudeDegrees: 0, latitudeDegrees: 0 },
      { distance: 15000000 - manifest.radius, tiltRadians: -0.5, yawRadians: 1.1, longitudeDegrees: 116.4074, latitudeDegrees: 39.9042 },
      { distance: 6500000 - manifest.radius, tiltRadians: -0.7, yawRadians: 2.4, longitudeDegrees: -179, latitudeDegrees: -67 }
    ]
    const close = (a, b) => assert(Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-12),
      `Camera mismatch: ${a} versus ${b}`)
    const lowViews = [-400, 0, 1600].flatMap(targetHeightMeters => [0, 80, 88].map(tilt => ({
      distance: 2, targetHeightMeters, tiltRadians: -tilt * Math.PI / 180, yawRadians: 1.1,
      longitudeDegrees: 116.5623, latitudeDegrees: 40.74863})))
    const eyeViews = [-60, 0, 60].flatMap(pitch => [0, 90, 180, 270].map(heading => ({
      model: 'eye', distance: 0, targetHeightMeters: 510, tiltRadians: -(90 + pitch) * Math.PI / 180,
      yawRadians: heading * Math.PI / 180, longitudeDegrees: 116.5623, latitudeDegrees: 40.74863})))
    views.concat(lowViews, eyeViews).forEach(view => {
      client.setCamera(view); client.setGlobeTarget(view.longitudeDegrees, view.latitudeDegrees)
      oracle.setCamera(view); oracle.setGlobeTarget(view.longitudeDegrees, view.latitudeDegrees)
      const preview = client.getCameraSnapshot(), expected = oracle.getCameraSnapshot()
      preview.cameraPosition.forEach((v, i) => close(v, expected.cameraPosition[i]))
      preview.projectionView.forEach((v, i) => close(v, expected.projectionView[i]))
    })
    client.setCamera(views[0]); client.setGlobeTarget(0, 0)
    const budget = { maximumChangeCount: 1, maximumPriorityUpdateCount: 2, maximumElapsedMs: 0 }
    const imagery = { descriptor: manifest.texture, targetPixelError: 1.25,
      maximumTextures: 64, maximumDraws: 256, devicePixelRatio: 1 }
    // Immutable projection measurements can outlive their source geometry.
    // Detached planning consumes those measurements without dereferencing it.
    const detachedDraw = {resourceId: 0xfffffffe, textureNode: {level: 0, root: 0, row: 0, column: 0}, texture: {level: 0, matrix: 0, row: 0, column: 0}}
    const detachedMeasure = () => ({visible: true, pixelsPerUv: 100,
      bounds: {minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1},
      hull: [[0,0], [1,0], [0,1]]})
    assert.throws(() => oracle.planImagery([detachedDraw], detachedMeasure, imagery), /Terra status 7/,
      'The normal Native path must still reject a missing nonzero mesh resource')
    const detachedPlan = oracle.planImagery([detachedDraw], detachedMeasure,
      Object.assign({}, imagery, {detached: true}))
    assert(detachedPlan.quality.planningComplete)
    assert.strictEqual(detachedPlan.draws[0].resourceId, detachedDraw.resourceId,
      'Detached Native input lost the renderer snapshot identity')
    const stepFrame = async () => {
      const result=await client.step(1,budget,frames,imagery)
      if(result.measurements)snapshots.add(result.measurements)
      return result
    }
    const planFrame = async (sequence, options) => {
      for (let round = 0; round < 2048; ++round) {
        const result = await client.planImagery(sequence, options)
        const credits=result.preparationWork&&result.preparationWork.measurementCredits
        if(credits)assert(credits.activeAllocations===0&&credits.heldGrantBytes===0&&credits.spentGrantBytes===0,
          'Worker returned reusable allocation permission across the RPC boundary')
        if (!result.pending && !result.continuation) {
          if(result.measurements)snapshots.add(result.measurements)
          return result
        }
        releaseMeasurements(result.measurements)
      }
      throw new Error('Bounded imagery measurements did not converge')
    }
    let packet = await stepFrame()
    assert(packet.updateState.priorityUpdateCount <= 2,
      'Publication must respect the native priority batch limit')
    assert(packet.frame.sequence >= 1, 'Worker did not publish terrain before imagery work')
    // No second cut may replace an unacknowledged display candidate.
    await assert.rejects(client.step(1, budget, frames), /awaiting presentation/)
    await assert.rejects(client.presentFrame(packet.frame.sequence + 1), /Stale Worker/)
    await client.discardFrame(packet.frame.sequence)
    frames.discard(packet.frame.sequence)
    const root = fs.readFileSync(path.join(__dirname,
      '../../testdata/miniprogram/golden/globe_root_0_record.bin'))
    packet.requests.forEach(request => {
      if (request.kind === REQUEST_ROOT) client.submitRecord(request.kind, request.key, root)
    })
    for (let step = 0; step < 16; ++step) {
      packet = await stepFrame()
      const candidate = packet
      assert(candidate.updateState.meshBytes <= candidate.updateState.maximumMeshBytes)
      assert(candidate.updateState.priorityUpdateCount <= 2)
      candidate.resources.forEach(resource => {
        assert(resource.positions.length > 0)
        assert(resource.model && resource.model.blocks.length > 0)
      })
      await client.presentFrame(packet.frame.sequence)
      frames.present(packet.frame.sequence)
      if (packet.frame.decisionsComplete) break
    }
    assert(packet.frame.decisionsComplete && packet.frame.coverageComplete)
    assert.strictEqual(packet.imageryPlan, undefined, 'Terrain publication waited for an imagery cut')
    const initialPlan = await planFrame(packet.frame.sequence, imagery)
    assert(initialPlan.preparationWork.measurementCredits.allocations>0,
      'Real Worker did not exercise native input batching')
    assert(client.imageryPayloadBytes() > 0, 'Real Worker omitted native imagery residency')
    assert.strictEqual(client.imageryReferenceBudget.actual, client.imageryReferencePayloadBytes())
    assert.strictEqual(client.imageryReferenceBudget.credits.size, 0)
    assert(client.imageryOutputPayloadBytes() > 0, 'Worker omitted immutable output ownership')
    assert.strictEqual(client.imageryOutputBudget.actual, client.imageryOutputPayloadBytes())
    assert.strictEqual(client.imageryOutputBudget.credits.size, 0)
    const referenceBytes = client.imageryReferencePayloadBytes()
    assert(referenceBytes > 0, 'Worker reclamation fixture has no index cache')
    const referenceReleased = await client.reclaimImageryReferences(referenceBytes)
    assert(referenceReleased > 0 && referenceReleased <= referenceBytes)
    assert.strictEqual(client.imageryReferenceBudget.actual,referenceBytes - referenceReleased)
    assert.deepStrictEqual((await planFrame(packet.frame.sequence, imagery)).imageryPlan.draws,
      initialPlan.imageryPlan.draws, 'Worker reclamation changed a published imagery cut')
    assert(client.imageryInputBudget.actual > 0 && !client.imageryInputBudget.credits.size,
      'Real Worker did not settle funded input ownership')
    assert(initialPlan.measurementHistory && initialPlan.measurementHistory.views <= 3)
    assert(initialPlan.measurementHistory.numericPayloadBytes <= initialPlan.measurementHistory.maximumNumericPayloadBytes)
    assert.deepStrictEqual(client.measurementHistory, initialPlan.measurementHistory)
    initialPlan.measurements.forEach(value => {
      assert(!('model' in value) && value.hull && value.bounds,
        'Worker projection transport lost its model-free coverage envelope')
      if(value.regions)assert(value.regions instanceof MeasurementRows,'Worker rebuilt per-row host objects')
    })
    assert(initialPlan.imageryPlan && initialPlan.imageryPlan.quality.spatialCut,
      'The Worker must calculate the imagery cut')
    assert.strictEqual(initialPlan.imageryPlan.quality.planner, 'terra-core')
    assert(initialPlan.imageryPlan.quality.selectedTextureCount <= imagery.maximumTextures)
    assert.strictEqual(frames.resources.size, 16)
    const copied = frames.copiedBytes
    packet = await stepFrame()
    assert.strictEqual(packet.additions.length, 0, 'A stable cut must not transfer meshes again')
    assert.strictEqual(packet.indices, frames.indices, 'Shared indices must be reused')
    assert.strictEqual(packet.updateState.priorityUpdateCount, 0)
    const heldCandidate = frames.candidate
    client.setCamera(views[1]); client.setGlobeTarget(views[1].longitudeDegrees, views[1].latitudeDegrees)
    let modelWork = 0
    for (let turn = 0; turn < 12; ++turn) {
      const advancement = await client.advanceTerrain(1, budget)
      modelWork += advancement.progress.priorityUpdateCount
      assert(advancement.progress.priorityUpdateCount <= 2)
      assert(Number.isInteger(advancement.progress.topologyChangeCount) &&
        advancement.progress.topologyChangeCount <= budget.maximumChangeCount,
        'Worker omitted or exceeded native topology change accounting')
      assert.strictEqual(advancement.progress.sequence, packet.frame.sequence)
      assert.strictEqual(advancement.frame, undefined, 'Model work published another frame')
      assert.strictEqual(advancement.additions, undefined, 'Model work transferred mesh content')
    }
    assert(modelWork > 0, 'The Worker did not advance priorities behind a held candidate')
    assert.strictEqual(frames.candidate, heldCandidate)
    assert.strictEqual(frames.copiedBytes, copied)
    client.setCamera(views[0]); client.setGlobeTarget(0, 0)
    for (let turn = 0; turn < 12; ++turn) await client.advanceTerrain(1, budget)
    await client.presentFrame(packet.frame.sequence)
    frames.present(packet.frame.sequence)
    assert.strictEqual(frames.copiedBytes, copied)
    await assert.rejects(planFrame(packet.frame.sequence, Object.assign({}, imagery, {
      descriptor: Object.assign({}, imagery.descriptor, { maximum_level: 29 })
    })), /imagery cut|terra_(plan|begin)_imagery|Invalid imagery/)
    packet = await stepFrame()
    await client.presentFrame(packet.frame.sequence)
    frames.present(packet.frame.sequence)
    assert.strictEqual(packet.additions.length, 0,
      'A failed imagery plan must preserve displayed terrain resources')
    const independent = await planFrame(packet.frame.sequence,
      Object.assign({}, imagery, { maximumTextures: 128 }))
    assert.strictEqual(independent.sequence, packet.frame.sequence)
    assert(independent.imageryPlan.quality.selectedTextureCount <= 128)
    let progressive = independent, continuations = 0
    while (progressive.imageryPlan.quality.planningComplete === false) {
      progressive = await planFrame(packet.frame.sequence, Object.assign({}, imagery, { maximumTextures: 128 }))
      assert(++continuations < 256, 'Independent imagery did not converge')
    }
    assert(progressive.imageryPlan.quality.meetsTarget || progressive.imageryPlan.quality.limitedByBudget,
      'Imagery stopped before satisfying or explaining its original demand')
    const superseded = await client.send({ type: 'imagery', sequence: packet.frame.sequence,
      imagery, camera: Object.assign({}, client.camera, client.target), viewport: client.viewport,
      viewRevision: client.viewRevision - 1 })
    assert.strictEqual(superseded.superseded, true, 'Obsolete camera work was not superseded')
    assert.strictEqual(frames.copiedBytes, copied, 'Imagery continuation copied unchanged terrain')
    assert.strictEqual(independent.additions, undefined, 'Imagery continuation produced a terrain candidate')
    await assert.rejects(client.planImagery(packet.frame.sequence-1, imagery), /Stale imagery frame/)
    const resource = frames.resources.values().next().value
    const cells = [
      { key: 'left', sourceUv: true, bounds: { minimumU: 0, maximumU: 0.5, minimumV: 0, maximumV: 1 } },
      { key: 'right', sourceUv: true, bounds: { minimumU: 0.5, maximumU: 1, minimumV: 0, maximumV: 1 } }
    ]
    const expectedParts = partitionSurface(resource.model, cells)
    const costs = await client.createPartitionPlanTask(resource.resourceId, cells).promise
    assert.deepStrictEqual(costs, cells.map(cell => {
      const part = expectedParts.find(part => part.cell.key === cell.key)
      return {key: cell.key, bytes: part ? part.positions.byteLength + part.uv.byteLength + part.indices.byteLength : 0}
    }), 'Worker cost-only plan differs from actual immutable output')
    const cancelledPlan = client.createPartitionPlanTask(resource.resourceId, cells)
    cancelledPlan.cancel()
    assert.strictEqual(await cancelledPlan.promise, null, 'Cancelled cost plan was published')
    const requiredBytes = expectedParts.reduce((n, part) => n + part.positions.byteLength + part.uv.byteLength + part.indices.byteLength, 0)
    assert.deepStrictEqual(await client.createPartitionTask(resource.resourceId, cells, requiredBytes - 1).promise,
      {limited: true, requiredBytes}, 'Worker allocated output beyond the receiver credit')
    const parts = await client.createPartitionTask(resource.resourceId, cells, requiredBytes).promise
    assert.deepStrictEqual(parts, expectedParts, 'Worker partitions differ from the surface oracle')
    assert(parts.length > 0 && parts.some(part => part.indices.length > 0))
    assert(parts.every(part => !part.positions.length && !part.uv.length), 'Worker duplicated source vertices')
    assert.strictEqual(client.pending.size, 0)
    // The same preview contract applies to the planar fallback path.
    const planar = Object.assign({}, manifest, { transform: 'planar', radius: 0,
      minimumU: 0, minimumV: 0, maximumU: 1000, maximumV: 2000,
      texture: Object.assign({}, manifest.texture, { kind: 'planar-single', maximum_level: 0,
        level_zero_columns: 1, bounds: [[0, 0], [1000, 2000]] }) })
    for(const snapshot of snapshots)releaseMeasurements(snapshot)
    snapshots.clear()
    await client.loadManifest(planar)
    assert.strictEqual(client.imageryPayloadBytes(), 256*176+4, 'Worker manifest reset kept imagery beyond its bridge page')
    assert.strictEqual(client.imageryInputBudget.actual, 256*176+4, 'Manifest reset retained input beyond its bridge page')
    oracle.loadManifest(planar)
    const view = { distance: 3500, tiltRadians: -0.7, yawRadians: 1.3, x: 300, y: 1200 }
    client.setCamera(view); client.setPlanarTarget(view.x, view.y)
    oracle.setCamera(view); oracle.setPlanarTarget(view.x, view.y)
    const preview = client.getCameraSnapshot(), expected = oracle.getCameraSnapshot()
    preview.projectionView.forEach((v, i) => close(v, expected.projectionView[i]))

    // Exercise the production Runtime branch with a real Worker and offline
    // records. The renderer acknowledges only from its simulated GPU phase.
    const rawManifest = { schema: 'terra.dataset-manifest', schema_version: 1,
      dataset_id: 'worker-contract', format_version: 1, patch_dim: 64, height_scale: manifest.heightScale,
      transform: { kind: 'cylindrical', radius: manifest.radius, bounds: [[-180, -90], [180, 90]] },
      endpoints: { root: '/root/{i}/{j}/{k}', detail: '/detail/{i}/{j}/{k}' },
      textures: [Object.assign({}, manifest.texture, { id: 'offline', kind: 'global-geodetic',
        url_template: 'https://tiles.example/{z}/{x}/{y}.jpg' })] }
    let renderer
    let rootRequestCount = 0
    runtime = await TerraGlobeRuntime.create({ abi: client, manifest: rawManifest,
      serviceOrigin: 'http://localhost:18080',
      viewport: { width: 320, height: 180, devicePixelRatio: 1 },
      canvas: { requestAnimationFrame: callback => setTimeout(callback, 0) },
      maximumTerrainRequests: 3, terrainRefreshBatchMs: 0,
      terrainRefreshMaximumDelayMs: 0,
      cameraSettleDelayMs: 0, terrainUpdateBudget: budget,
      request: options => ({ promise: new Promise(resolve => setTimeout(() => resolve({
        statusCode: options.url.includes('/root/') ? 200 : 404,
        data: new Uint8Array(root).buffer,
        header: { 'Content-Length': String(root.byteLength), 'X-Terra-Checksum': `fnv1a64:${common.fnv1a64(root)}` }
      }), options.url.includes('/root/') && ++rootRequestCount >= 7 ? 350 : 0)), abort() {} }),
      rendererFactory: (canvas, options) => {
        renderer = { frames: [], previews: [], capabilities: () => ({}),
          resize() {}, setBudget() {},
          beginCandidateForecast() {},
        admitCandidate(packet) { return this.reserveMeshOutputs(packet,0) },
        prepareMeshOutputs() { return null },
          reserveMeshOutputs(packet, bytes) {
            const credit = options.resourceLedger.reserve('mesh-transfer', bytes)
            return credit && {credit, valid: () => true, release() {}}
          },
          terrainRefinementDemand() { return {sequence: this.current ? this.current.sequence : 0, bytes: 0, keep: []} },
          reserveImageryDemand() { return true },
          setMeshFrame(frame, draws, resources, indices, updateState, imageryPlan, measurements, presentation) {
            this.current = Object.assign({}, frame, presentation && presentation.camera)
            this.frames.push({ frame: this.current, selectionFrame: frame, draws, resources, presentation, updateState })
          },
          setCameraFrame(snapshot) { this.previews.push(snapshot) },
          holdCandidate() { return null }, discardCandidate() {}, releaseCandidate() {},
          advanceResources() {},
          render() { if (!this.hold && this.current && this.current.coverageComplete) options.onPresented(this.current.sequence) },
          stats: () => ({}), destroy() {}
        }
        return renderer
      }
    })
    const waitFor = async (message, predicate) => {
      const deadline = Date.now() + 3000
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      assert(predicate(), `${message}: ${JSON.stringify(runtime.state())}`)
    }
    await waitFor('Runtime did not settle its initial Worker cut', () =>
      runtime.lastFrame && runtime.lastFrame.decisionsComplete && runtime.presentedSurface &&
      !runtime.refreshing && !runtime.meshFrames.candidate)
    assert(runtime.meshFrames.presented.resources.size > 0)
    assert(renderer.frames.some(entry => entry.frame.drawCount > 0 && !entry.frame.coverageComplete),
      'The delayed root fixture must exercise a populated incomplete coverage candidate')
    assert(runtime.meshFrames.presented.updateState.meshBytes <= runtime.meshFrames.presented.updateState.maximumMeshBytes)
    renderer.hold = true
    runtime.applyInteraction({headingDegrees: 30})
    await waitFor('Runtime did not prepare a held candidate', () => runtime.meshFrames.candidate && !runtime.refreshing)
    const heldSequence = runtime.meshFrames.candidate.frame.sequence
    const heldCopies = runtime.meshFrames.copiedBytes, heldFrames = renderer.frames.length
    runtime.scheduleRefresh()
    await waitFor('Blocked presentation prevented background model convergence', () =>
      runtime.terrainProgress && runtime.terrainProgress.progress.pendingPriorityUpdateCount === 0 && !runtime.refreshing)
    // Let already-owned camera/IO timers drain, then prove a settled model parks.
    await new Promise(resolve => setTimeout(resolve, 100))
    const parkedCount = runtime.performanceStats.modelAdvance.count
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.strictEqual(runtime.performanceStats.modelAdvance.count, parkedCount,
      'A settled model polled the presentation barrier')
    assert(parkedCount > 0)
    assert.strictEqual(renderer.frames.length, heldFrames)
    assert.strictEqual(runtime.meshFrames.copiedBytes, heldCopies)
    runtime.applyInteraction({headingDegrees: 20})
    await waitFor('A new camera failed to wake a parked model', () =>
      runtime.performanceStats.modelAdvance.count > parkedCount && !runtime.refreshing)
    assert.strictEqual(runtime.meshFrames.candidate.frame.sequence, heldSequence)
    runtime.pause()
    const pausedCount = runtime.performanceStats.modelAdvance.count
    runtime.scheduleRefresh()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.strictEqual(runtime.performanceStats.modelAdvance.count, pausedCount)
    renderer.hold = false
    runtime.resume()
    await waitFor('Real submission did not release the candidate after model advancement', () =>
      runtime.presentedFrame && runtime.presentedFrame.sequence >= heldSequence &&
      !runtime.refreshing && !runtime.meshFrames.candidate)
    runtime.setInteractionActive(true)
    const beforeStale = renderer.frames.length
    const originalStep = client.step
    client.step = async function (...args) {
      const packet = await originalStep.apply(this, args)
      // Force movement after native construction, before main-thread adoption.
      runtime.applyInteraction({headingDegrees: 15})
      return packet
    }
    try { await runtime.refresh() } finally { client.step = originalStep }
    assert(renderer.previews.length > 0, 'Camera preview must remain synchronous while the Worker runs')
    assert.strictEqual(renderer.frames.length, beforeStale + 1,
      'A completed reusable model was discarded because its selection camera changed')
    const adopted = renderer.frames[renderer.frames.length - 1]
    assert.strictEqual(adopted.presentation.selectionCurrent, false,
      'A lagging selection was falsely declared current')
    adopted.frame.projectionView.forEach((v,i) => close(v, client.getCameraSnapshot().projectionView[i]))
    let moving = setInterval(() => runtime.applyInteraction({headingDegrees: 0.1}), 2)
    try {
      await waitFor('Continuous input starved terrain publication', () => renderer.frames.length >= beforeStale + 4)
    } finally { clearInterval(moving) }
    runtime.setInteractionActive(false)
    await waitFor('Runtime did not present the latest camera', () => renderer.frames.length > beforeStale &&
      !runtime.refreshing && !runtime.meshFrames.candidate)
    const resourcesBeforePause = runtime.meshFrames.resources.size
    runtime.pause()
    assert(runtime.scheduler.paused)
    runtime.resume()
    await waitFor('Runtime did not resume', () => !runtime.refreshing && !runtime.meshFrames.candidate)
    assert(runtime.meshFrames.resources.size >= resourcesBeforePause)
    nativeRuntime = await TerraGlobeRuntime.create(Object.assign({}, runtime.options, {
      abi: oracle, terrainUpdateBudget: {maximumPriorityUpdateCount: 1,
        maximumChangeCount: 0, maximumElapsedMs: 0, maximumNodeCount: 8}
    }))
    oracle = null // Native Runtime now owns its Wasm context.
    nativeRuntime.setInteractionActive(true)
    for (let i = 0; i < 32; ++i) {
      nativeRuntime.applyInteraction({headingDegrees: 0.1})
      await nativeRuntime.refresh()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const nativeFrames = nativeRuntime.renderer.frames
    assert(nativeFrames.some(entry => entry.updateState.pendingPriorityUpdateCount > 0),
      'The single-priority fixture did not exercise a split scan')
    assert(nativeFrames.some(entry => entry.updateState.pendingPriorityUpdateCount === 0 &&
      !entry.presentation.selectionCurrent), 'Continuous input prevented native scan completion')
    nativeFrames.forEach(entry => {
      assert(entry.frame.projectionView === entry.presentation.camera.projectionView,
        'The native path presented a selection camera instead of the live camera')
    })
  } finally {
    if (nativeRuntime) await nativeRuntime.destroy()
    if (runtime) await runtime.destroy()
    for(const snapshot of snapshots)releaseMeasurements(snapshot)
    frames.clear()
    if (oracle) oracle.destroy()
    try {await client.destroy()}finally{await thread.terminate()}
  }
  console.log('Terrain Worker transfer, camera parity, and presentation contracts passed.')
}

main().catch(error => { console.error(error.stack); process.exitCode = 1 })
