const assert=require('assert')
const {install,TerrainWorkerHost}=require('./reference/measurement_host_fixture')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {NativePayloadBudget}=require('../../sdk/js/resources/native_payload_budget')

// Exercise the installed response pump: cancellation can arrive after a CPU
// checkpoint, while its numeric mirror is waiting for host credit. The mirror's
// terminal reply is also the input grant's receipt, even on a compatible rebase.
module.exports=async function verifyStreamReceipt() {
  const original=TerrainWorkerHost.prototype.handle
  try {
    for(const boundary of ['rebase','mirror-cancel','mirror-stop','complete']) {
      const ledger=new ResourceLedger(1024),budget=new NativePayloadBudget(ledger,'imagery-input-native',100)
      const credit=budget.begin(128)
      let host,actual=100,calls=0,resolve,reject,timer,terminal
      const abi={memoryBytes:()=>1024,nativeRevision:0,meshPayloadBytes:()=>0,heightPayloadBytes:()=>0,
        recordPayloadBytes:()=>0,imageryPayloadBytes:()=>actual,imageryInputPayloadBytes:()=>actual,
        imageryOutputPayloadBytes:()=>0,imageryReferencePayloadBytes:()=>0}
      const done=new Promise((yes,no)=>{resolve=yes;reject=no;timer=setTimeout(()=>no(new Error('Mirror receipt timed out')),2000)})
      TerrainWorkerHost.prototype.handle=async function(message) {
        host=this
        if(!this.abi){this.abi=abi;this.initializeProduction()}
        const stage=this.measurementBatch.stage()
        let allocation=stage.reserve(16)
        if(!allocation){this.measurementInputWorkspace.grant(message.inputGrant);allocation=stage.reserve(16)}
        assert(allocation);actual+=16;allocation.release()
        return {pending:++calls<2,measurements:[]}
      }
      const scope={postMessage(message) {
        try {
          if(message.error||message.type==='fatal')throw new Error(message.error)
          budget.observe(message.imageryInputBytes)
          if(message.mirrorWork) {
            if(boundary==='complete')scope.onmessage({data:{type:'measurement-grant',workId:message.mirrorWork.id,bytes:message.mirrorWork.bytes}})
            else if(boundary==='rebase')scope.onmessage({data:{type:'cancel-imagery',id:1,rebase:true}})
            else if(boundary==='mirror-stop')scope.onmessage({data:{type:'measurement-stop'}})
            else scope.onmessage({data:{type:'measurement-cancel',workId:message.mirrorWork.id}})
          }else if(message.value&&!message.progress){terminal=message;resolve()}
        }catch(error){reject(error)}
      }}
      install(scope)
      try {
        scope.onmessage({data:{type:'imagery',id:1,stream:true,inputGrant:{id:1,bytes:128}}})
        await done
        assert.strictEqual(ledger.bytes,228,'Mirror termination refunded before its actual receipt')
        assert.strictEqual(host.measurementBatch.stats().heldGrantBytes,0,
          boundary+' left producer permission alive after its terminal mirror receipt')
        assert.strictEqual(Boolean(terminal.value.superseded),boundary!=='complete')
        budget.finish(credit)
        assert.strictEqual(ledger.bytes,actual,'Receipt lost already-produced native input')
        assert.strictEqual(host.measurementBatch.stage().reserve(16),null,
          'A successor allocated using a cancelled stream’s returned credit')
      }finally {
        clearTimeout(timer)
        if(host)host.clearPlanning()
        // Let the installed pump close its own bounded dispatch timer.
        await new Promise(resolve=>setTimeout(resolve,10))
        budget.close()
      }
      assert.strictEqual(ledger.bytes,0)
    }
  }finally{TerrainWorkerHost.prototype.handle=original}
  console.log('Streamed input credit closes before mirror cancellation, stop and completion receipts')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
