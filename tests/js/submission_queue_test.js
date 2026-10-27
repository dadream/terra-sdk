const assert = require('assert')
const {GlSubmission} = require('../../adapters/webgl/gl_allocation')
const {SubmissionQueue} = require('../../adapters/webgl/submission_queue')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')

for (const outcome of ['complete', 'allocation-error', 'wait-error', 'destroy', 'lost']) {
  const ledger = new ResourceLedger(64), queue = new SubmissionQueue(), syncs = new Set()
  const receipts = [], published = [], cancelled = []
  let checks = 0, releases = 0
  const gl = {
    TIMEOUT_EXPIRED: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, NO_ERROR: 0,
    fenceSync() { const sync = {ready:false}; syncs.add(sync); return sync },
    flush() {}, deleteSync(sync) { syncs.delete(sync) },
    clientWaitSync(sync) { return sync.failed ? 4 : sync.ready ? 2 : 1 },
    getError() { ++checks; assert(!syncs.size); return outcome === 'allocation-error' ? 0x0505 : 0 },
    createBuffer() { return {} }, bindBuffer() {}, bufferData() {}, deleteBuffer() { ++releases }
  }
  const draw = new GlSubmission(gl)
  draw.hold(done => receipts.push(done))
  queue.submit(draw, true)
  const credit = ledger.reserve('upload', 64), resource = new GlSubmission(gl)
  resource.stage('buffer', r => r.buffer(0, new Uint8Array(64)), value => {
    credit.mark('resident'); published.push(value)
  }, () => {credit.release(); cancelled.push(true)})
  queue.submit(resource)
  assert.strictEqual(syncs.size, 2)
  assert.throws(() => queue.submit(new GlSubmission(gl), true), /lane is occupied/)
  assert.throws(() => queue.submit(new GlSubmission(gl)), /lane is occupied/)
  for (let i = 0; i < 20; ++i) assert(!queue.poll(() => {}))
  assert.strictEqual(checks, 0, 'Unfinished GPU work forced validation')
  assert.strictEqual(ledger.bytes, 64, 'Pending uploads lost their physical credit')
  assert.strictEqual(published.length, 0)
  if (outcome === 'destroy' || outcome === 'lost') {
    queue.cancel(outcome === 'lost')
    assert.deepStrictEqual(receipts, [outcome === 'lost'])
    assert.strictEqual(releases, outcome === 'lost' ? 0 : 1)
    if (outcome === 'lost') syncs.clear() // The lost context owns invalid handles.
  } else {
    draw.sync.ready = true
    assert(!queue.poll(() => {}))
    assert.deepStrictEqual(receipts, [true])
    assert.strictEqual(checks, 0)
    assert.strictEqual(ledger.bytes, 64)
    assert.strictEqual(published.length, 0, 'An earlier draw receipt published a later upload')
    if (outcome === 'wait-error') resource.sync.failed = true
    else resource.sync.ready = true
    if (outcome === 'complete') {
      assert(queue.poll(() => {})); assert.strictEqual(published.length, 1)
      assert.strictEqual(ledger.stats().residentBytes, 64)
      gl.deleteBuffer(published[0]);credit.release()
    } else {
      assert.throws(() => queue.poll(() => {}), /failed/)
      queue.cancel()
      assert.strictEqual(published.length, 0)
    }
  }
  queue.cancel()
  assert.strictEqual(cancelled.length, Number(outcome !== 'complete'))
  assert.strictEqual(queue.pending, null)
  assert.strictEqual(syncs.size, 0)
  assert.strictEqual(ledger.bytes, 0)
}
console.log('Bounded display/upload overlap, separate receipts, validation and teardown passed')
