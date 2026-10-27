const assert = require('assert')
const { WorkerTurn } = require('../../adapters/wasm/worker_turn')

module.exports = async function verifyWorkerTurn() {
  const channels = [], live = new Set(), messages = []
  class Channel {
    constructor() {
      this.port1 = {close: () => live.delete(this.port1)}
      this.port2 = {close: () => live.delete(this.port2), postMessage: () => {
        messages.push(() => this.port1.onmessage())
      }}
      live.add(this.port1); live.add(this.port2); channels.push(this)
    }
  }
  const turn = new WorkerTurn({MessageChannel: Channel})
  assert.strictEqual(live.size, 0, 'Creating a dispatcher opened idle ports')
  const waiting = turn.wait()
  assert.strictEqual(turn.wait(), waiting, 'Concurrent yields queued duplicate host tasks')
  assert.strictEqual(messages.length, 1)
  let resolved = false
  waiting.then(() => { resolved = true })
  await Promise.resolve()
  assert(!resolved, 'A microtask replaced the required host task')
  messages.shift()(); await waiting
  assert(resolved)
  const second = turn.wait()
  assert.strictEqual(channels.length, 1, 'A busy pump recreated ports for every slice')
  messages.shift()(); await second
  turn.close(); turn.close()
  assert.strictEqual(live.size, 0)
  const resumed = turn.wait()
  assert.strictEqual(channels.length, 2, 'An idle dispatcher could not restart')
  turn.close(); await resumed
  assert.strictEqual(live.size, 0, 'Closing suspended dispatch retained handles')
  // Hosts without MessageChannel retain a real task boundary, including close.
  const fallback = new WorkerTurn({})
  await fallback.wait()
  const cancelled = fallback.wait()
  fallback.close(); await cancelled
  assert.strictEqual(fallback.pending, null)
  assert.strictEqual(fallback.timer, null)
}
