const assert=require('assert')
const {TerraAbi}=require('../../adapters/wasm/terra_abi')
const {ImageryPlanner}=require('../../adapters/wasm/imagery_planner')
const {ImageryPreparation}=require('../../adapters/wasm/imagery_preparation')
const {LocalTerrainExecution}=require('../../adapters/wasm/local_terrain_execution')
const {TerraGlobeRuntime}=require('../../adapters/wasm/terra_globe_runtime')
const {TerrainWorkerClient}=require('../../adapters/wasm/terra_worker_client')
const {TerrainWorkerHost}=require('../../adapters/wasm/terra_worker_host')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {MeshFrames}=require('../../sdk/js/terrain/terra_mesh_frames')
const {holdMeshes,ownMeshWork}=require('../../sdk/js/resources/mesh_ownership')
const {CooperativeTask}=require('../../sdk/js/runtime/cooperative_task')
const {LocalMeasurementDelivery}=require('../../adapters/wasm/measurement_delivery_local')
const {ownNativeMeasurements}=require('../../adapters/wasm/native_surface_measurement')

function fixture() {
  const ledger=new ResourceLedger(4096),abi=Object.create(TerraAbi.prototype),physical=new Map(),events=[]
  let address=1024,meshBytes=0,destroys=0,destroyError,freeError,failedPointer,allocError
  Object.assign(abi,{context:1,nativeRevision:0,imageryReferenceRevision:0,
    imageryPlanners:new Set(),imageryScratchOwners:new Set(),nativeSurfaceOwners:new Set(),nativeAllocations:new Map()})
  abi.module={alloc(bytes){const pointer=address;address+=bytes+8;physical.set(pointer,bytes);if(allocError)throw allocError;return pointer},
    free(pointer){assert(physical.has(pointer),'Native buffer was freed twice');physical.delete(pointer);events.push(['free',pointer]);if(pointer===failedPointer)throw freeError},
    call(name){
      if(name==='terra_mesh_payload_bytes')return meshBytes
      if(name==='terra_destroy'){
        ++destroys;events.push(['destroy',ledger.bytes,physical.size])
        assert(ledger.bytes>=10,'Native credit was refunded before destroy confirmation')
        if(destroyError)throw destroyError
      }
      return 0
    }}
  abi.setResourceLedger(ledger)
  abi.nativeBudget.begin(ledger.reserve('mesh-native',10))
  const budgetNames=['nativeBudget','recordBudget','heightBudget','imageryInputBudget','imageryReferenceBudget','imageryOutputBudget']
  return {abi,ledger,physical,events,get destroys(){return destroys},
    corruptMesh(){meshBytes=11},failDestroy(error){destroyError=error},
    failFree(pointer,error){failedPointer=pointer;freeError=error},failAlloc(error){allocError=error},
    endFakeProducer(){physical.clear();for(const name of budgetNames)abi[name].close()},budgetNames}
}

function fundedBuffers(abi) {
  const credit=abi.beginImageryInput(32),input=abi.alloc(32,'imagery-input');credit.release()
  const control=abi.alloc(16)
  return {input,control}
}

