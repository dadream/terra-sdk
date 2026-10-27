const assert = require('assert')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')

module.exports = async function (module, manifest) {
  const abi = new TerraAbi(module), ledger = new ResourceLedger(32 * 1024 * 1024)
  let task
  try {
    abi.loadManifest(manifest)
    abi.setResourceLedger(ledger)
    const draw = new ImageryAdapter(manifest.texture).prepareDraw({textureNode:{level:0,root:0,row:0,column:0}})
    const uv = {minimumU:0,minimumV:0,maximumU:1,maximumV:1}
    const measurement = {visible:true, pixelsPerUv:64, bounds:uv,
      regions:Array.from({length:8192}, () => ({uv,pixelsPerUv:64})), hull:[[0,0],[1,0],[0,1]]}
    const options = {descriptor:manifest.texture, detached:true, maximumTextures:64, maximumDraws:512, maximumRounds:1}
    const initial = ledger.bytes
    task = abi.createImageryTask([draw], () => measurement, options)
    task.maximumSteps = 1
    assert(!task.step().done)
    assert(abi.imageryPackingBytes > 0 && abi.imageryInputBudget.credits.size === 1)
    assert(abi.imageryPackingBytes < 64 * 1024, 'Packing duplicated the entire input')
    assert(abi.imageryInputPayloadBytes() > 8192 * 176, 'No native input was staged before yielding')
    assert(ledger.bytes > initial + abi.imageryPackingBytes, 'Packing started without conversion credit')
    task.cancel()
    assert.strictEqual(ledger.bytes,initial)
    assert.strictEqual(abi.imageryInputBudget.credits.size,0)
    const complete = abi.planImagery([draw], () => measurement, options)
    const resident = abi.imageryInputPayloadBytes()
    assert(resident > 8192 * 176)
    assert.strictEqual(ledger.bytes,initial + resident + abi.imageryOutputPayloadBytes())
    // The old cut and one replacement fit; a second full packed copy does not.
    ledger.setLimit(initial + 2 * resident + 64 * 1024)
    task = abi.createImageryTask([draw], () => measurement, {...options,resetHistory:true})
    task.maximumSteps = 1
    assert(!task.step().done)
    assert.deepStrictEqual(abi.getImageryPlanner().readPlan([draw],options),complete,
      'Uncommitted conversion/reset changed the displayed cut')
    task.cancel()
    assert.strictEqual(ledger.bytes,initial + resident + abi.imageryOutputPayloadBytes())
    const replacement = abi.planImagery([draw], () => measurement, options)
    assert.deepStrictEqual(replacement.draws,complete.draws)
    assert.strictEqual(ledger.bytes,initial + resident + abi.imageryOutputPayloadBytes())
    ledger.setLimit(ledger.bytes)
    task = abi.createImageryTask([draw], () => measurement, options)
    assert.throws(() => task.step(), e => e.status === 9)
    assert.strictEqual(abi.imageryPackingBytes,0)
    assert.strictEqual(abi.imageryInputPayloadBytes(),resident)
    assert.deepStrictEqual(abi.getImageryPlanner().readPlan([draw],options),replacement,
      'A refused input replaced the previous native cut')
    await ledger.reclamation.pending
    abi.resetImagery()
    assert.strictEqual(abi.imageryInputPayloadBytes(),0)
    assert.strictEqual(abi.imageryInputBudget.actual,0)
  } finally {
    if (task) task.cancel()
    abi.destroy()
  }
  assert.strictEqual(ledger.bytes,0)
  console.log('Real Wasm input credits: preallocation refusal, packing cancellation, retained output and release passed')
}
