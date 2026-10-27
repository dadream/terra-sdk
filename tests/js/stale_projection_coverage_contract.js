const assert=require('assert')
const {TerrainWorkerHost}=require('./reference/measurement_host_fixture')
const {CooperativeTask}=require('../../sdk/js/runtime/cooperative_task')
const surface=require('../../sdk/js/terrain/terra_surface_plan')

module.exports=async function() {
  const original=surface.surfaceMeasurements,clock=Date.now
  let exact=0,now=0,firstCurrentFit
  Date.now=()=>now
  surface.surfaceMeasurements=function* (model,origin,context,bounds) {
    if(!bounds)++exact
    return {visible:true,pixelsPerUv:64,centerDistance:0,regions:[],refinable:bounds}
  }
  const host=new TerrainWorkerHost({holdSurface:()=>()=>{}})
  host.manifest={radius:6378000}
  host.abi={createImageryTask:draws=>new CooperativeTask((function*(){return {draws,levels:new Set(),
    quality:{planningComplete:true,meetsTarget:true,coverageGuaranteed:true,spatialCut:true}}})(),8)}
  const snapshot={projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}
  const view={revision:1,snapshot,camera:{distance:100},viewport:{width:400,height:400,fovRadians:1}}
  const imagery={descriptor:{kind:'global-geodetic',matrix_level_offset:1,minimum_level:0,maximum_level:8,
    tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]},
    maximumTextures:16,targetPixelError:1.25,refineBounds:true}
  const packet={frame:{sequence:1,...snapshot},draws:[{resourceId:1,origin:[0,0,0],flags:0,
    textureNode:{level:0,root:0,row:0,column:0}}],resources:new Map([[1,{model:{bounds:{},hull:[]}}]]),
    meshIdentity:'one',updateState:{modelRevision:1}}
  const message=()=>({...host.latestView,sequence:1,viewRevision:host.latestViewRevision,imagery})
  const untilComplete=async()=>{
    for(let i=0;i<50;++i){const result=await host.prepareImagery(packet,message());
      if(result.viewRevision===2&&result.imageryPlan&&result.imageryPlan.quality.demandReady&&firstCurrentFit===undefined)
        firstCurrentFit={exact,complete:result.imageryPlan.quality.planningComplete}
      if(!result.pending&&!result.continuation)return result}
    throw Error('Projection did not finish')
  }
  try {
    host.observeView(view)
    const plan=host.planImagery
    host.planImagery=async()=>({pending:true})
    await host.prepareImagery(packet,message());host.planImagery=plan
    ++now;host.observeView({...view,revision:2,camera:{distance:101}})
    const coverage=await untilComplete()
    assert.strictEqual(coverage.viewRevision,1,'Old coverage was mislabeled as current precision')
    assert.strictEqual(exact,0,'Already-passing obsolete bounds blocked first fitted coverage')
    assert.strictEqual(coverage.imageryPlan.quality.refinableMeasurementCount,1)
    const current=await untilComplete()
    assert.strictEqual(current.viewRevision,2)
    assert.deepStrictEqual(firstCurrentFit,{exact:0,complete:false},
      'Current globe held fitted coverage behind whole-view normalization')
    assert.strictEqual(exact,1,'Latest camera skipped required normalization')
    assert.strictEqual(current.imageryPlan.quality.refinableMeasurementCount,0)
  } finally {host.closeMeasurements();surface.surfaceMeasurements=original;Date.now=clock}
  console.log('Obsolete projection finishes safe coverage first; latest camera retains full normalization and actual view identity')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
