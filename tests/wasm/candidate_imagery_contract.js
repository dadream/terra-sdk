const assert = require('assert')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')

module.exports = async function verifyCandidateImagery(client, manifest, record) {
  const frames = new MeshFrames()
  const budget = {maximumChangeCount:16, maximumPriorityUpdateCount:256, maximumElapsedMs:0}
  const imagery = {descriptor:manifest.texture, targetPixelError:1.25, maximumTextures:128,
    maximumDraws:4096, maximumPartitionBytes:4*1024*1024, devicePixelRatio:1, terrainBound:false}
  let evaluations = 0, refused = true, forecastDraws
  const send = client.send, messages = []
  client.send = async function(message,...args) {
    messages.push([message.type,message.sequence,message.planId])
    const value = await send.call(this,message,...args)
    if (message.type==='step') messages.push(['selected',value.sequence,value.nativePlan && value.nativePlan.id])
    return value
  }
  const present = async packet => {
    try {await client.presentFrame(packet.frame.sequence);frames.present(packet.frame.sequence)}
    finally {releaseMeasurements(packet.measurements)}
  }
  try {
    await client.loadManifest(manifest)
    client.setViewport(640,360,Math.PI/6)
    client.setGlobeTarget(116.5623,40.74863)
    client.setCamera({distance:20000000,tiltRadians:0,yawRadians:0})
    const initial = await client.step(1,budget,frames)
    await present(initial)
    for (const request of initial.requests) if (request.kind===1)
      await client.submitRecord(request.kind,request.key,record)
    frames.evaluateCandidate = async (packet, forecast) => {
      ++evaluations
      assert.strictEqual(frames.candidate,null,'Candidate reached host publication before joint acceptance')
      assert.strictEqual(frames.presented,initial)
      assert(forecast.imageryPlan.quality.planningComplete && forecast.imageryPlan.quality.meetsTarget)
      assert(forecast.imageryPlan.draws.length && forecast.measurements.length)
      assert(forecast.imageryPlan.draws.every(draw=>packet.draws.some(mesh=>mesh.resourceId===draw.resourceId)))
      await assert.rejects(client.presentFrame(packet.frame.sequence),/Stale Worker frame receipt/,
        'Private forecast was already publishable')
      const draw=packet.draws.find(draw=>!(draw.flags&1)), rows=[]
      const scratch=frames.ledger.reserve('fixture-pricing',
        require('../../adapters/wasm/prepared_partitions').preparedPartitionBytes(draw))
      const task=client.createMeshPartitionPlanTask(packet.nativePlan.id,[{draw,cells:[{key:'quarter',
        sourceUv:true,bounds:{minimumU:0,maximumU:0.5,minimumV:0,maximumV:0.5}}]}],scratch.bytes,
      completed=>rows.push(...completed))
      try {await task.promise} finally {task.cancel();scratch.release()}
      assert.strictEqual(rows.length,1)
      assert.strictEqual(rows[0].source,'resident','Joint UV pricing rebuilt a prepared candidate model')
      if (refused) {refused=false;throw Object.assign(new Error('injected joint refusal'),{status:9})}
      forecastDraws=forecast.imageryPlan.draws
      const credit=frames.ledger.reserve('fixture-output',0)
      return {credit,valid:()=>true,release:()=>credit.release()}
    }
    await assert.rejects(client.step(1,budget,frames,imagery),error=>error.status===9)
    assert.strictEqual(frames.candidate,null)
    const accepted=await client.step(1,budget,frames,imagery)
    assert.strictEqual(evaluations,2)
    assert.strictEqual(accepted.imageryPlan.draws,forecastDraws,'Accepted publication discarded its forecast')
    assert(accepted.measurements.length)
    await present(accepted)
    let progressive=0
    imagery.refineBounds=true
    frames.evaluateCandidate=async (packet,forecast) => {
      assert(forecast.candidateReady && forecast.imageryPlan.quality.coverageGuaranteed)
      if (!forecast.imageryPlan.quality.planningComplete) ++progressive
      const credit=frames.ledger.reserve('fixture-output',0)
      return {credit,valid:()=>true,release:()=>credit.release()}
    }
    for(const distance of [1000000,20000000,100000,28000000]) {
      client.setCamera({distance,tiltRadians:0,yawRadians:0})
      for(let i=0;i<3;++i) {
        const next=await client.step(0.002,budget,frames,imagery)
        await present(next)
        let settled
        do {
          if(settled)releaseMeasurements(settled.measurements)
          settled=await client.planImagery(next.frame.sequence,imagery,()=>{})
        }
        while(settled.pending || settled.continuation)
        try {
          assert(settled.imageryPlan.quality.planningComplete,'Published candidate did not finish its refinement')
          assert.strictEqual(settled.meshIdentity,next.meshIdentity)
        }finally{releaseMeasurements(settled.measurements)}
      }
    }
    assert(progressive>0,'Fixture did not publish a complete cut before its final precision work')
  } catch(error) { console.error(JSON.stringify(messages));throw error }
  finally {client.send=send;frames.clear();await client.loadManifest(manifest)}
  console.log('Private candidate imagery, refusal/retry, commit ordering and accepted-plan reuse passed')
}
