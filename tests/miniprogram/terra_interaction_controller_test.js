const assert = require('assert')

const { TerraInteractionController } = require(
  '../../apps/miniprogram/utils/terra_interaction_controller')

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
    this.changes = []
    this.cancelCount = 0
  }

  panBy(change) { this.changes.push({ pan: change }) }
  zoomBy(scale, options) { this.changes.push({ zoom: scale, options }) }
  orbitBy(change) { this.changes.push({ orbit: change }) }
  applyInteraction(change) { this.changes.push(Object.assign({}, change)) }
  cancelAnimation() { this.cancelCount += 1 }
}

function pointer(id, x, y) {
  return { id, x, y }
}

function create(options) {
  const clock = new FrameClock()
  const camera = new FakeCamera()
  const events = []
  const controller = new TerraInteractionController(camera, Object.assign({
    requestFrame: (callback) => clock.request(callback),
    cancelFrame: (id) => clock.cancel(id),
    now: () => clock.time,
    onEvent: (type, detail) => events.push({ type, detail })
  }, options))
  return { camera, clock, controller, events }
}

function testMoveDeadZoneAndFrameMerge() {
  const value = create({ inertiaEnabled: false })
  value.controller.begin({ pointers: [pointer(1, 10, 10)], timeMs: 0 })
  value.controller.update({ pointers: [pointer(1, 12, 11)], timeMs: 10 })
  value.clock.tick()
  assert.strictEqual(value.camera.changes.length, 0)
  value.controller.update({ pointers: [pointer(1, 20, 15)], timeMs: 20 })
  value.controller.update({ pointers: [pointer(1, 40, 25)], timeMs: 30 })
  assert.strictEqual(value.camera.changes.length, 0)
  value.clock.tick()
  assert.strictEqual(value.camera.changes.length, 1)
  assert.strictEqual(value.camera.changes[0].xPixels, 28)
  assert.strictEqual(value.camera.changes[0].yPixels, 14)
  value.controller.end({ pointers: [], timeMs: 40 })
  assert(value.events.some((event) => event.type === 'interactionstart'))
  assert(value.events.some((event) => event.type === 'interactionend'))
  assert(value.events.some((event) => event.type === 'camerasettle'))
}

function testClampDropsOverflow() {
  const value = create({
    inertiaEnabled: false,
    maximumPanPixelsPerFrame: 20
  })
  value.controller.begin({ pointers: [pointer(1, 0, 0)], timeMs: 0 })
  value.controller.update({ pointers: [pointer(1, 200, -200)], timeMs: 16 })
  value.clock.tick()
  assert.strictEqual(value.camera.changes[0].xPixels, 20)
  assert.strictEqual(value.camera.changes[0].yPixels, -20)
  value.controller.update({ pointers: [pointer(1, 201, -199)], timeMs: 32 })
  value.clock.tick()
  assert.strictEqual(value.camera.changes[1].xPixels, 1)
  assert.strictEqual(value.camera.changes[1].yPixels, 1)
}

function testPinchAndPointerRestart() {
  const value = create({ inertiaEnabled: false })
  value.controller.begin({
    pointers: [pointer(1, 10, 10), pointer(2, 30, 10)], timeMs: 0
  })
  value.controller.update({
    pointers: [pointer(1, 5, 10), pointer(2, 35, 20)], timeMs: 16
  })
  value.clock.tick()
  const pinch = value.camera.changes[0]
  assert(pinch.zoomScale < 1)
  assert.deepStrictEqual(pinch.anchor, { x: 20, y: 15 })
  assert.notStrictEqual(pinch.headingDegrees, 0)

  value.controller.update({ pointers: [pointer(1, 6, 11)], timeMs: 32 })
  assert.strictEqual(value.camera.changes.length, 1)
  value.controller.update({ pointers: [pointer(1, 16, 11)], timeMs: 48 })
  value.clock.tick()
  assert.strictEqual(value.camera.changes.length, 2)
  assert.strictEqual(value.camera.changes[1].xPixels, 10)
}

function testLookAndCancel() {
  const value = create({ mode: 'look', inertiaEnabled: false })
  value.controller.begin({ pointers: [pointer(7, 10, 10)], timeMs: 0 })
  value.controller.update({ pointers: [pointer(7, 30, 30)], timeMs: 16 })
  value.clock.tick()
  assert.strictEqual(value.camera.changes[0].headingDegrees, 5)
  assert.strictEqual(value.camera.changes[0].tiltDegrees, -4)
  value.controller.update({ pointers: [pointer(7, 60, 60)], timeMs: 32 })
  value.controller.cancel()
  value.clock.tick()
  assert.strictEqual(value.camera.changes.length, 1)
}

function testFiniteInertiaAndNewTouchCancellation() {
  const value = create({
    inertiaMinimumPixelsPerMs: 0.05,
    inertiaMaximumDurationMs: 64,
    inertiaDecayPerFrame: 0.5
  })
  value.controller.begin({ pointers: [pointer(1, 0, 0)], timeMs: 0 })
  value.controller.update({ pointers: [pointer(1, 20, 0)], timeMs: 16 })
  value.clock.tick()
  value.controller.end({ pointers: [], timeMs: 17 })
  value.clock.tick()
  value.clock.tick()
  assert(value.camera.changes.length >= 2)
  value.controller.begin({ pointers: [pointer(2, 1, 1)], timeMs: 60 })
  const count = value.camera.changes.length
  value.clock.tick(100)
  assert.strictEqual(value.camera.changes.length, count)
  assert(value.events.some((event) => event.type === 'animationcancel'))
  value.controller.destroy()
  assert.throws(() => value.controller.begin({
    pointers: [pointer(3, 0, 0)], timeMs: 200
  }), /destroyed/)
}

function main() {
  testMoveDeadZoneAndFrameMerge()
  testClampDropsOverflow()
  testPinchAndPointerRestart()
  testLookAndCancel()
  testFiniteInertiaAndNewTouchCancellation()
  console.log('Mini Program interaction controller tests passed.')
}

main()
