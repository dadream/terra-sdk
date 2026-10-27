const assert=require('assert'),fs=require('fs'),path=require('path')
const {TerraAbi}=require('../../adapters/wasm/terra_abi')
const {LocalTerrainExecution}=require('../../adapters/wasm/local_terrain_execution')
const {MeshFrames}=require('../../sdk/js/terrain/terra_mesh_frames')
const {cameraSnapshot}=require('../../sdk/js/camera/terra_camera_snapshot')
const {releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')

// Four real planar meshes share one source image. Every loose measurement
// needs tightening, leaving the active map empty between precision passes.
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
  let execution,packet,result
  const present=value=>{try{abi.presentFrame(value.frame.sequence);frames.present(value.frame.sequence)}finally{releaseMeasurements(value.measurements)}}
  try {
    abi.loadManifest(manifest);abi.setPlanarLevel(1);abi.setPlanarTarget(camera.x,camera.y)
    abi.setViewport(viewport.width,viewport.height,viewport.fovRadians);abi.setCamera(camera)
    execution=new LocalTerrainExecution(abi,frames,manifest,()=>({revision:1,camera,viewport,
      snapshot:cameraSnapshot(manifest,camera,viewport)}))
    for(let turn=0;turn<8;++turn) {
      packet=await execution.step(1,budget,{viewRevision:1})
      for(const request of packet.requests)abi.submitRecord(request.kind,request.key,fs.readFileSync(path.join(__dirname,
        '../../testdata/miniprogram/golden',request.kind===1?'planar_root_record.bin':'planar_root_detail_record.bin')))
      present(packet)
      if(packet.draws.length===4&&!packet.requests.length)break
    }
    assert.strictEqual(packet.draws.length,4)
    for(let turn=0;turn<2048;++turn) {
      if(result)releaseMeasurements(result.measurements)
      result=await execution.planImagery(packet.frame.sequence,imagery)
      if(!result.pending&&!result.continuation)break
    }
    assert(result.imageryPlan&&result.imageryPlan.quality.planningComplete)
    const production=execution.preparation.measurementProduction.stats()
    assert(production.refinements>=4,'Fixture did not tighten all four planar meshes')
    assert.strictEqual(execution.preparation.measurementSourceRevision,1,
      'Same-view precision passes invented a new projection identity')
    assert(Array.from(execution.preparation.imageryMeasurements.values()).every(value=>!value.refinable))
    require('./native_model_handoff_contract')(abi,frames)
    await require('./native_source_lifetime_contract')({abi,frames,execution,packet,imagery,budget,present})
    await require('./native_source_binding_contract')(abi,frames,budget)
    console.log('Real Native planar preparation: empty active map preserves projection identity through complete tightening')
  }finally {
    if(result)releaseMeasurements(result.measurements)
    if(execution)execution.destroy()
    frames.clear();abi.destroy()
  }
  assert.strictEqual(frames.ledger.bytes,0)
}
