const { FrameCoordinator } = require('../../sdk/js/runtime/frame_coordinator')
const assert = require('assert')

const viewerModule = require('../../adapters/browser/terra_viewer')
assert.strictEqual(viewerModule.TerraViewer.name, 'TerraViewer')
assert.strictEqual(viewerModule.TerraViewerError.name, 'TerraViewerError')

function identityWithDepthScale() {
  return new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0.01, 0,
    0, 0, 0, 1
  ])
}

class FakeRenderer {
  constructor() {
    this.overlays = []
    this.textureClears = 0
    this.imagerySources = []
    this.textures = { clear: () => { this.textureClears += 1 } }
  }

  setOverlays(value) { this.overlays.push(value) }
  setImagerySource(descriptor, resolveTile) {
    this.imagerySources.push({ descriptor, resolveTile })
  }
}

class FakePlanarRuntime {
  textureUrl(tile) { return this.textureUrlResolver(tile) }
  constructor() {
    this.manifest = {
      transform: 'planar',
      minimumU: -1,
      minimumV: -1,
      maximumU: 1,
      maximumV: 1,
      radius: 0,
      texture: { id: 'planar', kind: 'planar-single', matrix_level_offset: 0, maximum_level: 0, minimum_level: 0,
        tile_size: 256, level_zero_columns: 1, level_zero_rows: 1, bounds: [[-1,-1],[1,1]] }
    }
    this.budget = {
      physicalWidth: 100,
      physicalHeight: 100,
      devicePixelRatio: 1
    }
    this.fovRadians = Math.PI / 6
    this.lastFrame = {
      sequence: 1,
      requestCount: 0,
      failedRecordCount: 0,
      projectionView: identityWithDepthScale(),
      cameraPosition: [0, 0, 10]
    }
    this.lastSurface = {
      draws: [{resourceId: 1, firstIndex: 0, indexCount: 6, vertexCount: 4, origin: [0, 0, 0]}],
      resources: new Map([[1, {
        positions: new Float32Array([-1,-1,10, 1,-1,20, 1,1,30, -1,1,20]),
        textureUv: new Float32Array([0,0, 1,0, 1,1, 0,1])
      }]]),
      indices: new Uint16Array([0,1,2, 0,2,3])
    }
    this.presentedFrame = this.lastFrame
    this.presentedSurface = this.lastSurface
    this.submitSurface(this.lastSurface)
    this.renderer = new FakeRenderer()
    this.view = {
      schema: 'terra.view-state.v2',
      mode: 'planar',
      target: { x: 0, y: 0, heightMeters: 0 },
      rangeMeters: 4,
      headingDegrees: 0,
      tiltDegrees: 0
    }
    this.destroyed = false
    this.pauseCount = 0
    this.resumeCount = 0
    this.interactionStates = []
    this.interactionChanges = []
    this.nextFrameHandle = 1
    this.frameCallbacks = new Map()
    this.canvas = {
      requestAnimationFrame: (callback) => {
        const handle = this.nextFrameHandle++
        this.frameCallbacks.set(handle, callback)
        return handle
      },
      cancelAnimationFrame: (handle) => {
        this.frameCallbacks.delete(handle)
      }
    }
    this.frameClock = new FrameCoordinator({
      requestFrame: callback => this.canvas.requestAnimationFrame(callback),
      cancelFrame: handle => this.canvas.cancelAnimationFrame(handle),
      render() { return false }
    })
    this.atmosphere = {
      enabled: false,
      sunAzimuthDegrees: 135,
      sunZenithDegrees: 35,
      turbidity: 2,
      exposure: 1
    }
  }

