const assert=require('assert')
const fs=require('fs')
const path=require('path')
const {TerraPlanarRuntime}=require('../../adapters/wasm/terra_globe_runtime')
const {TerraWebGlRenderer}=require('../../adapters/webgl/terra_webgl_renderer')
const {fnv1a64}=require('../../sdk/js/core/terra_globe_common')
const {FakeCanvas,FakeGl}=require('../js/support/webgl_fixture')
const createOwner=require('./support/terrain_owner')

async function verify(bytes,worker) {
  const abi=await createOwner(bytes,worker),canvas=new FakeCanvas(new FakeGl()),loaded=new Set()
  const records=['planar_root_record.bin','planar_root_detail_record.bin'].map(name=>
    fs.readFileSync(path.join(__dirname,'../../testdata/miniprogram/golden',name)))
  const manifest={schema:'terra.dataset-manifest',schema_version:1,dataset_id:'world-admission',
    format_version:1,patch_dim:64,height_scale:1e-14,
    transform:{kind:'planar',bounds:[[0,0],[1025,1025]],radius:0},
    endpoints:{root:'/root/{i}/{j}/{k}',detail:'/detail/{i}/{j}/{k}'},
    textures:[{id:'fixture',kind:'planar-tms',url_template:'/image/{z}/{x}/{y}',
      matrix_level_offset:0,maximum_level:3,tile_size:64}]}
  // Constant from construction. This includes native measurement continuations;
  // it is not a claim about the global minimum or a transition-only ledger edit.
  const maximumResourceBytes=3*1024*1024,commandHeadroom=8192
  const successorMeshes=4
  let runtime,competitor,armed=false,requestCount=0,blockedAt,observations
  const receipts=[],quotes=[],diagnostics=[]
  const present=abi.presentFrame.bind(abi)
  abi.presentFrame=sequence=>{
    const candidate=runtime&&runtime.meshFrames.candidate
    if(candidate&&candidate.frame.sequence===sequence)receipts.push({sequence,meshes:candidate.draws.length,
      whileCompeting:Boolean(competitor),submitted:runtime.renderer.lastSubmittedSurface===runtime.renderer.current})
    return present(sequence)
  }
  const turn=()=>new Promise(resolve=>setTimeout(resolve,2))
  const wait=async(predicate,label)=>{
    const start=Date.now()
    while(Date.now()-start<30000) {
      for(const image of canvas.images)if(!loaded.has(image)&&image.onload) {
        loaded.add(image);image.width=image.height=64;image.onload()
      }
      assert.strictEqual(runtime.resourceLedger.maximumBytes,maximumResourceBytes)
      assert.strictEqual(runtime.resourceLedger.stats().overBudgetBytes,0)
      assert(!runtime.lastError,runtime.lastError)
      if(predicate())return Date.now()-start
      await turn()
    }
    assert.fail(label+': '+JSON.stringify({worker,state:runtime.state(),receipts,quotes,blockedAt}))
  }
  const ready=meshes=>runtime.meshFrames.presented&&runtime.meshFrames.presented.draws.length===meshes&&
    runtime.renderer.stats().quality.ready&&!runtime.refreshing&&!runtime.refreshPending
  const level=async value=>{
    runtime.planarLevel=value;await abi.setPlanarLevel(value);runtime.scheduleRefresh()
  }
  try {
    runtime=await TerraPlanarRuntime.create({canvas,abi,manifest,planarLevel:0,maximumResourceBytes,
      serviceOrigin:'http://127.0.0.1',initialTarget:{x:600,y:400},initialTiltRadians:0,
      viewport:{width:640,height:360,devicePixelRatio:1},
      onDiagnostic:(kind,detail)=>diagnostics.push({kind,detail}),
      rendererFactory(canvas,options) {
        // This target fits the shared capacity. The two-object GPU window
        // still slices uploads, but must not split its terrain successor.
        // mesh_group_contract covers real capacity refusals and local cuts.
        const r=new TerraWebGlRenderer(canvas,{...options,uploadBudgetObjects:2})
        const accept=r.setMeshFrame.bind(r)
        r.setMeshFrame=(frame,draws,...args)=>{
          const plan=r.meshOutputPlan,paid=plan&&plan.preparedWorld
          accept(frame,draws,...args)
          if(armed&&!competitor&&draws.length===successorMeshes) {
            armed=false
            blockedAt={sequence:frame.sequence,paid:Boolean(paid),
              worldBytes:plan&&plan.attempt.worldCutBytes,workPeak:plan&&plan.attempt.worldWorkPeakBytes}
            // All geometry and UV destinations already have their credits.
            // Leave only the known bounded command envelope, preventing a
            // second whole-world workspace from borrowing unpriced capacity.
            const available=r.resourceLedger.maximumBytes-r.resourceLedger.bytes-commandHeadroom
            assert(available>0,'Fixture cannot hold unrelated production')
            competitor=r.resourceLedger.reserve('fixture-unrelated-production',available)
            assert(competitor)
          }
        }
        return r
      },
      request(options) {
        ++requestCount
        const data=records[options.url.includes('/detail/')?1:0]
        return {promise:Promise.resolve({statusCode:200,
          data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),
          header:{'Content-Length':String(data.byteLength),'X-Terra-Checksum':'fnv1a64:'+fnv1a64(data)}}),abort(){}}
      }})
    await wait(()=>ready(2),'Initial constant-budget coverage did not converge')
    const prepare=runtime.meshFrames.prepareOutputs
    runtime.meshFrames.prepareOutputs=packet=>{
      const plan=prepare(packet)
      if(!plan)return plan
      const admit=plan.admit.bind(plan)
      plan.admit=async(...args)=>{
        const result=await admit(...args)
        if(result)quotes.push({meshes:args[0].draws.length,producer:args[1],
          requiredBytes:plan.attempt.requiredBytes,worldBytes:plan.attempt.worldCutBytes,
          worldWorkPeak:plan.attempt.worldWorkPeakBytes,prepaid:Boolean(plan.preparedWorld)})
        return result
      }
      return plan
    }
    armed=true
    await level(1)
    const handoffMs=await wait(()=>receipts.some(value=>value.meshes===successorMeshes&&value.whileCompeting),
      'A paid display successor waited for another whole-world allocation')
    assert(blockedAt&&blockedAt.paid&&blockedAt.worldBytes>0,'Output omitted display-cut admission')
    assert(runtime.renderer.worldDisplay.stats.prepaidInstalls>0,'Paid display successor was not adopted')
    assert.strictEqual(runtime.renderer.stats().quality.missingCount,0)
    assert(receipts.some(value=>value.meshes===successorMeshes&&value.submitted),'Acknowledgement preceded real drawing')
    assert(!receipts.some(value=>value.meshes===3),'Upload window split a funded target')
    competitor.release();competitor=null
    const fineMs=await wait(()=>ready(4),'Fine precision did not resume after the actual refund')
    const transitions=[]
    for(const value of [0,1,0]) {
      await level(value)
      const ms=await wait(()=>ready(value?4:2),'Constant-budget round trip did not converge')
      transitions.push({level:value,ms,pixelError:runtime.renderer.stats().quality.resolvedMaxPixelError})
    }
    assert(quotes.length&&quotes.every(value=>value.prepaid&&value.worldBytes>0),
      'A real new-mesh transaction omitted its display successor')
    assert(diagnostics.every(value=>value.kind==='imagery_input_capacity'),JSON.stringify(diagnostics))
    observations={worker,maximumResourceBytes,peakManagedBytes:runtime.resourceLedger.highWaterBytes,
      commandHeadroom,blockedAt,handoffMs,fineMs,transitions,quotes,requestCount,
      prepaidInstalls:runtime.renderer.worldDisplay.stats.prepaidInstalls}
  } finally {
    if(competitor)competitor.release()
    if(runtime)runtime.destroy();else abi.destroy()
    if(abi.termination)await abi.termination
    await turn()
    if(runtime) {
      assert.strictEqual(runtime.resourceLedger.bytes,0,'Joint display/terrain ownership survived teardown')
      assert(!runtime.renderer.resourceTimer&&!runtime.renderer.textures.retryTimers.size)
    }
  }
  return observations
}
module.exports=async bytes=>{
  const result=[]
  for(const worker of [false,true])result.push(await verify(bytes,worker))
  console.log('Wasm/Worker paid world handoff, funded full receipts and constant-budget round trips',JSON.stringify(result))
  return result
}
module.exports.verify=verify
if(require.main===module)module.exports(fs.readFileSync(process.argv[2])).catch(error=>{
  console.error(error);process.exitCode=1
})
