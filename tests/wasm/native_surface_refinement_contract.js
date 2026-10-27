const assert=require('assert')
const surface=require('../../sdk/js/terrain/terra_surface_plan')
const {refineMeasurements}=require('../js/reference/measurement_refinement')
const {ImageryAdapter}=require('../../sdk/js/imagery/terra_imagery_adapter')
const {adoptMeasurementRows,MeasurementKernel}=require('../../sdk/js/terrain/measurement_rows')
const {invertMatrix4}=require('../../sdk/js/math/matrix')
const {ImageryInputWorkspace}=require('../../sdk/js/resources/imagery_input_workspace')

function drain(iterator){let next;do{next=iterator.next()}while(!next.done);return next.value}
function equal(a,b,label) {
  assert(a===b||Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-8,Math.abs(a)*1e-9),label+': '+a+' / '+b)
}

module.exports=async function verifyNativeRefinement(abi,fixture,native,plan,foreignDraw,descriptor,ledger) {
  const owned=[],models=[],records=[]
  function view(distance,tilt) {
    abi.setGlobeTarget(...fixture.target);abi.setCamera({distance,tiltRadians:tilt,yawRadians:1.1})
    const frame=abi.getCameraSnapshot()
    return surface.projectionContext(frame,{width:640,height:360},invertMatrix4(frame.projectionView))
  }
  const measure=(context,boundsOnly=false)=>drain(surface.surfaceMeasurements(fixture.model,fixture.draw.origin,context,boundsOnly))
  const kinds=value=>({scalar:value.regions.filter(r=>!r.projection).length,projective:value.regions.filter(r=>r.projection).length})
  let mixed
  const searched=[]
  for(const distance of [5000000,3000000,7000000,9000000,12000000]) {
    for(const tilt of [-0.5,-0.9,-1.2]) {
      const context=view(distance,tilt),previous=measure(context),counts=kinds(previous)
      searched.push({distance,tilt,...counts})
      if(counts.scalar&&counts.projective){mixed={context,previous,counts};break}
    }
    if(mixed)break
  }
  assert(mixed,'No actually mixed scalar/projective fixture: '+JSON.stringify(searched))
  const global=view(18000000,0),oblique=view(1000000,-1.2)
  const scenes=[{name:'scalar',context:global,previous:measure(global)},
    {name:'projective',context:oblique,previous:measure(oblique)},
    {name:'mixed',...mixed},{name:'bounds',context:oblique,previous:measure(oblique,true),boundsOnly:true}]
  const kernel=new MeasurementKernel(ledger)
  async function reject(model,context,previous,extra) {
    const before=abi.imageryInputPayloadBytes()
    await assert.rejects(abi.createNativeSurfaceMeasurementTask(model,context,
      {tight:true,previous,sourceRevision:7,...extra}).run(),error=>error.status===2)
    assert.strictEqual(abi.imageryInputPayloadBytes(),before,'Identity rejection changed native ownership')
  }
  try {
    for(const scene of scenes) {
      const counts=kinds(scene.previous),context=scene.context
      assert(scene.name!=='projective'||!counts.scalar&&counts.projective)
      const base=await abi.createNativeSurfaceMeasurementTask(native,context,
        {boundsOnly:scene.boundsOnly,sourceRevision:7,viewRevision:900}).run();owned.push(base.regions)
      const expected=drain(refineMeasurements(fixture.model,fixture.draw.origin,context,scene.previous))
      if(scene.name==='scalar') {
        await reject(native,{...context,sx:context.sx*2},base.regions)
        const matrix=context.matrix.slice();matrix[0]+=1e-12
        await reject(native,{...context,matrix},base.regions)
        await reject(native,context,base.regions,{sourceRevision:8})
        const foreign=await abi.createNativeSurfaceModelTask(foreignDraw,{planId:plan}).run();models.push(foreign)
        await reject(foreign,context,base.regions);foreign.close()
        const row=new Uint8Array(176);base.regions.copyTo(row,0,0,1)
        const domain=new DataView(row.buffer).getUint32(172,true)
        const partial=await abi.createNativeSurfaceMeasurementTask(native,context,{sourceRevision:7,domains:[domain]}).run()
        owned.push(partial.regions);await reject(native,context,partial.regions);partial.regions.close()
        let workspace
        const waiting=abi.createNativeSurfaceMeasurementTask(native,context,{tight:true,previous:base.regions,sourceRevision:7,
          inputWorkspace:()=>workspace=new ImageryInputWorkspace(4000)})
        assert(waiting.step().waiting);waiting.cancel();assert(workspace.finished)
        assert(base.regions.state().handle.id,'Cancellation consumed the caller previous loan')
      }
      const before=abi.imageryInputPayloadBytes(),original=abi.module.call
      let last,steps=0,operations=0,grants=0
      abi.module.call=function(name,...args) {
        const result=original.call(this,name,...args)
        if(name==='terra_step_surface_measurement'&&result===0) {
          const p=args[args.length-1],v=this.refreshMemory().dataView
          last={phase:v.getUint32(p+12,true),operations:v.getUint32(p+16,true),copied:v.getUint32(p+52,true)}
          operations+=last.operations;++steps;if(args[6])++grants
          assert(last.operations<=37,'Refinement ignored its work quantum')
        }
        return result
      }
      let actual
      try {
        actual=await abi.createNativeSurfaceMeasurementTask(native,context,{tight:true,previous:base.regions,
          sourceRevision:7,viewRevision:901,maximumOperations:37,maximumMilliseconds:0}).run()
      }finally{abi.module.call=original}
      owned.push(actual.regions)
      assert.strictEqual(actual.viewRevision,901,'Exact projection reuse confused view transport revisions')
      assert.strictEqual(actual.visible,expected.visible);assert.strictEqual(actual.refinable,false)
      equal(actual.pixelsPerUv,expected.pixelsPerUv,'Refined summary')
      if(scene.name==='projective') {
        assert(last.phase===6&&last.copied===0&&!grants,'Already projective input was remeasured or copied')
        assert(abi.imageryInputPayloadBytes()-before<abi.module.call('terra_surface_measurement_work_bytes'),
          'Already projective input allocated another canonical region array')
      }
      base.regions.close()
      const lease=ledger.reserve('refinement-test-mirror',actual.regions.length*176);assert(lease)
      let data=new Uint8Array(lease.bytes),mirror
      try {
        for(let first=0;first<actual.regions.length;first+=256)
          actual.regions.copyTo(data,first*176,first,Math.min(256,actual.regions.length-first))
        mirror=adoptMeasurementRows(data,lease);data=null
        assert.strictEqual(mirror.rows.length,expected.regions.length,'Selective merge changed full surface row count')
        for(let i=0;i<mirror.rows.length;++i) {
          const row=expected.regions[i],b=row.uv
          for(const cell of [b,{minimumU:b.minimumU,maximumU:(b.minimumU+b.maximumU)/2,
            minimumV:b.minimumV,maximumV:(b.minimumV+b.maximumV)/2}])
            equal(kernel.error(mirror.rows,i,cell),surface.regionError(row,cell),'Selective merge local error')
        }
      }finally {data=null;if(mirror)mirror.release();else lease.release()}
      const draw=new ImageryAdapter(descriptor).prepareDraw(fixture.draw)
      const options={descriptor,targetPixelError:1.25,maximumTextures:64,maximumDraws:512,detached:true}
      const planned=abi.planImagery([draw],()=>actual,options),oracle=abi.createImageryPlanner()
      try {
        const reference=oracle.plan([draw],()=>({...expected,bounds:fixture.model.bounds,hull:fixture.model.hull}),options)
        const signature=p=>p.draws.map(d=>[d.texture.level,d.texture.row,d.texture.column].join('/')).sort()
        assert.deepStrictEqual(signature(planned),signature(reference),'Selective merge changed the complete imagery cut')
      }finally{oracle.destroy();abi.resetImagery()}
      actual.regions.close()
      records.push({name:scene.name,...counts,outputRows:actual.regions.length,steps,operations,workGrants:grants})
    }
  }finally {
    kernel.close();for(const rows of owned)rows.close();for(const model of models)model.close()
  }
  return records
}
