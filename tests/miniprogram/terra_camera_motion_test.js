const assert = require('assert')

const {
  TerraCameraMotionController,
  angularDistance,
  interpolateCoordinate,
  routeMetrics
} = require('../../apps/miniprogram/utils/terra_camera_motion')

const RADIUS = 6378137

class FrameClock {
  constructor() {
    this.time = 0
    this.nextId = 1
    this.callbacks = new Map()
  }

  request(callback) {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    return id
  }

  cancel(id) {
    this.callbacks.delete(id)
  }

  tick(milliseconds) {
    this.time += milliseconds === undefined ? 16 : milliseconds
    const callbacks = Array.from(this.callbacks.values())
    this.callbacks.clear()
    callbacks.forEach((callback) => callback(this.time))
  }
}

class FakeCamera {
  constructor() {
    this.view = {
      schema: 'terra.view-state.v1',
      mode: 'globe',
      target: {
        longitudeDegrees: 120.58,
        latitudeDegrees: 31.334,
        heightMeters: 0
      },
      rangeMeters: RADIUS + 12000,
      headingDegrees: 0,
      tiltDegrees: 45
    }
    this.views = []
  }

  getView() {
    return JSON.parse(JSON.stringify(this.view))
  }

  setView(view) {
    this.view = JSON.parse(JSON.stringify(view))
    this.views.push(this.getView())
  }
}

function create() {
  const clock = new FrameClock()
  const camera = new FakeCamera()
  const states = []
  const controller = new TerraCameraMotionController(camera, {
    radius: RADIUS,
    requestFrame: (callback) => clock.request(callback),
    cancelFrame: (id) => clock.cancel(id),
    now: () => clock.time,
    onState: (state) => states.push(state)
  })
  return { camera, clock, controller, states }
}

function testFlyToCompletesAtTarget() {
  const value = create()
  value.controller.flyTo([120.568391, 31.310469, 0], {
    durationMs: 100,
    heightAboveTargetMeters: 12000,
    tiltDegrees: 40,
    headingDegrees: 15
  })
  value.clock.tick(0)
  value.clock.tick(50)
  assert.notStrictEqual(value.camera.view.target.longitudeDegrees, 120.58)
  value.clock.tick(50)
  assert(Math.abs(value.camera.view.target.longitudeDegrees -
    120.568391) < 1e-8)
  assert(Math.abs(value.camera.view.target.latitudeDegrees -
    31.310469) < 1e-8)
  assert.strictEqual(value.camera.view.headingDegrees, 15)
  assert.strictEqual(value.camera.view.tiltDegrees, 40)
  assert.strictEqual(value.controller.state().mode, 'idle')
  assert.strictEqual(value.controller.state().reason, 'flying_complete')
}

function testOrbitDirectionAndStop() {
  const clockwise = create()
  clockwise.controller.startOrbit([120.58, 31.334, 0], {
    direction: 'clockwise',
    speedDegreesPerSecond: 12
  })
  clockwise.clock.tick(0)
  clockwise.clock.tick(1000)
  assert(Math.abs(clockwise.camera.view.headingDegrees - 12) < 1e-8)
  assert.strictEqual(clockwise.controller.stop('test'), true)
  const stoppedHeading = clockwise.camera.view.headingDegrees
  clockwise.clock.tick(1000)
  assert.strictEqual(clockwise.camera.view.headingDegrees, stoppedHeading)

  const counterclockwise = create()
  counterclockwise.controller.startOrbit([120.58, 31.334, 0], {
    direction: 'counterclockwise',
    speedDegreesPerSecond: 12
  })
  counterclockwise.clock.tick(0)
  counterclockwise.clock.tick(1000)
  assert(Math.abs(counterclockwise.camera.view.headingDegrees + 12) < 1e-8)
}

function testLongDistanceFlightUsesStagedPath() {
  const value = create()
  const startLongitude = value.camera.view.target.longitudeDegrees
  value.controller.flyTo([116.4074, 39.9042, 0], {
    durationMs: 1000,
    heightAboveTargetMeters: 12000,
    tiltDegrees: 45
  })
  assert.strictEqual(value.controller.state().path, 'staged')
  assert.strictEqual(value.controller.state().phase, 'ascend')
  value.clock.tick(0)
  value.clock.tick(200)
  assert.strictEqual(value.controller.state().phase, 'ascend')
  assert.strictEqual(value.camera.view.target.longitudeDegrees, startLongitude)
  const raisedRange = value.camera.view.rangeMeters
  value.clock.tick(300)
  assert.strictEqual(value.controller.state().phase, 'cruise')
  assert.notStrictEqual(value.camera.view.target.longitudeDegrees,
    startLongitude)
  assert(value.camera.view.rangeMeters >= raisedRange)
  assert.strictEqual(value.camera.view.tiltDegrees, 0)
  value.clock.tick(300)
  assert.strictEqual(value.controller.state().phase, 'cruise')
  value.clock.tick(200)
  assert.strictEqual(value.controller.state().phase, 'descend')
  assert.strictEqual(value.camera.view.target.longitudeDegrees, 116.4074)
  value.clock.tick(200)
  assert.strictEqual(value.controller.state().mode, 'idle')
  assert.strictEqual(value.controller.state().phase, '')
  assert.strictEqual(value.camera.view.target.latitudeDegrees, 39.9042)
  assert.strictEqual(value.camera.view.tiltDegrees, 45)
}

