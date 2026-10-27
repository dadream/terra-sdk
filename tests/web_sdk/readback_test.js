const assert = require('assert')
const nextSubmission = require('./readback')

function fixture() {
  const frames = new Map(), timers = new Map()
  let next = 0, ready = false, draws = 0
  const renderer = {
    requestRender() {},
    render(force) {
      assert.strictEqual(this, renderer)
      if (!ready) return null
      ready = false; ++draws
      return {submitted: draws, force}
    }
  }
  const original = renderer.render
  const options = {
    requestFrame(callback) { const id = ++next; frames.set(id, callback); return id },
    cancelFrame(id) { frames.delete(id) },
    setTimer(callback, ms) { assert.strictEqual(ms, 10000); const id = ++next; timers.set(id, callback); return id },
    clearTimer(id) { timers.delete(id) }
  }
  return {renderer, options, frames, timers, ready() { ready = true },
    frame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()) },
    clean() { assert.strictEqual(renderer.render, original); assert.strictEqual(frames.size + timers.size, 0) }}
}

async function main() {
  const owned = fixture(), pending = nextSubmission(owned.renderer, owned.options)
  assert.strictEqual(owned.frames.size, 0, 'Readback created a competing display clock')
  assert.strictEqual(owned.renderer.render(false), null)
  owned.ready()
  // The owner consumes every free GPU slot before a polling reader arrives.
  const submitted = owned.renderer.render(false)
  assert.strictEqual(owned.renderer.render(), null)
  assert.deepStrictEqual(await pending, submitted)
  assert.strictEqual(submitted.force, true, 'Owned readback did not force a real display submission')
  owned.clean()

  const preparation = fixture(), awaitingDraw = nextSubmission(preparation.renderer, preparation.options)
  preparation.renderer.surfaceDrawn = false
  preparation.ready(); preparation.renderer.render(false)
  assert.strictEqual(preparation.timers.size, 1, 'Preparation-only result completed a pixel readback')
  preparation.renderer.surfaceDrawn = true
  preparation.ready(); preparation.renderer.render(false)
  await awaitingDraw; preparation.clean()

  const transition = fixture()
  let stable = false
  const stableRead = nextSubmission(transition.renderer, Object.assign({accept: () => stable}, transition.options))
  transition.ready(); transition.renderer.render()
  assert.strictEqual(transition.timers.size, 1, 'Unstable submitted state completed a stable readback')
  stable = true
  transition.ready(); transition.renderer.render()
  assert.strictEqual((await stableRead).submitted, 2)
  transition.clean()

  const standalone = fixture(), driven = nextSubmission(standalone.renderer,
    Object.assign({drive: true}, standalone.options))
  standalone.frame()
  assert.strictEqual(standalone.frames.size, 1)
  standalone.ready(); standalone.frame()
  assert.strictEqual((await driven).submitted, 1)
  standalone.clean()

  const timeout = fixture(), expired = nextSubmission(timeout.renderer, Object.assign({drive: true}, timeout.options))
  for (const callback of [...timeout.timers.values()]) callback()
  await assert.rejects(expired, /Timed out waiting/)
  timeout.clean()

  const broken = fixture(), render = () => { throw new Error('draw failed') }
  broken.renderer.render = render
  const failed = nextSubmission(broken.renderer, broken.options)
  assert.throws(() => broken.renderer.render(), /draw failed/)
  await assert.rejects(failed, /draw failed/)
  assert.strictEqual(broken.renderer.render, render)
  assert.strictEqual(broken.frames.size + broken.timers.size, 0)
  console.log('Readback observes owned submissions; standalone, timeout and failure cleanup passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
