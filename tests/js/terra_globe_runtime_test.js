const nativeFixture = require('./reference/native_mesh_fixture')
const assert = require('assert')
const verifyLocalImageryGrants=require('./local_imagery_grants_test')

const common = require('../../sdk/js/core/terra_globe_common')
const runtimeModule = require('../../adapters/wasm/terra_globe_runtime')
const imageryProfiles = require('../../sdk/js/imagery/terra_imagery_profiles')

const recordRequest = {
  kind: runtimeModule.REQUEST_ROOT,
  key: { level: 0, i: 0, j: 134217728, k: 134217728 }
}

function manifest() {
  return {
    schema: 'terra.dataset-manifest',
    schema_version: 1,
    dataset_id: 'globe',
    format_version: 1,
    patch_dim: 64,
    height_scale: 1,
    transform: {
      kind: 'cylindrical',
      bounds: [[-180, -90], [180, 90]],
      radius: 6378000
    },
    endpoints: {
      root: '/terra/v1/datasets/globe/root/{i}/{j}/{k}',
      detail: '/terra/v1/datasets/globe/detail/{i}/{j}/{k}'
    },
    textures: [{
      id: 'blue-marble',
      kind: 'global-geodetic',
      url_template: 'https://tiles.example/{z}/{x}/{y}.jpg',
      matrix_level_offset: 0,
      maximum_level: 8
    }]
  }
}

function payload() {
  return new Uint8Array([1, 2, 3, 4, 5])
}

function response(bytes) {
  return {
    statusCode: 200,
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    header: {
      'Content-Length': String(bytes.byteLength),
      'X-Terra-Checksum': `fnv1a64:${common.fnv1a64(bytes)}`
    }
  }
}

function identity() {
  return new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ])
}

class FakeAbi {
  constructor() {
    this.loadedManifest = null
    this.viewports = []
    this.cameras = []
    this.targets = []
    this.submissions = []
    this.failures = []
    this.retryRecords = []
    this.updateCount = 0
    this.cameraSnapshotCount = 0
    this.destroyed = false
  }

  loadManifest(value, capacityBytes) {
    this.loadedManifest = value
    this.terrainCapacityBytes = capacityBytes
  }

  beginHeightQuery() { return {id: 1} }
  stepHeightQuery() { return {state: 6, reasons: 1, requests: [], sample: {available: false}} }
  endHeightQuery() {}
  getHeightQueryRegion() { return null }

  setViewport(width, height, fovRadians) {
    this.viewports.push({ width, height, fovRadians })
  }

  setCamera(value) {
    this.cameras.push(Object.assign({}, value))
  }

  setGlobeTarget(longitudeDegrees, latitudeDegrees) {
    this.targets.push({ longitudeDegrees, latitudeDegrees })
  }

  getCameraSnapshot() {
    this.cameraSnapshotCount += 1
    return {
      cameraPosition: [4, 5, 6],
      projectionView: identity()
    }
  }

  prepareMeshFrame(threshold, budget) {
      const frame = this.updateStep(threshold, budget)
      return {frame, updateState: this.getUpdateState(), draws: this.getMeshResources().map(nativeFixture.meshDraw),
        nativePlan: {id: 1, residentBytes: 0, additionalBytes: 0, reclaimableBytes: 0, maximumBytes: 67108864}}
    }
    materializeMeshFrame(packet) { packet.nativePlan = null }
    discardMeshPlan() {}
    replacementWorkBytes() { return 4 }
    createReplacementTask() { return {async run() { return {groups: []} }, cancel() {}} }

  updateStep() {
    this.updateCount += 1
    return {
      sequence: this.updateCount,
      patchCount: 1,
      requestCount: this.getRequests().length,
      loadedRecordCount: this.submissions.length,
      failedRecordCount: this.failures.length,
      drawCount: 0,
      vertexCount: 0,
      decisionsComplete: true,
      cameraPosition: [1, 2, 3],
      projectionView: identity()
    }
  }

  getRequests() {
    return this.submissions.length ? [] : [recordRequest]
  }

  getUpdateState() { return {modelRevision: 1, topologyChangeCount: 0, pendingPriorityUpdateCount: 0, budgetExhausted: false} }
  advanceTerrain() { return this.getUpdateState() }
  getMeshResources() { return [] }
  copyMeshResource() { throw new Error('No mesh resources in this fixture') }
  presentFrame() {}
  retainMeshes() {}

  getIndices() {
    return new Uint16Array([0,1,2])
  }

  submitRecord(kind, key, bytes) {
    this.submissions.push({ kind, key, bytes: Array.from(bytes) })
  }

  failRecord(kind, key) {
    this.failures.push({ kind, key })
  }

  retryRecord(kind, key) {
    this.retryRecords.push({ kind, key })
  }

  destroy() {
    if (this.nativeBudget) this.nativeBudget.close()
    this.destroyed = true
  }
}

class FakeRenderer {
  // Fixture quotes are single complete groups. The real texture-store tests
  // cover owned grants and rolling exchanges across multiple groups.
  reserveImageryDemand(demand) {
    return this.options.resourceLedger.canReserve(demand.bytes, [], demand.keep)
  }
  terrainRefinementDemand() { return {sequence: this.frames.length ? this.frames[this.frames.length - 1].frame.sequence : 0,
    bytes: 0, keep: []} }
  candidateCanYield() { return true }
  beginCandidateForecast() {}
  admitCandidate(packet) { return this.reserveMeshOutputs(packet, 0) }
  prepareMeshOutputs() { return null }
  reserveMeshOutputs(packet, bytes) {
    const credit = this.options.resourceLedger.reserve('mesh-transfer', bytes)
    return credit && {credit, valid: () => true, release() {}}
  }
  holdCandidate() { return null }
  discardCandidate() {}
  releaseCandidate() {}
  constructor(options) {
    this.options = options
    this.frames = []
    this.budgets = []
    this.resizes = []
    this.cameraFrames = []
    this.interactionStates = []
    this.renderCount = 0
    this.destroyed = false
    this.contextLost = false
  }

  capabilities() {
    return { maxTextureSize: 2048, maxVertexAttribs: 8, version: 'fake' }
  }

  setBudget(value) {
    this.budgets.push(value)
  }

  resize(width, height) {
    this.resizes.push({ width, height })
  }

  setMeshFrame(frame, draws, resources, indices) {
    this.frames.push({ frame, draws, resources, indices })
  }

  setCameraFrame(snapshot) {
    this.cameraFrames.push(snapshot)
  }

  setInteractionActive(active) {
    this.interactionStates.push(active)
  }

  advanceResources() {}

  render() {
    this.renderCount += 1
    return { submitted: 0, queued: 0 }
  }

  stats() {
    return {
      geometry: { entries: 0, bytes: 0 },
      textures: { entries: 0, bytes: 0, active: 0, queued: 0 },
      draws: { submitted: 0, queued: 0 }
    }
  }

  destroy() {
    if (this.nativeBudget) this.nativeBudget.close()
    this.destroyed = true
  }
}

function canvas() {
  return {
    width: 0,
    height: 0,
    requestAnimationFrame(callback) {
      return setTimeout(callback, 0)
    }
  }
}

async function settle(turns) {
  for (let index = 0; index < (turns || 1); ++index) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function createRuntime(options) {
  let renderer = null
  const runtime = await runtimeModule.TerraGlobeRuntime.create(Object.assign({
    canvas: canvas(),
    manifest: manifest(),
    request() { throw new Error('Test transport is not configured') },
    serviceOrigin: 'https://terrain.example',
    terrainRefreshBatchMs: 0,
    terrainRefreshMaximumDelayMs: 0,
    viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
    rendererFactory(node, rendererOptions) {
      renderer = new FakeRenderer(rendererOptions)
      return renderer
    }
  }, options))
  return { runtime, renderer }
}

function testPlatformBackgroundDispatch() {
  const jobs = new Map(), calls = []
  let next = 0
  const runtime = new runtimeModule.TerraGlobeRuntime({canvas:canvas(),
    setTask(callback, delay) {const id = ++next; jobs.set(id, {callback, delay}); return id},
    clearTask(id) {jobs.delete(id)}})
  try {
    runtime.frameClock.enqueueWork('platform', () => calls.push('ready'))
    assert.strictEqual(jobs.size, 1, 'Runtime discarded the platform background dispatcher')
    const [id, job] = [...jobs][0]
    jobs.delete(id); job.callback()
    assert.deepStrictEqual(calls, ['ready'])
    runtime.frameClock.enqueueWork('delayed', () => {throw Error('Destroyed task ran')}, 16)
    const pending = [...jobs.values()][0]
    assert(pending.delay > 0 && pending.delay <= 16)
    runtime.destroy(); pending.callback()
    assert.strictEqual(jobs.size, 0, 'Runtime destroy left a platform task alive')
  } finally {runtime.destroy()}
}

function testTerrainRequestOrdering() {
  const fine = {
    kind: runtimeModule.REQUEST_DETAIL,
    key: { level: 8, i: 1, j: 2, k: 3 }
  }
  const root = {
    kind: runtimeModule.REQUEST_ROOT,
    key: { level: 0, i: 4, j: 5, k: 6 }
  }
  const coarse = {
    kind: runtimeModule.REQUEST_DETAIL,
    key: { level: 1, i: 7, j: 8, k: 9 }
  }
  const sameLevel = {
    kind: runtimeModule.REQUEST_DETAIL,
    key: { level: 1, i: 10, j: 11, k: 12 }
  }
  const requests = [fine, sameLevel, root, coarse]
  assert.deepStrictEqual(runtimeModule.orderTerrainRequests(requests),
    [root, fine, sameLevel, coarse])
  assert.deepStrictEqual(requests, [fine, sameLevel, root, coarse])
  assert(runtimeModule.terrainRequestPriority(root) >
    runtimeModule.terrainRequestPriority(coarse))
  assert.strictEqual(runtimeModule.terrainRequestPriority(coarse),
    runtimeModule.terrainRequestPriority(fine))
}

function testGeographicCamera() {
  const target = {
    longitudeDegrees: 116.4074,
    latitudeDegrees: 39.9042
  }
  const camera = runtimeModule.geographicCamera(
    6378000, 1280, 720, 30 * Math.PI / 180, target)
  assert.strictEqual(camera.yawRadians, 0)
  assert.strictEqual(camera.tiltRadians, 0)
  assert.strictEqual(camera.longitudeDegrees, target.longitudeDegrees)
  assert.strictEqual(camera.latitudeDegrees, target.latitudeDegrees)
  assert.throws(() => runtimeModule.geographicCamera(
    6378000, 1280, 720, 0.5, { longitudeDegrees: 181, latitudeDegrees: 0 }),
  /longitude/)
  const defaultAtmosphere = runtimeModule.normalizeAtmosphereOptions()
  assert.strictEqual(defaultAtmosphere.enabled, true)
  assert.strictEqual(defaultAtmosphere.sunEnabled, true)
  assert.strictEqual(defaultAtmosphere.fogEnabled, false)
  assert.strictEqual(defaultAtmosphere.fogDensityMultiplier, 1)
  const fog = runtimeModule.normalizeAtmosphereOptions({
    fogEnabled: true, fogDensityMultiplier: 2.5
  })
  assert.strictEqual(fog.fogEnabled, true)
  assert.strictEqual(fog.fogDensityMultiplier, 2.5)
}

async function testResourceBudgetOwnership() {
  for (const maximumResourceBytes of [undefined, 96 * 1024 * 1024, 168 * 1024 * 1024]) {
    const abi = new FakeAbi()
    abi.getRequests = () => []
    const meshLimits = []
    const prepare = abi.prepareMeshFrame.bind(abi)
    abi.prepareMeshFrame = (threshold, budget) => {
      meshLimits.push(budget.meshBudgetBytes)
      return prepare(threshold, budget)
    }
    const maximumImageryBytes = maximumResourceBytes === undefined ? undefined : 60 * 1024 * 1024
    const maximumTerrainMeshBytes = maximumResourceBytes === undefined ? undefined :
      (maximumResourceBytes === 96 * 1024 * 1024 ? 12 : 32) * 1024 * 1024
    const maximumPartitionBytes = maximumResourceBytes === undefined ? undefined : 10 * 1024 * 1024
    const maximumTextureRequests = maximumResourceBytes === undefined ? undefined :
      (maximumResourceBytes === 96 * 1024 * 1024 ? 1 : 8)
    const {runtime, renderer} = await createRuntime({abi, maximumResourceBytes, maximumImageryBytes,
      maximumTerrainMeshBytes, maximumPartitionBytes, maximumTextureRequests, maximumTerrainRequests: 1,
      recordCacheBytes: 24 * 1024 * 1024,
      viewport: {width: 640, height: 360, devicePixelRatio: 1}})
    try {
      const limit = maximumResourceBytes === undefined ? 768 * 1024 * 1024 : maximumResourceBytes
      assert.strictEqual(runtime.resourceLedger.maximumBytes, limit)
      assert.strictEqual(renderer.options.resourceLedger, runtime.resourceLedger)
      assert.strictEqual(renderer.options.maximumTextureRequests, maximumTextureRequests || 8,
        'Terrain concurrency rewrote independent imagery concurrency')
      assert.strictEqual(renderer.options.imageryShareMaximumBytes, maximumImageryBytes || limit)
      assert.strictEqual(runtime.budget.maximumResourceBytes, limit)
      const shares = () => [runtime.budget.geometryCacheBytes, runtime.budget.partitionCacheBytes,
        runtime.budget.textureCacheBytes]
      const initialShares = [2 * (maximumTerrainMeshBytes || 64 * 1024 * 1024),
        maximumPartitionBytes || 16 * 1024 * 1024, 256 * 1024 * 1024]
      assert(Object.isFrozen(runtime.resourcePolicy))
      assert.strictEqual(abi.terrainCapacityBytes, initialShares[0] / 2)
      assert.deepStrictEqual(runtime.resourcePolicy.terrainCapacity, {
        meshBytes:initialShares[0]/2, recordBytes:initialShares[0]/2, heightBytes:initialShares[0],
        publicationBytes:2*initialShares[0]})
      assert.deepStrictEqual(shares(), initialShares, 'Application resource shares were ignored')
      assert.deepStrictEqual([renderer.options.geometryCacheBytes, renderer.options.partitionCacheBytes,
        renderer.options.textureCacheBytes], initialShares, 'Renderer started with different capacities')
      const queries = runtime.heightQueries.stats()
      assert(queries.progressRequiredBytes > 0 && queries.progressBytes === queries.progressRequiredBytes,
        'Navigation started without a funded query continuation reserve')
      assert.strictEqual(renderer.options.additionalResourceBytes, undefined,
        'Renderer still owns the total via a record-cache allowance')
      runtime.resize({width: 1600, height: 900, devicePixelRatio: 2})
      assert.strictEqual(renderer.budgets[renderer.budgets.length - 1].maximumTextureRequests,
        maximumTextureRequests || 8, 'Viewport silently reduced imagery concurrency')
      assert.strictEqual(runtime.resourceLedger.maximumBytes, limit, 'Resize silently raised the total limit')
      assert.strictEqual(runtime.budget.maximumResourceBytes, limit)
      assert.deepStrictEqual(shares(), initialShares, 'Resize silently changed the resource policy')
      runtime.budget.textureCacheBytes *= 2
      runtime.applyBudget()
      assert.strictEqual(runtime.resourceLedger.maximumBytes, limit, 'Cache redistribution changed the total')
      assert.deepStrictEqual(shares(), initialShares, 'Frame budget overwrote the instance resource policy')
      runtime.resize({width: 320, height: 180, devicePixelRatio: 1})
      assert.strictEqual(runtime.resourceLedger.maximumBytes, limit)
      assert.strictEqual(runtime.budget.maximumResourceBytes, limit)
      assert.deepStrictEqual(shares(), initialShares)
      assert(meshLimits.length > 0 && meshLimits.every(bytes => bytes === initialShares[0] / 2),
        'Native selection did not receive the fixed mesh capacity')
      assert(renderer.budgets.every(budget => budget.geometryCacheBytes === initialShares[0] &&
        budget.partitionCacheBytes === initialShares[1] && budget.textureCacheBytes === initialShares[2]))
      assert(runtime.resourceLedger.bytes <= limit)
    } finally { runtime.destroy() }
    assert.strictEqual(runtime.resourceLedger.bytes, 0)
  }
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '128']) {
    assert.throws(() => new runtimeModule.TerraGlobeRuntime({canvas: canvas(), maximumResourceBytes: value}),
      /positive safe integer/)
    assert.throws(() => new runtimeModule.TerraGlobeRuntime({canvas: canvas(), maximumImageryBytes: value}),
      /positive safe integer/)
    for (const name of ['maximumTerrainMeshBytes', 'maximumPartitionBytes'])
      assert.throws(() => new runtimeModule.TerraGlobeRuntime({canvas: canvas(), [name]: value}),
        /positive safe integer/)
  }
  assert.throws(() => new runtimeModule.TerraGlobeRuntime({canvas: canvas(),
    maximumTerrainMeshBytes: 0x80000000}), /uint32 height payload range/)
  let rendererCreated = false
  await assert.rejects(createRuntime({abi: new FakeAbi(), maximumTerrainMeshBytes: 1024,
    rendererFactory() { rendererCreated = true }}), /cannot hold root coverage/)
  assert.strictEqual(rendererCreated, false, 'Invalid terrain capacity created renderer resources')
  const abi = new FakeAbi()
  abi.getRequests = () => []
  const {runtime} = await createRuntime({abi, terrainNavigation: {enabled: false}})
  assert.strictEqual(runtime.heightQueries.stats().progressBytes, 0,
    'Disabled navigation retained a mandatory query reserve')
  runtime.destroy()
  assert.strictEqual(runtime.resourceLedger.bytes, 0)
}

