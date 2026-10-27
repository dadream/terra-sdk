const assert = require('assert')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {NativePayloadBudget} = require('../../sdk/js/resources/native_payload_budget')

module.exports = async function (module, manifest) {
  const abi = new TerraAbi(module), ledger = new ResourceLedger(16 * 1024 * 1024)
  let task, candidate
  try {
    abi.loadManifest(manifest)
    const draw = new ImageryAdapter(manifest.texture).prepareDraw({textureNode:{level:0,root:0,row:0,column:0}})
    const uv = {minimumU:0,minimumV:0,maximumU:1,maximumV:1}
    const measured = {visible:true, bounds:uv, pixelsPerUv:1024,
      regions:Array.from({length:4096}, () => ({uv,pixelsPerUv:1024})), hull:[[0,0],[1,0],[1,1],[0,1]]}
    const options = {descriptor:manifest.texture,detached:true,maximumTextures:64,maximumDraws:512}
    const display = abi.getImageryPlanner(), shown = display.plan([draw], () => measured, options)
    const resident = abi.imageryReferencePayloadBytes()
    assert(resident > 0)
    // Isolate index ownership. Input conversion has its own independent contract.
    abi.imageryReferenceBudget = new NativePayloadBudget(ledger,'imagery-reference-native',resident)
    candidate = abi.createImageryPlanner()
    ledger.setLimit(resident)
    task = candidate.createTask([draw], () => measured, options)
    assert.throws(() => { while (!task.step().done) {} }, error => error.status === 9)
    assert.strictEqual(abi.imageryReferencePayloadBytes(), resident)
    assert.deepStrictEqual(display.readPlan([draw], options), shown)
    const pending = () => module.call('terra_imagery_reference_work_bytes', abi.context, candidate.id) >>> 0
    const first = pending()
    assert(first > 0 && first < 65536)
    ledger.setLimit(resident + first - 1)
    assert.throws(() => candidate.plan([draw], () => measured, {...options,continuation:true}), error => error.status === 9)
    assert.strictEqual(pending(), first)
    assert.strictEqual(ledger.bytes, resident)
    ledger.setLimit(resident + first)
    task = candidate.createTask([draw], () => measured, {...options,continuation:true})
    task.maximumSteps = 1
    assert(!task.step().done)
    assert(abi.imageryReferencePayloadBytes() > resident, 'Exact minimum grant did not advance')
    assert.strictEqual(ledger.bytes, abi.imageryReferencePayloadBytes())
    task.cancel()
    assert.strictEqual(ledger.bytes, abi.imageryReferencePayloadBytes(), 'Cancellation refunded live tree indices')
    assert.deepStrictEqual(display.readPlan([draw], options), shown)
    ledger.setLimit(16 * 1024 * 1024)
    const result = candidate.plan([draw], () => measured, {...options,continuation:true})
    assert.deepStrictEqual(result.draws, shown.draws)
    assert.deepStrictEqual(result.quality, shown.quality)
    // Coarse replacement must retire obsolete per-view references even when
    // the retained topology cache is below its node-pruning threshold.
    const coarse = {...measured,pixelsPerUv:64,regions:[{uv,pixelsPerUv:64}]}
    candidate.plan([draw], () => coarse, options)
    assert.strictEqual(abi.imageryReferencePayloadBytes(), resident)
    candidate.destroy(); candidate = null
    display.reset()
    assert.strictEqual(ledger.bytes, 0)
  } finally {
    if (task) task.cancel()
    if (candidate) candidate.destroy()
    abi.destroy()
  }
  assert.strictEqual(ledger.bytes, 0)
  console.log('Real Wasm reference credits: exact refusal, cursor recovery, minimum grants, cancellation and stale-index retirement passed')
}