  submitSurface(surface) {
    this.renderedSurface = surface
    this.renderedSurfaceRevision = (this.renderedSurfaceRevision || 0) + 1
  }
  getView() { return JSON.parse(JSON.stringify(this.view)) }
  normalizeView(value) { return JSON.parse(JSON.stringify(value)) }
  setView(value) { this.view = JSON.parse(JSON.stringify(value)); return this.getView() }
  panBy() {}
  zoomBy() {}
  orbitBy() {}
  setTilt() {}
  topDown() {}
  northUp() {}
  reset() {}
  cancelAnimation() { return false }
  applyInteraction(change) { this.interactionChanges.push(change) }
  setInteractionActive(active) { this.interactionStates.push(active) }
  flushAnimationFrame() {
    const callbacks = Array.from(this.frameCallbacks.values())
    this.frameCallbacks.clear()
    callbacks.forEach((callback) => callback(16))
  }
  resize() {}
  scheduleRender() {}
  refresh() {}
  pause() { this.pauseCount += 1 }
  resume() { this.resumeCount += 1 }
  rangeLimits() { return { minimum: 0.5, maximum: 40 } }
  getAtmosphere() { return Object.assign({}, this.atmosphere) }
  setAtmosphere(value) {
    if (this.manifest.transform !== 'cylindrical') {
      throw new Error('Atmosphere is only available in globe mode')
    }
    this.atmosphere = Object.assign({}, this.atmosphere, value)
    return this.getAtmosphere()
  }
  state() {
    return {
      schema: 'terra.miniprogram.planar-runtime.v1',
      frame: {
        sequence: this.lastFrame.sequence,
        requestCount: this.lastFrame.requestCount,
        failedRecordCount: this.lastFrame.failedRecordCount
      }
    }
  }
  destroy() { this.destroyed = true; if (this.frameClock) this.frameClock.destroy() }
}

function testProjectionHelpers() {
  const frame = {
    projectionView: identityWithDepthScale(),
    cameraPosition: [0, 0, 10]
  }
  const projected = viewerModule.projectWorld([0, 0, 0], frame, {
    physicalWidth: 100,
    physicalHeight: 100,
    devicePixelRatio: 1
  })
  assert.deepStrictEqual(projected, { x: 50, y: 50, depth: 0, visible: true })
  assert.strictEqual(viewerModule.globeFrontFacing([0, 0, 1], frame, 1), true)
  assert.strictEqual(viewerModule.globeFrontFacing([0, 0, -1], frame, 1), false)
  const route = viewerModule.subdivideGlobeRoute([
    [100, 20, 0], [110, 25, 100]
  ])
  assert(route.length > 2)
  assert.deepStrictEqual(route[0], [100, 20, 0])
  assert(Math.abs(route[route.length - 1][0] - 110) < 0.000001)
}