async function testSuccessfulLoadAndControls() {
  const abi = new FakeAbi()
  const requests = []
  const bytes = payload()
  const initialTarget = {
    longitudeDegrees: 116.4074,
    latitudeDegrees: 39.9042
  }
  const result = await createRuntime({
    abi,
    initialTarget,
    cameraSettleDelayMs: 5,
    request(options) {
      requests.push(options)
      return { promise: Promise.resolve(response(bytes)), abort() {} }
    }
  })
  await settle(4)

  assert.strictEqual(result.runtime.renderedSurface, null)
  const submitted = {draws: [], resources: new Map(), indices: new Uint16Array()}
  result.renderer.options.onSurfaceSubmitted({draws: [], meshResources: new Map()}, false)
  assert.strictEqual(result.runtime.renderedSurface, null, 'Ownership receipt fabricated submitted geometry')
  const retained = {draws: [{resourceId: 9, workerGeneration: 1}]}
  result.renderer.options.onSurfaceSubmitted(retained, false)
  const progress = result.runtime.state().terrainSelection.submitted
  const generation = abi.generation
  abi.generation = 2
  result.renderer.options.onSurfaceSubmitted(retained, false)
  assert.strictEqual(result.runtime.state().terrainSelection.submitted.meshRevision, progress.meshRevision,
    'A restarted Worker relabelled the retained display cut')
  result.renderer.options.onSurfaceSubmitted({draws: [{resourceId: 9, workerGeneration: 2}]}, false)
  assert.strictEqual(result.runtime.state().terrainSelection.submitted.meshRevision, progress.meshRevision + 1)
  abi.generation = generation
  result.renderer.options.onDrawsSubmitted(submitted)
  assert.strictEqual(result.runtime.renderedSurface, submitted)
  assert.strictEqual(result.runtime.renderedSurfaceRevision, 1)
  result.runtime.clearanceSignature = 'previous draw set'
  result.renderer.options.onDrawsSubmitted(null)
  assert.strictEqual(result.runtime.renderedSurface, null)
  assert.strictEqual(result.runtime.renderedSurfaceRevision, 2)
  assert.strictEqual(result.runtime.clearanceSignature, 'previous draw set',
    'A draw callback recomputed clearance before the draw transaction finished')

  assert.strictEqual(abi.loadedManifest.datasetId, 'globe')
  assert.strictEqual(requests.length, 1)
  assert.strictEqual(requests[0].url,
    'https://terrain.example/terra/v1/datasets/globe/root/0/134217728/134217728')
  assert.strictEqual(abi.submissions.length, 1)
  assert.deepStrictEqual(abi.submissions[0].bytes, Array.from(bytes))
  assert.strictEqual(result.runtime.state().terrain.entries, 1)
  assert.strictEqual(
    result.runtime.state().frame.decisionsComplete, true)
  assert.strictEqual(result.runtime.state().radiusMeters, 6378000)
  assert.strictEqual(result.runtime.textureUrl({ level: 3, matrix: 3, row: 4, column: 5 }),
    'https://tiles.example/3/5/4.jpg')

  const initialCamera = Object.assign({}, result.runtime.camera)
  assert.deepStrictEqual(abi.targets[0], initialTarget)
  assert.strictEqual(initialCamera.tiltRadians, 0)
  assert.strictEqual(initialCamera.yawRadians, 0)
  assert.strictEqual(initialCamera.longitudeDegrees, 116.4074)
  assert.strictEqual(initialCamera.latitudeDegrees, 39.9042)
  assert.deepStrictEqual(result.runtime.getView(), {
    schema: 'terra.view-state.v2',
    mode: 'globe',
    target: {
      longitudeDegrees: 116.4074,
      latitudeDegrees: 39.9042,
      heightMeters: 0
    },
    rangeMeters: initialCamera.distance,
    headingDegrees: 0,
    tiltDegrees: 0
  })
  const previewUpdateCount = abi.updateCount
  const previewFrameCount = result.renderer.frames.length
  const previewSnapshotCount = abi.cameraSnapshotCount
  result.runtime.setInteractionActive(true)
  result.runtime.applyInteraction({
    headingDegrees: 2,
    tiltDegrees: 1
  })
  result.runtime.applyInteraction({ headingDegrees: 3 })
  result.runtime.scheduleRefresh()
  await settle(2)

  assert.strictEqual(abi.updateCount, previewUpdateCount)
  assert.strictEqual(result.renderer.frames.length, previewFrameCount)
  assert.strictEqual(abi.cameraSnapshotCount, previewSnapshotCount + 2)
  assert.strictEqual(result.renderer.cameraFrames.length, 2)
  assert.deepStrictEqual(result.renderer.interactionStates, [true])
  assert.strictEqual(
    result.runtime.state().performance.cameraPreview.count, 2)
  result.runtime.setInteractionActive(false)
  assert.strictEqual(abi.updateCount, previewUpdateCount)
  assert.strictEqual(result.renderer.frames.length, previewFrameCount)
  await settle(2)
  assert.strictEqual(abi.updateCount, previewUpdateCount + 1)
  assert.strictEqual(result.renderer.frames.length, previewFrameCount + 1)
  assert.deepStrictEqual(result.renderer.interactionStates, [true, false])
  assert(result.runtime.state().performance.fullUpdate.count > 0)

  const continuousStart = abi.updateCount
  result.runtime.setInteractionActive(true)
  result.runtime.applyInteraction({ headingDegrees: 8, tiltDegrees: 8 })
  await settle(150)
  assert(abi.updateCount > continuousStart, 'Continuous look interaction must advance before release')
  assert(abi.updateCount <= continuousStart + 2, 'Interaction updates must be coalesced')
  const stationaryCount = abi.updateCount
  await settle(160)
  assert.strictEqual(abi.updateCount, stationaryCount, 'A stationary held gesture must not spin')
  result.runtime.setInteractionActive(false)
  await settle(2)

  const debouncedUpdates = abi.updateCount
  const debouncedSnapshots = abi.cameraSnapshotCount
  for (let index = 0; index < 12; ++index) {
    result.runtime.zoomBy(index % 2 === 0 ? 0.98 : 1.02)
  }
  assert.strictEqual(abi.updateCount, debouncedUpdates)
  assert.strictEqual(abi.cameraSnapshotCount, debouncedSnapshots + 12)
  assert.strictEqual(result.runtime.cameraPreviewDirty, true)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await settle(2)
  assert.strictEqual(abi.updateCount, debouncedUpdates + 1)
  assert.strictEqual(result.runtime.cameraRefreshTimer, null)
  assert.strictEqual(result.runtime.cameraPreviewDirty, false)

  const atomicUpdates = abi.updateCount
  result.runtime.setView({
    schema: 'terra.view-state.v2',
    mode: 'globe',
    target: {
      longitudeDegrees: 120,
      latitudeDegrees: 30,
      heightMeters: 0
    },
    rangeMeters: initialCamera.distance * 0.9,
    headingDegrees: 20,
    tiltDegrees: 35
  })
  assert.strictEqual(abi.updateCount, atomicUpdates, 'A view change presents before starting a model update')
  await settle(3)
  assert.strictEqual(abi.updateCount, atomicUpdates + 1)
  assert.strictEqual(result.runtime.getView().tiltDegrees, 35)

  const animationUpdates = abi.updateCount
  const animationSnapshots = abi.cameraSnapshotCount
  result.runtime.setView(Object.assign({}, result.runtime.getView(), {
    headingDegrees: 30,
    tiltDegrees: 40
  }), { animate: true, durationMs: 48 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.strictEqual(abi.updateCount, animationUpdates + 1)
  assert(abi.cameraSnapshotCount > animationSnapshots)
  assert.strictEqual(result.runtime.getView().tiltDegrees, 40)

  assert.throws(() => result.runtime.setView({
    schema: 'terra.view-state.v2',
    mode: 'globe',
    target: { longitudeDegrees: 200, latitudeDegrees: 30 },
    rangeMeters: initialCamera.distance,
    headingDegrees: 0,
    tiltDegrees: 0
  }), /outside globe bounds/)
  assert.strictEqual(result.runtime.camera.longitudeDegrees, 120)
  result.runtime.reset()
  result.runtime.applyCamera({ tiltDelta: -0.25, yawDelta: 0.5 })
  assert.strictEqual(result.runtime.camera.tiltRadians, -0.25)
  assert.strictEqual(result.runtime.camera.yawRadians, 0.5)
  result.runtime.reset()
  result.runtime.moveSurfacePixels(100, -50)
  assert(result.runtime.camera.longitudeDegrees < initialCamera.longitudeDegrees)
  assert(result.runtime.camera.latitudeDegrees < initialCamera.latitudeDegrees)
  result.runtime.setTargetDegrees(120, 30)
  assert.strictEqual(result.runtime.camera.longitudeDegrees, 120)
  assert.strictEqual(result.runtime.camera.latitudeDegrees, 30)
  result.runtime.focusInitialTarget()
  assert.strictEqual(result.runtime.camera.distance, 6378000 * 0.45)
  assert.strictEqual(result.runtime.camera.longitudeDegrees, 116.4074)
  assert.strictEqual(result.runtime.camera.latitudeDegrees, 39.9042)
  result.runtime.zoom(0.8)
  assert(result.runtime.camera.distance < 6378000 * 0.45)
  result.runtime.tilt45()
  assert.strictEqual(result.runtime.camera.tiltRadians, -Math.PI / 4)
  result.runtime.rotateYaw(0.5)
  assert.strictEqual(result.runtime.camera.yawRadians, 0.5)
  result.runtime.topDown()
  assert.strictEqual(result.runtime.camera.tiltRadians, 0)
  result.runtime.northUp()
  assert.strictEqual(result.runtime.camera.yawRadians, 0)
  result.runtime.reset()
  assert.deepStrictEqual(result.runtime.camera, initialCamera)
  result.runtime.resize({ width: 1600, height: 900, devicePixelRatio: 2 })
  assert.strictEqual(result.runtime.scheduler.maximumConcurrent, 3)
  assert(result.renderer.budgets.length >= 2)
  assert.strictEqual(result.runtime.maximumTextureRequests, 8)
  assert.strictEqual(result.renderer.options.maximumTextureRequests, 8)
  assert.strictEqual(result.renderer.options.terrainBoundImagery, false)
  assert.strictEqual(result.renderer.options.maximumTextureEntries, undefined)
  assert.strictEqual(result.renderer.budgets[
    result.renderer.budgets.length - 1].maximumTextureRequests, 8)
  assert.strictEqual(result.renderer.budgets[
    result.renderer.budgets.length - 1].maximumTextureEntries, undefined)
  assert.strictEqual(result.runtime.retryFailed(), false)
  result.runtime.destroy()
  assert.strictEqual(abi.destroyed, true)
  assert.strictEqual(result.renderer.destroyed, true)
}

async function testCloseRangePanUsesSurfaceScale() {
  const abi = new FakeAbi()
  const result = await createRuntime({
    abi,
    request() {
      return { promise: Promise.resolve(response(payload())), abort() {} }
    }
  })
  await settle(4)
  const radius = result.runtime.manifest.radius
  result.runtime.setView({
    schema: 'terra.view-state.v2',
    mode: 'globe',
    target: {
      longitudeDegrees: 120.6,
      latitudeDegrees: 31.3,
      heightMeters: 0
    },
    rangeMeters: 15000,
    headingDegrees: 0,
    tiltDegrees: 0
  })
  const before = result.runtime.getView()
  result.runtime.panBy({ xPixels: 96, yPixels: 40 })
  const after = result.runtime.getView()
  const longitudeDelta = Math.abs(after.target.longitudeDegrees -
    before.target.longitudeDegrees)
  const latitudeDelta = Math.abs(after.target.latitudeDegrees -
    before.target.latitudeDegrees)
  assert(longitudeDelta > 0.005)
  assert(longitudeDelta < 0.05)
  assert(latitudeDelta > 0.001)
  assert(latitudeDelta < 0.05)
  assert.strictEqual(after.rangeMeters, before.rangeMeters)

  result.runtime.setView({
    schema: 'terra.view-state.v2',
    mode: 'globe',
    target: before.target,
    rangeMeters: 15000,
    headingDegrees: 0,
    tiltDegrees: 0
  })
  const zoomTarget = result.runtime.getView()
  result.runtime.zoomBy(1.25, { anchor: { x: 960, y: 360 } })
  const zoomedOut = result.runtime.getView()
  assert(Math.abs((zoomedOut.rangeMeters) - 18750) < 0.000001)
  assert(Math.abs(zoomedOut.target.longitudeDegrees -
    zoomTarget.target.longitudeDegrees) < 0.02)
  result.runtime.zoomBy(0.8, { anchor: { x: 960, y: 360 } })
  const zoomedBack = result.runtime.getView()
  assert(Math.abs((zoomedBack.rangeMeters) - 15000) < 0.000001)
  assert(Math.abs(zoomedBack.target.longitudeDegrees -
    zoomTarget.target.longitudeDegrees) < 0.000001)

  result.runtime.applyInteraction({ zoomScale: 2 })
  assert(Math.abs((result.runtime.getView().rangeMeters) -
    30000) < 0.000001)
  result.runtime.applyCamera({ zoomScale: 0.5 })
  assert(Math.abs((result.runtime.getView().rangeMeters) -
    15000) < 0.000001)
  assert.throws(() => result.runtime.zoomBy(0), /must be positive/)
  result.runtime.destroy()
}

async function testFailedWorkerAdoption() {
  const abi = new FakeAbi(), discarded = []
  abi.isWorker = true
  abi.getRequests = () => []
  abi.discardFrame = async sequence => { discarded.push(sequence) }
  abi.step = async (threshold, budget, frames) => {
    const frame = abi.updateStep()
    try { return frames.adopt({frame, draws: frame.sequence === 1 ? [{resourceId: 1}, {resourceId: 2}] : [],
      indices: new Uint16Array([0, 1, 2]), requests: [], updateState: abi.getUpdateState(),
      additions: frame.sequence === 1 ? [{resourceId: 1, positions: new Float32Array(9),
        textureUv: new Float32Array(6)}] : []}) }
    catch (error) { await abi.discardFrame(frame.sequence); throw error }
  }
  const result = await createRuntime({abi})
  try {
    await settle(8)
    assert.deepStrictEqual(discarded, [1])
    assert.strictEqual(result.runtime.meshFrames.resources.size, 0)
    assert.strictEqual(result.runtime.meshFrames.copiedBytes, 0)
    assert.strictEqual(result.runtime.meshFrames.presented.frame.sequence, 2,
      'Rejected transfer blocked subsequent candidate publication')
  } finally { result.runtime.destroy() }
}

async function testCandidateReplacement() {
  const abi = new FakeAbi()
  let pendingPriorities = 0
  abi.nextModel = 1
  const baseUpdate = abi.updateStep.bind(abi)
  abi.updateStep = () => { abi.model = abi.nextModel; return Object.assign(baseUpdate(), {drawCount: 1, coverageComplete: true}) }
  const state = revision => ({modelRevision: revision, topologyChangeCount: 0, pendingPriorityUpdateCount: 0, budgetExhausted: true})
  abi.getUpdateState = () => state(abi.model)
  abi.advanceTerrain = (threshold, budget) => Object.assign(state(abi.nextModel),
    {budgetExhausted: !budget.coarseningOnly, pendingPriorityUpdateCount: pendingPriorities})
  abi.getRequests = () => []
  abi.getMeshResources = () => [{resourceId: abi.model, vertexCount: 3}]
  abi.copyMeshResource = draw => ({resourceId: draw.resourceId,
    positions: new Float32Array(9), textureUv: new Float32Array(6)})
  const {runtime, renderer} = await createRuntime({abi, maximumRefreshRetries: 0,
    canvas: {requestAnimationFrame: () => 1}})
  let release, enter
  const beginReceipt = () => {
    const started = new Promise(resolve => {enter = resolve})
    abi.retainMeshes = () => new Promise((resolve, reject) => {release = {resolve, reject}; enter()})
    return started
  }
  renderer.holdCandidate = () => {
    renderer.held = {draws: runtime.meshFrames.presented.draws.concat(runtime.meshFrames.candidate.draws)}
    return renderer.held
  }
  const releases = []
  renderer.discardCandidate = token => {
    assert.strictEqual(runtime.meshFrames.candidate, null, 'Renderer retired before CPU discard')
    token.discarded = true
  }
  renderer.releaseCandidate = token => {
    releases.push(token.discarded === true)
    if (renderer.held === token) renderer.held = null
  }
  try {
    for (let attempt = 0; attempt < 20 && !runtime.meshFrames.candidate && !runtime.lastError; ++attempt) await settle()
    assert(runtime.meshFrames.candidate, runtime.lastError || 'Initial candidate did not finish preparation')
    await runtime.presentMeshFrame(runtime.meshFrames.candidate.frame.sequence)
    abi.nextModel = 2; await runtime.refresh()
    const candidate = runtime.meshFrames.candidate
    abi.nextModel = 3
    runtime.camera.longitudeDegrees += 1
    pendingPriorities = 7 // A newer published cut can precede the next scan's completion.
    let entered = beginReceipt(), replacing = runtime.refresh()
    await settle(3)
    assert(renderer.held, 'Pending future priorities blocked an already published newer model')
    await entered
    pendingPriorities = 0
    assert(renderer.held && runtime.meshFrames.candidate === candidate)
    assert.strictEqual(abi.updateCount, 2, 'Successor published before display ownership acknowledgement')
    // Continuous movement coalesces behind the one transaction.
    abi.nextModel = 4
    const beforeUpdate = abi.updateStep
    abi.updateStep = () => {
      assert(renderer.held.discarded, 'Successor production preceded renderer retirement')
      return beforeUpdate()
    }
    await runtime.refresh(); await runtime.refresh()
    release.resolve(); await replacing
    abi.updateStep = beforeUpdate
    assert.strictEqual(runtime.meshFrames.candidate.updateState.modelRevision, 4)
    assert.deepStrictEqual(Array.from(runtime.meshFrames.resources.keys()), [1,2,4])
    assert(!renderer.held)
    const publications = abi.updateCount
    await runtime.refresh(); await runtime.refresh()
    assert.strictEqual(abi.updateCount, publications, 'An unchanged model kept replacing itself')

    abi.nextModel = 5
    runtime.camera.longitudeDegrees += 1
    entered = beginReceipt(); replacing = runtime.refresh(); await entered
    release.reject(new Error('injected receipt failure')); await replacing
    assert.strictEqual(abi.updateCount, publications, 'Failed retention discarded the pending candidate')
    assert.strictEqual(runtime.meshFrames.candidate.updateState.modelRevision, 4)
    assert(!renderer.held)
    assert.strictEqual(releases[releases.length - 1], false, 'Failed retention abandoned a still-owned candidate')
    assert.strictEqual(runtime.refreshPending, false, 'Failed retention bypassed the retry limit')
    entered = beginReceipt(); replacing = runtime.refresh(); await entered
    runtime.pause(); release.resolve(); await replacing
    assert.strictEqual(abi.updateCount, publications, 'Pause published a successor after a delayed receipt')
    assert(runtime.meshFrames.presented.resources.has(4), 'Pause lost a submitted candidate mesh')
    assert(!renderer.held)
    abi.retainMeshes = () => {}; runtime.resume(); await settle(5)
    assert.strictEqual(runtime.meshFrames.candidate.updateState.modelRevision, 5)
    assert.strictEqual(runtime.state().terrainSelection.supersededCandidateCount, 2)
    abi.nextModel = 6
    runtime.camera.longitudeDegrees += 1
    const update = abi.updateStep
    abi.updateStep = (threshold, budget) => {
      assert.strictEqual(budget.maximumChangeCount, 0, 'A replaced candidate reopened topology before admission')
      throw Object.assign(new Error('capacity fixture'), {status: 9, requests: []})
    }
    await runtime.refresh()
    assert.strictEqual(runtime.meshFrames.candidate, null)
    assert(runtime.meshFrames.presented.resources.has(5), 'Refusal lost acknowledged mixed display')
    assert.strictEqual(releases[releases.length - 1], true, 'Refusal resumed the discarded renderer candidate')
    assert(runtime.meshCapacityBlocked && !renderer.held)
    abi.updateStep = (threshold, budget) => {
      assert.strictEqual(budget.maximumChangeCount, 0, 'Capacity retry enlarged the blocked candidate')
      return update()
    }
    await runtime.refresh() // One bounded coarsening recovery precedes production.
    await runtime.refresh()
    abi.updateStep = update
    assert.strictEqual(runtime.meshFrames.candidate.updateState.modelRevision, 6)
    abi.nextModel = 7
    runtime.camera.longitudeDegrees += 1
    entered = beginReceipt(); replacing = runtime.refresh(); await entered
    runtime.destroy(); release.resolve(); await replacing
    assert.strictEqual(runtime.meshFrames.resources.size, 0, 'Late retention resurrected destroyed resources')
  } finally { runtime.destroy() }
}

async function testSameViewCandidateProgress() {
  const abi = new FakeAbi(), outputs = []
  let nextModel = 1, advances = 0
  const advanceBudgets = [], publicationBudgets = []
  const update = abi.updateStep.bind(abi)
  const state = revision => ({modelRevision: revision, topologyChangeCount: 0, pendingPriorityUpdateCount: 0, budgetExhausted: false})
  abi.updateStep = (threshold, budget) => {
    publicationBudgets.push(budget)
    abi.model = nextModel; return Object.assign(update(), {drawCount: 1, coverageComplete: true})
  }
  abi.getUpdateState = () => state(abi.model)
  abi.advanceTerrain = (threshold, budget) => {
    ++advances; advanceBudgets.push(budget)
    return Object.assign(state(nextModel), {budgetExhausted: advances < 6,
      topologyChangeCount: [0, 0, 3, 5, 24, 16][advances - 1] || 0})
  }
  abi.getRequests = () => []
  abi.getMeshResources = () => [{resourceId: abi.model, vertexCount: 3}]
  abi.copyMeshResource = draw => ({resourceId: draw.resourceId,
    positions: new Float32Array(9), textureUv: new Float32Array(6)})
  const {runtime} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1},
    rendererFactory(node, options) {
      const renderer = new FakeRenderer(options)
      renderer.reserveMeshOutputs = (packet, bytes) => {
        const credit = options.resourceLedger.reserve('mesh-transfer', bytes)
        if (!credit) return null
        const output = {credit, released: false, valid: () => !output.released,
          release() { output.released = true }}
        outputs.push(output)
        return output
      }
      renderer.holdCandidate = () => { throw new Error('A current-view candidate was superseded') }
      return renderer
    }})
  try {
    for (let attempt = 0; attempt < 20 && !runtime.meshFrames.candidate && !runtime.lastError; ++attempt) await settle()
    assert(runtime.meshFrames.candidate, runtime.lastError || 'Initial candidate did not finish preparation')
    assert(!outputs[0].released, 'Frame transfer released the handoff plan before its first draw')
    await runtime.presentMeshFrame(runtime.meshFrames.candidate.frame.sequence)
    assert(outputs[0].released)
    nextModel = 2; await runtime.refresh()
    const candidate = runtime.meshFrames.candidate, output = outputs[1]
    assert(!output.released)
    for (nextModel = 3; nextModel <= 20; ++nextModel) {
      runtime.frameClock.work.clear() // This explicit refresh consumes the queued continuation.
      await runtime.refresh()
      assert.strictEqual(runtime.meshFrames.candidate, candidate, 'Newer same-view work starved a pending handoff')
      assert(!output.released, 'Background refinement invalidated admitted partition work')
    }
    assert.strictEqual(advances, 18, 'Waiting for presentation stopped background terrain work')
    assert.deepStrictEqual(advanceBudgets.slice(0, 6).map(b => b.maximumChangeCount),
      [32, 32, 32, 32, 32, 32], 'Logical rounds consumed a display-wide mutation allowance')
    assert.strictEqual(runtime.terrainModel.stats().topologyChanges, 48,
      'Presentation prevented a paid immutable model from progressing beyond one round')
    assert(advanceBudgets.every(b => b.maximumChangeCount <= 32),
      'A logical round exceeded its operation ceiling')
    assert(!runtime.frameClock.work.has('terrain'), 'Deferred topology kept scheduling itself without a receipt')
    assert.strictEqual(abi.updateCount, 2, 'Intermediate models were materialized without presentation progress')
    assert(runtime.refreshPending)
    // New camera/model work must retain the paid output until display progress;
    // each round has its own bound, independently of that output's receipt.
    runtime.renderer.candidateCanYield = () => false
    for (let move = 0; move < 12; ++move) {
      runtime.camera.longitudeDegrees += 0.01
      runtime.frameClock.work.clear()
      await runtime.refresh()
      assert.strictEqual(runtime.meshFrames.candidate, candidate,
        'Continuous movement cancelled a candidate before display progress')
      assert(!output.released)
      assert.strictEqual(advanceBudgets[advanceBudgets.length - 1].maximumChangeCount, 32)
    }
    assert.strictEqual(abi.updateCount, 2)
    await runtime.presentMeshFrame(candidate.frame.sequence)
    assert(output.released, 'Presentation did not release the handoff destinations')
    await runtime.refresh()
    assert.strictEqual(runtime.meshFrames.candidate.updateState.modelRevision, 21,
      'Presentation replayed intermediate models instead of coalescing to the latest')
    assert.strictEqual(abi.updateCount, 3)
    assert.strictEqual(publicationBudgets[2].maximumChangeCount, 0,
      'Publication added another topology batch before consuming background progress')
    assert(!outputs[2].released)
    await runtime.refresh()
    assert(advanceBudgets[advanceBudgets.length - 1].maximumChangeCount !== 0,
      'A new publication did not reopen the background topology window')
  } finally { runtime.destroy() }
  assert(outputs.every(output => output.released), 'Destroy retained handoff destinations')
}

