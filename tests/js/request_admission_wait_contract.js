const assert = require('assert')
const {RequestScheduler} = require('../../sdk/js/core/terra_globe_common')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

module.exports = async function() {
  const scheduler = new RequestScheduler(1), starts = []
  let finish, eligible = true
  const start = key => () => {starts.push(key); return {promise:Promise.resolve(), abort() {}}}
  scheduler.enqueue('in-flight', () => ({promise:new Promise(resolve => {finish=resolve}), abort() {finish()}}))
  scheduler.enqueue('detail', start('detail'), 100, () => eligible)
  scheduler.enqueue('coverage', start('coverage'), 10)
  // The dependency changes after queueing and before a network slot opens.
  eligible = false; finish(); await tick()
  assert.deepStrictEqual(starts, ['coverage'], 'Queued detail started after its preparation dependency became unavailable')
  assert.deepStrictEqual(scheduler.stats(), {active:0, queued:1})
  for(let receipt=0; receipt<32; ++receipt) scheduler.pump()
  await tick()
  assert.deepStrictEqual(starts, ['coverage'], 'Repeated unrelated receipts started a parked request')
  eligible = true; scheduler.pump(); await tick()
  assert.deepStrictEqual(starts, ['coverage','detail'])
  assert.deepStrictEqual(scheduler.stats(), {active:0, queued:0})
  eligible = false
  scheduler.enqueue('obsolete', start('obsolete'), 100, () => eligible)
  scheduler.cancelExcept(new Set()); eligible = true; scheduler.pump(); await tick()
  assert(!starts.includes('obsolete'), 'Cancellation retained a dependency waiter')
  scheduler.pause(); scheduler.enqueue('paused', start('paused'), 1, () => eligible)
  assert(!starts.includes('paused')); scheduler.resume(); await tick()
  assert(starts.includes('paused'))
  scheduler.clear()
  console.log('Request admission waits: dispatch rechecks dependencies, independent coverage runs, explicit wakes and cancellation preserve queue ownership')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
