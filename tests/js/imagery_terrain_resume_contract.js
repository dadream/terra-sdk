const assert=require('assert')

// Exercise the actual runtime's two asynchronous entry points. A rejected
// terrain successor must not strand the preparation retained by its old cut.
module.exports=async({createRuntime,FakeAbi,settle})=>{
  for(const worker of [false,true]) {
    const abi=new FakeAbi();abi.getRequests=()=>[]
    const {runtime,renderer}=await createRuntime({abi,canvas:{requestAnimationFrame:()=>1}})
    let credit,resolveFirst,shown,planning,requests=0,suspensions=0,steps=0
    const result=()=>({sequence:shown.frame.sequence,viewRevision:runtime.cameraRevision,
      imageryPlan:{draws:[],quality:{planningComplete:true}},measurements:[]})
    const execution={
      planImagery(){
        if(++requests===1)return new Promise(resolve=>{resolveFirst=resolve})
        // Finishing the retained preparation is a real ownership receipt.
        // The terrain refusal itself cannot return this credit.
        assert(credit.active);credit.release()
        return Promise.resolve(result())
      },
      suspendImagery(){
        ++suspensions;assert(runtime.candidateEvaluating)
        resolveFirst(worker?{superseded:true}:result())
      },
      async step(){
        if(++steps===1)assert(credit.active,'The rejected candidate refunded retained imagery input')
        throw Object.assign(new Error('Controlled terrain capacity refusal'),{status:9,requests:[]})
      },
      observeView(){},
      destroy(){}
    }
    try {
      await settle(2)
      shown=runtime.meshFrames.presented
      assert(shown&&!runtime.refreshing&&!runtime.meshFrames.candidate)
      runtime.frameClock.work.clear()
      credit=runtime.resourceLedger.reserve('fixture-retained-imagery',64)
      renderer.imageryPlanningOptions=()=>({})
      renderer.setImageryPlan=()=>true
      if(worker) {
        abi.isWorker=true;abi.viewRevision=runtime.cameraRevision
        abi.planImagery=execution.planImagery;abi.suspendImagery=execution.suspendImagery;abi.step=execution.step
        const advance=abi.advanceTerrain.bind(abi)
        abi.advanceTerrain=(...args)=>Promise.resolve({selectionViewRevision:abi.viewRevision,
          requests:[],progress:advance(...args)})
      }else runtime.localExecution=execution
      planning=runtime.refreshImagery()
      assert.strictEqual(requests,1)
      await runtime.refresh()
      assert.strictEqual(suspensions,1,'The terrain transaction did not reach the controlled suspension')
      await planning
      await settle(2)
      assert.strictEqual(requests,2,'Rejected terrain admission stranded the interrupted imagery producer')
      assert(!credit.active,'Resumed imagery did not complete its retained allocation')
      assert.strictEqual(runtime.meshFrames.presented,shown,'Capacity refusal changed the presented owner')
      assert.strictEqual(runtime.lastError,'')
    } finally {
      if(resolveFirst)resolveFirst({superseded:true})
      if(planning)await planning
      abi.isWorker=false
      if(credit)credit.release()
      runtime.destroy()
      assert.strictEqual(runtime.resourceLedger.bytes,0)
    }
  }
  console.log('Terrain refusal resumes Direct/Worker imagery; retained input survives until its real completion')
}
