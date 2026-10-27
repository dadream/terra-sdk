const {Cleanup}=require('../../sdk/js/runtime/cleanup')

// The renderer owns its received numerical rows. A completed producer keeps
// three optional references to the original input: preparation, transport
// history and the native tree. Retiring only one cannot refund that input.
function reclaimMeasurementInputs(preparation,delivery,needed) {
  const abi=preparation.abi,before=abi.imageryInputPayloadBytes()
  const result=preparation.measurementProduction.trim(needed)
  const plan=preparation.lastImageryPlan,planner=abi.primaryImagery
  if(before-abi.imageryInputPayloadBytes()<needed&&plan&&plan.quality.planningComplete===true&&
      !preparation.imageryJob&&!preparation.measurementJob&&!preparation.imageryTask&&!preparation.partitionFit&&
      delivery&&!delivery.active&&!(delivery.queue&&delivery.queue.length)&&!delivery.sender.active&&
      (!planner||!planner.tasks.size)) {
    const cleanup=new Cleanup()
    cleanup.run(()=>preparation.clearPlanning())
    cleanup.run(()=>preparation.measurementHistory.clear())
    cleanup.run(()=>delivery.sender.clear())
    cleanup.run(()=>abi.resetImagery())
    cleanup.run(()=>abi.observeImageryInput())
    cleanup.finish()
  }
  return {released:Math.max(0,before-abi.imageryInputPayloadBytes()),more:result.more}
}

// Publication can make retained rows idle without adding a native model.
// Include the completed response's receipt, not just model allocation changes.
function measurementCacheRevision(preparation,delivery) {
  return [preparation.abi.nativeRevision,preparation.imageryPlanRevision,
    !!preparation.imageryJob,!!preparation.measurementJob,!!delivery.sender.active,
    delivery.sender.sequence].join(':')
}

module.exports={reclaimMeasurementInputs,measurementCacheRevision}
