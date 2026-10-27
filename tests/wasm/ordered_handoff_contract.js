const assert=require('assert')
const fs=require('fs')
const {verify}=require('./native_imagery_recovery_contract')

// Let a real partial handoff's displayed imagery finish before preparing the
// remaining group. A slow terrain worker can naturally produce this order.
// Native group selection, memory and precision remain unchanged.
function orderHandoff(runtime) {
  const renderer=runtime.renderer,refresh=runtime.refresh
  const evidence={}
  let gate,closed=false,failed
  runtime.refresh=async function(...args) {
    if(!closed&&!evidence.completed&&!this.refreshing&&this.meshFrames.presented&&
        this.meshFrames.presented.draws.length===3) {
      if(!gate)gate=(async()=>{
        evidence.meshes=this.meshFrames.presented.draws.map(draw=>draw.resourceId)
        const start=Date.now();let stable=0
        while(!closed&&!this.destroyed&&Date.now()-start<3000) {
          const q=renderer.stats().quality
          if(q.sourceDrawCount===3&&q.planningComplete&&q.targetMet&&
              !this.imageryRefreshing&&!this.imageryRefreshPending) {
            if(++stable===3) {
              evidence.completed=true;evidence.waitMs=Date.now()-start
              evidence.measuredRows=q.measurementRegionCount
              evidence.bytes=this.resourceLedger.bytes
              break
            }
          } else stable=0
          await new Promise(resolve=>setTimeout(resolve,5))
        }
        if(!closed&&!this.destroyed)assert(evidence.completed,'Intermediate imagery failed to finish at the order barrier')
      })().catch(error=>{failed=error;closed=true;runtime.lastError=error.message})
      await gate
    }
    if(!closed&&!this.destroyed)return refresh.apply(this,args)
  }
  return {evidence,async close() {
    closed=true;runtime.refresh=refresh
    if(gate)await gate
    if(failed)throw failed
  }}
}
async function run(bytes,worker) {
  let control
  try {
    const result=await verify(bytes,worker,async({runtime,index})=>{
      if(index===3)control=orderHandoff(runtime)
      if(index===4) {
        assert(control&&control.evidence.completed,
          'Ordered handoff never exercised the intermediate display')
        const prepared=runtime.renderer.meshPreparationStats.last
        assert(prepared.emptyCoverageCells>0,'Native empty-cell proof did not reach display admission')
        control.evidence.finalPreparation={emptyCoverageCells:prepared.emptyCoverageCells,
          worldCutBytes:prepared.worldCutBytes,attempts:runtime.renderer.meshPreparationStats.attempts}
        await control.close()
      }
    })
    return {...result,order:control.evidence}
  } finally {if(control)await control.close()}
}
module.exports=async bytes=>{
  const result=[]
  for(const worker of [false,true])result.push(await run(bytes,worker))
  console.log('Ordered Direct/Worker 2MiB handoff preserves fully measured mixed coverage and completes',JSON.stringify(result))
  return result
}
if(require.main===module)module.exports(fs.readFileSync(process.argv[2])).catch(error=>{
  console.error(error);process.exitCode=1
})
