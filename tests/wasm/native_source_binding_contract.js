const assert=require('assert')
const surface=require('../../sdk/js/terrain/terra_surface_plan')
const {NativeMeasurementProduction}=require('../../adapters/wasm/native_measurement_production')
const {ImageryInputWorkspace}=require('../../sdk/js/resources/imagery_input_workspace')
const {TASK_WAIT}=require('../../sdk/js/runtime/cooperative_task')

// Source identity stays fixed while its addressing changes from a private
// plan to resident ownership. The pending metadata allocation must not freeze
// an ID which the owner retires before that allocation is authorized.
module.exports=async function(abi,frames,budget) {
  const baseline=abi.imageryInputPayloadBytes(),packet=await abi.prepareMeshFrame(1,budget)
  const source={planId:packet.nativePlan.id},draw=packet.draws.find(d=>!d.flags),
    resource=frames.presented.resources.get(draw.resourceId)
  assert(resource,'Source binding needs an unchanged resident mesh')
  const stages=[],credits=new Map();let id=300000,work,actual
  const production=new NativeMeasurementProduction(abi,()=>{
    const stage=new ImageryInputWorkspace(++id);stages.push(stage);return stage
  })
  const receipt=()=>{for(const [stage,credit] of credits)if(stage.finished){abi.imageryInputBudget.finish(credit);credits.delete(stage)}}
  const grant=()=>{
    const stage=stages[stages.length-1],quote=stage.quote(),credit=abi.imageryInputBudget.begin(quote.bytes)
    assert(credit);credits.set(stage,credit);assert(stage.grant({id:quote.id,bytes:credit.bytes}))
  }
  try {
    const context=surface.projectionContext(packet.frame,{width:640,height:360})
    work=production.measure(draw,resource,context,{get planId(){return source.planId},viewRevision:1,sourceRevision:1})
    const waiting=work.next();assert(!waiting.done&&waiting.value===TASK_WAIT)
    abi.discardMeshPlan(packet.nativePlan);source.planId=0
    for(let turn=0;turn<10000;++turn) {
      grant()
      let next
      do {next=work.next();receipt()}while(!next.done&&next.value!==TASK_WAIT)
      if(next.done){actual=next.value;work=null;break}
    }
    assert(actual&&actual.regions.length>0,'Retired candidate addressing prevented the resident read')
    assert.strictEqual(production.stats().measurements,1)
    assert(stages.every(stage=>stage.finished)&&!credits.size)
    console.log('Native source binding: admission wait, retired plan, same resident identity and receipts passed')
  }finally {
    if(work)work.return()
    production.destroy();receipt()
    if(actual)actual.regions.close()
    if(source.planId)abi.discardMeshPlan(packet.nativePlan)
  }
  assert.strictEqual(abi.imageryInputPayloadBytes(),baseline,'Source rebinding retained Native input')
}