async function testPreparationModelProgress() {
  const abi = new FakeAbi(), budgets = []
  let model = 1, target = 1, selection = 1, release
  abi.getRequests = () => []
  const update = abi.updateStep.bind(abi)
  abi.updateStep = () => { selection = model; return Object.assign(update(), {drawCount: 1, coverageComplete: true}) }
  abi.getUpdateState = () => ({modelRevision: selection, topologyChangeCount: 0, pendingPriorityUpdateCount: 0})
  abi.getMeshResources = () => [{resourceId: selection, vertexCount: 3}]
  abi.copyMeshResource = draw => ({resourceId: draw.resourceId,
    positions: new Float32Array(9), textureUv: new Float32Array(6)})
  abi.advanceTerrain = (threshold, budget) => {
    budgets.push(budget.maximumChangeCount)
    const changes = Math.min(8, budget.maximumChangeCount, target - model)
    model += changes
    return {modelRevision: model, topologyChangeCount: changes, pendingPriorityUpdateCount: 0,
      budgetExhausted: model < target, limitedByCapacity: false}
  }
  const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  try {
    for (let i = 0; i < 20 && !runtime.meshFrames.candidate; ++i) await settle()
    await runtime.presentMeshFrame(runtime.meshFrames.candidate.frame.sequence)
    runtime.frameClock.work.clear()
    budgets.length = 0; target = 97
    const previous = runtime.meshFrames.presented, publications = abi.updateCount
    renderer.prepareMeshOutputs = () => ({
      admit: (packet, bytes) => new Promise(resolve => {
        release = () => resolve(renderer.reserveMeshOutputs(packet, bytes))
      }), release() {}
    })
    const pending = runtime.refresh()
    for (let i = 0; i < 100 && model < target; ++i) await settle()
    assert.strictEqual(model, target, 'UV preparation held logical terrain before its fixed target')
    assert.deepStrictEqual(budgets.slice(0, 12), Array(12).fill(32),
      'UV preparation blocked or enlarged a logical model round')
    assert(runtime.refreshing && runtime.terrainPreparation && release)
    assert.strictEqual(runtime.meshFrames.presented, previous, 'Model advance changed display ownership')
    assert.strictEqual(abi.updateCount, publications + 1, 'Background work generated intermediate publications')
    const preparedModel = selection
    runtime.camera.longitudeDegrees += 1
    await runtime.refresh()
    const beforeCamera = budgets.length
    for (let i = 0; i < 20 && budgets.length === beforeCamera; ++i) await settle()
    assert.strictEqual(budgets[beforeCamera], 32, 'New camera work waited for the old display receipt')
    assert(!runtime.frameClock.work.has('terrain-model'), 'A converged model kept polling')
    release(); await pending
    assert.strictEqual(runtime.meshFrames.candidate.updateState.modelRevision, preparedModel)
    assert.strictEqual(runtime.terrainChanges, 96, 'Preparation discarded completed logical mutations')
    assert.strictEqual(runtime.terrainPreparation, null)
    assert(!runtime.frameClock.work.has('terrain-model'))

    await runtime.presentMeshFrame(runtime.meshFrames.candidate.frame.sequence)
    runtime.frameClock.work.clear()
    abi.advanceTerrain = () => ({modelRevision: model, topologyChangeCount: 0,
      pendingPriorityUpdateCount: 0, budgetExhausted: false})
    const idle = runtime.refresh()
    for (let i = 0; i < 20 && !(runtime.terrainPreparation && runtime.terrainPreparation.ran); ++i) await settle()
    assert(runtime.terrainPreparation && runtime.terrainPreparation.ran)
    assert.strictEqual(runtime.refreshPending, false, 'Unchanged background work requested another identical publication')
    release(); await idle
    await runtime.presentMeshFrame(runtime.meshFrames.candidate.frame.sequence)
    const completed = abi.updateCount
    await settle(5)
    assert.strictEqual(abi.updateCount, completed, 'An idle model created a preparation/publication loop')

    const paused = runtime.refresh()
    for (let i = 0; i < 20 && !runtime.terrainPreparation; ++i) await settle()
    runtime.pause()
    const count = budgets.length
    await settle(5)
    assert.strictEqual(budgets.length, count, 'Paused preparation kept advancing')
    release(); await paused
    assert.strictEqual(runtime.terrainPreparation, null)
    assert.strictEqual(runtime.meshFrames.candidate, null, 'Paused preparation adopted a late candidate')
  } finally { runtime.destroy() }
}

