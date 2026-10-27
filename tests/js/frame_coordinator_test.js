const assert = require('assert')
const { FrameCoordinator } = require('../../sdk/js/runtime/frame_coordinator')
const { TimingSeries } = require('../../sdk/js/diagnostics/timing')

function host() {
  let now = 0, next = 0
  const frames = new Map(), draws = []
  const clock = new FrameCoordinator({
    now: () => now,
    requestFrame(callback) { const id = ++next; frames.set(id, callback); return id },
    cancelFrame(id) { frames.delete(id) },
    render() { draws.push(now); return true }
  })
  return { clock, frames, draws, advance(ms) { now += ms },
    frame(ms = 16) {
      now += ms
      const pending = Array.from(frames.values()); frames.clear()
      pending.forEach(callback => callback(now))
    } }
}

async function main() {
  await require('./cooperative_turn_contract')()
  await require('./browser_task_turn_contract')()
  testIndependentWork()
  testDisplayWait()
  const series = new TimingSeries(4)
  for (const time of [1, 2, 3, 100, 5, 6]) series.record(time)
  const stats = series.snapshot(0, true)
  assert.strictEqual(stats.count, 6)
  assert.strictEqual(stats.windowCount, 4)
  assert.strictEqual(stats.p50Ms, 5)
  assert.strictEqual(stats.p95Ms, 100)
  assert.strictEqual(stats.over50Ms, 1)
  series.record(NaN); series.record(-1)
  assert.strictEqual(series.count, 6)
  for (let i = 0; i < 10000; ++i) series.record(2)
  assert.strictEqual(series.samples.byteLength, 32, 'A long session must not grow the metric working set')
  assert.strictEqual(series.snapshot(1000).p99Ms, 2, 'Recent percentiles must age out an old stall')
  assert.strictEqual(series.maximumMs, 100, 'Lifetime evidence of the stall remains available')

  const h = host(), order = []
  h.clock.request('input', () => { order.push('input'); h.clock.markCamera(); h.clock.invalidate() })
  h.clock.request('animation', () => order.push('animation'))
  h.clock.invalidate(); h.clock.invalidate()
  h.clock.enqueueWork('terrain', () => order.push('obsolete'))
  h.clock.enqueueWork('terrain', () => order.push('latest terrain'))
  assert.strictEqual(h.frames.size, 1, 'All users share one host display callback')
  h.frame()
  assert.deepStrictEqual(order, ['animation', 'input'])
  assert.strictEqual(h.draws.length, 1, 'Input and camera presentation must use the same frame')
  assert.strictEqual(h.clock.snapshot(true).cameraToSubmit.count, 1)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepStrictEqual(order, ['animation', 'input', 'latest terrain'])
  assert.strictEqual(h.frames.size, 0, 'An idle coordinator must not poll')

  const advance = () => {
    h.clock.invalidate()
    h.clock.request('animation', () => h.clock.invalidate())
  }
  h.clock.request('animation', advance)
  h.frame(16)
  h.frame(350)
  assert.strictEqual(h.clock.snapshot(true).continuousInterval.lastMs, 350,
    'A stall above 250ms must not disappear from the active-frame statistics')
  h.clock.invalidate(); h.frame(10000)
  assert.strictEqual(h.clock.snapshot(true).continuousInterval.lastMs, 350,
    'An idle interval must not be counted as an animation stall')

  const id = h.clock.request('input', () => { throw new Error('cancelled callback ran') })
  h.clock.cancel(id)
  h.clock.enqueueWork('data', () => order.push('resumed work'))
  const late = Array.from(h.frames.values())[0]
  h.clock.setPaused(true)
  late()
  assert.strictEqual(h.frames.size, 0)
  h.clock.setPaused(false); h.frame()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.strictEqual(order[order.length - 1], 'resumed work')

  h.clock.request('animation', () => { throw new Error('destroyed callback ran') })
  h.clock.enqueueWork('destroyed', () => { throw new Error('destroyed work ran') })
  const detached = Array.from(h.frames.values())[0]
  h.clock.destroy(); detached()
  assert.strictEqual(h.frames.size, 0)
  assert.strictEqual(h.clock.snapshot().pendingWork, 0)
  console.log('Unified frame ordering, coalescing, pause/destroy and bounded percentile metrics passed')
}

