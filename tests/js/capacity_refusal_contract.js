const assert=require('assert')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {MeshFrames}=require('../../sdk/js/terrain/terra_mesh_frames')
const {produceMeshCandidate}=require('../../adapters/wasm/mesh_candidate_production')

// Exercise the real candidate's refusal/discard boundary. A last native
// disposer can release a predecessor which the private quote was borrowing.
// Refunding the quote itself, or an already disposable memo, is different.
module.exports=async()=>{
  for(const execution of ['candidate','direct'])for(const kind of ['temporary','predecessor','memo','no-op']) {
    const ledger=new ResourceLedger(1000),frames=new MeshFrames(ledger)
    const unregister=kind==='no-op'&&ledger.reclamation.register({revision:()=>0,reclaim:async()=>0})
    const display=ledger.reserve('presented-owner',380)
    let previous
    previous=kind==='memo'?ledger.reserveDisposable('optional',100,()=>previous.release()):
      ledger.reserve('previous-native-input',100)
    const revision=ledger.availabilityRevision
    let disposed=false
    frames.prepareOutputs=()=>({
      capacityShortfallBytes:0,
      async admit(){
        const work=ledger.reserve('private-work',500),cut=work.split(60,'resident','private-cut')
        let extra
        try {
          if(kind==='memo') {
            extra=ledger.reserve('private-work',60)
            assert(extra&&!previous.active,'The fixture did not reclaim its optional memo')
          }
          const refusal={}
          assert.strictEqual(ledger.reserve('private-work',kind==='memo'?200:60,[],[],[],refusal),null)
          assert(refusal.shortfallBytes>0)
          this.capacityShortfallBytes=refusal.shortfallBytes
          return null
        }finally{cut.release();work.release();if(extra)extra.release()}
      },
      release(){}
    })
    try {
      const describe=async()=>({nativePlan:{id:1,residentBytes:0,additionalBytes:0,
        reclaimableBytes:0,maximumBytes:1000},draws:[],frame:{},updateState:{modelRevision:1},requests:[]})
      const discard=()=>{disposed=true;if(kind==='predecessor')previous.release()}
      frames.describe=describe
      const operation=execution==='candidate'?produceMeshCandidate({generation:1,destroyed:false,
        describe,discardPlan:discard},frames):frames.read({setResourceLedger:()=>({finish(){}}),
        getRequests:()=>[],discardMeshPlan:discard})
      await assert.rejects(operation,error=>{
        assert(disposed,'Refusal was stamped before the native plan disposer')
        assert.strictEqual(error.status,9)
        assert(display.active,'Refusal released the presented owner')
        assert(ledger.availabilityRevision>revision,'The fixture did not return its own working credit')
        assert.strictEqual(error.capacityRevision,kind==='predecessor'?revision:ledger.availabilityRevision,
          kind==='predecessor'?'Last-disposer refund was lost':'Private or memo refund manufactured a retry')
        return true
      })
    } finally {if(unregister)unregister();previous.release();display.release();frames.clear()}
    assert.strictEqual(ledger.bytes,0)
    assert.strictEqual(ledger.disposableBytes,0)
  }
  console.log('Capacity refusals preserve last-disposer refunds and park after private or disposable-only cleanup')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
