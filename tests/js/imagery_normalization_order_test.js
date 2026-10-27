const assert=require('assert')
const surface=require('../../sdk/js/terrain/terra_surface_plan')
const {TerrainWorkerHost}=require('./reference/measurement_host_fixture')

module.exports=async function() {
  const original=surface.surfaceMeasurements
  try {
    for(const [privateCandidate,partial] of [[false,false],[true,false],[true,true]]) {
      const host=new TerrainWorkerHost(),visits=[],cuts=[]
      let nativeInput
      const models=[{bounds:{},hull:[]},{bounds:{},hull:[]}]
      const draws=models.map((_,i)=>({resourceId:i+1,origin:[0,0,0],flags:0,
        textureNode:{level:0,root:i,row:0,column:0},texture:{level:1,matrix:2,row:0,column:i}}))
      const descriptor={kind:'global-geodetic',matrix_level_offset:1,bounds:[[-180,-90],[180,90]],
        minimum_level:0,maximum_level:19,tile_size:256,level_zero_columns:2,level_zero_rows:1}
      const message={imagery:{descriptor,maximumTextures:32,maximumDraws:32,targetPixelError:1.25,refineBounds:true},
        camera:{distance:1},viewport:{width:400,height:400}}
      const packet={frame:{sequence:1,projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},
        draws,resources:new Map(models.map((model,i)=>[i+1,{model}])),updateState:{modelRevision:1},meshIdentity:'1,2'}
      surface.surfaceMeasurements=function*(model,origin,context,bounds,tight) {
        visits.push([models.indexOf(model),bounds?'bound':tight?'tight':'loose'])
        return {pixelsPerUv:bounds?800:tight?100:400,visible:true,refinable:!tight,regions:[]}
      }
      host.abi={...require('./reference/imagery_task_fixture'),async planImageryAsync(source,measure,options) {
        // Native continuation resumes its committed input, not the current JS map.
        if(!options.continuation)nativeInput=source.map(draw=>measure(draw).refinable)
        cuts.push(nativeInput.slice())
        return {draws:source.map(draw=>({...draw,imageryPixelError:.5})),levels:new Set(),quality:{
          planningComplete:!(partial&&cuts.length===1),coverageGuaranteed:true,spatialCut:true,targetPixelError:1.25,meetsTarget:true}}
      }}
      host.imageryJob={coarsening:false,planId:privateCandidate?7:0,message:{planId:privateCandidate?7:0},
        exact:new Set(),precise:new Map(),releaseMeshes(){}}
      try {
        let value,published=!privateCandidate
        for(let i=0;i<100;++i) {
          value=await host.planImagery(packet,message)
          if(privateCandidate&&!published&&value.candidateReady) {
            assert(cuts[0].every(Boolean),'Private terrain lost its early complete fitted coverage')
            host.publishImageryCandidate(7);published=true
          }
          if(value.imageryPlan&&value.imageryPlan.quality.planningComplete&&!value.pending&&!value.continuation)break
        }
        assert(value.imageryPlan&&!value.pending&&!value.continuation,'Normalized demand did not finish')
        assert.strictEqual(value.imageryPlan.quality.refinableMeasurementCount,0)
        assert(cuts[0].every(Boolean),'Global coverage waited for whole-view exact measurement')
        assert.strictEqual(cuts.length,2,
          'Global normalization must follow one fitted coverage cut without fitting every exact tier')
        assert(cuts[cuts.length-1].every(value=>!value),'Published refinement resumed Native with obsolete measurement input')
        assert.deepStrictEqual(visits.filter(row=>row[1]!=='bound'),
          [[0,'loose'],[0,'tight'],[1,'loose'],[1,'tight']],
          'Required measurement tiers were separated by whole-view fitting or repeated')
        const count=visits.length
        await host.planImagery(packet,message)
        assert.strictEqual(visits.length,count,'Unchanged normalized demand repeated measurement')
      } finally {host.clearPlanning()}
    }
  } finally {surface.surfaceMeasurements=original}
  console.log('Imagery normalization: price global coverage first, finish exact tiers per mesh, reuse settled results')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
