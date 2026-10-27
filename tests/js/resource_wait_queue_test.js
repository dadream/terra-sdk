const assert = require('assert')
const {ResourceWaitQueue} = require('../../sdk/js/resources/resource_wait_queue')

module.exports = async function verifyResourceWaitQueue() {
  const queue = new ResourceWaitQueue()
  let available = false, attempts = 0, completed = false
  const first = queue.wait(() => { ++attempts; return available })
  const stopped = assert.rejects(first.promise, error => error.name === 'AbortError')
  const second = queue.wait(() => { completed = true; return true })
  await Promise.resolve(); await Promise.resolve()
  assert.strictEqual(attempts, 1)
  assert.strictEqual(completed, false, 'A later producer bypassed the unserved head')
  await Promise.resolve(); await Promise.resolve()
  assert.strictEqual(attempts, 1, 'A refused acquisition busy-polled without a capacity wake')
  first.cancel()
  await stopped; await second.promise
  assert(completed)
  assert.strictEqual(queue.pending.length, 0)

  const resumed = queue.wait(() => { ++attempts; return available })
  await Promise.resolve()
  available = true; queue.wake(); queue.wake()
  await resumed.promise
  assert.strictEqual(attempts, 3)
  assert.strictEqual(queue.pending.length, 0)

  let cancelDuringAcquire
  const cancelled = queue.wait(() => { cancelDuringAcquire(); return true })
  cancelDuringAcquire = cancelled.cancel
  const rejected = assert.rejects(cancelled.promise, error => error.name === 'AbortError')
  const following = queue.wait(() => true)
  await rejected; await following.promise
  assert.strictEqual(queue.pending.length, 0, 'Reentrant cancellation removed the following owner')
  console.log('Resource wait FIFO, cancellation, coalesced wake and no-poll progress passed')
}