function testPoisRouteAndSurface() {
  const runtime = new FakePlanarRuntime()
  const viewer = new viewerModule.TerraViewer(runtime, {})
  viewer.handleRuntimeState(runtime.state())
  const positions = []
  const clicks = []
  const surfaceChanges = []
  viewer.on('featureposition', (event) => positions.push(event))
  viewer.on('featureclick', (event) => clicks.push(event))
  viewer.on('surfacechange', (event) => surfaceChanges.push(event))

  viewer.interaction.begin({
    pointers: [{ id: 1, x: 10, y: 10 }],
    timeMs: 0,
    mode: 'look'
  })
  viewer.interaction.update({
    pointers: [{ id: 1, x: 30, y: 30 }],
    timeMs: 16
  })
  viewer.interaction.update({
    pointers: [{ id: 1, x: 50, y: 50 }],
    timeMs: 32
  })
  assert.deepStrictEqual(runtime.interactionStates, [true])
  assert.strictEqual(runtime.interactionChanges.length, 0)
  assert.strictEqual(runtime.frameCallbacks.size, 1)
  runtime.flushAnimationFrame()
  assert.strictEqual(runtime.interactionChanges.length, 1)
  assert.strictEqual(runtime.interactionChanges[0].headingDegrees, 10)
  viewer.interaction.end({ pointers: [], timeMs: 48 })
  assert.deepStrictEqual(runtime.interactionStates, [true, false])

  viewer.setPois([
    {
      id: 'center',
      coordinate: [0, 0, 0],
      altitudeMode: 'absolute',
      icon: 'station',
      priority: 10
    },
    {
      id: 'surface',
      coordinate: [0.1, 0.1, 0],
      altitudeMode: 'surface',
      priority: 1
    }
  ])
  assert.strictEqual(viewer.projectedPois.length, 2)
  assert.strictEqual(viewer.projectedPois[0].id, 'center')
  assert.strictEqual(viewer.projectedPois[1].surfaceStatus, 'approximate')
  assert(positions.length >= 2)
  const picked = viewer.pickPoi({ x: 50, y: 50 })
  assert.strictEqual(picked.featureId, 'center')
  assert.throws(() => viewer.pickPoi({ x: Number.NaN, y: 50 }),
    (error) => error.code === 'invalid_screen_point')
  viewer.handleTap({ x: 50, y: 50 })
  assert.strictEqual(clicks[0].featureId, 'center')
  assert.strictEqual(runtime.renderer.overlays.slice(-1)[0].points.length, 2)
  assert.throws(() => viewer.setPois([
    { id: 'same', coordinate: [0, 0] },
    { id: 'same', coordinate: [0, 0] }
  ]), (error) => error.code === 'invalid_pois' && /unique/.test(error.message))
  assert.throws(() => viewer.setPois(new Array(257).fill({
    id: 'too-many', coordinate: [0, 0]
  })), /at most 256/)

  const display = runtime.renderedSurface
  runtime.submitSurface(null)
  assert.strictEqual(viewer.sampleRenderedSurface([0, 0]).status, 'unavailable',
    'A candidate must not masquerade as an already displayed surface')
  runtime.submitSurface(Object.assign({}, display, {
    draws: display.draws.concat({resourceId: 2, firstIndex: 0, indexCount: 0, origin: [0,0,0]}),
    resources: new Map([...display.resources, [2, {positions: new Float32Array(0), textureUv: new Float32Array(0)}]])
  }))
  assert.strictEqual(viewer.sampleRenderedSurface([0,0]).heightMeters, 20,
    'An empty draw must not hide coverage provided by another mesh')
  runtime.submitSurface(display)
  const ready = viewer.sampleRenderedSurface([0, 0, 0])
  assert.strictEqual(ready.status, 'approximate')
  assert.strictEqual(ready.heightMeters, 20)
  assert.strictEqual(viewer.sampleRenderedSurface([0.2, 0.3]).heightMeters, 22.5,
    'Surface query must interpolate a triangle, not choose a nearest vertex')
  assert.strictEqual(viewer.sampleRenderedSurface([2, 2]).status, 'unavailable',
    'A distant vertex must not fabricate coverage')
  runtime.submitSurface(Object.assign({}, display, {
    draws: display.draws.map(draw => Object.assign({}, draw,
      {origin: [draw.origin[0], draw.origin[1], draw.origin[2] + 5]}))}))
  assert.deepStrictEqual(viewer.sampleRenderedSurface([0, 0]),
    {status: 'approximate', heightMeters: 25, revision: runtime.renderedSurfaceRevision},
    'Surface queries ignored a submitted local replacement while awaiting the full frame receipt')
  viewer.handleRuntimeState(runtime.state())
  assert.strictEqual(surfaceChanges[surfaceChanges.length - 1].revision, runtime.renderedSurfaceRevision,
    'A local submission did not update surface-bound features before the native frame receipt')
  runtime.submitSurface(null)
  viewer.handleRuntimeState(runtime.state())
  assert.strictEqual(viewer.sampleRenderedSurface([0, 0]).status, 'unavailable',
    'Context loss fell back to the still-owned candidate surface')
  assert.strictEqual(viewer.projectedPois.find(poi => poi.id === 'surface').surfaceStatus, 'unavailable')
  assert.strictEqual(surfaceChanges[surfaceChanges.length - 1].revision, runtime.renderedSurfaceRevision)
  runtime.submitSurface(display)
  viewer.handleRuntimeState(runtime.state())
  surfaceChanges.length = 0
  runtime.lastFrame.requestCount = 1
  viewer.surfaceCache = null
  assert.strictEqual(viewer.sampleRenderedSurface([0, 0, 0]).status, 'approximate')
  runtime.lastFrame.requestCount = 0
  assert.throws(() => viewer.getRouteView(),
    (error) => error.code === 'route_unavailable')

  viewer.setRoute({
    id: 'route',
    coordinates: [[-0.5, 0, 0], [0.5, 0, 0]],
    altitudeMode: 'surface',
    color: '#112233',
    widthPixels: 4
  })
  const overlay = runtime.renderer.overlays.slice(-1)[0]
  assert.strictEqual(overlay.route.worlds.length, 2)
  assert.strictEqual(overlay.route.color, '#112233')
  const routeView = viewer.getRouteView({ paddingPixels: 20 })
  assert.strictEqual(routeView.mode, 'planar')
  assert.strictEqual(routeView.target.x, 0)
  assert(routeView.rangeMeters >= 0.5 && routeView.rangeMeters <= 40)
  assert.throws(() => viewer.setRoute({
    id: 'large', coordinates: new Array(2049).fill([0, 0, 0])
  }), /2 to 2048/)

  runtime.lastFrame = Object.assign({}, runtime.lastFrame, { sequence: 2 })
  viewer.handleRuntimeState(runtime.state())
  assert.strictEqual(surfaceChanges.length, 0, 'A prepared frame changed surface-bound features before submission')
  runtime.presentedFrame = runtime.lastFrame
  viewer.handleRuntimeState(runtime.state())
  assert.strictEqual(surfaceChanges.length, 0, 'A native ownership receipt fabricated a display change')
  runtime.submitSurface(Object.assign({}, display))
  viewer.handleRuntimeState(runtime.state())
  assert.strictEqual(surfaceChanges.length, 1)
  assert.strictEqual(surfaceChanges[0].revision, runtime.renderedSurfaceRevision)
  const overlayCount = runtime.renderer.overlays.length
  viewer.handleRuntimeState(runtime.state())
  assert.strictEqual(runtime.renderer.overlays.length, overlayCount)
  assert.strictEqual(viewer.getState().featureCount, 2)
  assert.strictEqual(viewer.getState().routeId, 'route')

  const replacementResolver = () => 'https://tiles.example/planar.png'
  viewer.imagery.setSource({
    id: 'replacement',
    tileScheme: 'planar-single',
    minimumLevel: 0,
    maximumLevel: 0,
    attribution: 'Example imagery',
    resolveTile: replacementResolver
  })
  assert.strictEqual(runtime.renderer.textureClears, 0)
  assert.strictEqual(runtime.renderer.imagerySources.length, 1)
  assert.strictEqual(runtime.renderer.imagerySources[0].descriptor.id,
    'replacement')
  assert.strictEqual(runtime.renderer.imagerySources[0].resolveTile({level: 0, row: 0, column: 0}),
    replacementResolver())
  assert.strictEqual(runtime.manifest.texture.id, 'replacement')
  assert.strictEqual(viewer.getState().imageryAttribution, 'Example imagery')
  assert.throws(() => viewer.imagery.setSource({ id: 'broken' }),
    (error) => error.code === 'invalid_imagery_source')

  assert.deepStrictEqual(viewer.environment.getAtmosphere(),
    runtime.atmosphere)
  assert.throws(() => viewer.environment.setAtmosphere({ enabled: true }),
    (error) => error.code === 'invalid_atmosphere_options')
  runtime.manifest.transform = 'cylindrical'
  const atmosphere = viewer.environment.setAtmosphere({
    enabled: true,
    sunAzimuthDegrees: 160
  })
  assert.strictEqual(atmosphere.enabled, true)
  assert.strictEqual(atmosphere.sunAzimuthDegrees, 160)

  viewer.pause()
  assert.strictEqual(viewer.getState().paused, true)
  assert.strictEqual(runtime.pauseCount, 1)
  viewer.resume()
  assert.strictEqual(viewer.getState().paused, false)
  assert.strictEqual(runtime.resumeCount, 1)
  viewer.clearRoute()
  const eventCount = positions.length
  viewer.clearPois()
  assert(positions.slice(eventCount).some((event) => !event.visible))
  viewer.setPois([{ id: 'center', coordinate: [0, 0, 0] }])
  assert.strictEqual(positions[positions.length - 1].featureId, 'center')
  assert.strictEqual(positions[positions.length - 1].visible, true)
  viewer.clearPois()
  assert.strictEqual(runtime.renderer.overlays.slice(-1)[0].points.length, 0)
  viewer.destroy()
  assert.strictEqual(runtime.destroyed, true)
  assert.strictEqual(viewer.surfaceCache, null, 'Destroyed viewer retained a display mesh through query cache')
  assert.throws(() => viewer.sampleRenderedSurface([0, 0]), error => error.code === 'surface_query_failed')
}