async function main() {
  for(const mode of ['cancel','observe','recursive','planner','closing']) {
    const f=fixture(),{abi,ledger}=f,buffers=fundedBuffers(abi),primary=new Error(mode+' failed'),calls=[]
    abi.createImageryScratch(()=>{
      calls.push('first')
      if(mode==='closing') {
        assert.throws(()=>abi.alloc(8),error=>error.name==='AbortError')
        assert.throws(()=>abi.setResourceLedger(new ResourceLedger()),error=>error.name==='AbortError')
        assert.throws(()=>abi.createImageryScratch(),/closed/)
        assert.throws(()=>abi.createImageryPlanner(),/closed/)
        throw primary
      }
      if(mode==='cancel')throw primary
      if(mode==='recursive')abi.nativeCall('terra_release_mesh_resource')
    })
      .request(64)
    const owner=Array.from(abi.imageryScratchOwners)[0];owner.allocate()
    abi.createImageryScratch(()=>calls.push('second'))
    if(mode==='planner') {
      const planner=Object.create(ImageryPlanner.prototype)
      Object.assign(planner,{abi,input:{owned:true},output:{owned:true},adapter:{owned:true},
        tasks:new Set([{cancel(){calls.push('task1');throw primary}},{cancel(){calls.push('task2')}}])})
      abi.imageryPlanners.add(planner);abi.primaryImagery=planner
    }
    if(mode==='observe')abi.observeImageryInput=()=>{throw primary}
    if(mode==='recursive') {
      f.corruptMesh()
      assert.throws(()=>abi.nativeCall('produce'),/Native mesh allocation exceeded its credit/)
    }else assert.throws(()=>abi.destroy(),error=>error===primary)
    assert.deepStrictEqual(calls.filter(value=>value==='first'||value==='second'),['first','second'])
    if(mode==='planner')assert.deepStrictEqual(calls.slice(0,2),['task1','task2'])
    assert.strictEqual(abi.context,0);assert(abi.destroyed&&abi.teardownComplete)
    assert.strictEqual(f.destroys,1);assert.strictEqual(ledger.bytes,0)
    assert.strictEqual(abi.imageryScratchOwners.size,0);assert.strictEqual(abi.imageryPlanners.size,0)
    assert.strictEqual(abi.nativeAllocations.size,0);assert.strictEqual(f.physical.size,0)
    assert.strictEqual(abi.imageryPackingBytes,0);assert(!owner.onDestroy&&!owner.buffer)
    abi.free(buffers.input);abi.free(buffers.control);abi.destroy()
    assert.strictEqual(f.destroys,1,'Late finally retried native destruction')
  }

  // A destructor/free can throw after completing part of its work. Repeating
  // that native call can double-free; retain credit and poison the owner instead.
  for(const mode of ['destroy','free','alloc']) {
    const f=fixture(),{abi,ledger}=f,{input}=fundedBuffers(abi),failure=new Error(mode+' receipt failed')
    const owner=abi.createImageryScratch();owner.request(64);owner.allocate()
    const held=ledger.bytes
    if(mode==='destroy')f.failDestroy(failure)
    if(mode==='free')f.failFree(input,failure)
    if(mode==='alloc')f.failAlloc(failure)
    assert.throws(()=>mode==='free'?abi.free(input):mode==='alloc'?abi.alloc(8):abi.destroy(),error=>error===failure)
    assert.strictEqual(abi.context,0);assert(abi.destroyed&&!abi.teardownComplete)
    assert.strictEqual(ledger.bytes,held,'Unconfirmed producer received a refund')
    assert(f.budgetNames.every(name=>abi[name].retiring))
    const nativeCalls=f.destroys,freeCalls=f.events.filter(row=>row[0]==='free').length
    assert.throws(()=>abi.destroy(),error=>error===failure)
    if(mode==='free')assert.throws(()=>abi.free(input),error=>error===failure)
    assert.strictEqual(f.destroys,nativeCalls)
    assert.strictEqual(f.events.filter(row=>row[0]==='free').length,freeCalls)
    assert.throws(()=>abi.alloc(8),error=>error.name==='AbortError')
    assert.throws(()=>abi.nativeCall('produce'),error=>error.name==='AbortError')
    assert.throws(()=>abi.setResourceLedger(new ResourceLedger()),error=>error.name==='AbortError')
    f.endFakeProducer();assert.strictEqual(ledger.bytes,0)
  }

  {
    const f=fixture(),primary=new Error('native operation failed'),call=f.abi.module.call
    f.abi.module.call=(name,...args)=>{if(name==='produce'){f.corruptMesh();throw primary}return call(name,...args)}
    assert.throws(()=>f.abi.nativeCall('produce'),error=>error===primary)
    assert(/exceeded its credit/.test(primary.cleanupError.message))
    assert.strictEqual(f.destroys,1);assert.strictEqual(f.ledger.bytes,0)
  }

  const source=new Error('work failed'),cancel=new Error('cancel failed')
  {
    let refs=0,closed=0
    const rows=[];rows.borrow=()=>{++refs;return ()=>{--refs}}
    const delivery=new LocalMeasurementDelivery(new ResourceLedger())
    delivery.sender.begin=()=>({bytes:0,quote:()=>({references:[]}),grant(){},
      step(){throw source},cancel(){++closed;throw cancel}})
    delivery.receiver.pin=()=>({missing:[],release(){++closed;throw cancel}})
    await assert.rejects(delivery.publish({measurements:ownNativeMeasurements([{resourceId:1,regions:rows}])},
      [1],{},()=>false),error=>error===source)
    assert.strictEqual(closed,2);assert.strictEqual(refs,0);assert.strictEqual(delivery.active,null)
    const peers=[]
    delivery.active={work:{cancel(){peers.push('work');throw cancel}},credit:{release(){peers.push('credit')}}}
    delivery.sender.clear=()=>{peers.push('sender');throw source}
    delivery.receiver.clear=()=>peers.push('receiver')
    assert.throws(()=>delivery.close(),error=>error===cancel)
    assert.deepStrictEqual(peers,['work','credit','sender','receiver'])
  }
  const iterator={next(){throw source},return(){throw cancel}}
  assert.throws(()=>new CooperativeTask(iterator).step(),error=>error===source)
  const yielding=new CooperativeTask({next(){return {done:false}},return(){throw cancel}})
  await assert.rejects(yielding.run(()=>Promise.reject(source)),error=>error===source)
  const calls=[],resources=[1,2].map(id=>({ownership:{hold(){return ()=>{calls.push(id);if(id===1)throw cancel}}}}))
  assert.throws(holdMeshes(resources),error=>error===cancel);assert.deepStrictEqual(calls,[1,2])
  calls.length=0
  assert.throws(()=>ownMeshWork(iterator,resources).next(),error=>error===source)
  assert.deepStrictEqual(calls,[1,2])

  // Clear every independent preparation owner even if releasing its mesh loan
  // fails. Detach references before callbacks so recursive clear is harmless.
  {
    const f=fixture(),p=new ImageryPreparation({abi:f.abi}),events=[]
    assert(f.abi.nativeSurfaceOwners.has(p.measurementProduction.registration))
    p.imageryJob={releaseMeshes(){events.push('mesh');p.clearPlanning();throw source}}
    p.imageryTask={task:{cancel(){events.push('input');throw cancel}}}
    p.partitionFit={work:{return(){events.push('fit')}}}
    p.measurementJob={work:{return(){events.push('measurement')}},boundsWork:{return(){events.push('bounds')}}}
    assert.throws(()=>p.clearPlanning(),error=>error===source)
    assert.deepStrictEqual(events,['mesh','input','fit','measurement','bounds'])
    assert(!p.imageryJob&&!p.imageryTask&&!p.partitionFit&&!p.measurementJob)
    assert.strictEqual(p.measurementProduction.loans.values.size,0)
    f.abi.destroy();assert.strictEqual(f.ledger.bytes,0)
  }

  {
    const events=[],frames=new MeshFrames()
    frames.productionTask={cancel(){events.push('production');throw source}}
    frames.replacementTask={cancel(){events.push('replacement')}}
    frames.candidate={outputs:{release(){events.push('candidate')}}}
    frames.presented={outputs:{release(){events.push('presented')}}}
    frames.resources.set(1,{ownership:{retire(){events.push('resource1');throw cancel}}})
    frames.resources.set(2,{ownership:{retire(){events.push('resource2')}}})
    assert.throws(()=>frames.clear(),error=>error===source)
    assert.deepStrictEqual(events,['production','replacement','candidate','presented','resource1','resource2'])
    assert(!frames.candidate&&!frames.presented&&!frames.resources.size)
  }

  {
    const events=[],local=Object.create(LocalTerrainExecution.prototype)
    Object.assign(local,{cancelRevision:0,turn:{close(){events.push('turn')}},
      unregisterMeasurementReclaimer(){events.push('reclaimer')},
      measurementDelivery:{close(){events.push('mirror')}},
      tasks:new Set([{cancel(){events.push('task');throw source}},{cancel(){events.push('peer')}}]),
      preparation:{closeMeasurements(){events.push('measurements')}},
      prepared:{release(){events.push('prepared')}}})
    assert.throws(()=>local.destroy(),error=>error===source)
    assert.deepStrictEqual(events,['reclaimer','turn','mirror','task','peer','measurements','prepared'])
    assert(!local.prepared&&!local.tasks.size)
  }

  {
    const host=new TerrainWorkerHost(),events=[],action=name=>()=>events.push(name)
    host.abi={discardTerrainWork:action('terrain'),discardMeshPlan:action('plan'),destroy:action('abi')}
    host.pendingMesh={result:{nativePlan:{}},productionTask:{cancel(){events.push('production');throw source}},
      transferTask:{cancel:action('transfer')},prepared:{release:action('prepared')}}
    host.discardImageryCandidate=action('imagery')
    host.partitionJobs.set(1,{cancel(){events.push('partition1');throw cancel},releaseMeshes:action('loan1')})
    host.partitionJobs.set(2,{cancel:action('partition2'),releaseMeshes:action('loan2')})
    host.terrainEpoch={clear:action('epoch')};host.frames={clear:action('frames')}
    host.clearPlanning=action('planning');host.measurementHistory={clear:action('history')}
    host.measurementProduction={settle(){},destroy:action('measurements')}
    await assert.rejects(host.handle({type:'destroy'}),error=>error===source)
    assert.deepStrictEqual(events,['terrain','production','transfer','imagery','prepared','plan',
      'partition1','loan1','partition2','loan2','epoch','frames','planning','history','measurements','abi'])
    assert(host.destroyed&&!host.pendingMesh&&!host.partitionJobs.size)
  }

  {
    const events=[],runtime=Object.create(TerraGlobeRuntime.prototype),action=name=>()=>events.push(name)
    Object.assign(runtime,{cancelAnimation(){events.push('animation');runtime.destroy();throw source},
      cancelCameraRefresh:action('camera'),cancelInteractionRefresh:action('interaction'),cancelTerrainRefresh:action('terrain'),
      walkController:{cancel:action('walk')},groundDemands:{destroy:action('ground')},heightQueries:{destroy:action('height')},
      terrainTransport:{destroy:action('transport')},releaseMeshListener:action('listener'),frameClock:{destroy:action('clock')},
      scheduler:{clear:action('scheduler')},terrainRetryTimers:new Set(),recordCache:{clear:action('record')},
      localExecution:{destroy:action('local')},meshReceipts:{clear:action('receipt')},meshFrames:{clear:action('frames')},
      terrainEpoch:{clear:action('epoch')},renderer:{destroy:action('renderer')},abi:{destroy:action('abi')}})
    assert.throws(()=>runtime.destroy(),error=>error===source)
    assert(runtime.destroyed);assert.deepStrictEqual(events.slice(-3),['epoch','renderer','abi'])
    assert.strictEqual(events.filter(value=>value==='animation').length,1)
  }

  // A fatal Worker message is not an ownership report. Even a forged zero in
  // that message cannot release bytes before the platform termination receipt.
  for(const result of ['resolve','reject','throw']) {
    const ledger=new ResourceLedger(256),fatal=new Error('native owner failed'),termination=new Error('termination failed')
    let resolve,reject,ended=false,reports=0
    const worker={postMessage(){},terminate(){if(result==='throw')throw termination;return new Promise((yes,no)=>{resolve=yes;reject=no})}}
    const client=new TerrainWorkerClient(worker,{workerTimeoutMs:60000,onError(){++reports}})
    client.nativeBytes=32;client.setResourceLedger(ledger)
    let rpcError
    const request=client.send({type:'probe'}).catch(error=>{rpcError=error})
    try {
      client.receive({type:'fatal',error:fatal.message,nativeBytes:0})
      assert(client.destroyed);assert.strictEqual(ledger.bytes,32)
      if(result==='resolve') {
        await Promise.resolve();assert(!rpcError)
        ended=true;resolve();await client.termination;await request
        assert.strictEqual(ledger.bytes,0)
      }else {
        if(result==='reject')reject(termination)
        await assert.rejects(client.termination,error=>error===termination);await request
        assert.strictEqual(ledger.bytes,32);assert.strictEqual(reports,1)
      }
      assert.strictEqual(rpcError.message,fatal.message);assert.strictEqual(client.pending.size,0)
    }finally{
      // Test-only external confirmation for the synthetic producer; no real
      // Worker, native memory, page, service or network client was created.
      ended=true;client.fail(new Error('test cleanup'));if(ended)client.closeNativeBudget()
    }
  }
  console.log('ABI teardown drains peers, preserves primary failures, tracks raw buffers and holds uncertain credit until Worker termination passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})
