const assert=require('assert')
const surface=require('../../sdk/js/terrain/terra_surface_plan')
const {TerrainWorkerHost}=require('../js/reference/measurement_host_fixture')

module.exports=async function verifyMeasurementRefinement(abi,descriptor) {
  const fixture=require('../js/reference/measurement_fixture')(true)
  const model=surface.prepareSurface(fixture.positions,fixture.uv,fixture.indices,0,fixture.indices.length)
  const frame={sequence:1,projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],cameraPosition:[0,0,0]}
  const viewport={width:320,height:320,devicePixelRatio:1}
  const draw={resourceId:1,textureNode:{level:0,root:0,row:0,column:0},
    texture:{level:1,matrix:2,row:0,column:0},origin:[0,0,0],flags:0}
  const options={descriptor,maximumTextures:1,maximumDraws:1024,targetPixelError:1.25,detached:true}
  const measure=tight=>Object.assign(surface.measureSurface(model,draw.origin,
    surface.projectionContext(frame,viewport,frame.projectionView),tight),{bounds:model.bounds,hull:model.hull})
  abi.resetImagery()
  assert(abi.planImagery([draw],()=>measure(false),options).quality.limitedByTextureBudget,
    'Fixture must reproduce a false budget limitation from the cheap bound')
  const host=new TerrainWorkerHost()
  host.abi=abi
  host.imageryJob={coarsening:false,exact:new Set(),precise:new Map(),releaseMeshes() {}}
  const packet={frame,draws:[draw],resources:new Map([[1,{model}]]),updateState:{modelRevision:1},meshIdentity:1}
  const message={imagery:options,viewport,camera:{distance:1}}
  let result,rounds=0
  try {
    do {
      result=await host.planImagery(packet,message)
      if(result.outputWork) host.imageryOutputWorkspace.grant(result.outputWork)
      if(result.inputWork) host.imageryInputWorkspace.grant(result.inputWork)
      if(result.referenceWork) host.imageryReferenceWorkspace.grant({...result.referenceWork,bytes:Math.max(65536,result.referenceWork.bytes)})
      assert(++rounds<128,'Precision refinement failed to converge')
    } while(result.pending || result.continuation || !result.imageryPlan.quality.planningComplete)
    assert(result.imageryPlan.quality.meetsTarget && result.imageryPlan.quality.selectedTextureCount===1)
    assert(host.imageryJob.precise.has(1),'Worker never requested the tight bound')
    assert.strictEqual(host.imageryMeasurements.get(1).refinable,false)
    assert.strictEqual(host.imageryJob.precise.get(1),null,'Completed tightening retained the old measurement')
    assert.strictEqual(host.imageryMeasurements.get(1).regions.length,model.blocks.length)
    // A renderer may retain its old demand/measurements while a provisional
    // cut is streamed. Completion must carry the measurements that actually
    // justify the new cut, even when their IDs were sent in a prior delta.
    assert.deepStrictEqual(result.measurements.map(m=>m.resourceId),[1],
      'Completed demand omitted a measurement already streamed in a preview')
    assert.strictEqual(result.measurements[0].pixelsPerUv,host.imageryMeasurements.get(1).pixelsPerUv)
    assert.deepStrictEqual(result.measurements[0].regions,host.imageryMeasurements.get(1).regions)
    const again=await host.planImagery(packet,message)
    assert.strictEqual(again.imageryPlan,result.imageryPlan,'Stable exact work was restarted')
    assert(Array.from(host.measurementHistory.views.values()).every(v=>!v.values.get(1).refinable),
      'Reusing this view can silently restore the loose bound')
  } finally {host.clearPlanning()}
  // Mixed blocks retain exactly the same projective regions and Native cut
  // while tightening only the remaining derivative summaries.
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0.8,0,0,1]
  const context=surface.projectionContext({projectionView:matrix},viewport,
    require('../../sdk/js/math/matrix').invertMatrix4(matrix))
  const drain=work=>{let next;do{next=work.next()}while(!next.done);return next.value}
  const before=surface.measureSurface(model,draw.origin,context)
  const refined=drain(require('../js/reference/measurement_refinement').refineMeasurements(model,draw.origin,context,before))
  const complete=drain(surface.surfaceMeasurements(model,draw.origin,context,false,true))
  for(const maximumTextures of [1,64]) {
    const plan=value=>{
      abi.resetImagery()
      return abi.planImagery([draw],()=>Object.assign({},value,{bounds:model.bounds,hull:model.hull}),
        {...options,maximumTextures})
    }
    assert.deepStrictEqual(plan(refined),plan(complete),'Reusing projective regions changed the Native cut')
  }
  // Finite upper bounds are valid demand in both zoom directions. With enough
  // capacity the real Native planner proves the cut without any triangle pass.
  for (const coarsening of [false, true]) {
    abi.resetImagery()
    const bounded = new TerrainWorkerHost()
    bounded.abi = abi
    bounded.imageryJob = {coarsening, exact:new Set(), precise:new Map(), releaseMeshes() {}}
    try {
      let value
      for (let round=0;round<128;++round) {
        value=await bounded.planImagery(packet,{...message,imagery:{...options,maximumTextures:64}})
        if(value.outputWork) bounded.imageryOutputWorkspace.grant(value.outputWork)
        if(value.inputWork) bounded.imageryInputWorkspace.grant(value.inputWork)
        if(value.referenceWork) bounded.imageryReferenceWorkspace.grant({...value.referenceWork,bytes:Math.max(65536,value.referenceWork.bytes)})
        if(value.imageryPlan && value.imageryPlan.quality.planningComplete !== false && !value.pending && !value.continuation) break
      }
      assert(value.imageryPlan && value.imageryPlan.quality.meetsTarget && !value.continuation)
      assert(bounded.imageryMeasurements.get(1).conservative,
        'A sufficient upper bound still forced an exact whole-surface scan')
      assert.strictEqual(bounded.imageryJob.exact.size,0)
      assert.strictEqual(bounded.imageryJob.precise.size,0)
      assert(bounded.imageryMeasurements.get(1).pixelsPerUv>=measure(true).pixelsPerUv,
        'Fast acceptance understated the independently tightened surface error')
    } finally {bounded.clearPlanning()}
  }
}