async function testResidentQueries() {
  const runtime = new FakePlanarRuntime()
  const viewer = new viewerModule.TerraViewer(runtime, {})
  const expected = {status: 'available', source: 'cbdam-cache', heightMeters: 81.25,
    sampleSpacingMeters: 30, level: 8, dataLevel: 6, revision: 11}
  runtime.sampleTerrain = async (u, v) => {
    assert.deepStrictEqual([u, v], [25, 30])
    return expected
  }
  runtime.lastSurface = null
  runtime.presentedSurface = null
  runtime.submitSurface(null)
  assert.deepStrictEqual(await viewer.sampleTerrain([25, 30]), expected,
    'Resident data query must not depend on the display mesh')
  const queryResult = {status: 'limited', source: 'cbdam-query', reasons: ['no-data'],
    heightMeters: 81.25, verticalAccuracyMeters: null}
  const options = {sampleSpacingMeters: 10}
  runtime.queryTerrain = async (u, v, value) => {
    assert.deepStrictEqual([u, v], [25, 30]); assert.strictEqual(value, options)
    return queryResult
  }
  assert.deepStrictEqual(await viewer.queryTerrain([25, 30], options), queryResult)
  const terrainState = {active: true, eye: {status: 'limited'}, front: null}
  runtime.getTerrainState = () => terrainState
  let retried = 0
  runtime.retryTerrain = () => ++retried
  assert.strictEqual(viewer.camera.getTerrainState(), terrainState)
  viewer.camera.retryTerrain()
  assert.strictEqual(retried, 1)
  runtime.queryTerrain = async () => { throw Object.assign(new Error('cancelled'), {code: 'terrain_query_cancelled'}) }
  await assert.rejects(viewer.queryTerrain([25, 30]), cause => cause.code === 'terrain_query_cancelled')
  viewer.mode = 'globe'
  runtime.manifest.radius = 10
  runtime.submitSurface(new FakePlanarRuntime().renderedSurface)
  assert.strictEqual(viewer.sampleRenderedSurface([180, 0]).status, 'unavailable',
    'A back-side triangle cannot provide local globe coverage')
  await assert.rejects(viewer.sampleTerrain([NaN, 0]), error => error.code === 'invalid_coordinate')
  viewer.destroy()
  await assert.rejects(viewer.sampleTerrain([25, 30]), error => error.code === 'terrain_query_failed')
}

