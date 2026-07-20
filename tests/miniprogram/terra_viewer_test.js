const assert = require('assert')

const viewerModule = require('../../apps/miniprogram/utils/terra_viewer')

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
    this.textures = { clear: () => { this.textureClears += 1 } }
  }

  setOverlays(value) { this.overlays.push(value) }
}

class FakePlanarRuntime {
  constructor() {
    this.manifest = {
      transform: 'planar',
      minimumU: -1,
      minimumV: -1,
      maximumU: 1,
      maximumV: 1,
      radius: 0,
      texture: { id: 'planar' }
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
      draws: [{ firstVertex: 0, vertexCount: 3, origin: [0, 0, 0] }],
      positions: new Float32Array([
        -1, -1, 10,
        0, 0, 20,
        1, 1, 30
      ]),
      textureUv: new Float32Array(6),
      indices: new Uint16Array(0)
    }
    this.renderer = new FakeRenderer()
    this.view = {
      schema: 'terra.view-state.v1',
      mode: 'planar',
      target: { x: 0, y: 0, height: 0 },
      rangeMeters: 4,
      headingDegrees: 0,
      tiltDegrees: 0
    }
    this.destroyed = false
    this.pauseCount = 0
    this.resumeCount = 0
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
  applyInteraction() {}
  resize() {}
  scheduleRender() {}
  refresh() {}
  pause() { this.pauseCount += 1 }
  resume() { this.resumeCount += 1 }
  rangeLimits() { return { minimum: 0.5, maximum: 40 } }
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
  destroy() { this.destroyed = true }
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
  assert.strictEqual(viewer.projectedPois[1].surfaceStatus, 'ready')
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

  const ready = viewer.sampleSurface([0, 0, 0])
  assert.strictEqual(ready.status, 'ready')
  assert.strictEqual(ready.heightMeters, 20)
  runtime.lastFrame.requestCount = 1
  viewer.surfaceCache = null
  assert.strictEqual(viewer.sampleSurface([0, 0, 0]).status, 'approximate')
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
  assert.strictEqual(surfaceChanges.length, 1)
  assert.strictEqual(surfaceChanges[0].revision, 2)
  const overlayCount = runtime.renderer.overlays.length
  viewer.handleRuntimeState(runtime.state())
  assert.strictEqual(runtime.renderer.overlays.length, overlayCount)
  assert.strictEqual(viewer.getState().featureCount, 2)
  assert.strictEqual(viewer.getState().routeId, 'route')

  viewer.imagery.setSource({
    id: 'replacement',
    tileScheme: 'planar-single',
    minimumLevel: 0,
    maximumLevel: 0,
    attribution: 'Example imagery',
    resolveTile: () => 'https://tiles.example/planar.png'
  })
  assert.strictEqual(runtime.renderer.textureClears, 1)
  assert.strictEqual(runtime.manifest.texture.id, 'replacement')
  assert.strictEqual(viewer.getState().imageryAttribution, 'Example imagery')
  assert.throws(() => viewer.imagery.setSource({ id: 'broken' }),
    (error) => error.code === 'invalid_imagery_source')

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
}

function main() {
  testProjectionHelpers()
  testPoisRouteAndSurface()
  console.log('Mini Program TerraViewer product facade tests passed.')
}

main()
