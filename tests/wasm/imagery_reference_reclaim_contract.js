const assert = require('assert')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')

module.exports = async function (module, manifest) {
  const abi = new TerraAbi(module), ledger = new ResourceLedger(16 * 1024 * 1024)
  try {
    abi.loadManifest(manifest); abi.setResourceLedger(ledger)
    const draw = new ImageryAdapter(manifest.texture).prepareDraw({textureNode:{level:0,root:0,row:0,column:0}})
    const uv = {minimumU:0,minimumV:0,maximumU:1,maximumV:1}
    const measured = {visible:true,bounds:uv,pixelsPerUv:2048,
      regions:Array.from({length:1024}, () => ({uv,pixelsPerUv:2048})), hull:[[0,0],[1,0],[1,1],[0,1]]}
    const options = {descriptor:manifest.texture,detached:true,maximumTextures:64,maximumDraws:512}
    const planner = abi.getImageryPlanner(), shown = planner.plan([draw], () => measured, options)
    const resident = abi.imageryReferencePayloadBytes(), input = abi.imageryInputPayloadBytes()
    assert(resident > 8192)
    ledger.setLimit(ledger.bytes)
    const request = 8192
    await abi.imageryInputBudget.tryRun(request, bytes => {
      assert(bytes >= request && ledger.bytes <= ledger.maximumBytes)
      assert(abi.imageryReferencePayloadBytes() <= resident - request,
        'Input capacity was recovered without destroying reference storage')
      assert.strictEqual(abi.imageryReferenceBudget.actual,abi.imageryReferencePayloadBytes())
    })
    assert.deepStrictEqual(planner.readPlan([draw],options),shown,'Cache pressure changed the displayed plan')
    assert.strictEqual(abi.imageryInputPayloadBytes(),input,'Index reclamation discarded measurement input')
    assert(abi.imageryReferenceReclamation.bytes >= request)
    const slicesBefore = abi.imageryReferenceReclamation.slices
    let smallReleases = 0
    for (let i = 0; i < 48; ++i) smallReleases += await abi.reclaimImageryReferences(1)
    const smallSlices = abi.imageryReferenceReclamation.slices - slicesBefore
    assert(smallReleases > 0, 'Fixture had no remaining optional references')
    assert(smallSlices <= 50, `Small requests rescanned an empty prefix: ${smallSlices} slices`)
    assert.deepStrictEqual(planner.readPlan([draw],options),shown,'Incremental trimming changed the displayed plan')
    const remaining = abi.imageryReferencePayloadBytes()
    const released = await abi.reclaimImageryReferences(remaining)
    assert(released > 0 && released <= remaining)
    assert.strictEqual(abi.imageryReferencePayloadBytes(),remaining - released)
    assert.strictEqual(abi.imageryReferenceBudget.actual,remaining - released)
    assert.deepStrictEqual(planner.readPlan([draw],options),shown)
    const before = ledger.reclamation.stats().attempts
    const pressure = ledger.reserve('other-work', ledger.maximumBytes - ledger.bytes)
    assert(pressure)
    assert.strictEqual(ledger.reserve('refused',1),null)
    await ledger.reclamation.pending
    const exhausted = ledger.reclamation.stats().attempts
    assert.strictEqual(ledger.reserve('refused',1),null)
    await ledger.reclamation.pending
    assert.strictEqual(ledger.reclamation.stats().attempts,exhausted,'Unchanged no-op reclamation polled again')
    assert(exhausted >= before)
    pressure.release()
    console.log(`Real Wasm imagery cache reclamation: ${resident} index bytes, funded input recovery and unchanged cut passed`)
  } finally { abi.destroy() }
  assert.strictEqual(ledger.bytes,0)
}