async function testPartialTargetTopology() {
  for (const resume of ['camera', 'completion', 'recovery']) {
    const abi = new FakeAbi(), production = [], advances = []
    let model = 1, selected = 1, remaining = 0, release, preparing
    const update = abi.updateStep.bind(abi)
    abi.getRequests = () => []
    abi.updateStep = (threshold, budget) => {
      production.push(budget.maximumChangeCount)
      selected = model
      return Object.assign(update(), {drawCount: 1, coverageComplete: true})
    }
    abi.getUpdateState = () => ({modelRevision: selected, topologyChangeCount: 0,
      pendingPriorityUpdateCount: 0, pendingMeshGroups: remaining, budgetExhausted: false})
    abi.getMeshResources = () => [{resourceId: selected, vertexCount: 3}]
    abi.copyMeshResource = draw => ({resourceId: draw.resourceId,
      positions: new Float32Array(9), textureUv: new Float32Array(6)})
    abi.advanceTerrain = (threshold, budget) => {
      advances.push(budget.maximumChangeCount)
      const changes = Math.min(8, budget.maximumChangeCount)
      model += changes
      return {modelRevision: model, topologyChangeCount: changes,
        pendingPriorityUpdateCount: advances.length === 1 ? 2 : 0,
        budgetExhausted: true, limitedByCapacity: false}
    }
    const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
    try {
      for (let i = 0; i < 20 && !runtime.meshFrames.candidate; ++i) await settle()
      const first = runtime.meshFrames.candidate
      first.updateState.pendingMeshGroups = 2
      await runtime.presentMeshFrame(first.frame.sequence)
      runtime.frameClock.work.clear()
      remaining = 0 // This continuation will finish the original target.
      renderer.prepareMeshOutputs = () => ({
        admit: (packet, bytes) => new Promise(resolve => {
          release = () => resolve(renderer.reserveMeshOutputs(packet, bytes))
        }), release() {}
      })
      preparing = runtime.refresh()
      for (let i = 0; i < 30 && advances.length < 2; ++i) await settle()
      assert.strictEqual(production[production.length - 1], 0,
        'A partial target changed topology before producing its remaining groups')
      assert.deepStrictEqual(advances, [0, 0],
        'Preparation replaced a pending target or stopped its priority continuation')
      assert.strictEqual(model, selected)
      assert(!runtime.frameClock.work.has('terrain-model'),
        'A pending group spun topology-only work while waiting for production')
      assert.strictEqual(runtime.meshFrames.presented, first)
      if (resume === 'camera') {
        runtime.camera.longitudeDegrees += 1
        await runtime.refresh()
      } else {
        release(); await preparing; preparing = null
        if (resume === 'recovery') {
          runtime.meshFrames.candidate.updateState.pendingMeshGroups = 1
          runtime.meshRecovery = {changed: false, revision: model}
          await runtime.advanceTerrain(true)
        } else {
          await runtime.presentMeshFrame(runtime.meshFrames.candidate.frame.sequence)
          runtime.frameClock.work.clear()
          preparing = runtime.refresh()
        }
      }
      for (let i = 0; i < 30 && advances.length === 2; ++i) await settle()
      assert.strictEqual(advances[2], 32, `${resume} did not resume bounded topology work`)
      assert(model > selected || resume === 'completion', 'Resumed work made no model progress')
    } finally {
      runtime.destroy()
      if (release) release()
      if (preparing) await preparing
    }
  }
}

async function testHandoffPlanLifetime() {
  const {MeshOutputPlan} = require('../../adapters/webgl/mesh_output_plan')
  const {ResourceCache} = require('../../sdk/js/resources/resource_cache')
  const {GeometryCache} = require('../../adapters/webgl/geometry_cache')
  const abi = new FakeAbi(), plans = []
  const tile = {level: 0, matrix: 0, row: 0, column: 0}
  const leaf = {level: 1, matrix: 1, row: 0, column: 0}
  const key = common.textureKeyString
  const update = abi.updateStep.bind(abi)
  abi.updateStep = () => Object.assign(update(), {drawCount: 1, coverageComplete: true})
  abi.getRequests = () => []
  abi.getMeshResources = () => [{resourceId: abi.updateCount, vertexCount: 3, texture: tile}]
  abi.copyMeshResource = draw => ({resourceId: draw.resourceId,
    positions: new Float32Array(9), textureUv: new Float32Array(6)})
  let renderer, acknowledge, presentationWakes = 0, preparationWakes = 0, imageryWakes = 0
  const {runtime} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1},
    rendererFactory(node, options) {
      renderer = new FakeRenderer(options)
      renderer.partitionGroups = {wakeImagery() { ++imageryWakes }}
      renderer.requestRender = () => { ++presentationWakes; options.requestRender() }
      renderer.requestResources = () => { ++preparationWakes; options.requestResources() }
      renderer.resourceLedger = options.resourceLedger
      renderer.geometry = new GeometryCache({ledger: options.resourceLedger, owner: 'geometry'})
      renderer.indices = {quote: () => 0, fund: outputs => outputs} // No GPU index producer in this lifetime fixture.
      renderer.displaySurface = {current: {draws: []}} // This lifetime fixture borrows no displayed geometry.
      const images = new ResourceCache({ledger: options.resourceLedger, owner: 'images'})
      images.set(key(tile), {}, 1); images.set(key(leaf), {}, 1)
      renderer.textures = {cache: images, targetDesired: new Map(), gpuReady: () => false,
        presentationTileFor: () => tile}
      renderer.presentation = {cells: new Map([[key(leaf), {cell: leaf, a: tile, b: leaf}]])}
      renderer.partitionCapacityBytes = 10000
      renderer.partitionBytes = renderer.partitionReservedBytes = renderer.partitionCpuBytes = 0
      renderer.prunePartitions = () => {}
      renderer.partitionCell = draw => ({key: key(draw.texture)})
      renderer.sourceUvScale = () => 0 // Exercise the explicit-clipping handoff lifetime.
      options.meshPartitionWorkspaceBytes = () => 0 // This fixture uses no native scratch.
      options.createMeshPartitionPlanTask = (id, rows, onRows) =>
        require('./reference/mesh_cost_batch')(rows, onRows,
          row => row.cells.map(cell => ({key: cell.key, bytes: 66})))
      renderer.prepareMeshOutputs = packet => {
        const plan = new MeshOutputPlan(renderer, packet, draw => `mesh:${draw.resourceId}`)
        renderer.meshOutputPlan = plan; plans.push(plan)
        return require('./reference/mesh_allocation_quote')(plan)
      }
      const destroy = renderer.destroy.bind(renderer)
      renderer.destroy = () => { renderer.geometry.clear(); images.clear(); destroy() }
      return renderer
    }})
  try {
    for (let attempt = 0; attempt < 20 && !runtime.meshFrames.candidate && !runtime.lastError; ++attempt) await settle()
    assert(runtime.meshFrames.candidate, runtime.lastError || 'Prepared handoff did not reach the renderer')
    const plan = plans[0], candidate = runtime.meshFrames.candidate
    // This GPU-free fixture acknowledges the consumer acceptance explicitly.
    candidate.outputs.acceptSurface()
    assert(plan.accepted)
    assert(plan.valid(), 'Runtime closed the fixed handoff before asynchronous work could consume it')
    assert.strictEqual(renderer.partitionReservedBytes, 264)
    assert.strictEqual(renderer.partitionCpuBytes, 264)
    assert.strictEqual(renderer.geometry.reservedBytes, 60)
    assert.strictEqual(renderer.textures.cache.entries.get(key(leaf)).holds, 1)
    const footprint = plan.draws(candidate.draws)
    renderer.presentation.cells.clear()
    assert.deepStrictEqual(plan.draws(candidate.draws), footprint, 'Handoff followed mutable imagery history')
    abi.presentFrame = () => new Promise(resolve => { acknowledge = resolve })
    const receipt = runtime.presentMeshFrame(candidate.frame.sequence)
    await Promise.resolve()
    assert(acknowledge && plan.valid(), 'A sent receipt released resources before its acknowledgement')
    acknowledge(); await receipt
    assert(plan.closed)
    assert.strictEqual(imageryWakes, 1, 'The completed receipt failed to resume parked imagery')
    assert.strictEqual(presentationWakes, 1, 'The completed receipt failed to wake post-handoff imagery')
    assert.strictEqual(preparationWakes, 1, 'The completed receipt failed to wake post-handoff preparation')
    assert.strictEqual(renderer.partitionReservedBytes + renderer.partitionCpuBytes + renderer.geometry.reservedBytes, 0)
    assert.strictEqual(renderer.textures.cache.entries.get(key(leaf)).holds, 0)
    await runtime.refresh()
    assert(plans[1].valid())
  } finally { runtime.destroy() }
  assert(plans.every(plan => plan.closed))
  assert.strictEqual(runtime.resourceLedger.bytes, 0, 'Handoff lifecycle leaked reservations or image holds')
}

async function testResourceContract() {
  for (const name of ['prepareMeshFrame', 'createMeshTask', 'commitMeshFrame', 'discardMeshPlan',
    'getUpdateState', 'getMeshResources', 'copyMeshPositions', 'copyMeshUv',
    'advanceTerrain', 'retainMeshes', 'presentFrame']) {
    const abi = new FakeAbi()
    abi[name] = undefined
    let renderer
    await assert.rejects(createRuntime({abi, rendererFactory(node, options) {
      renderer = new FakeRenderer(options); return renderer
    }}), new RegExp('Terra ABI is missing ' + name))
    assert(abi.destroyed && renderer.destroyed, 'Rejected resource adapter leaked runtime owners')
    assert.strictEqual(abi.loadedManifest, null, 'Incomplete adapter was started')
  }
  for (const name of ['setMeshFrame', 'setCameraFrame', 'holdCandidate', 'discardCandidate', 'releaseCandidate', 'prepareMeshOutputs', 'reserveMeshOutputs', 'terrainRefinementDemand', 'reserveImageryDemand']) {
    let renderer
    await assert.rejects(createRuntime({abi: new FakeAbi(), rendererFactory(node, options) {
      renderer = new FakeRenderer(options); renderer[name] = undefined; return renderer
    }}), new RegExp('Terra renderer is missing ' + name))
    assert(renderer.destroyed)
  }
}

async function testDirectPreparationLifecycle() {
  for (const action of ['pause', 'destroy']) {
    const abi = new FakeAbi(); abi.getRequests = () => []
    const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
    await settle(3)
    if (runtime.meshFrames.candidate) await runtime.presentMeshFrame(runtime.meshFrames.candidate.frame.sequence)
    const read = runtime.meshFrames.read.bind(runtime.meshFrames)
    let release, entered
    const ready = new Promise(resolve => {entered = resolve})
    const gate = new Promise(resolve => {release = resolve})
    runtime.meshFrames.read = async (...args) => {entered(); await gate; return read(...args)}
    const refresh = runtime.refresh()
    await ready
    const displayed = renderer.frames.length, cameraCalls = abi.cameras.length
    runtime[action]()
    if (action === 'destroy') runtime.meshFrames.read = read
    // Simulate cancellation before any access to the destroyed native context.
    if (action === 'destroy') abi.prepareMeshFrame = () => {throw new Error('cancelled boundary')}
    release(); await refresh
    assert.strictEqual(renderer.frames.length, displayed, 'Late direct preparation reached the renderer')
    assert.strictEqual(runtime.meshFrames.candidate, null, 'Pause retained a late candidate')
    if (action === 'destroy') {
      assert.strictEqual(abi.cameras.length, cameraCalls, 'Completion touched a destroyed native camera')
      assert(!runtime.state().diagnostics.some(d => d.kind === 'runtime_refresh_failed'),
        'Expected destruction was reported as a refresh failure')
    }
    runtime.destroy()
  }
}

async function testMeshCapacityBackpressure() {
  const abi = new FakeAbi()
  abi.getRequests = () => []
  const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  await settle(3)
  const update = abi.updateStep.bind(abi), displayed = runtime.meshFrames.presented
  const occupied = runtime.resourceLedger.reserve('test-owned', 1)
  const quality = {state: 'ready', ready: true, settled: true, limitationReasons: []}
  renderer.stats = () => ({quality})
  let attempts = 0, recoveries = 0
  const recover = abi.advanceTerrain.bind(abi)
  abi.advanceTerrain = (...args) => { ++recoveries; return recover(...args) }
  abi.updateStep = () => {
    ++attempts
    throw Object.assign(new Error('capacity fixture'), {status: 9, requests: []})
  }
  try {
    await runtime.refresh(); await settle(5)
    assert.strictEqual(recoveries, 1, 'Capacity recovery waited for the held display clock')
    assert.strictEqual(runtime.meshRecovery, null, 'An unchanged model kept recovery alive')
    assert.strictEqual(attempts, 1, 'Capacity refusal entered the ordinary retry loop')
    assert.strictEqual(runtime.meshFrames.presented, displayed, 'Refusal lost the displayed owner')
    assert.strictEqual(runtime.refreshPending, false)
    assert.strictEqual(runtime.state().error, '')
    assert.strictEqual(runtime.state().terrainSelection.meshCapacityBlocked, true)
    assert.strictEqual(runtime.state().renderer.quality.ready, false)
    assert(runtime.state().renderer.quality.limitationReasons.includes('terrain-memory'))
    assert.strictEqual(quality.ready, true, 'State reporting mutated renderer quality')
    assert(!runtime.state().diagnostics.some(d => d.kind === 'runtime_refresh_failed'))
    abi.updateStep = (threshold, budget) => {
      assert.strictEqual(budget.maximumChangeCount, 0, 'Initial refusal allowed retry to grow topology')
      return update()
    }
    occupied.release(); await settle(8)
    assert.strictEqual(runtime.state().terrainSelection.meshCapacityBlocked, false)
    assert.strictEqual(runtime.state().renderer.quality.state, 'ready')
  } finally {runtime.destroy()}
}

