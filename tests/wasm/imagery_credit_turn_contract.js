const assert = require('assert')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ImageryInputWorkspace} = require('../../sdk/js/resources/imagery_input_workspace')

module.exports = function verifyImageryCreditTurns(module, manifest) {
  const abi = new TerraAbi(module), ledger = new ResourceLedger(16 * 1024 * 1024)
  const workspaces = [], credits = new Map(), counts = {input:0, reference:0, output:0}
  let task
  const workspace = kind => {
    const value = new ImageryInputWorkspace(workspaces.length + 1), reserve = value.reserve
    value.kind = kind; value.polls = 0
    value.reserve = function(bytes) {
      if (!this.granted) ++this.polls
      return reserve.call(this, bytes)
    }
    workspaces.push(value)
    return value
  }
  try {
    abi.loadManifest(manifest); abi.setResourceLedger(ledger)
    const draw = new ImageryAdapter(manifest.texture).prepareDraw({textureNode:{level:0,root:0,row:0,column:0}})
    const uv = {minimumU:0,minimumV:0,maximumU:1,maximumV:1}
    task = abi.getImageryPlanner().createTask([draw], () => ({visible:true, bounds:uv,
      pixelsPerUv:2048, regions:[{uv, pixelsPerUv:2048}], hull:[[0,0],[1,0],[1,1],[0,1]]}),
    {descriptor:manifest.texture, detached:true, maximumTextures:256, maximumDraws:1024,
      inputWorkspace:workspace('input'), referenceWorkspace:() => workspace('reference'),
      outputWorkspace:() => workspace('output')})
    let next
    for (let round=0; ; ++round) {
      assert(round < 4096, 'Funded native planning did not converge')
      next = task.step()
      for (const [owner, credit] of credits) if (owner.finished) {credit.release(); credits.delete(owner)}
      const pending = workspaces.filter(value => value.quote())
      assert(pending.length <= 1, 'One cursor requested concurrent allocation grants')
      if (pending.length) {
        assert(next.waiting, 'A native grant dependency was treated as ordinary CPU work')
        const owner = pending[0], quote = owner.quote()
        assert.strictEqual(owner.polls, 1, 'Native input/index/output quote was polled again before its RPC')
        const acquire = {input:'beginImageryInput', reference:'beginImageryReferences', output:'beginImageryOutput'}[owner.kind]
        credits.set(owner, abi[acquire](quote.bytes))
        owner.grant(quote); ++counts[owner.kind]
      }
      if (next.done) break
    }
    assert(next.value.quality.planningComplete && next.value.quality.meetsTarget)
    assert(counts.input === 1 && counts.reference > 0 && counts.output >= 2)
    assert.strictEqual(credits.size, 0)
    for (const name of ['imageryInputBudget','imageryReferenceBudget','imageryOutputBudget'])
      assert.strictEqual(abi[name].credits.size, 0, 'Completed native planning retained an RPC grant')
    console.log('Real Wasm immediate grant boundaries:', JSON.stringify(counts))
  } finally {
    if (task) task.cancel()
    credits.forEach(credit => credit.release())
    abi.destroy()
  }
  assert.strictEqual(ledger.bytes, 0)
}
