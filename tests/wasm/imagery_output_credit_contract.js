const assert = require('assert')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')

module.exports = async function (module, manifest) {
  const abi = new TerraAbi(module), ledger = new ResourceLedger(32 * 1024 * 1024)
  const call = module.call, ranges = []
  try {
    abi.loadManifest(manifest); abi.setResourceLedger(ledger)
    const owner = abi.getImageryPlanner()
    const draw = new ImageryAdapter(manifest.texture).prepareDraw({textureNode:{level:0,root:0,row:0,column:0}})
    const uv = {minimumU:0,minimumV:0,maximumU:1,maximumV:1}
    const measure = pixels => ({visible:true,bounds:uv,pixelsPerUv:pixels,
      regions:[{uv,pixelsPerUv:pixels}], hull:[[0,0],[1,0],[1,1],[0,1]]})
    const options = {descriptor:manifest.texture,detached:true,maximumTextures:4096,maximumDraws:8192}
    const shown = owner.plan([draw], () => measure(64), options), held = JSON.stringify(shown)
    const before = abi.imageryOutputPayloadBytes()
    assert(before > 0 && before === abi.imageryOutputBudget.actual)
    const begin = abi.beginImageryOutput
    let refused = false
    abi.beginImageryOutput = function(bytes) {
      if (!refused && module.call('terra_imagery_output_work_bytes', this.context, owner.id)) {
        refused = true
        ledger.setLimit(ledger.bytes + bytes - 1)
      }
      return begin.call(this, bytes)
    }
    assert.throws(() => owner.plan([draw], () => measure(16384), options), error => error.status === 9)
    assert(refused && module.call('terra_imagery_output_work_bytes', abi.context, owner.id) > 0)
    assert.strictEqual(abi.imageryOutputPayloadBytes(), before, 'Refused output allocated a snapshot')
    assert.strictEqual(abi.imageryOutputBudget.credits.size, 0)
    assert.strictEqual(JSON.stringify(shown), held)
    await ledger.reclamation.pending
    ledger.setLimit(32 * 1024 * 1024)
    abi.beginImageryOutput = begin
    module.call = function(name, ...args) {
      if (name === 'terra_get_imagery_draws') {
        assert(args[4] > 0 && args[4] <= 256)
        assert(abi.imageryOutputPackingBytes <= 8 + 256 * 32)
        assert(abi.imageryOutputBudget.actual <= abi.imageryOutputBudget.stats().creditedBytes)
        ranges.push([args[2], args[4]])
        this.exports.memory.grow(1)
      }
      return call.call(this, name, ...args)
    }
    abi.copyVector = () => {throw new Error('Imagery output allocated a complete ABI buffer')}
    const result = owner.plan([draw], () => measure(16384), {...options,continuation:true})
    assert(result.draws.length > 256 && ranges.length > 1)
    assert.strictEqual(ranges.reduce((sum, row) => sum + row[1], 0), result.draws.length)
    assert.strictEqual(abi.imageryOutputPackingBytes, 0)
    assert.strictEqual(abi.imageryOutputBudget.credits.size, 0)
    assert.strictEqual(abi.imageryOutputBudget.actual, abi.imageryOutputPayloadBytes())
    const reads = ranges.length
    assert.deepStrictEqual(owner.readPlan([draw], options), result)
    assert.strictEqual(ranges.length, reads, 'Unchanged output repeated range conversion')
    assert.strictEqual(JSON.stringify(shown), held, 'Resumed publication mutated retained output')
    owner.output = null
    const readback = owner.readPlanSteps([draw], {...options,incremental:true})
    assert(!readback.next().done && abi.imageryOutputPackingBytes > 0)
    const scratch = abi.imageryOutputPackingBytes, owned = ledger.bytes
    const snapshotBytes = abi.imageryOutputPayloadBytes() - scratch
    readback.return()
    assert.strictEqual(abi.imageryOutputPackingBytes, 0)
    assert.strictEqual(ledger.bytes, owned - scratch, 'Cancelled readback refunded a live snapshot')
    assert.strictEqual(abi.imageryOutputPayloadBytes(), snapshotBytes)
    assert.deepStrictEqual(owner.readPlan([draw], options), result, 'Cancelled decoding changed native output')
    abi.resetImagery()
    assert.strictEqual(abi.imageryOutputPayloadBytes(), 0)
    console.log(`Real Wasm output credit: ${result.draws.length} draws in ${reads} bounded ranges; refusal, resume and release passed`)
  } finally { module.call = call; abi.destroy() }
  assert.strictEqual(ledger.bytes, 0)
}