async function testLateCandidateAdmissionRefusal() {
  const abi = new FakeAbi(); abi.getRequests = () => []
  const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  await settle(3)
  const frame = runtime.lastFrame, surface = runtime.lastSurface, shown = runtime.meshFrames.presented
  const setFrame = renderer.setMeshFrame.bind(renderer), displays = renderer.frames.length
  renderer.setMeshFrame = () => {throw Object.assign(new Error('Late image destination shortage'),
    {status: 9, candidateAdmissionRejected: true, capacityShortfallBytes: 4})}
  try {
    runtime.frameClock.work.clear(); await runtime.refresh(); runtime.frameClock.work.clear()
    assert.strictEqual(runtime.meshFrames.candidate, null, 'Unreceived candidate kept waiting for a display receipt')
    assert.strictEqual(runtime.meshFrames.presented, shown)
    assert.strictEqual(runtime.lastFrame, frame, 'Refused receiver advanced the public frame')
    assert.strictEqual(runtime.lastSurface, surface)
    assert.strictEqual(renderer.frames.length, displays)
    assert.strictEqual(runtime.lastError, '')
    assert(!runtime.state().diagnostics.some(d => d.kind === 'runtime_refresh_failed'))
    renderer.setMeshFrame = setFrame
  } finally {runtime.destroy()}
  assert.strictEqual(runtime.resourceLedger.bytes, 0)
}

async function testMeshCapacityCoarsening() {
  const abi = new FakeAbi()
  abi.getRequests = () => []
  const {runtime} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  await settle(3)
  const update = abi.updateStep.bind(abi), displayed = runtime.meshFrames.presented
  let model = 1, advances = 0, attempts = 0
  const preferred = runtime.terrainUpdateBudget().meshBudgetBytes
  const failedTarget = preferred - 200000
  abi.updateStep = (threshold, budget) => {
    ++attempts
    if (model < 3) throw Object.assign(new Error('candidate exceeds destination'),
      {status: 9, requests: [], modelRevision: model, capacityShortfallBytes: 90000,
        capacitySelectedBytes: failedTarget})
    assert.strictEqual(budget.maximumChangeCount, 0, 'Recovered publication refined before admission')
    assert.strictEqual(budget.coarseningOnly, true, 'Recovered publication rebuilt speculative heights')
    return update()
  }
  abi.advanceTerrain = (threshold, budget) => {
    assert.strictEqual(budget.coarseningOnly, true, 'Recovery can create new refinement dependencies')
    assert.strictEqual(budget.maximumChangeCount, 32)
    assert.strictEqual(budget.meshBudgetBytes, failedTarget - 30000,
      'Recovery used the old display/configuration instead of the refused candidate')
    ++advances; ++model
    return {modelRevision: model, topologyChangeCount: advances === 1 ? 32 : 1,
      pendingPriorityUpdateCount: 0, budgetExhausted: advances === 1, limitedByCapacity: true}
  }
  try {
    await runtime.refresh()
    for (let turn = 0; turn < 2; ++turn) {
      runtime.frameClock.work.clear()
      await runtime.refresh()
      assert.strictEqual(runtime.meshFrames.presented, displayed, 'Coarsening retired the displayed mesh')
      assert.strictEqual(attempts, 1, 'Unfinished recovery repeatedly attempted production')
    }
    assert.strictEqual(advances, 2)
    assert.strictEqual(runtime.meshRecovery, null)
    assert(runtime.frameClock.work.has('terrain'), 'Completed coarsening did not wake production')
    runtime.frameClock.work.clear(); await runtime.refresh()
    assert.strictEqual(attempts, 2)
    assert.strictEqual(advances, 2, 'Recovery publication started speculative background work')
    assert.strictEqual(runtime.meshCapacityBlocked, false)
  } finally {runtime.destroy()}
}

async function testTerrainCapacityFeedback() {
  const {TerrainCapacity} = require('../../sdk/js/terrain/terrain_capacity')
  const capacity = new TerrainCapacity(200, 40)
  assert(!capacity.refuse(undefined, 1))
  assert(capacity.refuse(90, 1, 190))
  assert.strictEqual(capacity.bytes, 160)
  assert(capacity.beginRestore(1))
  assert(capacity.restoring && capacity.bytes === 200)
  assert(!capacity.beginRestore(1), 'The same restoration started twice')
  assert(capacity.refuse(90, 1, 200))
  assert.strictEqual(capacity.bytes, 130)
  assert(!capacity.restoring)
  assert(capacity.beginRestore(1))
  capacity.complete(1)
  assert(!capacity.restoring && capacity.recoveryBytes === undefined)
  assert(capacity.refuse(90, 1, 200))
  assert.strictEqual(capacity.bytes, 170, 'Completed recovery retained obsolete backoff')
  capacity.updateView(2)
  assert.strictEqual(capacity.bytes, 170, 'A new view silently changed the working quota')
  assert(capacity.beginRestore(2))
  assert(capacity.refuse(30, 2, 200))
  assert.strictEqual(capacity.bytes, 160,
    'A new view lost the finite relief quota when its restoration was refused')
  assert(capacity.beginRestore(2))
  capacity.updateView(3)
  assert(!capacity.restoring && capacity.recoveryBytes === undefined,
    'A new view inherited the previous local restoration window')
  assert(capacity.refuse(1000, 3))
  assert.strictEqual(capacity.bytes, 40, 'Capacity feedback lost root coverage')
  assert(!capacity.refuse(1000, 3), 'Minimum quota advertised another useful reduction')
  await require('./terrain_incremental_recovery_contract')()
}

async function testTerrainPrecisionWakeup() {
  const abi = new FakeAbi(); abi.getRequests = () => []
  const window = {maximumChangeCount:4, maximumPriorityUpdateCount:128, maximumElapsedMs:2}
  const {runtime, renderer} = await createRuntime({abi, terrainUpdateBudget:window,
    canvas: {requestAnimationFrame: () => 1}})
  await settle(3)
  const capacity = runtime.terrainCapacity, preferred = capacity.bytes
  const occupied = runtime.resourceLedger.reserve('pressure', runtime.resourceLedger.maximumBytes - runtime.resourceLedger.bytes)
  try {
    capacity.refuse(90000, runtime.cameraRevision)
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    runtime.meshCapacityBlocked = true
    occupied.resize(occupied.bytes - 3 * preferred); await Promise.resolve()
    assert.strictEqual(runtime.terrainUpdateBudget().meshBudgetBytes, preferred - 30000,
      'A capacity receipt reopened refinement before recovery publication')
    runtime.meshCapacityBlocked = false
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    renderer.terrainRefinementDemand = () => null
    occupied.release(); await Promise.resolve()
    assert.strictEqual(capacity.bytes, preferred - 30000, 'Unknown imagery demand reopened terrain precision')
    assert(!runtime.frameClock.work.has('terrain'))
    renderer.terrainRefinementDemand = () => ({sequence: runtime.lastFrame.sequence,
      bytes: 0, keep: [], admission: {}})
    runtime.retryTerrainPrecision()
    assert.strictEqual(capacity.bytes, preferred - 30000,
      'A provisional image continuation restored full terrain capacity before final demand was priced')
    assert(!runtime.frameClock.work.has('terrain'), 'Incomplete pricing woke whole-quota recovery')
    renderer.terrainRefinementDemand = () => ({sequence: runtime.lastFrame.sequence, bytes: runtime.resourceLedger.maximumBytes, keep: []})
    runtime.retryTerrainPrecision()
    assert.strictEqual(capacity.bytes, preferred - 30000, 'Pending imagery demand was treated as free space')
    renderer.terrainRefinementDemand = () => ({sequence: runtime.lastFrame.sequence, bytes: 0, keep: []})
    runtime.retryTerrainPrecision()
    assert.strictEqual(capacity.bytes, preferred, 'A real refund did not reopen the affordable unchanged view')
    assert(runtime.frameClock.work.has('terrain'), 'Precision recovery changed policy without waking terrain')
    assert(capacity.restoring)
    const restored = runtime.terrainUpdateBudget()
    for (const key of Object.keys(window)) assert.strictEqual(restored[key], window[key],
      'Restoration replaced the configured work window with per-node publication')
    assert.strictEqual(runtime.terrainUpdateBudget(true).maximumChangeCount, window.maximumChangeCount,
      'Emergency coarsening lost its configured topology window')
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    runtime.resourceLedger.available(); await Promise.resolve()
    assert(!runtime.frameClock.work.has('terrain'), 'Settled preferred capacity polled terrain')
    const surface = runtime.meshFrames.presented, draws = surface.draws
    const selected = preferred / 2
    surface.draws = [{resourceId:1,textureResourceId:1,positionFloatCount:(selected-4)/4,textureFloatCount:1}]
    try {
      assert(runtime.reduceTerrainCapacity(3,preferred))
      assert.strictEqual(capacity.bytes,selected-1,
        'Restoration backoff stayed above the already smaller displayed cut')
      assert(!capacity.restoring)
    } finally {surface.draws=draws}
  } finally {occupied.release(); runtime.destroy()}
}

async function testMinimumTerrainRestorationRefusal() {
  const abi = new FakeAbi(); abi.getRequests = () => []
  const {runtime} = await createRuntime({abi, canvas:{requestAnimationFrame:() => 1}})
  await settle(3)
  const capacity = runtime.terrainCapacity, ledger = runtime.resourceLedger
  let occupied
  try {
    assert(capacity.refuse(capacity.preferred * 3, runtime.cameraRevision))
    assert.strictEqual(capacity.bytes, capacity.minimum)
    assert(capacity.beginRestore(runtime.cameraRevision))
    occupied = ledger.reserve('minimum-recovery-pressure', ledger.maximumBytes - ledger.bytes)
    const ownedBytes = ledger.bytes, refusal = {}
    assert.strictEqual(ledger.reserve('imagery-input', 4096, [], [], [], refusal), null)
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    assert(runtime.recoverSharedCapacity({kind:'imagery-input', sequence:runtime.lastFrame.sequence,
      keys:['minimum-recovery'], shortfallBytes:refusal.shortfallBytes}),
    'A refused restoration from minimum capacity did not reopen the relief publication path')
    assert.strictEqual(capacity.bytes, capacity.minimum,
      'Refused restoration kept the larger target quota instead of the owned relief floor')
    assert(!capacity.restoring)
    assert(runtime.meshRecovery && runtime.meshCapacityBlocked && runtime.frameClock.work.has('terrain'))
    const budget = runtime.terrainUpdateBudget(true)
    assert.strictEqual(budget.meshBudgetBytes, capacity.minimum)
    assert(budget.coarseningOnly)
    assert.strictEqual(ledger.bytes, ownedBytes, 'Recovery refunded an unacknowledged owner')
    const reductions = capacity.reductions
    assert(!capacity.refuse(refusal.shortfallBytes, runtime.cameraRevision),
      'An unchanged minimum quota advertised another useful reduction')
    assert.strictEqual(capacity.reductions, reductions)
  } finally {if (occupied) occupied.release(); runtime.destroy()}
}

async function testJointTerrainRecoveryCompletion() {
  const abi = new FakeAbi(); abi.getRequests = () => []
  const update = abi.updateStep.bind(abi)
  abi.updateStep = (...args) => Object.assign(update(...args), {coverageComplete:true})
  abi.getUpdateState = () => ({modelRevision:1, topologyChangeCount:0,
    pendingPriorityUpdateCount:0, pendingMeshGroups:0, budgetExhausted:false,
    limitedByCapacity:false, achievedLodError:0.001, requestedLodThreshold:0.002})
  const {runtime, renderer} = await createRuntime({abi, canvas:{requestAnimationFrame:() => 1}})
  await settle(3)
  const capacity = runtime.terrainCapacity, preferred = capacity.preferred
  const stats = renderer.stats.bind(renderer)
  let settled = false
  renderer.stats = () => Object.assign(stats(), {quality:{settled}})
  try {
    assert(capacity.refuse(90000, runtime.cameraRevision))
    const relief = capacity.bytes
    assert(capacity.beginRestore(runtime.cameraRevision))
    await runtime.refresh(); await runtime.meshReceipts.tail; await settle(3)
    assert.strictEqual(runtime.presentedFrame.coverageComplete, true)
    assert.strictEqual(capacity.recoveryBytes, relief,
      'A terrain-only receipt forgot the relief floor while imagery was still refining')
    assert(capacity.refuse(90000, runtime.cameraRevision, preferred))
    assert.strictEqual(capacity.bytes, relief - 30000,
      'Unsettled imagery restarted the same terrain relief cycle')
    assert(capacity.beginRestore(runtime.cameraRevision))
    settled = true
    const view = runtime.presentedSurface.selectionViewRevision
    runtime.presentedSurface.selectionViewRevision = view - 1
    runtime.retryTerrainPrecision()
    assert.strictEqual(capacity.recoveryBytes, relief - 30000,
      'A stale displayed terrain completed recovery')
    runtime.presentedSurface.selectionViewRevision = view
    runtime.meshCapacityBlocked = true
    runtime.retryTerrainPrecision()
    assert.strictEqual(capacity.recoveryBytes, relief - 30000)
    runtime.meshCapacityBlocked = false
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    runtime.retryTerrainPrecision()
    assert.strictEqual(capacity.recoveryBytes, undefined,
      'Joint terrain/imagery settlement did not finish recovery without a camera change')
    assert(!runtime.frameClock.work.has('terrain'), 'Recovery completion started another topology cycle')
    assert(capacity.refuse(90000, runtime.cameraRevision, preferred))
    assert.strictEqual(capacity.bytes, relief, 'A later pressure episode inherited an obsolete relief floor')
    assert(capacity.beginRestore(runtime.cameraRevision))
    runtime.renderMode = 'height'; settled = false
    runtime.retryTerrainPrecision()
    assert.strictEqual(capacity.recoveryBytes, undefined,
      'Height-only presentation waited for an imagery target it does not use')
  } finally {runtime.destroy()}
}

