const assert=require('assert')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')

module.exports=async()=>{
  const ledger=new ResourceLedger(100)
  const hot=ledger.reserve('projection-cache',60),cold=ledger.reserve('old-mesh-cache',40)
  let revision=0,hotCalls=0,coldCalls=0
  const unregisterHot=ledger.reclamation.register({owner:hot.owner,revision:()=>revision,
    reclaim:async needed=>{++hotCalls;const n=Math.min(needed,hot.bytes);hot.resize(hot.bytes-n);return n}})
  const unregisterCold=ledger.reclamation.register({owner:cold.owner,revision:()=>0,
    reclaim:async needed=>{++coldCalls;const n=Math.min(needed,cold.bytes);cold.resize(cold.bytes-n);return n}})
  let output
  try {
    // The same small destination is produced twice. A recently used derived
    // cache can refill between requests; the old cache must still get a turn.
    assert.strictEqual(ledger.reserve('output',10),null)
    await ledger.reclamation.pending
    output=ledger.reserve('output',10);assert(output);output.release();output=null
    assert(hot.resize(60));++revision
    assert.strictEqual(ledger.reserve('output',10),null)
    await ledger.reclamation.pending
    output=ledger.reserve('output',10);assert(output)
    assert.strictEqual(coldCalls,1,'Repeated small pressure starved the old mesh cache')
    assert.strictEqual(hotCalls,1,'The same projection cache was rebuilt and reclaimed before other owners ran')
    assert.strictEqual(hot.bytes,60)
    assert.strictEqual(cold.bytes,30)
    assert.strictEqual(ledger.highWaterBytes,100)
  } finally {
    if(output)output.release()
    unregisterHot();unregisterCold();hot.release();cold.release()
    assert.strictEqual(ledger.bytes,0)
  }

  // Owner destruction can race with an awaited receipt. A saved scan order
  // must not call the deleted provider or resurrect it for the next request.
  let complete,deletedCalls=0
  const first=ledger.reclamation.register({revision:()=>0,
    reclaim:()=>new Promise(resolve=>{complete=resolve})})
  const deleted=ledger.reclamation.register({revision:()=>0,
    reclaim:async()=>{++deletedCalls;return 0}})
  try {
    const pending=ledger.reclamation.request(10)
    await Promise.resolve();deleted();complete(0);await pending
    await ledger.reclamation.request(10)
    assert.strictEqual(deletedCalls,0)
    assert.strictEqual(ledger.reclamation.owners.size,1)
  } finally {first();deleted()}
  console.log('Small pressure rotates across owners; pending receipts respect provider destruction')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
