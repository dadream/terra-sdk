const assert = require('assert')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ownMesh} = require('../../sdk/js/resources/mesh_ownership')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')
const {install} = require('./reference/measurement_host_fixture')
const {WORKER_PROTOCOL} = require('../../adapters/wasm/worker_protocol')
const fixture = require('./reference/native_mesh_fixture')

module.exports = async function verifyCandidateGroups() {
  for (const outcome of ['accepted', 'large-workspace', 'refused', 'fatal', 'atomic-accepted', 'atomic-refused',
    'unchanged', 'resident-coverage', 'pending-coverage']) {
    const unchanged = outcome === 'unchanged'
    const covered = outcome === 'resident-coverage'
    const atomic = outcome.startsWith('atomic-')
    const accepted = outcome==='accepted' || outcome==='large-workspace' || outcome==='atomic-accepted' ||
      covered || outcome==='pending-coverage'
    const boundaryBytes = atomic ? 4096 : outcome==='large-workspace' ? 1024 : 128
    const f = require('./reference/grid_surface_fixture')(1)
    const frames = new MeshFrames(new ResourceLedger(1024 * 1024))
    const loans = new Map(), borrowed = [], released = [], generated = [], events = [], evaluations = []
    const proof = {groups:[0,1,2,3].map(i => ({before:[i+1],after:[i+5]}))}
    const draws = [1,2,3,4,5,6,7,8].map(resourceId => fixture.meshDraw({resourceId,
      vertexCount:f.positions.length/3, origin:[0,0,0], flags:0, firstIndex:0, indexCount:f.indices.length}))
    let sequence = 0, prepared, commits = 0, transferred, transferCount = 0, firstCopy, firstModel
    const packet = ids => ({nativePlan:{id:sequence, additionalBytes:0,residentBytes:0,
      reclaimableBytes:0,maximumBytes:1024*1024}, draws:ids.map(id=>({...draws[id-1]})),
    updateState:{modelRevision:sequence}, frame:{sequence, coverageComplete:true,
      projectionView:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]), cameraPosition:new Float32Array([0,0,1])}})
    const abi = {...fixture, incrementalLayout:true, setViewport(){}, setCamera(){}, setGlobeTarget(){},
      prepareMeshFrame() {++sequence; return prepared=packet(sequence===1||unchanged?[1,2,3,4]:[5,6,7,8])},
      replacementWorkBytes:()=>boundaryBytes,
      createReplacementTask() {return new CooperativeTask((function*(){yield;return proof})())},
      selectMeshGroups(plan, groups) {
        assert.strictEqual(commits,1,'A failed forecast published the full terrain candidate')
        return prepared=packet(proof.groups.flatMap((group,i)=>groups.includes(i)?group.after:group.before))
      },
      materializeMeshFrame(value) {
        if(sequence===2 && !atomic && !unchanged) assert(events.indexOf('replacement') < events.lastIndexOf('materialize'),
          'Candidate generation preceded its funded fallback proof')
        for(const draw of value.draws) if(!generated.includes(draw.resourceId)) generated.push(draw.resourceId)
      },
      commitMeshFrame(value) {assert.strictEqual(value.nativePlan,prepared.nativePlan);++commits;value.nativePlan=null},
      getIndices:()=>f.indices, getRequests:()=>[],memoryBytes:()=>65536,
      borrowMeshResource(draw) {
        const id=draw.resourceId
        borrowed.push(id);loans.set(id,true)
        return ownMesh({resourceId:id,textureResourceId:draw.textureResourceId,
          positions:f.positions.slice(),textureUv:f.uv.slice()},
        {bytes:f.positions.byteLength,mark(){},release(){loans.delete(id);released.push(id)}})
      },
      presentFrame(){}, discardFrame(){}, discardMeshPlan(){}, destroy(){}
    }
    const worker={postMessage(message){
      events.push(message.type)
      queueMicrotask(()=>scope.onmessage({data:message}))
    },terminate(){}}
    const client=new TerrainWorkerClient(worker,{workerTimeoutMs:2500})
    const scope={postMessage(message){
      if(message.value && message.value.additions) {transferred=message.value;++transferCount}
      queueMicrotask(()=>worker.onmessage({data:message}))
    }}
    install(scope,{abi})
    // The real host/client production/selection/copy path is exercised here;
    // projection continuation and native cuts have separate real-Wasm tests.
    client.planImagery=async () => {
      assert(!unchanged,'Identical immutable geometry waited for another private imagery forecast')
      assert(!covered,'Funded inherited coverage waited for a whole-view precision forecast')
      return {candidateReady:true,viewRevision:client.viewRevision,
      measurements:[], imageryPlan:{draws:prepared.draws,
        quality:{coverageGuaranteed:true,planningComplete:true}}}
    }
    try {
      await client.send({type:'initialize',protocol:WORKER_PROTOCOL})
      client.setViewport(100,100,1);client.setCamera({longitudeDegrees:0,latitudeDegrees:0})
      const initial=await client.step(1,{},frames)
      await client.presentFrame(initial.frame.sequence);frames.present(initial.frame.sequence)
      if (accepted || atomic) {
        // The copy stage fits exactly. The boundary stage must borrow that
        // envelope before production, rather than add another 128 bytes later.
        frames.ledger.setLimit(frames.ledger.bytes + Math.max(atomic ? 0 : boundaryBytes,
          4 * (f.positions.byteLength + f.uv.byteLength)))
      }
      if(covered || outcome==='pending-coverage')frames.reserveOutputs=(packet,bytes)=>{
        const credit=frames.ledger.reserve('fixture-destinations',bytes)
        if(!credit)return null
        let closed=false
        return {credit,valid:()=>!closed,hasResidentCoverage:()=>covered&&!closed,
          release(){closed=true}}
      }
      frames.evaluateCandidate=async (value,forecast) => {
        assert.strictEqual(frames.presented,initial)
        assert.strictEqual(frames.candidate,null)
        assert.strictEqual(commits,1)
        evaluations.push(value.draws.map(draw=>draw.resourceId))
        assert.deepStrictEqual(forecast.imageryPlan.draws,value.draws)
        const addition=value.additions.find(resource=>resource.resourceId===5)
        if(!firstCopy){firstCopy=addition.positions;firstModel=addition.model}
        assert.strictEqual(addition.positions,firstCopy,'Selection copied surviving positions again')
        assert.strictEqual(addition.model,firstModel,'Selection rebuilt surviving surface metadata')
        assert.deepStrictEqual(Array.from(value.frame.projectionView),Array.from(initial.frame.projectionView))
        if(outcome==='fatal') throw new Error('injected fatal evaluation')
        if(outcome==='refused' || outcome==='atomic-refused' || !atomic && evaluations.length<3) return null
        const credit=frames.ledger.reserve('fixture-output',0)
        return {credit,valid:()=>true,release:()=>credit.release()}
      }
      const result=client.step(1,{},frames,{terrainBound:false})
      if(unchanged) {
        const selected=await result
        assert.strictEqual(commits,2,'Metadata-only selection was not committed')
        assert.deepStrictEqual(evaluations,[],'Unchanged geometry priced new imagery destinations')
        assert.deepStrictEqual(selected.draws.map(draw=>draw.resourceId),[1,2,3,4])
        assert.strictEqual(selected.resources.get(1),initial.resources.get(1))
        assert.strictEqual(selected.imageryPlan,undefined,'Metadata publication claimed current imagery precision')
        assert.strictEqual(selected.additions.length,0,'Unchanged geometry allocated another host copy')
        await client.presentFrame(selected.frame.sequence);frames.present(selected.frame.sequence)
      } else if(accepted) {
        const selected=await result
        assert.deepStrictEqual(selected.draws.map(draw=>draw.resourceId),atomic||covered ? [5,6,7,8] : [5,2,3,4])
        if(covered) {
          assert.strictEqual(selected.imageryPlan,undefined,'Coverage receipt fabricated current precision')
          assert(selected.outputs.valid(),'Inherited destinations were released before display receipt')
        } else assert.strictEqual(selected.resources.get(5).positions,firstCopy)
        if (atomic) assert.strictEqual(selected.replacementPlan.atomic,true,
          'A full successor without a seam proof was allowed to publish partial groups')
        else if(!covered)assert.strictEqual(selected.resources.get(2),initial.resources.get(2))
        assert.strictEqual(commits,2)
        await client.presentFrame(selected.frame.sequence);frames.present(selected.frame.sequence)
      } else {
        await assert.rejects(result,outcome==='fatal'?/injected fatal/:error=>error.status===9)
        assert.strictEqual(commits,1)
        assert.strictEqual(frames.presented,initial)
      }
      assert.strictEqual(transferCount,2,'Late selection retransferred the whole candidate')
      assert.strictEqual(events.filter(type=>type==='replacement').length,atomic||unchanged ? 0 : 1,'Unexpected boundary production')
      assert.deepStrictEqual(borrowed,unchanged?[1,2,3,4]:[1,2,3,4,5,6,7,8],'Late selection borrowed/rebuilt a produced mesh again')
      assert.deepStrictEqual(evaluations,unchanged||covered?[]:outcome==='fatal'||atomic?[[5,6,7,8]]:[[5,6,7,8],[5,6,3,4],[5,2,3,4]])
      assert.strictEqual(events.filter(type=>type==='select-groups').length,outcome==='fatal'||atomic||unchanged||covered?0:2)
      if (outcome==='atomic-accepted'||covered) assert([5,6,7,8].every(id=>loans.has(id)), 'Complete successor lost its native owners')
      else {
        if(!unchanged)assert([6,7,8].every(id=>released.includes(id)),'Discarded private native loans remained live')
        assert(loans.has(2),'Restoring old terrain retired its display owner')
      }
      assert(frames.ledger.highWaterBytes<=frames.ledger.maximumBytes,'Fallback exceeded the shared limit')
      assert.strictEqual(transferred.additions.length,unchanged?0:4)
      await client.send({type:'destroy'})
    } finally {client.destroy();frames.clear()}
    assert.strictEqual(loans.size,0)
    assert.strictEqual(frames.ledger.bytes,0,'Late selection leaked copy credit')
  }
  console.log('Late candidate selection shrinks complete groups, reuses copies/models and preserves old publication on refusal')
}

if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
