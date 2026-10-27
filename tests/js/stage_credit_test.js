const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {runCreditStage} = require('../../sdk/js/resources/stage_credit')

module.exports = async function verifyStageCredit() {
  for(const outcome of ['success','failure','cancel','cancel-failure']) {
    const ledger = new ResourceLedger(100)
    const credit = ledger.reserve('producer',100)
    let finish, stage
    const operation = runCreditStage(credit,'boundary',80, value => {
      stage=value
      return new Promise((resolve,reject)=>{finish=()=>outcome.includes('failure')
        ?reject(new Error('injected stage failure')):resolve(7)})
    })
    const checked = outcome.includes('failure') ? assert.rejects(operation,/injected stage failure/) : operation
    assert.strictEqual(credit.bytes,20)
    assert.strictEqual(ledger.bytes,100)
    assert.strictEqual(ledger.reserve('unrelated',1),null,'Active stage credit became spendable twice')
    if(outcome.startsWith('cancel')) {
      credit.release()
      assert.strictEqual(ledger.bytes,80,'Cancelled parent refunded unfinished stage work')
      assert(stage.active)
    }
    finish();await checked
    assert(!stage.active)
    if(outcome.startsWith('cancel')) {
      assert(!credit.active,'Stage completion resurrected the cancelled producer')
      assert.strictEqual(ledger.bytes,0)
    } else {
      assert.strictEqual(credit.bytes,100,'Stage receipt lost the next producer grant')
      assert.strictEqual(ledger.bytes,100)
      credit.release()
    }
    assert.strictEqual(ledger.bytes,0)
  }
  console.log('Sequential stage peak credit, failure refunds and cancellation receipts passed')
}

if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
