const assert = require('assert')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')
const {ImageryInputWorkspace} = require('../../sdk/js/resources/imagery_input_workspace')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')

module.exports = function (module, manifest) {
  function run(minimum) {
    const abi = new TerraAbi(module), ledger = new ResourceLedger(32 * 1024 * 1024)
    const workspaces = [], credits = new Map(), counts = {reference:0, output:0, steps:0}
    let task, plan
    const workspace = kind => {
      const value = new ImageryInputWorkspace(workspaces.length + 1)
      value.kind = kind; workspaces.push(value)
      return value
    }
    try {
      abi.loadManifest(manifest); abi.setResourceLedger(ledger)
      const draw = new ImageryAdapter(manifest.texture).prepareDraw({textureNode:{level:0,root:0,row:0,column:0}})
      const uv = {minimumU:0,minimumV:0,maximumU:1,maximumV:1}
      const measured = {visible:true,bounds:uv,pixelsPerUv:2048,
        regions:Array.from({length:4096}, () => ({uv,pixelsPerUv:2048})), hull:[[0,0],[1,0],[1,1],[0,1]]}
      const options = {descriptor:manifest.texture,detached:true,maximumTextures:256,maximumDraws:1024,
        maximumRounds:1,referenceWorkspace:() => workspace('reference'),outputWorkspace:() => workspace('output')}
      do {
        task = abi.createImageryTask([draw], () => measured,
          {...options,continuation:Boolean(plan),inputWorkspace:workspace('input')})
        let next
        do {
          assert(++counts.steps < 10000, 'Funded reference batches failed to converge')
          next = task.step()
          for (const [owner, credit] of credits) if (owner.finished) {credit.release(); credits.delete(owner)}
          for (const owner of workspaces.filter(value => value.quote())) {
            assert.strictEqual(credits.size, 0, 'New allocation quote preceded the previous grant receipt')
            const quote = owner.quote()
            let credit
            if (minimum && owner.kind === 'reference') {
              const budget = abi.imageryReferenceBudget, lease = budget.begin(quote.bytes)
              assert(lease)
              credit = {bytes:lease.bytes,release() {abi.observeImageryInput();budget.finish(lease)}}
            } else credit = abi[{input:'beginImageryInput',reference:'beginImageryReferences',
              output:'beginImageryOutput'}[owner.kind]](quote.bytes)
            credits.set(owner, credit)
            owner.grant({...quote,bytes:credit.bytes || quote.bytes})
            if (owner.kind !== 'input') ++counts[owner.kind]
          }
        } while (!next.done)
        plan = next.value
      } while (!plan.quality.planningComplete)
      assert(plan.quality.meetsTarget && !credits.size)
      assert.strictEqual(abi.imageryReferencePayloadBytes(), abi.imageryReferenceBudget.actual)
      assert(ledger.highWaterBytes <= ledger.maximumBytes)
    } finally {
      if (task) task.cancel()
      credits.forEach(credit => credit.release())
      abi.destroy()
    }
    assert.strictEqual(ledger.bytes, 0)
    return {plan, counts}
  }
  const minimum = run(true), batch = run(false)
  assert.deepStrictEqual(batch.plan, minimum.plan, 'Batching changed the converged imagery cut or error')
  assert(batch.counts.reference < minimum.counts.reference, 'Available reference credit was not reused')
  console.log('Real Wasm reference batching, identical cuts:', JSON.stringify({minimum:minimum.counts,batch:batch.counts}))
}
