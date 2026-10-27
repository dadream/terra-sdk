const assert = require('assert')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')

module.exports = function verifyInputIdentity(module, manifest) {
  const abi = new TerraAbi(module), ledger = new ResourceLedger(32 * 1024 * 1024)
  const call = module.call
  const operations = []
  let task
  module.call = function(name, ...args) {
    if (['terra_stage_imagery_input', 'terra_append_imagery_surface',
      'terra_append_retained_imagery_surface', 'terra_append_imagery_regions'].includes(name))
      operations.push({name, args})
    return call.call(this, name, ...args)
  }
  try {
    abi.loadManifest(manifest); abi.setResourceLedger(ledger)
    const adapter = new ImageryAdapter(manifest.texture)
    const draw = root => adapter.prepareDraw({resourceId: root + 1, key: {i: root},
      textureNode: {level: 0, root, row: 0, column: root}})
    const [a, b, added] = [0, 1, 2].map(draw)
    const uv = {minimumU:0, minimumV:0, maximumU:1, maximumV:1}
    const measure = (count, pixels = 64) => ({visible:true, bounds:uv, pixelsPerUv:pixels,
      regions:Array.from({length:count}, () => ({uv, pixelsPerUv:pixels}))})
    const ma = measure(4096), mb = measure(4096), mc = measure(1)
    const measurements = new Map([[a, ma], [b, mb], [added, mc]])
    const options = {descriptor:manifest.texture, maximumTextures:64, maximumDraws:512,
      detached:true, maximumRounds:1}
    const plan = draws => abi.planImagery(draws, d => measurements.get(d), options)
    const count = name => operations.filter(op => op.name === name).length
    const signature = cut => cut.draws.map(d => [d.resourceId, d.textureNode.root,
      d.textureNode.level, d.imageryPixelError])
    const old = plan([a, b]), resident = abi.imageryInputPayloadBytes()
    const stableOld = signature(old)
    assert(resident > 8192 * 176)
    // Only the new row and member table fit beside the old input. A full
    // converted copy of the successor would require over another MiB.
    ledger.setLimit(ledger.bytes + 64 * 1024)
    operations.length = 0
    const successor = plan([b, added, a])
    assert.strictEqual(count('terra_append_retained_imagery_surface'), 2)
    assert.strictEqual(count('terra_append_imagery_surface'), 1)
    assert.strictEqual(count('terra_append_imagery_regions'), 1)
    const quote = operations.find(op => op.name === 'terra_stage_imagery_input').args
    assert.deepStrictEqual(quote.slice(3, 7), [3, 1, 1, 0])
    assert.deepStrictEqual(signature(old), stableOld, 'Rebinding changed an old result')
    assert.deepStrictEqual(successor.draws.map(d => d.resourceId), [1, 2, 3],
      'Reordered input used previous draw positions')
    assert(abi.imageryInputPayloadBytes() < resident + 2048)
    ledger.setLimit(32 * 1024 * 1024)

    // Cancel after a retained row and one batch of a new dense row. Staging
    // must not replace the native cut or refund its retained numeric payload.
    const before = ledger.bytes, beforeInput = abi.imageryInputPayloadBytes()
    measurements.set(added, measure(4096))
    operations.length = 0
    task = abi.createImageryTask([a, added], d => measurements.get(d), options)
    task.maximumSteps = 1
    assert(!task.step().done)
    assert.strictEqual(count('terra_append_retained_imagery_surface'), 1)
    assert(abi.imageryInputPayloadBytes() > beforeInput)
    task.cancel(); task = null
    assert.strictEqual(abi.imageryInputPayloadBytes(), beforeInput)
    assert.strictEqual(ledger.bytes, before)
    assert.deepStrictEqual(signature(abi.getImageryPlanner().readPlan([b, added, a], options)),
      signature(successor), 'Cancelled partial input replaced the native cut')

    // Changed measurements at an unchanged geometry ID are new inputs. Other
    // surfaces still retain their own data; changing only a global cut order
    // must not be confused with a measurement change.
    measurements.set(a, measure(4096, 128))
    operations.length = 0
    const changed = plan([a, b])
    assert.strictEqual(count('terra_append_retained_imagery_surface'), 1)
    assert.strictEqual(count('terra_append_imagery_surface'), 1)
    assert.notStrictEqual(changed.draws[0].imageryPixelError, old.draws[0].imageryPixelError)
    const fresh = abi.createImageryPlanner()
    try {
      const expected = fresh.plan([a, b], d => measurements.get(d), options)
      assert.deepStrictEqual(signature(changed), signature(expected), 'Retained input differs from fresh planning')
    } finally {fresh.destroy()}
    operations.length = 0
    abi.planImagery([a, b], d => measurements.get(d), {...options, resetHistory:true})
    assert.strictEqual(count('terra_append_retained_imagery_surface'), 0)
    abi.resetImagery()
    assert.strictEqual(abi.imageryInputPayloadBytes(), 0)
    assert.strictEqual(abi.imageryInputBudget.credits.size, 0)
  } finally {
    if (task) task.cancel()
    abi.destroy(); module.call = call
  }
  assert.strictEqual(ledger.bytes, 0)
  console.log('Wasm input identity: local edits, reorder, changed measurements, cancelled staging and exact release passed')
}