async function testTerrainDemandBackpressure() {
  const abi = new FakeAbi(); abi.getRequests = () => []
  const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  await settle(3)
  try {
    const preferred = runtime.terrainUpdateBudget().meshBudgetBytes
    renderer.terrainRefinementDemand = () => ({sequence: runtime.lastFrame.sequence, bytes: runtime.resourceLedger.maximumBytes, keep: []})
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, true,
      'Terrain continued speculative refinement through an unfunded current imagery cut')
    assert.strictEqual(runtime.terrainDemand.reason, 'capacity')
    assert.strictEqual(runtime.terrainCapacity.bytes, preferred, 'Demand backpressure reduced terrain precision')
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    runtime.retryTerrainDemand()
    assert(!runtime.frameClock.work.has('terrain'), 'Blocked demand polled unchanged terrain')
    const update = abi.updateStep.bind(abi)
    abi.updateStep = (...args) => Object.assign(update(...args), {decisionsComplete: false})
    await runtime.refresh(); await settle(8)
    assert(!runtime.frameClock.work.has('terrain') && !runtime.refreshPending,
      'A demand-blocked, non-converged cut spun without runnable work')
    abi.updateStep = update
    const pendingTarget = runtime.pendingTerrainTarget
    runtime.pendingTerrainTarget = () => true
    const heldBudget = runtime.terrainUpdateBudget()
    await runtime.advanceModel(heldBudget)
    assert.strictEqual(heldBudget.maximumChangeCount, 0, 'Demand backpressure replaced an unfinished terrain target')
    runtime.pendingTerrainTarget = pendingTarget
    renderer.terrainRefinementDemand = () => null
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, true,
      'Partial same-camera planning lost the previous demand backpressure')
    ++runtime.cameraRevision
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, false,
      'An old view prevented a new view from selecting its first surface')
    renderer.terrainRefinementDemand = () => ({sequence: runtime.lastFrame.sequence, bytes: runtime.resourceLedger.maximumBytes, keep: []})
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, true)
    renderer.terrainRefinementDemand = () => ({sequence: runtime.lastFrame.sequence, bytes: 1, keep: []})
    runtime.retryTerrainDemand()
    assert(runtime.frameClock.work.has('terrain'), 'Affordable future demand never resumed terrain')
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, false,
      'Refinement waited for images instead of checking their future capacity')
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    runtime.retryTerrainDemand()
    assert(!runtime.frameClock.work.has('terrain'), 'Unchanged affordable demand kept waking terrain')
    const selected = preferred / 2
    assert(runtime.reduceTerrainCapacity(3, selected))
    assert.strictEqual(runtime.terrainCapacity.bytes, selected - 1,
      'A tiny refusal consumed unused allowance instead of forcing a smaller selected cut')
  } finally {runtime.destroy()}
}

async function testUnpricedTerrainWindow() {
  const abi = new FakeAbi(); abi.getRequests = () => []
  const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  await settle(3)
  try {
    let sequence = runtime.lastFrame.sequence + 1
    runtime.lastFrame = Object.assign({}, runtime.lastFrame, {decisionsComplete: false})
    renderer.terrainRefinementDemand = () => ({sequence: sequence - 1, bytes: 0, keep: []})
    runtime.beginTerrainPreparation({frame: {sequence}, updateState: {modelRevision: 2},
      selectionViewRevision: runtime.cameraRevision})
    assert.strictEqual(runtime.terrainUpdateBudget().maximumChangeCount, 0,
      'An affordable predecessor image plan authorized refinement beyond an unpriced terrain window')
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, false,
      'Planning wait invalidated native dependency protection through capacity recovery')
    const recovery = runtime.terrainUpdateBudget(true)
    assert(recovery.coarseningOnly && recovery.maximumChangeCount !== 0,
      'Pending pricing prevented actual capacity recovery')
    renderer.terrainRefinementDemand = () => null
    assert.strictEqual(runtime.terrainUpdateBudget().maximumChangeCount, 0,
      'Incomplete imagery planning released the unpriced terrain window')
    await runtime.finishTerrainPreparation()
    renderer.terrainRefinementDemand = () => ({sequence: sequence - 1, bytes: 0, keep: []})
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, false,
      'Cancelled preparation kept waiting for a frame that can never be priced')
    const update = abi.updateStep.bind(abi)
    const updateState = abi.getUpdateState.bind(abi)
    abi.updateStep = (...args) => Object.assign(update(...args), {decisionsComplete: false})
    abi.getUpdateState = () => Object.assign(updateState(), {budgetExhausted: true})
    await runtime.refresh()
    abi.updateStep = update
    abi.getUpdateState = updateState
    assert.strictEqual(runtime.lastFrame.sequence, sequence)
    await runtime.meshReceipts.tail
    assert.strictEqual(runtime.presentingSequence, null,
      'The selected frame has not completed its ownership receipt')
    assert.strictEqual(runtime.terrainUpdateBudget().maximumChangeCount, 0,
      'Publishing the selected frame lost its own pending imagery price')
    // A physical zero-operation selection can report budget exhaustion even
    // when the model is idle. One independent observation may publish the
    // completed metadata; it must then park instead of repeating arrays.
    const selected = abi.updateCount
    await settle(6)
    const idle = abi.updateCount
    await settle(6)
    assert(idle <= selected + 1 && abi.updateCount === idle &&
      !runtime.frameClock.work.has('terrain') && !runtime.refreshPending,
    'Unpriced deferred refinement kept publishing equivalent zero-change frames')
    sequence = runtime.lastFrame.sequence
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    runtime.lastFrame = Object.assign({}, runtime.lastFrame, {decisionsComplete: false})
    renderer.terrainRefinementDemand = () => ({sequence, bytes: 0, keep: []})
    runtime.retryTerrainDemand()
    assert(runtime.frameClock.work.has('terrain'), 'Pricing completion did not release the terrain window')
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, false,
      'A priced affordable cut waited for imagery downloads')
    const surface = runtime.meshFrames.presented
    runtime.beginTerrainPreparation(Object.assign({}, surface, {frame: {sequence: sequence + 1},
      selectionViewRevision: runtime.cameraRevision}))
    assert(runtime.terrainUpdateBudget().maximumChangeCount !== 0,
      'An unchanged priced surface created another preparation/pricing wakeup loop')
    await runtime.finishTerrainPreparation()
    // A planning wait can leave a zero-change lookahead after its display
    // receipt. The next selection must use that unspent topology window,
    // rather than repeatedly publishing the same coarse model with a zero cap.
    renderer.terrainRefinementDemand = () => null
    runtime.terrainUpdateBudget()
    runtime.terrainChanges = 0
    renderer.terrainRefinementDemand = () => ({sequence, bytes: 0, keep: []})
    runtime.retryTerrainDemand()
    const prepare = abi.prepareMeshFrame.bind(abi), budgets = []
    abi.prepareMeshFrame = (threshold, budget) => {budgets.push(budget); return prepare(threshold, budget)}
    await runtime.refresh()
    assert(budgets.length && budgets[0].maximumChangeCount !== 0,
      'Completed imagery pricing kept publishing zero-change terrain windows: ' + JSON.stringify({
        budgets: budgets.map(budget => budget.maximumChangeCount), changes: runtime.terrainChanges,
        refreshing: runtime.refreshing, presenting: runtime.presentingSequence, demand: runtime.terrainDemand.stats()}))
    await runtime.meshReceipts.tail
    renderer.terrainRefinementDemand = () => ({sequence:runtime.lastFrame.sequence,bytes:0,keep:[]})
    assert.strictEqual(runtime.updateTerrainDemand(),false)
    runtime.terrainChanges = 0
    budgets.length = 0
    await runtime.refresh()
    assert(budgets.length && budgets[0].maximumChangeCount !== 0,
      'An already priced zero-change lookahead permanently spent the next topology window')
    renderer.terrainRefinementDemand = () => ({sequence: runtime.lastFrame.sequence,
      bytes: runtime.resourceLedger.maximumBytes, keep: []})
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, true,
      'A completed but unfunded image cut released terrain refinement')
    ++runtime.cameraRevision
    renderer.terrainRefinementDemand = () => null
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, false,
      'The previous view prevented first-surface selection for a new camera')
    runtime.beginTerrainPreparation({frame: {sequence: sequence + 1}, updateState: {modelRevision: 3},
      selectionViewRevision: runtime.cameraRevision - 1})
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, false,
      'An obsolete preparation reinstated the previous view barrier')
    await runtime.finishTerrainPreparation()
  } finally {await runtime.finishTerrainPreparation(); runtime.destroy()}
}

async function testUnfundedConservativeDemand() {
  const abi = new FakeAbi(); abi.getRequests = () => []
  const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  await settle(3)
  try {
    let requests = 0
    renderer.refineImageryDemand = () => {++requests; return true}
    const demand = {sequence: runtime.lastFrame.sequence, bytes: runtime.resourceLedger.maximumBytes,
      keep: [], refinable: true}
    renderer.terrainRefinementDemand = () => demand
    const preferred = runtime.terrainCapacity.bytes, budget = runtime.terrainUpdateBudget()
    assert.strictEqual(runtime.terrainDemand.reason, 'measurement')
    assert.strictEqual(budget.maximumChangeCount, 0)
    assert.strictEqual(budget.coarseningOnly, false,
      'An unverified imagery overestimate discarded terrain refinement dependencies')
    assert(requests > 0, 'Unfunded conservative demand never requested tighter measurement')
    assert.strictEqual(runtime.recoverSharedCapacity({sequence: demand.sequence, keys: ['tile'], shortfallBytes: 3000}), false,
      'Starting measurement consumed the producer refusal before actual recovery')
    assert.strictEqual(runtime.terrainCapacity.bytes, preferred,
      'Imagery pressure reduced terrain precision before checking a refinable bound')
    assert(!runtime.meshRecovery)
    demand.refinable = false
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, true,
      'Genuine capacity pressure was hidden after exact measurement')
    assert.strictEqual(runtime.terrainDemand.reason, 'capacity')
    demand.bytes = 0
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, false)
    assert.strictEqual(runtime.terrainDemand.reason, null)
    renderer.reserveImageryDemand = () => false
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, true,
      'A feasibility check resumed terrain without a committed imagery reservation')
    renderer.reserveImageryDemand = () => true
    assert.strictEqual(runtime.terrainUpdateBudget().coarseningOnly, false)
  } finally {runtime.destroy()}
}

async function testHeightCapacityParking() {
  const abi = new FakeAbi(); abi.getRequests = () => []
  const {runtime, renderer} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  await settle(3)
  renderer.terrainRefinementDemand = () => null
  runtime.lastFrame = Object.assign({}, runtime.lastFrame, {decisionsComplete: false})
  runtime.terrainUpdateBudget()
  const displayed = runtime.meshFrames.presented, occupied = runtime.resourceLedger.reserve('height-pressure', 1)
  const publications = abi.updateCount
  const attempts = []
  abi.advanceTerrain = (threshold, budget) => {
    attempts.push(budget.coarseningOnly)
    throw Object.assign(new Error('height credit occupied'), {status: 9, requests: [],
      capacityRevision: runtime.resourceLedger.availabilityRevision})
  }
  try {
    runtime.frameClock.work.clear()
    await runtime.refresh()
    assert(runtime.meshRecovery && runtime.meshCapacityBlocked)
    assert.strictEqual(abi.updateCount, publications, 'Failed logical work fell through to physical publication')
    runtime.frameClock.work.clear()
    await runtime.refresh()
    assert.deepStrictEqual(attempts, [false, true])
    assert.strictEqual(runtime.meshRecovery, null)
    assert(!runtime.frameClock.work.has('terrain'), 'Unfunded coarsening spun the terrain queue')
    assert.strictEqual(runtime.meshFrames.presented, displayed)
    assert.strictEqual(runtime.lastError, '')
    occupied.release(); await Promise.resolve()
    assert(runtime.frameClock.work.has('terrain'), 'Real capacity release did not wake height work')
  } finally {occupied.release(); runtime.destroy()}
}

async function testCapacityReleasedDuringRecovery() {
  const abi = new FakeAbi(); abi.getRequests = () => []
  const {runtime} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  await settle(3)
  const occupied = runtime.resourceLedger.reserve('delayed-owner', 1)
  abi.updateStep = () => { throw Object.assign(new Error('occupied'),
    {status: 9, requests: [], modelRevision: 1}) }
  await runtime.refresh(); runtime.frameClock.work.clear()
  abi.isWorker = true; abi.viewRevision = runtime.cameraRevision
  let release
  abi.advanceTerrain = () => new Promise(resolve => { release = () => resolve({
    selectionViewRevision: abi.viewRevision, requests: [], progress: {modelRevision: 1,
      topologyChangeCount: 0, pendingPriorityUpdateCount: 0, budgetExhausted: false}}) })
  try {
    const recovering = runtime.refresh()
    assert(runtime.refreshing)
    occupied.release(); await settle(2)
    release(); await recovering
    assert(runtime.frameClock.work.has('terrain'), 'Capacity released during recovery did not wake production')
  } finally {abi.isWorker = false; runtime.destroy()}
}

async function testIncrementalConvergence() {
  class IncrementalAbi extends FakeAbi {
    updateStep() {
      const frame = super.updateStep()
      frame.decisionsComplete = this.updateCount >= 2
      return frame
    }

    getRequests() {
      return []
    }
  }
  const abi = new IncrementalAbi()
  const result = await createRuntime({
    abi,
    request() {
      return { promise: Promise.resolve(response(payload())), abort() {} }
    }
  })
  await settle(4)
  assert.strictEqual(abi.updateCount, 2)
  assert.strictEqual(result.runtime.lastFrame.decisionsComplete, true)
  result.runtime.destroy()
}

async function testNetworkWaitDoesNotSpin() {
  class WaitingAbi extends FakeAbi {
    updateStep() {
      const frame = super.updateStep()
      frame.decisionsComplete = false
      return frame
    }

    getRequests() {
      return [recordRequest]
    }
  }
  const abi = new WaitingAbi()
  let aborts = 0
  const result = await createRuntime({
    abi,
    request() {
      return {
        promise: new Promise(() => {}),
        abort() {
          aborts += 1
        }
      }
    }
  })
  await settle(8)
  assert.strictEqual(abi.updateCount, 1,
    'pending terrain I/O caused an empty LOD refresh loop')
  result.runtime.destroy()
  assert.strictEqual(aborts, 1)
}