function testDisplayWait() {
  const h = host()
  try {
    // No animation/input actor exists: queue is intentionally empty, whereas
    // frameWait must still expose the host's withheld display callback.
    h.clock.invalidate(); h.frame(66)
    let stats = h.clock.snapshot(true)
    assert.strictEqual(stats.frameWait.count, 1)
    assert.strictEqual(stats.frameWait.lastMs, 66)
    assert.strictEqual(stats.queue.count, 0)
    h.advance(10000)
    assert.strictEqual(h.clock.snapshot(true).frameWait.count, 1, 'Idle time created a display sample')

    h.clock.invalidate()
    const stale = [...h.frames.values()][0]
    h.clock.setPaused(true); h.advance(1000); stale()
    assert.strictEqual(h.clock.snapshot(true).frameWait.count, 1, 'Cancelled display recorded a wait')
    h.clock.resetMetrics(); h.clock.setPaused(false); h.frame(16)
    stats = h.clock.snapshot(true)
    assert.strictEqual(stats.frameWait.count, 1)
    assert.strictEqual(stats.frameWait.lastMs, 16, 'Resume included paused time')
    h.clock.invalidate()
    const detached = [...h.frames.values()][0]
    h.clock.destroy(); h.advance(1000); detached()
    assert.strictEqual(h.clock.snapshot(true).frameWait.count, 1, 'Destroyed display recorded a wait')
  } finally { h.clock.destroy() }
}

function testIndependentWork() {
  let now = 0, serial = 0
  const frames = new Map(), tasks = new Map(), calls = []
  const clock = new FrameCoordinator({
    now: () => now,
    requestFrame(callback) { const id = ++serial; frames.set(id, callback); return id },
    cancelFrame(id) { frames.delete(id) },
    setTask(callback, delay) { const id = ++serial; tasks.set(id, {callback, due: now + delay}); return id },
    clearTask(id) { tasks.delete(id) },
    render: () => { calls.push('display'); return true }
  })
  const turn = () => {
    const ready = [...tasks].filter(([, t]) => t.due <= now)
    for (const [id, t] of ready) { if (tasks.delete(id)) t.callback() }
  }
  try {
    clock.invalidate() // The host never delivers this frame during work checks.
    clock.enqueueWork('terrain', () => calls.push('obsolete'))
    clock.enqueueWork('terrain', () => {
      calls.push('terrain'); now += 5
      clock.enqueueWork('terrain', () => calls.push('continuation'))
    })
    clock.enqueueWork('gpu', () => calls.push('gpu'))
    turn()
    assert.deepStrictEqual(calls, ['terrain'], 'Work was recursive or exceeded its host slice')
    turn()
    assert.deepStrictEqual(calls, ['terrain', 'gpu', 'continuation'], 'Ready resources waited for display delivery')
    assert.strictEqual(frames.size, 1)
    assert.strictEqual(tasks.size, 0, 'Idle work queue kept polling')

    clock.enqueueWork('gpu', () => calls.push('late poll'), 16)
    const stale = [...tasks.values()][0].callback
    clock.enqueueWork('gpu', () => calls.push('ready asset'))
    assert.strictEqual(tasks.size, 1, 'A wake created duplicate background callbacks')
    stale(); turn()
    assert.strictEqual(calls[calls.length - 1], 'ready asset')
    assert(!calls.includes('late poll'), 'Cancelled timer entered a newer generation')
    clock.enqueueWork('gpu', () => calls.push('obsolete immediate'))
    clock.enqueueWork('gpu', () => calls.push('latest'), 16)
    turn()
    assert.strictEqual(calls[calls.length - 1], 'latest', 'A later poll postponed ready work')

    clock.enqueueWork('cancelled', () => { throw Error('Cancelled work ran') })
    const cancelled = [...tasks.values()][0].callback
    clock.cancelWork('cancelled'); cancelled()
    assert.strictEqual(tasks.size, 0)
    clock.enqueueWork('paused', () => calls.push('resumed'))
    const late = [...tasks.values()][0].callback
    clock.setPaused(true); late()
    assert.strictEqual(tasks.size, 0); assert.strictEqual(frames.size, 0)
    assert(!calls.includes('resumed'))
    clock.setPaused(false); turn()
    assert.strictEqual(calls[calls.length - 1], 'resumed')
    const [id, callback] = [...frames][0]; frames.delete(id); callback()
    assert.strictEqual(calls[calls.length - 1], 'display')

    clock.enqueueWork('destroyed', () => { throw Error('Destroyed work ran') })
    const detached = [...tasks.values()][0].callback
    clock.destroy(); detached()
    assert.strictEqual(tasks.size, 0); assert.strictEqual(frames.size, 0)
    assert.strictEqual(clock.snapshot().pendingWork, 0)
  } finally { clock.destroy() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
