const assert=require('assert')
const {verify}=require('./native_imagery_recovery_contract')
const {MeasurementRows}=require('../../sdk/js/terrain/measurement_rows')

// Separate cache-pressure case. The ordinary constant-budget round trip has
// no observer and must still pass without a test initiating reclamation.
module.exports=async function(bytes,workers=[false,true]) {
  const receipts=[]
  for(const worker of workers)await verify(bytes,worker,async({runtime,abi,index})=>{
    if(index!==1)return
    const deadline=Date.now()+3000
    while((runtime.refreshing||runtime.refreshPending||runtime.imageryRefreshing||runtime.imageryRefreshPending)&&
        Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,2))
    assert(!runtime.refreshing&&!runtime.refreshPending&&!runtime.imageryRefreshing&&!runtime.imageryRefreshPending,
      'Completed-cache fixture still has active producer work')
    const r=runtime.renderer,sequence=runtime.meshFrames.presented.frame.sequence
    const rows=Array.from(r.current.workerMeasurements.values(),value=>value.regions)
      .filter(value=>value instanceof MeasurementRows&&value.length)
    assert(rows.length,'Completed-cache fixture has no received evidence')
    const contents=rows.map(value=>{
      const data=new Uint8Array(value.length*176);value.copyTo(data);return data
    })
    const before=abi.imageryInputPayloadBytes()
    assert(before>256*176+4,'Completed-cache fixture has no native input to reclaim')
    if(worker)await abi.reclaimMeasurementInputs(before)
    else runtime.localExecution.reclaimMeasurementInputs(before)
    const after=abi.imageryInputPayloadBytes()
    assert.strictEqual(after,256*176+4,'Completed producer/transport/tree input remained pinned after pressure')
    for(let i=0;i<rows.length;++i) {
      const data=new Uint8Array(rows[i].length*176);rows[i].copyTo(data)
      assert.deepStrictEqual(data,contents[i],'Producer reclamation changed received numerical evidence')
    }
    r.render(false)
    const quality=r.stats().quality
    assert.strictEqual(runtime.meshFrames.presented.frame.sequence,sequence,'Cache pressure replaced displayed terrain')
    assert(quality.planningComplete&&quality.targetMet&&quality.missingCount===0&&quality.resolvedMaxPixelError<=1.25,
      'Producer reclamation invalidated received display precision')
    assert.strictEqual(runtime.resourceLedger.stats().overBudgetBytes,0)
    receipts.push({worker,beforeNativeInputBytes:before,afterNativeInputBytes:after,
      receivedRows:rows.reduce((sum,value)=>sum+value.length,0),pixelError:quality.resolvedMaxPixelError})
  })
  console.log('Direct/Worker completed projection input: actual cache refund, unchanged received rows, subsequent 2MiB round trip and zero teardown',JSON.stringify(receipts))
  return receipts
}
if(require.main===module)module.exports(require('fs').readFileSync(process.argv[2])).catch(error=>{
  console.error(error);process.exitCode=1
})