async function testTerrainResponsesAreBatched() {
  const requests = [0, 1, 2].map((index) => ({
    kind: runtimeModule.REQUEST_DETAIL,
    key: { level: 1, i: index, j: 2, k: 3 }
  }))
  class BatchedAbi extends FakeAbi {
    getRequests() {
      return this.submissions.length >= requests.length ? [] : requests
    }
  }
  const abi = new BatchedAbi()
  const result = await createRuntime({
    abi,
    terrainRefreshBatchMs: 20,
    terrainRefreshMaximumDelayMs: 100,
    request() {
      return {
        promise: Promise.resolve(response(payload())),
        abort() {}
      }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.strictEqual(abi.submissions.length, requests.length)
  assert.strictEqual(abi.updateCount, 2,
    'one terrain batch caused multiple full LOD updates')
  assert.strictEqual(result.runtime.terrainRefreshTimer, null)
  result.runtime.destroy()
}

async function testStaleTerrainResponseUsesCurrentGeneration() {
  const abi = new FakeAbi()
  let resolveRequest = null
  const result = await createRuntime({
    abi,
    cameraSettleDelayMs: 0,
    request() {
      return {
        promise: new Promise((resolve) => { resolveRequest = resolve }),
        abort() {}
      }
    }
  })
  for (let attempt = 0; attempt < 20 && !resolveRequest && !result.runtime.lastError; ++attempt) await settle()
  assert.strictEqual(typeof resolveRequest, 'function')
  const requestRevision = result.runtime.cameraRevision
  result.runtime.setInteractionActive(true)
  result.runtime.applyInteraction({ headingDegrees: 10 })
  assert(result.runtime.cameraRevision > requestRevision)
  resolveRequest(response(payload()))
  await settle(4)
  assert.strictEqual(abi.submissions.length, 1,
    'Immutable data still required by the current cut must survive a camera revision')
  assert.strictEqual(result.runtime.state().terrain.entries, 1)

  result.runtime.setInteractionActive(false)
  await settle(4)
  assert.strictEqual(abi.submissions.length, 1)
  assert.strictEqual(result.runtime.state().terrain.entries, 1)
  result.runtime.destroy()
}

async function testRefreshFailureKeepsCommittedFrame() {
  class RecoveringAbi extends FakeAbi {
    updateStep() {
      if (this.updateCount === 1) {
        this.updateCount += 1
        throw new Error('transient frame failure')
      }
      return super.updateStep()
    }

    getRequests() {
      return []
    }
  }
  const abi = new RecoveringAbi()
  const result = await createRuntime({
    abi,
    request() {
      throw new Error('unexpected terrain request')
    }
  })
  for (let i = 0; i < 20 && !result.runtime.lastFrame; ++i) await settle()
  assert(result.runtime.lastFrame, 'Initial publication did not complete')
  const committedSequence = result.runtime.lastFrame.sequence
  const committedFrames = result.renderer.frames.length
  result.runtime.refresh()
  await settle(4)
  assert(result.runtime.lastFrame.sequence > committedSequence)
  assert.strictEqual(result.renderer.frames.length, committedFrames + 1)
  assert.strictEqual(result.runtime.lastError, '')
  assert(result.runtime.state().diagnostics.some((entry) =>
    entry.kind === 'runtime_refresh_failed'))
  result.runtime.destroy()
}

async function testFailureRecovery() {
  const abi = new FakeAbi()
  const bytes = payload()
  let online = false
  const result = await createRuntime({
    abi,
    maximumTerrainRetries: 0,
    terrainRetryDelayMs: 0,
    request() {
      return {
        promise: online
          ? Promise.resolve(response(bytes))
          : Promise.reject(new Error('offline')),
        abort() {}
      }
    }
  })
  await settle(4)
  assert.strictEqual(abi.failures.length, 1)
  assert.strictEqual(result.runtime.state().terrain.failedRequestCount, 1)
  online = true
  assert.strictEqual(result.runtime.retryFailed(), true)
  await settle(4)
  assert.strictEqual(abi.retryRecords.length, 1)
  assert.deepStrictEqual(abi.retryRecords[0], recordRequest)
  assert.strictEqual(abi.submissions.length, 1)
  assert.strictEqual(result.runtime.state().terrain.failedRequestCount, 0)
  result.runtime.destroy()
}

async function testTransientFailureIsRetried() {
  const abi = new FakeAbi()
  const bytes = payload()
  let attempts = 0
  const result = await createRuntime({
    abi,
    maximumTerrainRetries: 1,
    terrainRetryDelayMs: 0,
    request() {
      attempts += 1
      return {
        promise: attempts === 1
          ? Promise.reject(new Error('transient'))
          : Promise.resolve(response(bytes)),
        abort() {}
      }
    }
  })
  await settle(8)
  assert.strictEqual(attempts, 2)
  assert.strictEqual(abi.submissions.length, 1)
  assert.strictEqual(abi.failures.length, 0)
  assert.strictEqual(result.runtime.state().terrain.failedRequestCount, 0)
  assert(result.runtime.state().diagnostics.some((entry) =>
    entry.kind === 'terrain_retry'))
  result.runtime.destroy()
}

async function testTransportAbortIsNotCancellation() {
  // Fetch uses AbortError both for an explicit cancel and for a transport's
  // deadline. Only the scheduler knows whether it actually cancelled the task.
  const abi = new FakeAbi()
  let attempts = 0
  const result = await createRuntime({abi, maximumTerrainRetries: 1, terrainRetryDelayMs: 0,
    request() {
      ++attempts
      return {promise: attempts === 1
        ? Promise.reject(Object.assign(new Error('The operation was aborted'), {name: 'AbortError'}))
        : Promise.resolve(response(payload())), abort() {}}
    }})
  try {
    await settle(8)
    assert.strictEqual(attempts, 2, 'A transport deadline silently abandoned a still-required terrain record')
    assert.strictEqual(abi.submissions.length, 1)
    assert.strictEqual(result.runtime.lastFrame.requestCount, 0)
    assert.deepStrictEqual(result.runtime.scheduler.stats(), {active: 0, queued: 0})
  } finally {result.runtime.destroy()}

  // A cancelled task can finish after the same key has become desirable again.
  // Suppression must belong to that task, not to an error's name or message.
  const second = await createRuntime({abi: new FakeAbi(), request() {
    let reject
    return {promise: new Promise((resolve, fail) => { reject = fail }),
      abort() {reject(new Error('network stopped'))}}
  }})
  try {
    second.runtime.scheduler.cancelExcept(new Set())
    await settle(4)
    assert.strictEqual(second.runtime.retries.size, 0, 'An owned cancellation consumed the retry budget')
    assert.strictEqual(second.runtime.failedRequests.size, 0)
    assert.strictEqual(second.runtime.terrainRetryTimers.size, 0)
  } finally {second.runtime.destroy()}
}

async function testTerrainInputLifecycle() {
  const {maximumEncodedRecordBytes} = require('../../sdk/js/terrain/terrain_record')
  for (const kind of ['oversized', 'invalid-type', 'decode']) {
    const abi = new FakeAbi()
    let attempts = 0, submissions = 0
    abi.submitRecord = () => { ++submissions; throw new Error('Invalid terrain encoding') }
    const result = await createRuntime({abi, maximumTerrainRetries: kind === 'decode' ? 0 : 2,
      terrainRetryDelayMs: 0, request(options) {
        ++attempts
        assert.strictEqual(options.maximumResponseBytes, maximumEncodedRecordBytes(64, 1))
        return {promise: Promise.resolve(kind === 'oversized'
          ? {statusCode: 200, data: new ArrayBuffer(options.maximumResponseBytes + 1)}
          : kind === 'invalid-type' ? {statusCode: 200, data: {invalid: true}} : response(payload())), abort() {}}
      }})
    try {
      await settle(8)
      assert.strictEqual(attempts, 1, 'Invalid transport input was repeatedly requested')
      assert.strictEqual(submissions, kind === 'decode' ? 1 : 0)
      assert.strictEqual(result.runtime.recordCache.entries.size, 0, 'Rejected input entered the encoded cache')
      assert.strictEqual(result.runtime.terrainInputs.stats().availableBytes,
        result.runtime.terrainInputs.minimumBytes, 'Completed input did not return its serial credit')
    } finally { result.runtime.destroy() }
  }

  // An ABI operation may outlive the consumer. Hold its actual completion
  // receipt, rather than treating runtime destruction as an allocation refund.
  let complete, entered = false
  const abi = new FakeAbi(), submitted = new Promise(resolve => {complete = resolve})
  abi.submitRecord = () => { entered = true; return submitted }
  const {runtime} = await createRuntime({abi, request() {
    return {promise: Promise.resolve(response(payload())), abort() {}}
  }})
  try {
    for (let i = 0; i < 20 && !entered; ++i) await settle()
    assert(entered, 'Terrain submission did not start')
    assert.strictEqual(runtime.terrainInputs.stats().availableBytes, 0)
    assert.strictEqual(runtime.recordCache.entries.size, 0, 'Input was cached before decode succeeded')
    runtime.destroy()
    const held = Array.from(runtime.resourceLedger.leases).filter(lease => lease.owner === 'terrain-input')
    assert.strictEqual(held.reduce((sum, lease) => sum + lease.bytes, 0), runtime.terrainInputs.minimumBytes,
      'Destroy refunded input before the ABI completion receipt')
    complete(); await settle(4)
    assert.strictEqual(runtime.terrainInputs.stats().reservedBytes, 0)
    assert.strictEqual(runtime.recordCache.entries.size, 0, 'Late ABI completion resurrected the cache')
    assert.strictEqual(runtime.scheduler.active.size, 0)
  } finally { complete(); runtime.destroy() }
}

async function testSparseNotFoundIsNotRetried() {
  const abi = new FakeAbi()
  let requests = 0
  const result = await createRuntime({
    abi,
    maximumTerrainRetries: 2,
    terrainRetryDelayMs: 0,
    request() {
      requests += 1
      return {
        promise: Promise.resolve({
          statusCode: 404,
          data: new ArrayBuffer(0),
          header: {}
        }),
        abort() {}
      }
    }
  })
  await settle(6)
  assert.strictEqual(requests, 1)
  assert.strictEqual(abi.failures.length, 1)
  assert.strictEqual(result.runtime.state().terrain.failedRequestCount, 1)
  assert(result.runtime.state().diagnostics.some((entry) =>
    entry.kind === 'terrain_request_failed' &&
    /HTTP 404/.test(entry.detail.message)))
  result.runtime.destroy()
}

async function testTiandituProfile() {
  const abi = new FakeAbi()
  const token = '0123456789abcdef0123456789abcdef'
  const imagery = imageryProfiles.resolveImageryProfile('tianditu-img-c', token)
  const result = await createRuntime({
    abi,
    imagery,
    request() {
      return { promise: Promise.resolve(response(payload())), abort() {} }
    }
  })
  await settle(4)
  assert.strictEqual(abi.loadedManifest.texture.matrix_level_offset, 1)
  assert.strictEqual(abi.loadedManifest.texture.maximum_level, 17)
  assert.strictEqual(result.runtime.state().imageryId, 'tianditu-img-c')
  const url = result.runtime.textureUrl({
    level: 0,
    matrix: 1,
    row: 0,
    column: 0
  })
  assert.strictEqual(url.indexOf('https://t0.tianditu.gov.cn/img_c/wmts?'), 0)
  result.runtime.diagnostic('texture_load_failed', { message: url })
  const report = JSON.stringify(result.runtime.state())
  assert.strictEqual(report.indexOf(token), -1)
  assert(report.indexOf('tk=[redacted]') >= 0)
  result.runtime.destroy()
}

async function testPublicImageryAndLifecycle() {
  const invalidMinimumRuntime = new runtimeModule.TerraGlobeRuntime({
    canvas: canvas(),
    imagery: {
      id: 'unsupported-minimum',
      tileScheme: 'global-geodetic',
      minimumLevel: 1,
      maximumLevel: 6,
      resolveTile: () => 'https://public.example/tile.png'
    }
  })
  assert.throws(() => invalidMinimumRuntime.validateRuntimeManifest(manifest()),
    /minimum level must be zero/)

  const abi = new FakeAbi()
  const result = await createRuntime({
    abi,
    imagery: {
      id: 'public-source',
      tileScheme: 'global-geodetic',
      minimumLevel: 0,
      maximumLevel: 6,
      resolveTile: (tile) =>
        `https://public.example/${tile.matrix}/${tile.column}/${tile.row}.png`
    },
    request() {
      return { promise: Promise.resolve(response(payload())), abort() {} }
    }
  })
  await settle(4)
  assert.strictEqual(abi.loadedManifest.texture.id, 'public-source')
  assert.strictEqual(abi.loadedManifest.texture.maximum_level, 6)
  assert.strictEqual(result.runtime.textureUrl({
    level: 1, matrix: 2, row: 3, column: 4
  }), 'https://public.example/1/4/3.png')
  const updateCount = abi.updateCount
  result.runtime.pause()
  assert.strictEqual(result.runtime.frameClock.paused, true)
  result.runtime.panBy({ xPixels: 10, yPixels: 5 })
  assert.strictEqual(abi.updateCount, updateCount)
  assert.strictEqual(result.runtime.state().paused, true)
  result.runtime.resume()
  assert.strictEqual(abi.updateCount, updateCount + 1)
  assert.strictEqual(result.runtime.state().paused, false)
  result.runtime.destroy()
}

async function testWxCancellation() {
  let aborts = 0
  global.wx = {
    request(options) {
      return {
        abort() {
          options.fail({errMsg: 'cancelled'})
          aborts += 1
        }
      }
    }
  }
  const task = require('../../adapters/miniprogram/wx_request').requestWithWx({
    url: 'https://terrain.example/record',
    responseType: 'arraybuffer', maximumResponseBytes: 71696
  })
  task.abort()
  await assert.rejects(task.promise, /cancelled/)
  assert.strictEqual(aborts, 1)
  delete global.wx
}

async function testSubmittedClearanceScheduling() {
  const abi = new FakeAbi()
  abi.getRequests = () => []
  const {runtime, renderer} = await createRuntime({abi})
  try {
    await settle(4)
    const events = []
    runtime.constrainCamera = () => { events.push(runtime.renderedSurface); return true }
    runtime.previewCamera = () => events.push('preview')
    runtime.scheduleRefresh = () => events.push('refresh')
    const first = {}, latest = {}
    renderer.options.onDrawsSubmitted(first)
    renderer.options.onDrawsSubmitted(latest)
    assert.deepStrictEqual(events, [], 'Clearance changed the camera inside a draw transaction')
    await settle(4)
    assert.deepStrictEqual(events, [latest, 'preview', 'refresh'],
      'Submitted detail did not constrain the camera independently of a native receipt')
    renderer.options.onDrawsSubmitted(first)
    renderer.options.onDrawsSubmitted(null)
    await settle(4)
    assert.strictEqual(events.length, 3, 'A delayed query used terrain lost with the context')
    renderer.options.onDrawsSubmitted(latest)
  } finally { runtime.destroy() }
  await settle(4)
}

function testPanProjectionAndClearance() {
  const { cameraSnapshot } = require('../../sdk/js/camera/terra_camera_snapshot')
  const ground = require('../../sdk/js/terrain/terra_ground')
  for (const mode of ['cylindrical', 'planar']) {
    for (const heading of [0, 45, 90, 135, 180, 270]) {
      for (const tilt of [0, 45, 76.3]) {
        const runtime = Object.create((mode === 'cylindrical' ? runtimeModule.TerraGlobeRuntime : runtimeModule.TerraPlanarRuntime).prototype)
        runtime.options = {}
        runtime.manifest = { transform: mode, radius: 6378000, minimumU: -1e6, maximumU: 1e6, minimumV: -1e6, maximumV: 1e6 }
        runtime.budget = { physicalWidth: 1000, physicalHeight: 800, devicePixelRatio: 1 }
        runtime.fovRadians = 0.6
        runtime.camera = { longitudeDegrees: 116.5623, latitudeDegrees: 40.74863, x: 0, y: 0,
          distance: 6378, yawRadians: heading * Math.PI / 180, tiltRadians: -tilt * Math.PI / 180 }
        const viewport = { width: 1000, height: 800, fovRadians: 0.6 }
        const before = cameraSnapshot(runtime.manifest, runtime.camera, viewport)
        const ray = ground.cameraRay(before, 500, 400, 1000, 800, 0.6)
        const point = mode === 'cylindrical' ? ground.sphereHit(ray, runtime.manifest.radius) : [0, 0, 0]
        runtime.applyPanPixels(2, 3)
        const after = cameraSnapshot(runtime.manifest, runtime.camera, viewport)
        const clip = [0, 1, 3].map(row => after.projectionView[row * 4 + 3] +
          point.reduce((sum, v, i) => sum + after.projectionView[row * 4 + i] * v, 0))
        const x = clip[0] / clip[2] * 500, y = -clip[1] / clip[2] * 400
        assert(Math.abs(x - 2) < 0.03 && Math.abs(y - 3) < 0.03,
          `${mode} heading ${heading} tilt ${tilt}: drag projected to ${x},${y}`)
        if (mode === 'cylindrical') {
          runtime.camera.distance = 1
          assert(runtime.constrainCamera(), 'terrain clearance must use the actual eye, not the orbit range')
          assert.strictEqual(runtime.camera.distance, 1, 'clearance changed the requested observation range')
          const eye = cameraSnapshot(runtime.manifest, runtime.camera, viewport).cameraPosition
          assert(Math.hypot(...eye) - runtime.manifest.radius >= 1.99)
        }
      }
    }
  }
  const surface = { draws: [{resourceId: 1, origin: [0, 0, 0], firstIndex: 0, indexCount: 3}],
    indices: new Uint16Array([0, 1, 2]), resources: new Map([[1, {
      positions: new Float32Array([0,0,100, 10,0,110, 0,10,120]), textureUv: new Float32Array([0,0,1,0,0,1]) }]]) }
  const hit = ground.surfaceHit(surface, {origin: [2,3,1000], direction: [0,0,-1]})
  assert(Math.abs(hit[2] - 108) < 1e-6, 'ground sample must interpolate the triangle rather than its nearest vertex')
}

async function testConfirmedNoData() {
  // The terrain service problem() response nests its code under error. Keep
  // the wire envelope here: a flattened mock hid a real integration failure.
  const problem = '{"error":{"code":"patch_not_found","message":"detail patch was not found"}}\n'
  const bytes = Buffer.from(problem)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const detail = runtimeModule.REQUEST_DETAIL
  for (const [kind, statusCode, data, confirmed] of [
    [detail, 404, buffer, true], [detail, 404, new Uint8Array(buffer), true],
    [detail, 404, JSON.parse(problem), false],
    [detail, 404, new Uint8Array(Buffer.from('{"code":"patch_not_found"}')), false],
    [detail, 404, new Uint8Array(Buffer.from('{"error":{"code":"dataset_not_found"}}')), false],
    [detail, 404, new Uint8Array(Buffer.from('<html>Not found</html>')), false],
    [detail, 500, buffer, false], [runtimeModule.REQUEST_ROOT, 404, buffer, false]
  ]) {
    const abi = new FakeAbi(), absent = []
    abi.getRequests = () => absent.length || abi.failures.length ? [] : [{kind, key: recordRequest.key}]
    abi.noDataRecord = key => { absent.push(key) }
    let requests = 0
    const result = await createRuntime({abi, maximumTerrainRetries: 0, request() {
      ++requests
      return {promise: Promise.resolve({statusCode, data, header: {}}), abort() {}}
    }})
    try {
      await settle(6)
      assert.strictEqual(absent.length, confirmed ? 1 : 0, `Unexpected no-data classification for ${kind}/${statusCode}`)
      assert.strictEqual(abi.failures.length, confirmed ? 0 : 1)
      assert.strictEqual(result.runtime.state().terrain.failedRequestCount, confirmed ? 0 : 1)
      assert.strictEqual(requests, 1, 'An authoritative absent detail was requested again')
    } finally { result.runtime.destroy() }
  }
}

async function testImageryContinuationSurvivesAdmissionChanges() {
  for (const invalidation of ['admission', 'receipt', 'renderer', 'pending', 'moving', 'source-stream']) {
    const runtime = Object.create(runtimeModule.TerraGlobeRuntime.prototype)
    Object.assign(runtime, { destroyed: false, paused: false, refreshing: false,
      cameraPreviewDirty: invalidation === 'moving', cameraRevision: 1, imageryRevision: 0,
      imageryContinuationTimer: null, imageryRefreshing: false, imageryRefreshPending: false,
      meshFrames: { candidate: null, presented: { frame: { sequence: 1 } } } })
    let admissionRevision = 0, calls = 0, applied = 0, cancelled = 0
    const cameraStates = [], coarseningStates = []
    runtime.renderer = {
      imageryPlanningOptions: () => ({ admissionRevision }),
      setImageryPlan(sequence, plan) {
        if (invalidation === 'renderer' && calls === 1) return false
        cameraStates.push(plan.quality.cameraCurrent)
        coarseningStates.push(plan.quality.coarsening)
        applied++
        return true
      }
    }
    runtime.scheduleRender = () => {}
    runtime.retryTerrainDemand = () => {}
    runtime.diagnostic = (_, error) => { throw new Error(error.message) }
    runtime.abi = { isWorker: true, cancelImagery() { cancelled++ }, async planImagery(sequence, options, onProgress) {
      calls++
      if (calls === 1) {
        if (invalidation === 'source-stream') {
          runtime.imageryRevision++
          onProgress({sequence, pending: true})
          assert.strictEqual(cancelled, 1, 'Source change waited for an obsolete stream to finish measuring')
          return {sequence, superseded: true}
        }
        if (invalidation === 'pending') return {sequence, pending: true}
        if (invalidation === 'admission') admissionRevision++
        if (invalidation === 'moving') runtime.cameraRevision++
        if (invalidation === 'receipt') runtime.meshFrames.presented = { frame: { sequence: 2 } }
      }
      return { sequence, measurements: [], imageryPlan: {draws: [], quality: { planningComplete: true, coarsening: true } } }
    } }
    await runtime.refreshImagery()
    await settle(40)
    runtime.destroyed = true
    if (runtime.imageryContinuationTimer !== null) clearTimeout(runtime.imageryContinuationTimer)
    assert.strictEqual(calls, ['admission','receipt'].includes(invalidation) ? 1 : 2,
      `${invalidation} must retain progress without waiting for terrain I/O or pointer settling`)
    assert.strictEqual(applied, invalidation === 'moving' ? 2 : 1)
    if (invalidation === 'moving') assert.deepStrictEqual(cameraStates, [false, true],
      'An old-camera plan was relabeled as a current-camera presentation')
    if (['receipt', 'moving'].includes(invalidation)) assert.deepStrictEqual(coarseningStates,
      invalidation === 'moving' ? [false, true] : [true],
      'Coarsening must require the latest camera without waiting for an identical terrain cut')
  }
}

async function testContinuousCameraRefresh() {
  const runtime = Object.create(runtimeModule.TerraGlobeRuntime.prototype)
  Object.assign(runtime, {destroyed: false, paused: false, interactionActive: false,
    cameraRefreshTimer: null, cameraSettleDelayMs: 15})
  let input = 0
  const refreshed = []
  runtime.previewCamera = () => true
  runtime.refresh = () => refreshed.push(input)
  try {
    for (input = 1; input <= 24; ++input) {
      runtime.scheduleCameraRefresh()
      await settle(5)
    }
    assert(refreshed.length > 0, 'Continuous wheel input deferred every terrain update until settling')
    await settle(20)
    assert(refreshed[refreshed.length - 1] >= 22, 'Coalesced camera refresh did not use the latest input')
  } finally { runtime.destroyed = true; runtime.cancelCameraRefresh() }
}

async function testTerrainQueryOwnership() {
  const runtime = {destroyed: false, abi: {sampleTerrain: () => new Promise(resolve => resolvers.push(resolve))}}
  const resolvers = []
  const query = runtimeModule.TerraGlobeRuntime.prototype.sampleTerrain
  const requests = Array.from({length: 16}, () => query.call(runtime, 0, 0))
  await assert.rejects(query.call(runtime, 0, 0), /capacity/)
  resolvers.splice(0).forEach(resolve => resolve({status: 'available'}))
  await Promise.all(requests)
  assert.strictEqual(runtime.pendingTerrainQueries, 0)
  const stale = query.call(runtime, 0, 0)
  runtime.abi = {}
  resolvers.pop()({status: 'available'})
  await assert.rejects(stale, /replaced/)
  assert.strictEqual(runtime.pendingTerrainQueries, 0)
}

function testElevatedViewContract() {
  const {cameraSnapshot} = require('../../sdk/js/camera/terra_camera_snapshot')
  for (const mode of ['globe', 'planar']) {
    const runtime = Object.create((mode === 'globe' ? runtimeModule.TerraGlobeRuntime : runtimeModule.TerraPlanarRuntime).prototype)
    runtime.manifest = {transform: mode === 'globe' ? 'cylindrical' : 'planar', radius: 6378000,
      minimumU: -1e6, maximumU: 1e6, minimumV: -1e6, maximumV: 1e6}
    runtime.camera = {}
    const target = mode === 'globe' ? {longitudeDegrees: 116.5623, latitudeDegrees: 40.74863, heightMeters: 1600} :
      {x: 230, y: 540, heightMeters: 1600}
    const view = runtime.normalizeView({schema:'terra.view-state.v2', mode, target,
      rangeMeters: 2, tiltDegrees: 88, headingDegrees: 14.5})
    runtime.assignView(view)
    assert.deepStrictEqual(runtime.getView(), view, 'Target height or physical range was lost on round-trip')
    const snapshot = cameraSnapshot(runtime.manifest, runtime.camera, {width:1280, height:720, fovRadians:0.6})
    const world = mode === 'globe' ? [
      Math.sin(target.longitudeDegrees*Math.PI/180)*Math.cos(target.latitudeDegrees*Math.PI/180),
      Math.sin(target.latitudeDegrees*Math.PI/180),
      Math.cos(target.longitudeDegrees*Math.PI/180)*Math.cos(target.latitudeDegrees*Math.PI/180)
    ].map(v => v*(runtime.manifest.radius+1600)) : [230,540,1600]
    assert(Math.abs(Math.hypot(...world.map((v,i) => v-snapshot.cameraPosition[i])) - 2) < 1e-6)
    assert(snapshot.nearPlane < 2 && snapshot.nearPlane > 0 && snapshot.farPlane > 2)
    assert(Array.from(snapshot.projectionView).every(Number.isFinite))
    assert.throws(() => runtime.normalizeView(Object.assign({},view,{schema:'terra.view-state.v1'})), /unsupported/)
    assert.throws(() => runtime.normalizeView(Object.assign({},view,{rangeMeters:0})), /range/)
  }
}

async function testPartialMeshReceiptContinues() {
  const abi = new FakeAbi()
  abi.getRequests = () => []
  abi.getMeshResources = () => [{resourceId: 1, vertexCount: 3}]
  abi.copyMeshResource = () => ({resourceId: 1, positions: new Float32Array(9), textureUv: new Float32Array(6)})
  const {runtime} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
  try {
    await settle() // Creation starts the initial publication asynchronously.
    const candidate = runtime.meshFrames.candidate
    assert(candidate)
    candidate.updateState.pendingMeshGroups = 1
    candidate.frame.decisionsComplete = false
    runtime.refreshPending = false
    let scheduled = 0
    runtime.scheduleRefresh = () => {++scheduled}
    await runtime.presentMeshFrame(candidate.frame.sequence)
    assert.strictEqual(runtime.meshFrames.presented, candidate)
    assert.strictEqual(scheduled, 1, 'An acknowledged partial cut did not continue its remaining groups')
  } finally {runtime.destroy()}
}

async function main() {
  testPlatformBackgroundDispatch()
  await require('./capacity_refusal_contract')()
  await require('./capacity_wake_contract')({createRuntime,FakeAbi,settle})
  await verifyLocalImageryGrants()
  await require('./imagery_terrain_resume_contract')({createRuntime,FakeAbi,settle})
  await testResourceBudgetOwnership()
  await testTerrainInputLifecycle()
  await testTransportAbortIsNotCancellation()
  await testPartialMeshReceiptContinues()
  await require('./terrain_empty_receipt_contract')({createRuntime, FakeAbi, settle})
  await testSubmittedClearanceScheduling()
  testElevatedViewContract()
  await testTerrainQueryOwnership()
  await testContinuousCameraRefresh()
  await testWorkerRecoverySchedulesTerrain()
  await testImageryContinuationSurvivesAdmissionChanges()
  testPanProjectionAndClearance()
  await testConfirmedNoData()
  testTerrainRequestOrdering()
  testGeographicCamera()
  await testSuccessfulLoadAndControls()
  await testCloseRangePanUsesSurfaceScale()
  await testFailedWorkerAdoption()
  await testResourceContract()
  await testDirectPreparationLifecycle()
  await testMeshCapacityBackpressure()
  await testLateCandidateAdmissionRefusal()
  await testMeshCapacityCoarsening()
  await testCapacityReleasedDuringRecovery()
  await testHeightCapacityParking()
  await testTerrainCapacityFeedback()
  await testMinimumTerrainRestorationRefusal()
  await testTerrainPrecisionWakeup()
  await require('./terrain_precision_measurement_contract')({createRuntime, FakeAbi, settle})
  await testJointTerrainRecoveryCompletion()
  await testTerrainDemandBackpressure()
  await testUnpricedTerrainWindow()
  await require('./terrain_model_work_contract')({createRuntime, FakeAbi, settle})
  await testUnfundedConservativeDemand()
  await testCandidateReplacement()
  await testSameViewCandidateProgress()
  await testPreparationModelProgress()
  await testPartialTargetTopology()
  await testHandoffPlanLifetime()
  await testIncrementalConvergence()
  await testNetworkWaitDoesNotSpin()
  await testTerrainResponsesAreBatched()
  await testStaleTerrainResponseUsesCurrentGeneration()
  await testRefreshFailureKeepsCommittedFrame()
  await testFailureRecovery()
  await testTransientFailureIsRetried()
  await testSparseNotFoundIsNotRetried()
  await testTiandituProfile()
  await testPublicImageryAndLifecycle()
  await testWxCancellation()
  console.log('Mini Program globe runtime tests passed.')
}

async function testWorkerRecoverySchedulesTerrain() {
  const old = new FakeAbi()
  const result = await createRuntime({abi: old,
    request: () => ({promise: Promise.resolve(response(payload())), abort() {}})})
  await settle(5)
  const runtime = result.runtime, camera = runtime.camera
  let next, attempts = 0
  runtime.createWorker = async () => {
    ++attempts
    if (attempts < 3) throw new Error('Restart failed')
    next = new FakeAbi()
    return next
  }
  runtime.canvas.requestAnimationFrame = () => 1 // Hold display delivery throughout recovery.
  old.destroy()
  await runtime.recoverWorker(new Error('Injected timeout'))
  assert.strictEqual(attempts, 3, 'Recovery must retry a bounded number of failed starts')
  assert.strictEqual(runtime.abi, next)
  assert.strictEqual(next.loadedManifest, runtime.manifest)
  assert.strictEqual(runtime.camera, camera, 'Recovery reset the latest camera')
  await settle(8)
  assert(next.updateCount > 0, 'Recovery waited for display delivery before advancing terrain')
  assert.strictEqual(runtime.scheduler.paused, false)
  assert(runtime.recordCache.entries.size > 0, 'Recovery discarded reusable terrain data')
  runtime.destroy()
}

const deadline = setTimeout(() => {
  console.error('Runtime lifecycle test did not finish'); process.exit(1)
}, 10000)
Object.assign(FakeAbi.prototype, require('./reference/native_mesh_fixture'))

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
}).finally(() => clearTimeout(deadline))
