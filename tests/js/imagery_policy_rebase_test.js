const assert = require('assert')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

// Exercise the actual request handler, not only planImagery: a frozen camera
// snapshot must accept new planning policy while preserving projection work.
module.exports = async function verifyImageryPolicyRebase() {
  const clock = Date.now, measure = surface.surfaceMeasurements
  try {
    for (const candidate of [false,true]) for (const phase of ['measurement','input']) for (const [policy,before,after] of [
      ['maximumTextures',147,151],['maximumTextures',151,147],['devicePixelRatio',1,2]]) {
      const projectionChange=policy==='devicePixelRatio'
      let now=0, starts=0, steps=0, freed=0
      Date.now=()=>now
      surface.surfaceMeasurements=function* (model,origin,context,conservative) {
        if (conservative) return {visible:true,pixelsPerUv:Infinity,regions:[],refinable:false}
        ++starts
        for(let i=0;i<4;++i){++steps;now+=5;yield}
        return {visible:true,pixelsPerUv:64,regions:[],refinable:false}
      }
      const ledger=new ResourceLedger(64), host=new TerrainWorkerHost(), inputs=[], cancelled=[]
      const resource=ownPayload({model:{bounds:{},hull:[]}},ledger.reserve('fixture-mesh',8),8,()=>++freed)
      const snapshot={projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}
      const view={revision:1,snapshot,camera:{distance:100},viewport:{width:400,height:400,fovRadians:1}}
      const descriptor={kind:'global-geodetic',matrix_level_offset:1,minimum_level:0,maximum_level:8,
        tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]}
      const request=value=>({...view,type:'imagery',viewRevision:1,sequence:1,planId:candidate?1:undefined,
        imagery:{descriptor,maximumTextures:147,targetPixelError:1.25,devicePixelRatio:1,[policy]:value}})
      host.frames.presented={frame:{sequence:1,...snapshot},resources:new Map([[1,resource]]),
        draws:[{resourceId:1,flags:0,origin:[0,0,0],textureNode:{level:0,root:0,row:0,column:0}}],
        meshIdentity:'1',updateState:{modelRevision:1}}
      if(candidate)host.pendingMesh={planId:1,prepared:{surface:host.frames.presented}}
      host.manifest={radius:6378000};host.observeView(view)
      host.abi={createImageryTask(draws,measureDraw,options){
        inputs.push(options[policy])
        return new CooperativeTask((function*(){let done=false
          try {
            for(let i=0;i<4;++i){now+=5;yield}
            done=true
            return {draws,levels:new Set(),quality:{planningComplete:true,meetsTarget:false,
              limitedByTextureBudget:true,maximumTextureCount:options.maximumTextures,testPixelRatio:options.devicePixelRatio}}
          } finally {if(!done)cancelled.push(options[policy])}
        })(),Infinity,()=>now)
      }}
      const until=async(message,predicate)=>{
        for(let i=0;i<100;++i){const value=await host.handle(message);if(predicate(value))return value}
        throw new Error('Imagery policy fixture did not finish')
      }
      try {
        await until(request(before),()=>phase==='measurement'?steps>0:Boolean(host.imageryTask))
        const epoch=host.imageryJob
        const previousSteps=steps
        if(!projectionChange)resource.ownership.retire()
        assert.strictEqual(freed,0,'Pending projection lost its immutable input')
        const result=await until(request(after),value=>{
          if(value.pending||value.continuation) {
            if(projectionChange)assert.notStrictEqual(host.imageryJob,epoch,'A pixel ratio change reused old projection')
            else assert.strictEqual(host.imageryJob,epoch,'A planning allowance change discarded the projection epoch')
          }
          return value.imageryPlan&&value.imageryPlan.quality.planningComplete
        })
        assert.strictEqual(result.imageryPlan.quality[projectionChange?'testPixelRatio':'maximumTextureCount'],after,
          'New capacity request completed with the frozen job\'s old allowance')
        assert.deepStrictEqual(inputs,phase==='input'?[before,after]:[after])
        assert.deepStrictEqual(cancelled,phase==='input'?[before]:[])
        assert.strictEqual(starts,projectionChange?2:1,'Projection lifetime did not match the changed policy')
        assert.strictEqual(steps,projectionChange?previousSteps+4:4,'Projection slices were incorrectly reused or repeated')
      } finally {host.clearPlanning();resource.ownership.retire()}
      assert.strictEqual(freed,1)
      assert.strictEqual(ledger.bytes,0)
    }
  } finally {Date.now=clock;surface.surfaceMeasurements=measure}
  console.log('Worker policy growth/shrink preserves projection and current capacity; pixel ratio invalidates projection')
}

if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
