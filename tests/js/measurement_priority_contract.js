const assert=require('assert')
const {TerrainWorkerHost}=require('./reference/measurement_host_fixture')
const {CooperativeTask}=require('../../sdk/js/runtime/cooperative_task')
const surface=require('../../sdk/js/terrain/terra_surface_plan')

module.exports=async function() {
  const original=surface.surfaceMeasurements,clock=Date.now,started=[],finished=[]
  let now=0,planned=[]
  Date.now=()=>now
  surface.surfaceMeasurements=function* (model,origin,context,boundsOnly) {
    started.push(model.id);now+=5;yield
    finished.push(model.id)
    return {visible:true,pixelsPerUv:boundsOnly?Infinity:64,centerDistance:0,regions:[],refinable:false}
  }
  const host=new TerrainWorkerHost({holdSurface:()=>()=>{}})
  host.abi={createImageryTask:draws=>new CooperativeTask((function*(){planned=draws.map(d=>d.resourceId);return {draws,levels:new Set(),
    quality:{planningComplete:true,meetsTarget:true,coverageGuaranteed:true,spatialCut:true}}})(),8)}
  const frame={sequence:1,projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}
  const draws=[1,2,3].map(resourceId=>({resourceId,origin:[0,0,0],flags:0,
    textureNode:{level:0,root:0,row:0,column:0}}))
  const resources=new Map([[1,2],[2,.8],[3,0]].map(([id,x])=>[id,{model:{id,bounds:{},hull:[],
    blocks:[{minimum:[x-.05,-.05,-.05],maximum:[x+.05,.05,.05],faces:[]}]}}]))
  const packet={frame,draws,resources,meshIdentity:'three',updateState:{modelRevision:1}}
  const message={sequence:1,viewRevision:1,snapshot:frame,camera:{distance:100},viewport:{width:400,height:400,fovRadians:1},
    imagery:{descriptor:{kind:'global-geodetic',matrix_level_offset:1,minimum_level:0,maximum_level:8,
      tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]},
      maximumTextures:16,targetPixelError:1.25,refineBounds:false}}
  try {
    await host.prepareImagery(packet,message)
    assert.strictEqual(started[0],3,'A short camera window measured off-screen storage order before its visible center')
    let complete=false
    for(let n=0;n<50;++n) {
      const result=await host.prepareImagery(packet,message)
      if(!result.pending&&!result.continuation){complete=true;break}
    }
    assert(complete,'Priority scheduling lost the complete measurement cut')
    assert.deepStrictEqual(started,[3,2,1,3,2,1],'Bounds/exact priority restarted or lost unchanged members')
    assert.deepStrictEqual(planned,[1,2,3],'Preview priority reordered the Native pyramid input')
    host.clearPlanning();started.length=0;finished.length=0
    message.imagery.descriptor.kind='planar-tms'
    message.imagery.descriptor.level_zero_columns=1
    host.imageryJob={coarsening:false,planId:0,message:{planId:0},
      exact:new Set(),precise:new Map(),releaseMeshes(){}}
    await host.planImagery(packet,message)
    assert.deepStrictEqual(started,[1])
    const changed={...packet,meshIdentity:'reordered',draws:[draws[1],draws[0],draws[2]]}
    complete=false
    for(let n=0;n<50;++n) {
      const result=await host.planImagery(changed,message)
      if(!result.pending&&!result.continuation){complete=true;break}
    }
    assert(complete,'Planar measurement continuation did not finish')
    assert.deepStrictEqual(finished,[2,1,3,2,1,3],
      'Planar bounds retained a separate priority queue instead of the shared streaming order')
    assert.deepStrictEqual(planned,[2,1,3])
  } finally {host.closeMeasurements();surface.surfaceMeasurements=original;Date.now=clock}
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
