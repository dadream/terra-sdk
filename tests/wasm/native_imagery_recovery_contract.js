const assert=require('assert')
const fs=require('fs')
const path=require('path')
const {TerraPlanarRuntime}=require('../../adapters/wasm/terra_globe_runtime')
const {FakeGl,FakeCanvas}=require('../js/support/webgl_fixture')
const {fnv1a64}=require('../../sdk/js/core/terra_globe_common')
const createOwner=require('./support/terrain_owner')

// Constant joint budget for actual native, host, images, UV and display work.
// Exercise the Direct/Worker continuation counterexample, not a proof of
// the global minimum or of every indivisible mountainous replacement group.
async function verify(bytes,worker,observe) {
  const abi=await createOwner(bytes,worker),gl=new FakeGl(),canvas=new FakeCanvas(gl),loaded=new Set()
  const records=['planar_root_record.bin','planar_root_detail_record.bin'].map(name=>
    fs.readFileSync(path.join(__dirname,'../../testdata/miniprogram/golden',name)))
  const manifest={schema:'terra.dataset-manifest',schema_version:1,dataset_id:'native-imagery-recovery',
    format_version:1,patch_dim:64,height_scale:1e-14,
    transform:{kind:'planar',bounds:[[0,0],[1025,1025]],radius:0},
    endpoints:{root:'/root/{i}/{j}/{k}',detail:'/detail/{i}/{j}/{k}'},
    textures:[{id:'fixture',kind:'planar-tms',url_template:'/image/{z}/{x}/{y}',
      matrix_level_offset:0,maximum_level:3,tile_size:64}]}
  const maximumResourceBytes=2*1024*1024,transitions=[]
  let runtime,requests=0,observations
  const turn=()=>new Promise(resolve=>setTimeout(resolve,2))
  try {
    runtime=await TerraPlanarRuntime.create({canvas,abi,manifest,planarLevel:0,maximumResourceBytes,
      serviceOrigin:'http://127.0.0.1',initialTarget:{x:600,y:400},initialTiltRadians:0,
      viewport:{width:640,height:360,devicePixelRatio:1},
      request(options) {
        ++requests
        const data=records[options.url.includes('/detail/')?1:0]
        return {promise:Promise.resolve({statusCode:200,
          data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),
          header:{'Content-Length':String(data.byteLength),'X-Terra-Checksum':'fnv1a64:'+fnv1a64(data)}}),abort(){}}
      }})
    for(const level of [0,1,0,1,0]) {
      if(level!==runtime.planarLevel) {
        runtime.planarLevel=level;await abi.setPlanarLevel(level);runtime.scheduleRefresh()
      }
      const start=Date.now();let completed=false
      while(Date.now()-start<30000) {
        for(const image of canvas.images)if(!loaded.has(image)&&image.onload) {
          loaded.add(image);image.width=image.height=64;image.onload()
        }
        assert.strictEqual(runtime.resourceLedger.maximumBytes,maximumResourceBytes)
        assert.strictEqual(runtime.resourceLedger.stats().overBudgetBytes,0)
        assert(!runtime.lastError,runtime.lastError)
        const shown=runtime.meshFrames.presented,quality=runtime.renderer.stats().quality
        if(shown&&shown.draws.length) {
          assert.strictEqual(quality.missingCount,0,'Native continuation lost resident coverage')
          assert(runtime.renderer.displaySurface.current.draws.length>0)
        }
        if(shown&&shown.draws.length===(level?4:2)&&quality.ready&&
            !runtime.refreshing&&!runtime.refreshPending) {
          assert(quality.planningComplete&&quality.targetMet&&quality.resolvedMaxPixelError<=1.25)
          assert(gl.calls.some(call=>call.name==='drawElements'),'Native continuation never reached drawing')
          transitions.push({level,ms:Date.now()-start,meshes:shown.draws.length,
            pixelError:quality.resolvedMaxPixelError,bytes:runtime.resourceLedger.bytes})
          if(observe)await observe({runtime,abi,worker,index:transitions.length})
          completed=true;break
        }
        await turn()
      }
      assert(completed,'Constant-budget native imagery continuation did not converge: '+JSON.stringify({
        worker,level,transitions,quality:runtime.renderer.stats().quality,
        capacity:runtime.state().terrainSelection.capacity,diagnostics:runtime.state().diagnostics,
        memory:runtime.resourceLedger.stats(),preparation:runtime.renderer.meshPreparationStats,
        imagery:{refreshing:runtime.imageryRefreshing,pending:runtime.imageryRefreshPending,
          waiting:runtime.imageryCapacityWait,planning:abi.imageryPlanning||runtime.localExecution&&runtime.localExecution.imageryPlanning}}))
    }
    const diagnostics=runtime.state().diagnostics
    for(const value of diagnostics) {
      assert(['imagery_input_capacity','terrain_mesh_capacity_pending'].includes(value.kind),JSON.stringify(value))
      assert(Number.isSafeInteger(value.detail.shortfallBytes)&&value.detail.shortfallBytes>0,
        'Capacity recovery must report an actual byte deficit: '+JSON.stringify(value))
    }
    assert(!runtime.meshCapacityBlocked&&!runtime.meshRecovery,'The complete round trip retained a capacity barrier')
    observations={worker,maximumResourceBytes,peakManagedBytes:runtime.resourceLedger.highWaterBytes,
      requests,transitions,diagnostics}
  } finally {
    if(runtime)runtime.destroy();else abi.destroy()
    if(abi.termination)await abi.termination
    await turn()
    if(runtime) {
      assert.strictEqual(runtime.resourceLedger.bytes,0,'Native grant continuation retained owned resources')
      assert(!runtime.renderer.resourceTimer&&!runtime.renderer.textures.retryTimers.size)
    }
  }
  return observations
}
module.exports=async bytes=>{
  const result=[]
  for(const worker of [false,true])result.push(await verify(bytes,worker))
  console.log('Direct/Worker native grants: constant 2MiB full-quality refinement/coarsening and zero teardown',JSON.stringify(result))
  return result
}
module.exports.verify=verify
if(require.main===module)module.exports(fs.readFileSync(process.argv[2])).catch(error=>{
  console.error(error);process.exitCode=1
})
