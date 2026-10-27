const {invariant} = require('../core/terra_globe_common')

const maximumBatchSteps = 8, maximumBatchBytes = 256 * 1024, maximumBatchMs = 4

// One funded RPC may execute several existing single-build native slices.
// Charge retained growth against the same grant; every native call still
// admits its own peak before allocating. Yield on time, count or byte limits.
function runHeightSlice(bytes, step, payloadBytes, now = Date.now) {
  const initial = payloadBytes(), started = now()
  let result
  for (let count = 0; count < maximumBatchSteps; ++count) {
    const remaining = bytes - Math.max(0, payloadBytes() - initial)
    invariant(remaining >= 0, 'Height batch exceeded its grant')
    result = step(remaining)
    const available = bytes - Math.max(0, payloadBytes() - initial)
    invariant(available >= 0, 'Height batch exceeded its grant')
    if (!result || !result.heightPending || result.heightWorkBytes > available ||
        now() - started >= maximumBatchMs) break
  }
  return result
}

// A zero-credit step selects/discovers work. Each subsequent slice is funded
// separately; its actual receipt settles the grant before the next admission.
async function runHeightWork(step, budget, discard, yieldWork) {
  let result, complete = false, failure
  try {
    result = await step(0)
    while (result && result.heightPending) {
      const bytes = result.heightWorkBytes
      invariant(Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 0xffffffff,
        'Invalid native height production quote')
      if (yieldWork) await yieldWork()
      result = bytes ? await budget.tryRun(bytes, step,
        Math.max(bytes, Math.min(maximumBatchBytes, bytes * maximumBatchSteps))) : await step(0)
    }
    complete = true
    return result
  } catch (error) {
    failure = error
    if (error.status === 9 && result) error.requests = result.requests || error.requests
    throw error
  } finally {
    if (!complete) await discard()
    if (failure && failure.status === 9) failure.capacityRevision = budget.ledger.availabilityRevision
  }
}

module.exports = {runHeightWork, runHeightSlice}
