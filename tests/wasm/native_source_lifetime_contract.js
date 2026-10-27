const assert=require('assert')
const {releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')

// Freeze an unmeasured Direct host cut, publish different real CBDAM geometry,
// then evict the idle Native mesh cache before resuming the original reader.
module.exports=async function({abi,frames,execution,packet,imagery,budget,present}) {
  const preparation=execution.preparation,plan=preparation.planImagery,yieldWork=preparation.yieldWork
  preparation.closeMeasurements()
  try {
    // Suspend at the real epoch boundary without measuring any mesh yet.
    // This makes later source loss independent of elapsed time or CPU speed.
    preparation.planImagery=async()=>({pending:true})
    preparation.yieldWork=async()=>false
    assert((await execution.planImagery(packet.frame.sequence,imagery)).pending)
  }finally{preparation.planImagery=plan;preparation.yieldWork=yieldWork}
  const frozen=preparation.imageryJob.result,oldIds=new Set(frozen.resources.keys())
  assert.strictEqual(frozen.frame.sequence,packet.frame.sequence)
  abi.setPlanarLevel(0)
  const next=await execution.step(1,budget,{viewRevision:1})
  // Settled same-view publications now adopt surviving work (covered by
  // published_projection_continuation_test). Keep this successor unsettled
  // so this independent lifetime fixture actually resumes its retired source.
  const decisionsComplete=next.frame.decisionsComplete
  next.frame.decisionsComplete=false
  present(next)
  assert(next.draws.every(draw=>!oldIds.has(draw.resourceId)),'Fixture did not replace the frozen Native sources')
  assert([...oldIds].every(id=>!frames.resources.has(id)),'Frozen host cut was still owned by the display frames')
  abi.trimMeshCache(0)
  let result
  try {
    for(let turn=0;turn<2048;++turn) {
      if(result)releaseMeasurements(result.measurements)
      result=await execution.planImagery(next.frame.sequence,imagery)
      if(!result.pending&&!result.continuation)break
    }
    assert(result.imageryPlan&&result.imageryPlan.quality.planningComplete)
    assert.strictEqual(result.modelRevision,frozen.updateState.modelRevision,
      'The retired-source reader silently switched terrain epochs')
    assert(result.measurements.length>0&&result.measurements.every(value=>oldIds.has(value.resourceId)))
    assert.strictEqual(preparation.imageryJob,null,'Completed epoch retained its source loan')
    assert.strictEqual(abi.nativeCall('terra_acquire_mesh_resource',abi.context,0xffffffff),2,
      'Fixture lost the Native missing-source rejection')
    abi.trimMeshCache(0)
    const stale=[...oldIds][0]
    assert.strictEqual(abi.nativeCall('terra_acquire_mesh_resource',abi.context,stale),2,
      'Completed numeric evidence still pinned its old Native mesh source')
    console.log('Direct frozen source: host retirement, Native cache pressure, canonical completion and source release passed')
  }finally{next.frame.decisionsComplete=decisionsComplete;if(result)releaseMeasurements(result.measurements)}
}
