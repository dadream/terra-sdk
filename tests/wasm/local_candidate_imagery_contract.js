const assert = require('assert')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {LocalTerrainExecution} = require('../../adapters/wasm/local_terrain_execution')
const {cameraSnapshot} = require('../../sdk/js/camera/terra_camera_snapshot')
const {preparedPartitionBytes, createPreparedPartitionBatch} = require('../../adapters/wasm/prepared_partitions')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')

module.exports = async function(source, manifest, record) {
  const globals = ['Worker','MessageChannel','structuredClone'].map(name => [name,global[name]])
  const abi = new TerraAbi(source.module)
  const frames = new MeshFrames()
  const viewport = {width:640,height:360,fovRadians:Math.PI/6}
  const camera = {longitudeDegrees:116.5623,latitudeDegrees:40.74863,distance:20000000,tiltRadians:0,yawRadians:0}
  let revision = 1, commits = 0, refused = true, malformed = true, rejectCommit = false, evaluations = 0, progressive = 0, forecastDraws
  const execution = new LocalTerrainExecution(abi,frames,manifest,() => ({revision,camera:{...camera},viewport,
    snapshot:cameraSnapshot(manifest,camera,viewport)}))
  const budget = {maximumChangeCount:16,maximumPriorityUpdateCount:256,maximumElapsedMs:0}
  const imagery = {descriptor:manifest.texture,targetPixelError:1.25,maximumTextures:128,
    maximumDraws:4096,maximumPartitionBytes:4*1024*1024,devicePixelRatio:1,terrainBound:false}
  const commit = abi.commitMeshFrame
  abi.commitMeshFrame = function(packet) {
    if(rejectCommit){rejectCommit=false;throw Object.assign(new Error('injected native commit refusal'),{status:9})}
    ++commits; return commit.call(this,packet)
  }
  const step = options => execution.step(1,budget,{viewRevision:revision,imagery:options})
  const present = packet => {
    try{abi.presentFrame(packet.frame.sequence);frames.present(packet.frame.sequence)}
    finally{releaseMeasurements(packet.measurements)}
  }
  try {
    for (const [name] of globals) global[name]=undefined
    abi.loadManifest(manifest)
    abi.setViewport(viewport.width,viewport.height,viewport.fovRadians)
    abi.setGlobeTarget(camera.longitudeDegrees,camera.latitudeDegrees)
    abi.setCamera(camera)
    const initial = await step()
    present(initial)
    for (const request of initial.requests) if (request.kind === 1) await abi.submitRecord(request.kind,request.key,record)
    frames.evaluateCandidate = async (packet, forecast) => {
      ++evaluations
      assert.strictEqual(frames.candidate,null)
      assert.strictEqual(frames.presented,initial)
      assert.strictEqual(commits,1,'Local native candidate committed before imagery admission')
      assert(forecast.candidateReady && forecast.imageryPlan.quality.coverageGuaranteed)
      assert(forecast.imageryPlan.draws.length && forecast.measurements.length)
      assert.throws(() => abi.presentFrame(packet.frame.sequence),'Private candidate accepted a display receipt')
      const draw = packet.draws.find(draw => !(draw.flags & 1))
      const scratch = frames.ledger.reserve('fixture-pricing',preparedPartitionBytes(draw))
      const rows = [{draw,cells:[{key:'quarter',sourceUv:true,
        bounds:{minimumU:0,maximumU:0.5,minimumV:0,maximumV:0.5}}]}]
      const task = createPreparedPartitionBatch(abi,packet.nativePlan.id,rows,
        frames.indices || execution.prepared.surface.indices,scratch.bytes,
        row => execution.preparedModel(packet.nativePlan.id,row.draw.resourceId))
      const priced=[]
      try {await task.run(rows => priced.push(...rows))} finally {task.cancel();scratch.release()}
      assert.strictEqual(priced[0].source,'resident','Local forecast rebuilt the private surface')
      if (refused) {refused=false;throw Object.assign(new Error('injected joint refusal'),{status:9})}
      if (malformed) {malformed=false;packet.additions[0].positions=new Float32Array(0)}
      forecastDraws=forecast.imageryPlan.draws
      const credit=frames.ledger.reserve('fixture-output',0)
      return {credit,valid:()=>true,release:()=>credit.release()}
    }
    await assert.rejects(step(imagery),error=>error.status===9)
    assert.strictEqual(commits,1)
    assert.strictEqual(frames.candidate,null)
    assert.strictEqual(execution.prepared,null)
    assert.strictEqual(execution.preparation.imageryJob,null)
    await assert.rejects(step(imagery),/Mesh transfer differs/)
    assert.strictEqual(commits,1,'Invalid consumer arrays reached native publication')
    assert.strictEqual(frames.candidate,null)
    const modelsBeforeRefusal=execution.preparation.measurementProduction.stats().models
    rejectCommit=true
    await assert.rejects(step(imagery),/injected native commit refusal/)
    assert.strictEqual(commits,1)
    assert.strictEqual(frames.candidate,null)
    assert.strictEqual(execution.preparation.measurementProduction.stats().models,modelsBeforeRefusal,
      'Failed publication retained model bindings on private host copies')
    const accepted=await step(imagery)
    assert.strictEqual(evaluations,4)
    assert.strictEqual(accepted.imageryPlan.draws,forecastDraws)
    assert.strictEqual(commits,2)
    present(accepted)
    imagery.refineBounds=true
    frames.evaluateCandidate=async (packet,forecast) => {
      assert(forecast.candidateReady && forecast.imageryPlan.quality.coverageGuaranteed)
      if (!forecast.imageryPlan.quality.planningComplete) ++progressive
      const credit=frames.ledger.reserve('fixture-output',0)
      return {credit,valid:()=>true,release:()=>credit.release()}
    }
    for (const distance of [1000000,20000000,100000,28000000]) {
      camera.distance=distance; ++revision; abi.setCamera(camera); execution.observeView()
      for (let i=0;i<3;++i) {
        const packet=await execution.step(0.002,budget,{viewRevision:revision,imagery})
        present(packet)
        let result
        for (let turn=0;turn<2048;++turn) {
          if(result)releaseMeasurements(result.measurements)
          result=await execution.planImagery(packet.frame.sequence,imagery)
          if (!result.pending && !result.continuation) break
        }
        try {
          assert(result.imageryPlan && result.imageryPlan.quality.planningComplete)
          assert.strictEqual(result.meshIdentity,packet.meshIdentity)
          assert.strictEqual(result.viewRevision,revision)
        }finally{releaseMeasurements(result.measurements)}
      }
    }
    assert(progressive>0,'Local fixture did not exercise publication before final precision')
    // An iterator can transfer ownership just before its async caller is
    // cancelled. Cancelling that finished iterator alone cannot retire it.
    const lease=frames.ledger.reserve('fixture-completed-preparation',16)
    const task=new CooperativeTask((function*(){return {release:()=>lease.release()}})())
    const pending=execution.runTask(task)
    execution.destroy()
    await assert.rejects(pending,/preparation was cancelled/)
    assert(!frames.ledger.leases.has(lease),'Cancelled completed preparation retained its resource')
  } finally {
    for (const [name,value] of globals) global[name]=value
    abi.commitMeshFrame=commit
    execution.destroy(); frames.clear(); abi.destroy()
  }
  assert.strictEqual(execution.tasks.size,0)
  for (const name of ['imageryInputBudget','imageryReferenceBudget','imageryOutputBudget'])
    assert.strictEqual(abi[name].credits.size,0)
  assert.strictEqual(frames.ledger.bytes,0,JSON.stringify(frames.ledger.stats().owners))
  console.log('Local private candidate admission, refusal, prepared UV reuse and scale continuation passed')
}
