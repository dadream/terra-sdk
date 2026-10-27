const assert = require('assert')
const {run} = require('./imagery_pipeline/benchmark')

async function verify() {
  const threeRequests = await run({requests: 3, inputEnvelopes: 2})
  const oldWindow = await run({inputEnvelopes: 2})
  assert.strictEqual(threeRequests.virtualCompletionMs, oldWindow.virtualCompletionMs,
    'The controlled comparison no longer isolates the local input-window bottleneck')
  const current = await run()
  assert(current.virtualCompletionMs < oldWindow.virtualCompletionMs,
    'Configured requests still serialized behind a fixed pair of input envelopes')
  assert(current.metrics.inputWaitMs < oldWindow.metrics.inputWaitMs)
  assert.strictEqual(current.metrics.peakBodies, current.config.requests,
    'Affordable input stages could not use configured network concurrency')
  const slowUpload = await run({tiles: 64, receiptMs: 160})
  assert(slowUpload.metrics.peakBitmaps * 256 * 256 * 4 <= slowUpload.maximumPipelineBytes,
    'Slow GPU receipts allowed unbounded decoded pixels')
  assert(slowUpload.managedHighWaterBytes <= slowUpload.config.sharedBytes)
  console.log('Controlled 384-image pipeline throughput, slow GPU receipts and teardown passed')
}
module.exports = verify
if (require.main === module) verify().catch(error => {console.error(error); process.exitCode = 1})
