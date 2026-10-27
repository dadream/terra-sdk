const assert=require('assert')
const {reclaimMeasurementInputs,measurementCacheRevision}=require('../../adapters/wasm/completed_measurement_cache')
const {ResourceReclamation}=require('../../sdk/js/resources/resource_reclamation')

function fixture() {
  const holds=new Set(['preparation','history','sender','tree']),calls=[]
  const abi={nativeRevision:1,primaryImagery:{tasks:new Set()},
    imageryInputPayloadBytes:()=>45060+(holds.size?2816:0)+(holds.has('tree')?264:0),
    resetImagery(){calls.push('tree');holds.delete('tree')},observeImageryInput(){}}
  const preparation={abi,imageryPlanRevision:1,lastImageryPlan:{quality:{planningComplete:true}},
    measurementProduction:{trim:()=>({released:0,more:false})},
    clearPlanning(){calls.push('preparation');holds.delete('preparation');this.lastImageryPlan=null},
    measurementHistory:{clear(){calls.push('history');holds.delete('history')}}}
  const delivery={queue:[],sender:{sequence:1,clear(){calls.push('sender');holds.delete('sender')}}}
  return {abi,preparation,delivery,holds,calls}
}

module.exports=async function() {
  for(const block of ['imageryJob','measurementJob','imageryTask','partitionFit','partial','native-task',
    'delivery','queued','quoted']) {
    const f=fixture()
    if(['imageryJob','measurementJob','imageryTask','partitionFit'].includes(block))f.preparation[block]={}
    if(block==='partial')f.preparation.lastImageryPlan.quality.planningComplete=false
    if(block==='native-task')f.abi.primaryImagery.tasks.add({})
    if(block==='delivery')f.delivery.active={}
    if(block==='queued')f.delivery.queue.push({})
    if(block==='quoted')f.delivery.sender.active={}
    const before=f.abi.imageryInputPayloadBytes()
    assert.strictEqual(reclaimMeasurementInputs(f.preparation,f.delivery,1).released,0,block)
    assert.strictEqual(f.abi.imageryInputPayloadBytes(),before,block+' lost active input')
    assert.deepStrictEqual(f.calls,[],block+' was cancelled by optional cache pressure')
  }
  {
    const f=fixture(),input=f.abi.imageryInputPayloadBytes;let modelBytes=64
    f.abi.imageryInputPayloadBytes=()=>input()+modelBytes
    f.preparation.measurementProduction.trim=()=>{modelBytes=0;return {released:64,more:false}}
    assert.strictEqual(reclaimMeasurementInputs(f.preparation,f.delivery,1).released,64)
    assert.deepStrictEqual(f.calls,[],'An adequate idle model refund discarded completed planning history')
  }
  {
    const f=fixture(),reclamation=new ResourceReclamation()
    f.preparation.imageryJob={}
    reclamation.register({revision:()=>measurementCacheRevision(f.preparation,f.delivery),
      reclaim:needed=>reclaimMeasurementInputs(f.preparation,f.delivery,needed).released})
    await reclamation.request(1)
    assert.strictEqual(reclamation.stats().reclaimedBytes,0)
    f.preparation.imageryJob=null
    await reclamation.request(1)
    assert.strictEqual(f.abi.imageryInputPayloadBytes(),45060)
    assert.strictEqual(reclamation.stats().reclaimedBytes,3080)
    assert.deepStrictEqual(f.calls,['preparation','history','sender','tree'])
    const attempts=reclamation.stats().attempts
    await reclamation.request(1)
    await reclamation.request(1)
    assert(reclamation.stats().attempts<=attempts+1,'An empty completed cache manufactured more reclamation')
  }
  {
    const f=fixture(),failure=new Error('projection disposer failed')
    f.preparation.clearPlanning=()=>{throw failure}
    assert.throws(()=>reclaimMeasurementInputs(f.preparation,f.delivery,1),error=>error===failure)
    assert.strictEqual(f.abi.imageryInputPayloadBytes(),47876,'A failed disposer falsely refunded retained input')
    assert.deepStrictEqual(f.calls,['history','sender','tree'])
  }
  console.log('Completed measurement cache: active work/quotes protected, terminal receipt wake and exact physical refund passed')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
