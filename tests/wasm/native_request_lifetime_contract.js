const assert=require('assert'),fs=require('fs'),path=require('path')
const {TerraAbi}=require('../../adapters/wasm/terra_abi')
const {LocalTerrainExecution}=require('../../adapters/wasm/local_terrain_execution')
const {MeshFrames}=require('../../sdk/js/terrain/terra_mesh_frames')
const {cameraSnapshot}=require('../../sdk/js/camera/terra_camera_snapshot')
const {releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')

// Publish a different real cut during a request's first cooperative host wait.
// The former wait preceded epoch ownership; the owned checkpoint must keep the
// selected source valid without duplicating its Native allocation.
module.exports=async function(module) {
  const abi=new TerraAbi(module),frames=new MeshFrames()
  const descriptor={kind:'planar-tms',matrix_level_offset:0,minimum_level:0,maximum_level:0,
    tile_size:256,level_zero_columns:1,level_zero_rows:1,bounds:[[0,0],[1025,1025]]}
  const manifest={formatVersion:1,patchDimension:64,transform:'planar',heightScale:0.0000976563,
    minimumU:0,minimumV:0,maximumU:1025,maximumV:1025,radius:0,texture:descriptor}
  const camera={x:512.5,y:512.5,distance:2296.4303426508686,tiltRadians:-Math.PI/4,yawRadians:0}
  const viewport={width:640,height:360,fovRadians:Math.PI/6}
  const imagery={descriptor,targetPixelError:1.25,maximumTextures:1,maximumDraws:1024,
    maximumPartitionBytes:4*1024*1024,devicePixelRatio:1,terrainBound:false,refineBounds:true}
  const budget={maximumChangeCount:16,maximumPriorityUpdateCount:256,maximumElapsedMs:0}
  const execution=new LocalTerrainExecution(abi,frames,manifest,()=>({revision:1,camera,viewport,
    snapshot:cameraSnapshot(manifest,camera,viewport)}))
  const records=[0,1].map(detail=>fs.readFileSync(path.join(__dirname,'../../testdata/miniprogram/golden',
    detail?'planar_root_detail_record.bin':'planar_root_record.bin')))
  const publish=async level=>{
    abi.setPlanarLevel(level)
    for(let turn=0;turn<8;++turn) {
      const packet=await execution.step(1,budget,{viewRevision:1})
      for(const request of packet.requests)abi.submitRecord(request.kind,request.key,records[request.kind===1?0:1])
      try{abi.presentFrame(packet.frame.sequence);frames.present(packet.frame.sequence)}
      finally{releaseMeasurements(packet.measurements)}
      if(packet.draws.length===(level?4:2)&&!packet.requests.length)return packet
    }
    throw new Error('Request lifetime fixture did not publish its terrain cut')
  }
  let pending,resume,restoreWait,restorePlan,result
  try {
    abi.loadManifest(manifest);abi.setPlanarTarget(camera.x,camera.y)
    abi.setViewport(viewport.width,viewport.height,viewport.fovRadians);abi.setCamera(camera)
    await publish(0)
    for(const [index,mode] of ['complete','cancel','failure','destroy'].entries()) {
      execution.preparation.closeMeasurements()
      const source=frames.candidate||frames.presented,oldIds=new Set(source.resources.keys())
      let retired=0
      for(const resource of source.resources.values())resource.ownership.addRelease(()=>++retired)
      const before=abi.meshPayloadBytes()
      restoreWait=execution.turn.wait
      let first=true
      execution.turn.wait=function(){
        if(!first)return restoreWait.call(this)
        first=false
        return new Promise(resolve=>{resume=resolve})
      }
      pending=execution.planImagery(source.frame.sequence,imagery)
      pending.catch(()=>{}) // Observe below, including fixture failure paths.
      assert(resume,'Fixture did not reach the first host wait')
      assert.strictEqual(abi.meshPayloadBytes(),before,'A request loan charged its Native payload twice')
      const successor=await publish(index%2?0:1)
      assert(successor.draws.every(draw=>!oldIds.has(draw.resourceId)))
      assert([...oldIds].every(id=>!frames.resources.has(id)))
      abi.trimMeshCache(0)
      restorePlan=execution.preparation.planImagery
      const retiredBeforeResume=retired
      if(mode==='cancel')execution.cancelImagery()
      if(mode==='destroy')execution.destroy()
      if(mode==='failure')execution.preparation.planImagery=async()=>{throw new Error('injected request failure')}
      resume();resume=null
      if(mode==='failure')await assert.rejects(pending,/injected request failure/)
      else {
        result=await pending
        if(mode==='complete') {
          for(let turn=0;result.pending||result.continuation;++turn) {
            assert(turn<2048,'Frozen request did not finish')
            releaseMeasurements(result.measurements)
            result=await execution.planImagery(successor.frame.sequence,imagery)
          }
          assert(result.imageryPlan&&result.imageryPlan.quality.planningComplete)
        }else assert(result.superseded)
      }
      assert.strictEqual(retiredBeforeResume,0,'The request source retired before its epoch adopted ownership')
      pending=null
      if(result)releaseMeasurements(result.measurements)
      result=null
      execution.preparation.planImagery=restorePlan;restorePlan=null
      execution.turn.wait=restoreWait;restoreWait=null
      assert.strictEqual(retired,oldIds.size,`${mode} retained its selected host source`)
      abi.trimMeshCache(0)
      for(const id of oldIds)assert.strictEqual(abi.nativeCall('terra_acquire_mesh_resource',abi.context,id),2,
        `${mode} retained its selected Native source`)
      assert.strictEqual(execution.planning,false)
    }
  }finally {
    if(resume)resume()
    if(pending){try{const value=await pending;releaseMeasurements(value.measurements)}catch(_) {}}
    if(result)releaseMeasurements(result.measurements)
    if(restoreWait)execution.turn.wait=restoreWait
    if(restorePlan)execution.preparation.planImagery=restorePlan
    execution.destroy();frames.clear();abi.destroy()
  }
  assert.strictEqual(frames.ledger.bytes,0,'Request lifetime left resource credit after teardown')
  console.log('Direct request source: first host wait, terrain replacement, Native trim, completion/cancel/error/destroy and zero teardown passed')
}

if(require.main===module) {
  const loader=require('../../adapters/wasm/terra_wasm')
  loader.instantiateTerraWasmBytes(fs.readFileSync(process.argv[2])).then(module.exports).catch(error=>{
    console.error(error.stack||error);process.exitCode=1
  })
}
