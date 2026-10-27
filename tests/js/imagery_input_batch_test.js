const assert=require('assert')
const {ImageryInputBatch}=require('../../sdk/js/resources/imagery_input_batch')
const {ImageryInputWorkspace}=require('../../sdk/js/resources/imagery_input_workspace')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {NativePayloadBudget}=require('../../sdk/js/resources/native_payload_budget')
const {finishImageryGrant}=require('../../adapters/wasm/imagery_grants')

module.exports=function() {
  // A CPU checkpoint is not an allocation receipt. Keep the funded window
  // through streamed turns, including intervening control messages. Return
  // unused permission before a terminal result or another kind of quote.
  for(const boundary of ['complete','quote','candidate','cancel','failure','nonstream']) {
    const ledger=new ResourceLedger(1024),budget=new NativePayloadBudget(ledger,'streamed-measurement',100)
    const owner={measurementInputWorkspace:null},batch=owner.measurementBatch=new ImageryInputBatch(()=>
      owner.measurementInputWorkspace=new ImageryInputWorkspace(31),128)
    owner.finishMeasurementGrant=()=>batch.finishGranted()
    owner.inputReceipted=id=>!owner.measurementInputWorkspace||
      owner.measurementInputWorkspace.id!==id||owner.measurementInputWorkspace.finished
    const first=batch.stage();assert.strictEqual(first.reserve(16),null)
    const credit=budget.beginPreferred(16,128),grant={id:31,bytes:credit.bytes}
    owner.measurementInputWorkspace.grant(grant)
    const message={type:'imagery',stream:true,inputGrant:grant}
    try {
      for(let turn=0;turn<3;++turn) {
        const work=turn?batch.stage():first,allocation=work.reserve(16)
        assert(allocation);budget.observe(100+(turn+1)*16);allocation.release()
        assert.strictEqual(finishImageryGrant(owner,message,{pending:true}),false,
          'A CPU checkpoint ended the funded measurement stream')
        finishImageryGrant(owner,{type:'call',method:'submitRecord'},{submitted:true})
        assert.strictEqual(finishImageryGrant(owner,{...message,inputGrant:{id:30,bytes:128}},
          {superseded:true}),true)
        assert.strictEqual(batch.stats().heldGrantBytes,128,
          'A control or obsolete reply revoked another stream’s permission')
        assert.strictEqual(ledger.bytes,228,'A pending stream refunded unconsumed credit')
      }
      const value=boundary==='complete'?{pending:false}:boundary==='quote'?{pending:true,outputWork:{id:32,bytes:8}}:
        boundary==='candidate'?{candidateReady:true,continuation:true}:boundary==='failure'?undefined:{pending:true}
      if(boundary==='cancel'){message.cancelled=true;owner.measurementInputWorkspace=null}
      if(boundary==='nonstream')message.stream=false
      assert.strictEqual(finishImageryGrant(owner,message,value),true,'A terminal boundary retained permission')
      assert.strictEqual(batch.stats().heldGrantBytes,0)
      assert.strictEqual(ledger.bytes,228,'Permission closure refunded before the actual receipt')
      budget.finish(credit)
      assert.strictEqual(ledger.bytes,148,'Receipt lost the produced native payload')
    }finally{batch.close();budget.close()}
    assert.strictEqual(ledger.bytes,0)
  }

  // Recorded Native projection phases on the canonical oblique route: the
  // common 101888-byte allocation already exceeds the old 64KiB preference.
  // Two meshes' payload and metadata should share an available call grant,
  // instead of adding a host/Worker round trip at each small phase boundary.
  let ordinaryPool,serial=0,grants=0
  const ordinary=new ImageryInputBatch(()=>ordinaryPool=new ImageryInputWorkspace(++serial))
  const phases=[101888,10968,4160,101888,10968,4160]
  for(const bytes of phases) {
    const stage=ordinary.stage()
    let credit=stage.reserve(bytes)
    if(!credit) {
      const quote=ordinaryPool.quote();++grants
      assert(ordinaryPool.grant({id:quote.id,bytes:quote.preferredBytes}))
      credit=stage.reserve(bytes)
    }
    assert(credit);credit.release()
  }
  assert.strictEqual(grants,1,'Ordinary Native measurement phases repeated host grants')
  assert.strictEqual(ordinary.stats().spentGrantBytes,phases.reduce((sum,n)=>sum+n,0))
  ordinary.finishGranted()
  assert.strictEqual(ordinary.stats().heldGrantBytes,0,'A completed call retained optional credit')

  let id=0
  const pools=[],batch=new ImageryInputBatch(()=>{
    const pool=new ImageryInputWorkspace(++id);pools.push(pool);return pool
  },64)
  const a=batch.stage();assert.strictEqual(a.reserve(10),null)
  assert.deepStrictEqual(pools[0].quote(),{id:1,bytes:10,preferredBytes:64})
  assert.throws(()=>pools[0].grant({id:1,bytes:9}),/Invalid/)
  assert(pools[0].grant({id:1,bytes:64}))
  const first=a.reserve(10);assert(first)
  assert.throws(()=>batch.finishGranted(),/live imagery allocation/)
  first.release();first.release()
  const b=batch.stage(),second=b.reserve(20);assert(second)
  assert.strictEqual(pools.length,1,'Small phases repeated grants')
  assert.throws(()=>b.reserve(1),/Invalid/);second.release()
  assert.strictEqual(batch.stats().spentGrantBytes,30)
  batch.finishGranted();assert(pools[0].finished)
  assert.strictEqual(batch.stats().unusedBytes,34)
  const c=batch.stage();assert.strictEqual(c.reserve(35),null)
  assert.strictEqual(pools[1].id,2)
  assert(!pools[0].grant({id:1,bytes:64}),'Old grant acquired new permission')
  assert(pools[1].grant({id:2,bytes:35}))
  c.reserve(35).release()
  const d=batch.stage();assert.strictEqual(d.reserve(1),null)
  assert(pools[1].finished&&pools[2].quote().bytes===1,'Overspend did not quote another grant')
  d.finished=true;assert(pools[2].finished)

  // Two resumable producers can park at different phases. Replacing an
  // unfunded quote does not strand the older ticket or grant the wrong bytes.
  const old=batch.stage(),fresh=batch.stage()
  assert.strictEqual(old.reserve(7),null);const oldPool=pools[pools.length-1]
  assert.strictEqual(fresh.reserve(11),null);const current=pools[pools.length-1]
  assert(oldPool.finished&&!oldPool.grant({id:oldPool.id,bytes:64}))
  assert(current.grant({id:current.id,bytes:64}))
  old.reserve(7).release();fresh.reserve(11).release()
  batch.finishGranted();assert.strictEqual(batch.stats().activeAllocations,0)
  const cancelled=batch.stage();cancelled.reserve(9);const pending=pools[pools.length-1]
  pending.grant({id:pending.id,bytes:64});cancelled.finished=true
  assert(pending.finished&&batch.stats().heldGrantBytes===0)

  // Preferred capacity is optional: exact existing room still admits the
  // minimum, and closing permission alone never refunds live native payload.
  const ledger=new ResourceLedger(100),budget=new NativePayloadBudget(ledger,'native-input',40)
  let workspace
  const exact=new ImageryInputBatch(()=>workspace=new ImageryInputWorkspace(99),64),ticket=exact.stage()
  ticket.reserve(32)
  const credit=budget.beginPreferred(32,64);assert(credit&&credit.bytes===32)
  workspace.grant({id:99,bytes:32});ticket.reserve(32).release();budget.observe(72)
  exact.finishGranted();assert.strictEqual(ledger.bytes,72)
  budget.finish(credit);assert.strictEqual(ledger.bytes,72)
  budget.close();assert.strictEqual(ledger.bytes,0)
  console.log('Imagery input batch: exact permission, bounded reuse, shortage, crossing tickets, stale grants and receipt-owned refund passed')
}
if(require.main===module)module.exports()
