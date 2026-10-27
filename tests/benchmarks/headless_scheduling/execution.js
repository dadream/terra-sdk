'use strict'
const assert=require('assert'),fs=require('fs')
const {performance}=require('perf_hooks')
const createOwner=require('../../wasm/support/terrain_owner')
const {MeshFrames}=require('../../../sdk/js/terrain/terra_mesh_frames')
const {releaseMeasurements}=require('../../../sdk/js/terrain/measurement_rows')
const {ResourceLedger}=require('../../../sdk/js/resources/resource_ledger')
const {LocalTerrainExecution}=require('../../../adapters/wasm/local_terrain_execution')
const {cameraSnapshot}=require('../../../sdk/js/camera/terra_camera_snapshot')
const {deriveFrameBudget,terrainResourceBudget,validateManifest}=require('../../../sdk/js/core/terra_globe_common')
const {TIANDITU_TEXTURE}=require('../../../sdk/js/imagery/terra_imagery_profiles')
const {createResourcePolicy}=require('../../../sdk/js/resources/resource_policy')
const {meshCutBytes}=require('../../../sdk/js/resources/mesh_coordinates')
const {cameraForPose,verifySnapshot}=require('./camera')

// Actual production executors with an explicit CPU-only consumer. Acceptance
// releases the old logical cut; it does not simulate a renderer/GPU receipt.
// Images are nominally available. No texture uploads or image budget claims.
async function run({wasm,worker,config,poses,records,signal,capacity,resourceOptions={},onStage}) {
  assert.strictEqual(capacity,'production','Execution must use an explicit production resource policy')
  const viewport={...config.viewport,fovRadians:config.verticalFovRadians}
  const frameBudget=deriveFrameBudget(viewport,{}, {terrainPixelError:config.terrainPixelError,
    verticalFovRadians:config.verticalFovRadians})
  const policy=createResourcePolicy({maximumResourceBytes:config.maximumManagedBytes,...resourceOptions},frameBudget)
  const budget=terrainResourceBudget(config.patchDimension,{...frameBudget,...policy},{
    maximumChangeCount:config.maximumTopologyChanges,maximumPriorityUpdateCount:256,maximumElapsedMs:4})
  const ledger=new ResourceLedger(policy.maximumResourceBytes)
  const frames=new MeshFrames(ledger,'benchmark-logical-cut')
  const manifest=validateManifest({...records.manifest,textures:[TIANDITU_TEXTURE]},TIANDITU_TEXTURE.id)
  const imagery={descriptor:manifest.texture,targetPixelError:config.imageryPixelError,
    maximumTextures:65536,maximumDraws:262144,maximumPartitionBytes:64*1024*1024,
    devicePixelRatio:1,terrainBound:false,refineBounds:true}
  const owner=await createOwner(wasm,worker)
  const modelAttempts=new Map()
  if(!worker) {
    const create=owner.createNativeSurfaceModelTask
    owner.createNativeSurfaceModelTask=function(draw,options) {
      const value=create.call(this,draw,options)
      modelAttempts.set(draw.resourceId,(modelAttempts.get(draw.resourceId)||0)+1)
      return value
    }
  }
  let camera,revision=0,execution
  const result={backend:worker?'worker':'direct',capacity,resourcePolicy:policy,terrainBudget:budget,
    maximumManagedBytes:ledger.maximumBytes,stages:[],complete:false}
  const stop=()=>{try{if(execution)execution.destroy()}finally{owner.destroy()}}
  signal.addEventListener('abort',stop,{once:true})
  const planning=()=>worker?owner.imageryPlanning:execution.imageryPlanning
  const view=()=>({revision,camera,viewport,snapshot:cameraSnapshot(manifest,camera,viewport)})
  const check=deadline=>{
    signal.throwIfAborted()
    assert(performance.now()<deadline,'Stage exceeded 60s wall-clock diagnostic guard')
  }
  const feed=async requests=>{
    for(const request of requests) {
      signal.throwIfAborted()
      const k=request.key,key=[k.level,k.i,k.j,k.k]
      await records.serve({type:'request',kind:request.kind,key},signal)
      const row=records.records.get([request.kind,...key.slice(1)].join('/'))
      if(row.status===404)await owner.noDataRecord(k)
      else {
        const fd=fs.openSync(row.file,'r'),bytes=Buffer.alloc(row.bytes)
        try {assert.strictEqual(fs.readSync(fd,bytes,0,bytes.length,row.offset),bytes.length)}
        finally {fs.closeSync(fd)}
        await owner.submitRecord(request.kind,k,bytes)
      }
    }
  }
  frames.evaluateCandidate=async (packet,forecast)=>{
    assert(forecast.candidateReady&&forecast.imageryPlan.quality.coverageGuaranteed,
      'Logical cut has no complete measured imagery cover')
    const credit=ledger.reserve('benchmark-logical-output',0)
    return {credit,valid:()=>true,release:()=>credit.release()}
  }
  try {
    owner.setResourceLedger(ledger)
    await owner.loadManifest(manifest,policy.maximumTerrainMeshBytes)
    owner.setViewport(viewport.width,viewport.height,viewport.fovRadians)
    if(!worker)execution=new LocalTerrainExecution(owner,frames,manifest,view)
    for(const pose of poses) {
      const started=performance.now(),deadline=started+60000,cpu=process.cpuUsage()
      const stage={id:pose.id,status:'running',turns:0,recordRequests:0,recordWallMs:0,
        maximumStepWallMs:0,maximumTopologyChanges:0,imageryCalls:0,maximumImageryCallWallMs:0}
      result.stages.push(stage)
      camera=cameraForPose(pose)
      ++revision
      owner.setGlobeTarget(camera.longitudeDegrees,camera.latitudeDegrees);owner.setCamera(camera)
      stage.cameraCheck=verifySnapshot(config,pose,owner.getCameraSnapshot())
      if(execution)execution.observeView()
      let stable=0,packet,priorIdentity
      try {
        for(;stage.turns<4096;++stage.turns) {
          check(deadline)
          const before=performance.now()
          packet=worker?await owner.step(frameBudget.lodThreshold,budget,frames,imagery):
            await execution.step(frameBudget.lodThreshold,budget,{viewRevision:revision,imagery})
          stage.maximumStepWallMs=Math.max(stage.maximumStepWallMs,performance.now()-before)
          try {await owner.presentFrame(packet.frame.sequence);assert(frames.present(packet.frame.sequence))}
          finally {releaseMeasurements(packet.measurements)}
          stage.terrain=packet.updateState
          stage.maximumTopologyChanges=Math.max(stage.maximumTopologyChanges,packet.updateState.topologyChangeCount)
          const requests=packet.requests||[],inputAt=performance.now()
          await feed(requests)
          stage.recordWallMs+=performance.now()-inputAt;stage.recordRequests+=requests.length
          const s=packet.updateState
          const idle=!requests.length&&!s.pendingPriorityUpdateCount&&!s.topologyChangeCount&&!s.pendingMeshGroups
          stable=idle&&priorIdentity===packet.meshIdentity?stable+1:0
          priorIdentity=packet.meshIdentity
          if(stable>=2){++stage.turns;break}
        }
        assert(stable>=2,'Terrain did not settle within the turn guard')
        stage.terrainTargetMet=stage.terrain.achievedLodError<=frameBudget.lodThreshold*1.001
        stage.terrainKeys=packet.draws.map(d=>[d.key.level,d.key.i,d.key.j,d.key.k,d.fragment].join('/')).sort()
        stage.publishedCutMeshBytes=meshCutBytes(packet.draws)
        let settled
        for(let n=0;n<4096;++n) {
          check(deadline)
          const before=performance.now()
          settled=worker?await owner.planImagery(packet.frame.sequence,imagery,()=>{}):
            await execution.planImagery(packet.frame.sequence,imagery)
          ++stage.imageryCalls
          stage.maximumImageryCallWallMs=Math.max(stage.maximumImageryCallWallMs,performance.now()-before)
          try {
            if(!settled.pending&&!settled.continuation) {
              assert(settled.imageryPlan&&settled.imageryPlan.quality.planningComplete)
              stage.imageryQuality={...settled.imageryPlan.quality}
              stage.imageryKeys=[...new Set(settled.imageryPlan.draws.map(d=>JSON.stringify(d.texture)))].sort()
              break
            }
          } finally {releaseMeasurements(settled.measurements)}
        }
        assert(stage.imageryQuality,'Imagery did not settle within the turn guard')
        stage.planning=JSON.parse(JSON.stringify(planning()))
        // Query the SAME accepted cut and camera once more. A persistent model
        // cache must not rebuild geometry just to answer a completed request.
        const again=worker?await owner.planImagery(packet.frame.sequence,imagery,()=>{}):
          await execution.planImagery(packet.frame.sequence,imagery)
        try {
          assert(again.imageryPlan&&again.imageryPlan.quality.planningComplete)
          stage.repeatPlanning=JSON.parse(JSON.stringify(planning()))
          for(const key of ['modelsBuilt','measurements','refinements','bounds'])
            assert.strictEqual(stage.repeatPlanning.work.nativeMeasurements[key],stage.planning.work.nativeMeasurements[key],
              'An unchanged completed request repeated Native work: '+key)
        }finally {releaseMeasurements(again.measurements)}
        stage.status=stage.terrain.limitedByCapacity?'terrain-capacity-limited':
          !stage.terrainTargetMet?'terrain-precision-limited':
          !stage.imageryQuality.meetsTarget?'imagery-precision-limited':'ready'
      } catch(error) {
        stage.status=error.status===9?'capacity-refused':'failed'
        stage.error=error.message;stage.errorStack=error.stack
        stage.planning=planning()&&JSON.parse(JSON.stringify(planning()))
      }
      stage.wallMs=performance.now()-started
      const consumed=process.cpuUsage(cpu)
      stage.processCpuMs=(consumed.user+consumed.system)/1000
      stage.resources=ledger.stats()
      stage.wasmHeapBytes=owner.memoryBytes()
      stage.modelSourceAttempts=worker?null:{uniqueSources:modelAttempts.size,
        attempts:[...modelAttempts.values()].reduce((a,b)=>a+b,0),
        rebuiltSources:[...modelAttempts.values()].filter(count=>count>1).length,
        maximumAttemptsPerSource:Math.max(0,...modelAttempts.values())}
      if(onStage)await onStage(stage,result)
      if(['failed','capacity-refused'].includes(stage.status))break
    }
    result.complete=result.stages.length===poses.length&&result.stages.every(s=>!['failed','capacity-refused'].includes(s.status))
  } finally {
    signal.removeEventListener('abort',stop)
    const errors=[]
    for(const action of [()=>execution&&execution.destroy(),()=>frames.clear(),()=>owner.destroy(),()=>owner.termination])
      try {await action()}catch(error){errors.push(error)}
    result.cleanup={ownerDestroyed:owner.destroyed===true,workerTerminated:worker?Boolean(owner.termination):null,
      ledgerBytes:ledger.bytes,networkRequests:records.network.requests,errors:errors.map(error=>error.message)}
    assert.strictEqual(ledger.bytes,0,'Execution retained managed payloads after teardown')
    if(errors.length)throw errors[0]
  }
  return result
}
module.exports={run}
