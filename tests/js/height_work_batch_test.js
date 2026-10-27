const assert = require('assert')
const {runHeightWork, runHeightSlice} = require('../../sdk/js/terrain/height_work')
const {NativePayloadBudget} = require('../../sdk/js/resources/native_payload_budget')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')

async function verifyBatch(occupied, count, expectedCalls) {
  const ledger = new ResourceLedger(1000), pressure = ledger.reserve('display', occupied)
  const budget = new NativePayloadBudget(ledger, 'height', 0)
  const grants = []
  let made = 0, discarded = false
  try {
    const result = await runHeightWork(bytes => {
      if (bytes) {
        grants.push(bytes)
        made += Math.min(count - made, Math.floor(bytes / 40))
        budget.observe(made * 40)
      }
      return made === count ? {complete:true} : {heightPending:true,heightWorkBytes:40}
    }, budget, () => {discarded = true})
    assert(result.complete && !discarded)
    assert.strictEqual(grants.length, expectedCalls, 'Height work still requires one grant per allocation')
    assert.strictEqual(ledger.bytes, occupied + count * 40, 'Unused batch credit survived its receipt')
    assert(ledger.highWaterBytes <= ledger.maximumBytes)
  } finally {budget.close();pressure.release()}
  assert.strictEqual(ledger.bytes,0)
}

async function main() {
  await verifyBatch(0,8,1)
  // The batch is optional: a minimum allocation must still run when the
  // displayed surface leaves no room for speculative reservation.
  await verifyBatch(920,2,2)
  let resident = 0, clock = 0, calls = 0
  const credits = []
  const pending = runHeightSlice(100, credit => {
    credits.push(credit); resident += 30; ++calls
    return {heightPending:true,heightWorkBytes:40}
  },()=>resident,()=>clock)
  assert.deepStrictEqual(credits,[100,70,40], 'Batch did not deduct earlier retained outputs')
  assert(pending.heightPending && resident===90)
  calls=0
  runHeightSlice(100,()=>{++calls;clock+=3;return {heightPending:true,heightWorkBytes:0}},()=>0,()=>clock)
  assert.strictEqual(calls,2,'Height batch ignored its cooperative time boundary')
  calls=0
  runHeightSlice(0,()=>{++calls;return {heightPending:true,heightWorkBytes:0}},()=>0,()=>0)
  assert.strictEqual(calls,8,'No-allocation scanning monopolized the producer')
  resident=0
  assert.throws(()=>runHeightSlice(10,()=>{resident=11;return {}},()=>resident,()=>0),/exceeded its grant/)
  console.log('Height continuation batching uses available room and returns unused credit')
}
main().catch(error=>{console.error(error);process.exitCode=1})
