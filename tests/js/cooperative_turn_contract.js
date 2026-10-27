const assert = require('assert')
const {CooperativeTurn} = require('../../sdk/js/runtime/cooperative_turn')

module.exports = async function () {
  let now = 0, callback, cancelled = 0, scheduled = 0
  const turn = new CooperativeTurn({now:() => now,
    schedule(value) {callback = value; return ++scheduled},
    cancel() {++cancelled; callback = null}})
  for (let i = 0; i < 16; ++i) {
    await turn.wait()
    now += 0.25
  }
  assert.strictEqual(scheduled, 0, 'Cheap rounds paid a host timer per checkpoint')
  const next = turn.wait()
  assert.strictEqual(scheduled, 1, 'A full CPU slice failed to yield to the host')
  assert.strictEqual(turn.wait(), next, 'Concurrent work scheduled duplicate host turns')
  now += 10
  callback(); callback = null
  await next
  await turn.wait()
  assert.strictEqual(scheduled, 1, 'The next CPU window did not start at resume')
  assert.strictEqual(turn.waitMs, 10)
  now += 4
  const pending = turn.wait()
  turn.close()
  await pending
  assert.strictEqual(cancelled, 1, 'Destroy left a host timer alive')
  now += 100
  await turn.wait()
  assert.strictEqual(scheduled, 2, 'A closed owner scheduled more work')
}