function testLongFramesCannotSkipStagedPhases() {
  const value = create()
  value.controller.flyTo([116.4074, 39.9042, 0], {
    durationMs: 900,
    heightAboveTargetMeters: 12000,
    tiltDegrees: 45
  })
  value.clock.tick(0)
  for (let index = 0; index < 5; ++index) value.clock.tick(1000)
  const phases = value.states.map((state) => state.phase).filter(Boolean)
  assert(phases.indexOf('ascend') >= 0)
  assert(phases.indexOf('cruise') > phases.indexOf('ascend'))
  assert(phases.indexOf('descend') > phases.indexOf('cruise'))
  assert.strictEqual(value.controller.state().mode, 'idle')
}

function testNearFlightStaysDirectAndAntipodalIsFinite() {
  const value = create()
  value.controller.flyTo([120.581, 31.334, 0], { durationMs: 100 })
  assert.strictEqual(value.controller.state().path, 'direct')
  value.clock.tick(0)
  value.clock.tick(50)
  assert.strictEqual(value.controller.state().phase, 'direct')
  const midpoint = interpolateCoordinate([0, 0, 0], [180, 0, 0], 0.5)
  assert(midpoint.every(Number.isFinite))
}

function testRoutePauseAndResume() {
  const value = create()
  const route = [
    [120.58, 31.334, 0],
    [120.568, 31.31, 0],
    [120.629, 31.324, 0]
  ]
  value.controller.playRoute(route, { durationMs: 1000 })
  value.clock.tick(0)
  value.clock.tick(400)
  const pausedLongitude = value.camera.view.target.longitudeDegrees
  assert.strictEqual(value.controller.pause(), true)
  assert.strictEqual(value.controller.state().mode, 'route-paused')
  value.clock.tick(500)
  assert.strictEqual(value.camera.view.target.longitudeDegrees,
    pausedLongitude)
  assert.strictEqual(value.controller.resume(), true)
  value.clock.tick(100)
  assert.notStrictEqual(value.camera.view.target.longitudeDegrees,
    pausedLongitude)
  value.clock.tick(500)
  assert.strictEqual(value.controller.state().mode, 'idle')
  assert(Math.abs(value.camera.view.target.longitudeDegrees - 120.629) < 1e-8)
  assert(Math.abs(value.camera.view.target.latitudeDegrees - 31.324) < 1e-8)
}

function testRouteMetrics() {
  const route = routeMetrics([
    [120.58, 31.334, 0],
    [120.568, 31.31, 0]
  ], RADIUS)
  assert(route.totalDistanceMeters > 2000)
  assert(route.totalDistanceMeters < 4000)
  assert(angularDistance(route.coordinates[0], route.coordinates[1]) > 0)
  assert.throws(() => routeMetrics([[120, 31, 0]], RADIUS),
    /at least two/)
}

function testMotionOptionsAreValidatedSynchronously() {
  const value = create()
  assert.throws(() => value.controller.flyTo([120.6, 31.3], {
    tiltDegrees: 90
  }), /outside \[0, 80\]/)
  assert.throws(() => value.controller.startOrbit([120.6, 31.3], {
    direction: 'sideways'
  }), /unsupported/)
  assert.throws(() => value.controller.playRoute([
    [120.58, 31.334], [120.568, 31.31]
  ], { rangeMeters: RADIUS }), /outside globe limits/)
  assert.strictEqual(value.clock.callbacks.size, 0)
}

function main() {
  testFlyToCompletesAtTarget()
  testLongDistanceFlightUsesStagedPath()
  testLongFramesCannotSkipStagedPhases()
  testNearFlightStaysDirectAndAntipodalIsFinite()
  testOrbitDirectionAndStop()
  testRoutePauseAndResume()
  testRouteMetrics()
  testMotionOptionsAreValidatedSynchronously()
  console.log('Camera motion controller tests passed.')
}

main()
