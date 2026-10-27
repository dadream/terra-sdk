const assert=require('assert')
const {LocalTerrainExecution}=require('../../adapters/wasm/local_terrain_execution')
const {LocalMeasurementDelivery}=require('../../adapters/wasm/measurement_delivery_local')
const {NativePayloadBudget}=require('../../sdk/js/resources/native_payload_budget')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {TerraAbi}=require('../../adapters/wasm/terra_abi')

// Exercise the actual Direct adapter's grant dispatcher and response pump.
// The fake native owner deliberately needs several host turns for one grant.
async function verifyLocalImageryGrants() {
  for(const kind of ['Input','References','Output']) {
    const ledger=new ResourceLedger(100),budget=new NativePayloadBudget(ledger,'fixture',40)
    const abi=Object.create(TerraAbi.prototype)
    abi['imagery'+(kind==='References'?'Reference':kind)+'Budget']=budget
    abi.observeImageryInput=()=>{}
    try {
      assert.throws(()=>abi['beginImagery'+kind](61),error=>error.status===9&&
        error.capacityShortfallBytes===1&&error.capacityRevision===ledger.availabilityRevision)
      assert.strictEqual(budget.credits.size,0)
      assert.strictEqual(ledger.bytes,40)
      const credit=abi['beginImagery'+kind](60)
      assert.strictEqual(ledger.bytes,100,'Exact capacity did not admit the minimum')
      credit.release();assert.strictEqual(ledger.bytes,40)
    }finally{budget.close()}
    assert.strictEqual(ledger.bytes,0)
  }
  for(const kind of ['input','reference','output'])for(const outcome of ['complete','cancel','suspend','refuse','failed']) {
    const ledger=new ResourceLedger(1000),budget=new NativePayloadBudget(ledger,'fixture-'+kind,100)
    const budgetName=kind==='input'?'imageryInputBudget':kind==='reference'?'imageryReferenceBudget':'imageryOutputBudget'
    const owner={[budgetName]:budget,observeImageryInput(){}}
    const work={id:1,finished:false},cursor={},prepared={cursor}
    let resume,reclaimReply,granted=0,turns=0,clearCount=0,calls=0,settled=false
    const pressure=ledger.reserve('competing-producer',outcome==='refuse'?600:850)
    assert(pressure)
    const stop=ledger.reclamation.register({revision:()=>0,reclaim:needed=>
      outcome==='refuse'?0:new Promise(resolve=>{reclaimReply=()=>{
        const bytes=Math.min(needed,pressure.bytes);pressure.resize(pressure.bytes-bytes);resolve(bytes)
      }})})
    const preparation={observeView(){},finishMeasurementGrant(){},inputReceipted:()=>work.finished,
      imageryReferenceWorkspace:kind==='reference'?work:null,imageryOutputWorkspace:kind==='output'?work:null,
      cancelImageryInputGrant(id){assert.strictEqual(id,1);work.finished=true},
      clearPlanning(){++clearCount;prepared.cursor=null;work.finished=true;budget.observe(100)},
      async prepareImagery(surface,message) {
        ++calls
        assert.strictEqual(surface,execution.frames.presented,'Direct stream kept the superseded published surface')
        assert.strictEqual(message.sequence,surface.frame.sequence,'Direct stream reported an obsolete sequence')
        if(!message[kind+'Grant'])return {pending:true,[kind+'Work']:{id:1,bytes:400}}
        assert.strictEqual(message[kind+'Grant'].bytes,400)
        assert.strictEqual(ledger.bytes,1000,'Native stage began without its complete grant')
        ++granted;budget.observe(380)
        if(granted<3)return {pending:true}
        if(outcome==='failed')throw new Error('Native stage failed')
        work.finished=true;return {pending:false}
      }}
    const execution=Object.assign(Object.create(LocalTerrainExecution.prototype),{
      abi:owner,frames:{ledger,presented:{frame:{sequence:1}},resources:new Map()},preparation,
      measurementDelivery:new LocalMeasurementDelivery(ledger),view:()=>({revision:1}),
      turn:{wait(){++turns;return new Promise(resolve=>{resume=resolve})}},cancelRevision:0,destroyed:false})
    const operation=execution.planImagery(1,{})
    operation.then(()=>{settled=true},()=>{settled=true})
    const flush=async()=>{for(let n=0;n<32;++n)await Promise.resolve()}
    try {
      await flush()
      if(outcome==='refuse') {
        await assert.rejects(operation,error=>error.status===9&&error.capacityShortfallBytes===100)
        assert.strictEqual(granted,0)
      } else {
        assert(reclaimReply&&!settled,'Direct discarded its cursor instead of waiting for reclamation')
        assert.strictEqual(prepared.cursor,cursor)
        assert.strictEqual(calls,1,'An unfunded cursor was restarted or polled')
        reclaimReply();reclaimReply=null;await flush()
        assert(resume&&budget.credits.size===1)
        assert.strictEqual(ledger.bytes,1000,'A slice refunded its unfinished stage')
        if(outcome==='cancel')execution.cancelImagery()
        if(outcome==='suspend')execution.suspendImagery()
        assert.strictEqual(ledger.bytes,1000,'Cancellation intent refunded a live stage')
        execution.frames.presented={frame:{sequence:2}}
        let next=resume;resume=null;next();await flush()
        if(outcome==='cancel'||outcome==='suspend') {
          assert(settled,'Suspended imagery waited for another producer turn')
          assert((await operation).superseded)
          if(outcome==='suspend')assert.strictEqual(prepared.cursor,cursor,'Soft suspension lost compatible preparation')
        }
        else {
          assert(resume&&granted===2&&budget.credits.size===1,'A grant ended before its actual receipt')
          next=resume;resume=null;next()
          if(outcome==='failed')await assert.rejects(operation,/Native stage failed/)
          else {assert(!(await operation).pending);assert.strictEqual(turns,2)}
        }
      }
      assert.strictEqual(budget.credits.size,0)
      assert.strictEqual(budget.actual,outcome==='complete'||outcome==='suspend'?380:100)
      assert.strictEqual(clearCount,outcome==='complete'||outcome==='suspend'?0:1)
    } finally {
      if(!settled)execution.cancelImagery()
      for(let n=0;n<128&&!settled;++n) {
        if(reclaimReply){const reply=reclaimReply;reclaimReply=null;reply()}
        if(resume){const next=resume;resume=null;next()}
        await Promise.resolve()
      }
      assert(settled,'Direct fixture did not drain its pending producer')
      await operation.catch(()=>{})
      execution.measurementDelivery.close();stop();pressure.release();budget.close()
    }
    assert.strictEqual(ledger.bytes,0)
  }
  console.log('Direct imagery grants: suspended cursor, real reclamation, multi-turn receipts, cancellation and zero teardown')
}
module.exports=async()=>{
  let timer
  try {
    return await Promise.race([verifyLocalImageryGrants(),new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Direct grant contract timed out')),3000)
    })])
  }finally{clearTimeout(timer)}
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
