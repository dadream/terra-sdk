const assert = require('assert')
const {createTaskTurn, setTask, clearTask} = require('../../adapters/browser/task_turn')
const {FrameCoordinator} = require('../../sdk/js/runtime/frame_coordinator')

module.exports = async function () {
  const original = Object.getOwnPropertyDescriptor(global, 'MessageChannel')
  let now = 0, posts = 0
  const channels = []
  class Channel {
    constructor() {
      this.port1 = {close() {this.closed = true}}
      this.port2 = {close() {this.closed = true}, postMessage() {++posts}}
      channels.push(this)
    }
  }
  Object.defineProperty(global, 'MessageChannel', {value:Channel, configurable:true, writable:true})
  let turn
  try {
    turn = createTaskTurn({now:() => now})
    await turn.wait()
    assert.strictEqual(posts, 0)
    now = 4
    const pending = turn.wait()
    assert.strictEqual(turn.wait(), pending)
    assert.strictEqual(posts, 1)
    channels[0].port1.onmessage()
    await pending
    assert(channels[0].port1.closed && channels[0].port2.closed)
    assert.strictEqual(channels[0].port1.onmessage, null)
    now = 8
    const cancelled = turn.wait()
    turn.close()
    await cancelled
    assert(channels[1].port1.closed && channels[1].port2.closed)
    assert.strictEqual(channels[1].port1.onmessage, null)
    global.MessageChannel = undefined
    turn = createTaskTurn({now:() => now})
    now += 4
    const fallback = turn.wait()
    turn.close()
    await fallback
    assert.strictEqual(posts, 2, 'Fallback required a browser channel')
  } finally {
    if (turn) turn.close()
    if (original) Object.defineProperty(global, 'MessageChannel', original)
    else delete global.MessageChannel
  }
  testBackgroundTasks()
}

function testBackgroundTasks() {
  const original = Object.getOwnPropertyDescriptor(global, 'MessageChannel')
  const originalSet = global.setTimeout, originalClear = global.clearTimeout
  let now = 0, serial = 0
  const channels = [], timers = new Map(), calls = []
  class Channel {
    constructor() {
      this.port1 = {close() {this.closed = true}}
      this.port2 = {close() {this.closed = true}, postMessage() {}}
      channels.push(this)
    }
  }
  let clock
  try {
    Object.defineProperty(global, 'MessageChannel', {value:Channel, configurable:true, writable:true})
    global.setTimeout = (callback, delay) => {const id = ++serial; timers.set(id, {callback, delay}); return id}
    global.clearTimeout = id => timers.delete(id)
    clock = new FrameCoordinator({now:()=>now, setTask, clearTask,
      requestFrame() {return 1}, cancelFrame() {}, render() {throw Error('Display was not delivered')}})
    clock.invalidate()
    clock.enqueueWork('terrain', () => {calls.push('terrain'); now += 4})
    clock.enqueueWork('upload', () => calls.push('upload'))
    assert.strictEqual(timers.size, 0, 'Ready browser work waited for a timer')
    channels[0].port1.onmessage()
    assert.deepStrictEqual(calls, ['terrain'], 'Host dispatch bypassed the bounded CPU slice')
    assert(channels[0].port1.closed && channels[0].port2.closed)
    channels[1].port1.onmessage()
    assert.deepStrictEqual(calls, ['terrain', 'upload'], 'Ready resources waited for display delivery')
    assert(channels.every(c => c.port1.closed && c.port2.closed), 'Idle dispatch retained ports')

    clock.enqueueWork('poll', () => calls.push('obsolete poll'), 16)
    const delayed = [...timers.values()][0]
    assert.strictEqual(delayed.delay, 16, 'A GPU/retry deadline became immediate work')
    clock.enqueueWork('poll', () => calls.push('ready'))
    assert.strictEqual(timers.size, 0, 'Ready data left its superseded timer alive')
    delayed.callback()
    assert(!calls.includes('obsolete poll'))
    const detached = channels[2].port1.onmessage
    clock.setPaused(true); detached()
    assert(!calls.includes('ready'), 'Cancelled browser dispatch entered a paused clock')
    clock.setPaused(false)
    channels[3].port1.onmessage()
    assert.strictEqual(calls[calls.length - 1], 'ready')
    clock.enqueueWork('destroyed', () => {throw Error('Destroyed work ran')})
    const destroyed = channels[4].port1.onmessage
    clock.destroy(); destroyed()
    assert(channels.every(c => c.port1.closed && c.port2.closed), 'Destroy retained browser ports')

    global.MessageChannel = undefined
    const fallback = setTask(() => calls.push('fallback'))
    const timer = [...timers.values()][0]
    assert.strictEqual(timer.delay, 0)
    clearTask(fallback); timer.callback()
    assert(!calls.includes('fallback'), 'Cancelled fallback timer ran')
    assert.strictEqual(timers.size, 0)

    global.MessageChannel = class extends Channel {
      constructor() {super(); this.port2.postMessage = () => {throw Error('Dispatch failed')}}
    }
    assert.throws(() => setTask(() => {}), /Dispatch failed/)
    assert(channels.every(c => c.port1.closed && c.port2.closed), 'Failed posting retained ports')
  } finally {
    if (clock) clock.destroy()
    global.setTimeout = originalSet; global.clearTimeout = originalClear
    if (original) Object.defineProperty(global, 'MessageChannel', original)
    else delete global.MessageChannel
  }
}