async function main() {
  await require('./browser_request_contract')()
  // The same facade can be installed in both hosts. Only the browser entry
  // supplies the Worker constructor; custom runtime factories see that policy.
  const mini = require('../../adapters/miniprogram/terra_viewer')
  const { TerrainWorkerClient } = require('../../adapters/wasm/terra_worker_client')
  for (const entry of [viewerModule, mini]) {
    let configuration
    const viewer = await entry.TerraViewer.create({mode: 'planar',
      maximumTerrainMeshBytes: 12*1024*1024, maximumPartitionBytes: 10*1024*1024,
      createRuntime: async options => { configuration = options; return new FakePlanarRuntime() }})
    assert.strictEqual(configuration.createWorker,
      entry === viewerModule ? TerrainWorkerClient.create : undefined)
    assert.strictEqual(configuration.request, entry === viewerModule
      ? require('../../adapters/browser/browser_request').browserRequest : require('../../adapters/miniprogram/wx_request').requestWithWx)
    assert.strictEqual(configuration.maximumTerrainMeshBytes, 12*1024*1024)
    assert.strictEqual(configuration.maximumPartitionBytes, 10*1024*1024)
    assert.strictEqual(typeof configuration.createTextureStore, 'function',
      'A public platform entry must supply its image ownership lifecycle')
    viewer.destroy()
  }
  const request = () => {throw new Error('Custom request should only be forwarded')}
  const custom = await viewerModule.TerraViewer.create({mode: 'planar', request,
    createRuntime: async options => {
      assert.strictEqual(options.request, request)
      return new FakePlanarRuntime()
    }})
  custom.destroy()
  const miniDefault = await mini.TerraViewer.create({mode: 'planar', request: null,
    createRuntime: async options => {
      assert.strictEqual(options.request, require('../../adapters/miniprogram/wx_request').requestWithWx)
      return new FakePlanarRuntime()
    }})
  miniDefault.destroy()
  await testResidentQueries()
  testProjectionHelpers()
  testPoisRouteAndSurface()
  console.log('Mini Program TerraViewer product facade tests passed.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
