const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ImageryInputWorkspace} = require('../../sdk/js/resources/imagery_input_workspace')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')

module.exports = async function () {
  for(const boundary of ['quote','receipt']) {
    const ledger=new ResourceLedger(1000)
    let client,calls=0
    const receive=(id,value,bytes)=>client.receive({id,value,memoryBytes:0,nativeRevision:0,nativeBytes:0,recordBytes:0,
      heightBytes:0,imageryBytes:bytes,imageryOutputBytes:0,indexBytes:0,imageryReferenceRevision:0,
      imageryReferenceBytes:0,imageryInputBytes:bytes})
    const worker={terminate(){},postMessage(message) {
      if(message.type!=='imagery')return
      ++calls
      queueMicrotask(()=>{
        if(!message.inputGrant)receive(message.id,{pending:true,inputWork:{id:1,bytes:400}},100)
        else if(calls===2&&boundary==='receipt')
          receive(message.id,{pending:true,inputReceipt:true,inputWork:{id:2,bytes:100}},380)
        else receive(message.id,{pending:false},380)
        if(calls===(boundary==='quote'?1:2)) {
          assert.strictEqual(client.pending.size,0,'Fixture did not cross an RPC reply')
          client.suspendImagery()
        }
      })
    }}
    client=new TerrainWorkerClient(worker);client.getCameraSnapshot=()=>({})
    client.nativeImageryInputBytes=100;client.setResourceLedger(ledger)
    try {
      const result=await client.planImagery(1,{})
      assert(result.superseded,'Suspension was lost between allocation phases')
      assert.strictEqual(calls,boundary==='quote'?1:2,'Suspended operation dispatched another grant')
      assert.strictEqual(client.imageryOperations.size,0)
      assert.strictEqual(client.imageryInputBudget.credits.size,0)
      assert.strictEqual(ledger.bytes,boundary==='quote'?100:380,'Suspension refunded live input')
    }finally{await client.destroy()}
    assert.strictEqual(ledger.bytes,0)
  }
  const workspace = new ImageryInputWorkspace(1)
  assert.strictEqual(workspace.reserve(400),null)
  assert.deepStrictEqual(workspace.quote(),{id:1,bytes:400})
  assert(!workspace.grant({id:2,bytes:400}))
  assert.throws(() => workspace.grant({id:1,bytes:399}),/Invalid/)
  assert(workspace.grant({id:1,bytes:400}))
  const lease = workspace.reserve(400)
  assert(workspace.active && !workspace.quote())
  lease.release()
  assert(workspace.finished && !workspace.grant({id:1,bytes:400}))

  for (const kind of ['input','reference','output']) for (const outcome of ['complete','cancel','terminate','refuse','stale']) {
    const ledger = new ResourceLedger(1000)
    const grantKey = kind + 'Grant'
    const workKey = kind + 'Work'
    const label = kind[0].toUpperCase() + kind.slice(1), budgetKey = 'imagery' + label + 'Budget'
    let client, grant, finishTermination, granted = 0, cancelled = 0, trimmed = 0
    const receive = (id, value, bytes, progress = false) => client.receive({id, value, progress,
      memoryBytes:0,nativeRevision:0,nativeBytes:0,recordBytes:0,heightBytes:0,
      imageryBytes:bytes+50,indexBytes:0,imageryOutputBytes:kind === 'output' ? bytes : 0, imageryReferenceRevision:0,
      imageryReferenceBytes:kind === 'reference' ? bytes : 0, imageryInputBytes:kind === 'input' ? bytes : 0})
    const worker = {
      terminate: () => outcome === 'terminate' ? new Promise(resolve => {finishTermination=resolve}) : undefined,
      postMessage(message) {
        if (message.type === 'cancel-imagery') {++cancelled;return}
        if (message.type === 'trim-imagery-references') {
          queueMicrotask(() => receive(message.id,{releasedBytes:0,pending:false},100)); return
        }
        if (message.type === 'trim-native-measurements') {
          ++trimmed
          queueMicrotask(() => receive(message.id,{released:0,more:false},100)); return
        }
        assert.strictEqual(message.type,'imagery')
        if (!message[grantKey]) {
          queueMicrotask(() => receive(message.id,{pending:true,[workKey]:{id:1,bytes:400}},100))
          return
        }
        ++granted; grant = message
        assert(message.stream, 'A nonstream caller refunded an unfinished packing grant')
        assert.strictEqual(ledger.bytes,500,'Conversion was not funded before dispatch')
        queueMicrotask(() => receive(message.id,{pending:true},380,true))
      }
    }
    client = new TerrainWorkerClient(worker)
    client.getCameraSnapshot = () => ({})
    client['nativeImagery' + label + 'Bytes'] = 100
    client.setResourceLedger(ledger)
    const pressure = outcome === 'refuse' ? ledger.reserve('pressure',600) : null
    const operation = client.planImagery(1,{})
    try {
      if (outcome === 'refuse') {
        await assert.rejects(operation,e=>e.status===9)
        assert(!granted && cancelled===1)
        if(kind==='input')assert.strictEqual(trimmed,1,'Input pressure skipped Native model reclamation')
        pressure.release()
        assert.strictEqual(ledger.bytes,100)
      } else {
        for (let i=0;i<10 && !grant;++i) await Promise.resolve()
        await Promise.resolve()
        assert(grant && ledger.bytes===500)
        assert.strictEqual(client[budgetKey].actual,380)
        if (outcome === 'terminate') {
          const rejected = assert.rejects(operation,/destroyed/)
          const termination = client.destroy()
          assert.strictEqual(ledger.bytes,500,'Destroy intent refunded the producer')
          finishTermination(); await termination; await rejected
          assert.strictEqual(ledger.bytes,0)
        } else {
          if (outcome === 'cancel') client.cancelImagery()
          receive(grant.id,outcome==='complete' ? {pending:true,inputReceipt:true} : {superseded:true},
            outcome==='complete' ? 260 : 100)
          await operation
          assert.strictEqual(ledger.bytes,outcome==='complete' ? 260 : 100)
          assert.strictEqual(client[budgetKey].credits.size,0)
        }
      }
    } finally {
      if (!client.destroyed) client.destroy()
      if (pressure) pressure.release()
    }
    assert.strictEqual(ledger.bytes,0)
  }
  const {reclaimImageryReferences} = require('../../sdk/js/resources/imagery_reference_reclamation')
  const producer = {imageryReferenceRevision:3}
  let slices = 0, yields = 0
  assert.strictEqual(await reclaimImageryReferences(producer,30,async (needed,restart) => {
    assert.strictEqual(restart,slices === 0)
    ++slices
    return {releasedBytes:10,pending:true}
  },async () => {++yields}),30)
  assert.strictEqual(slices,3); assert.strictEqual(yields,2)
  // Distinct requests can arrive while the same planner is waiting for input.
  // A successful partial trim must continue past its already empty prefix.
  assert.strictEqual(await reclaimImageryReferences(producer,10,async (needed,restart) => {
    assert.strictEqual(restart,false,'Same-epoch pressure restarted the reference scan')
    return {releasedBytes:10,pending:true}
  },async () => {throw new Error('One funded trim unexpectedly yielded')}),10)
  ++producer.imageryReferenceRevision
  assert.strictEqual(await reclaimImageryReferences(producer,10,async (needed,restart) => {
    assert.strictEqual(restart,true,'A changed planner reused an old reference cursor')
    return {releasedBytes:10,pending:false}
  },async () => {}),10)
  await assert.rejects(reclaimImageryReferences(producer,10,async () => {
    throw new Error('failed trim')
  },async () => {}),/failed trim/)
  assert.strictEqual(await reclaimImageryReferences(producer,10,async (needed,restart) => {
    assert.strictEqual(restart,true,'A failed trim left a reusable cursor')
    return {releasedBytes:10,pending:true}
  },async () => {}),10)
  slices = 0
  assert.strictEqual(await reclaimImageryReferences(producer,30,async () => {
    ++slices; ++producer.imageryReferenceRevision
    return {releasedBytes:5,pending:true}
  },async () => {throw new Error('A changed planning epoch restarted reclamation indefinitely')}),5)
  assert.strictEqual(slices,1)
  assert.strictEqual(producer.imageryReferenceReclamation.interrupted,1)
  const {TerraGlobeRuntime} = require('../../adapters/wasm/terra_globe_runtime')
  const runtime = Object.create(TerraGlobeRuntime.prototype), ledger = new ResourceLedger(1000)
  let attempts = 0, scheduled = 0
  Object.assign(runtime, {resourceLedger:ledger, cameraRevision:1, imageryRevision:0,
    meshFrames:{presented:{frame:{sequence:1}}},
    renderer:{setImageryPlan() {}, imageryPlanningOptions:()=>({})},
    abi:{isWorker:true, imageryInputPayloadBytes:()=>100, planImagery:async()=>{
      ++attempts; throw Object.assign(new Error('capacity'),{status:9,capacityRevision:ledger.availabilityRevision})
    }}, diagnostic() {}, scheduleImageryContinuation() {++scheduled}})
  await runtime.refreshImagery(); await runtime.refreshImagery()
  assert(attempts===1 && scheduled===0 && runtime.imageryCapacityWait,
    'An unchanged capacity refusal polled the Worker')
  const released = ledger.reserve('temporary',1); released.release()
  await runtime.refreshImagery()
  assert.strictEqual(attempts,2,'Changed capacity did not permit another input quote')
  ++runtime.cameraRevision
  await runtime.refreshImagery()
  assert.strictEqual(attempts,3,'A new camera could not replace a refused input')
  const {TerrainCapacity} = require('../../sdk/js/terrain/terrain_capacity')
  runtime.terrainCapacity = new TerrainCapacity(900,100)
  runtime.meshFrames.presented.draws = [{resourceId:1, textureResourceId:1,
    positionFloatCount:100, textureFloatCount:50}]
  runtime.renderer.terrainRefinementDemand = () => ({refinable:true})
  runtime.renderer.refineImageryDemand = () => {throw new Error('Unfunded input cannot refine its own measurement')}
  runtime.scheduleRefresh = () => {++scheduled}
  runtime.abi.planImagery = async () => {
    ++attempts; throw Object.assign(new Error('capacity'),{status:9,capacityShortfallBytes:300,
      capacityRevision:ledger.availabilityRevision})
  }
  ++runtime.cameraRevision
  await runtime.refreshImagery()
  assert(runtime.meshRecovery && runtime.meshCapacityBlocked && scheduled===1,
    'Input pressure parked behind the planner that needs the refused input')
  assert.strictEqual(runtime.terrainCapacity.bytes,500,'Recovery did not price the actual deficit')
  await runtime.refreshImagery()
  assert.strictEqual(scheduled,1,'An unchanged input refusal repeatedly coarsened terrain')
  for (const change of ['camera','source','surface','options']) {
    runtime.imageryCapacityWait = runtime.meshRecovery = null
    runtime.meshCapacityBlocked = false
    let refuse
    runtime.abi.planImagery = () => new Promise((resolve,reject) => {refuse=reject})
    const before = scheduled, bytes = runtime.terrainCapacity.bytes
    const pending = runtime.refreshImagery()
    if (change==='camera') ++runtime.cameraRevision
    else if (change==='source') ++runtime.imageryRevision
    else if (change==='surface') runtime.meshFrames.presented = {...runtime.meshFrames.presented,frame:{sequence:2}}
    else runtime.renderer.imageryPlanningOptions = () => ({maximumTextures:100})
    refuse(Object.assign(new Error('obsolete input'),{status:9,capacityShortfallBytes:300}))
    await pending
    assert(!runtime.meshRecovery && !runtime.imageryCapacityWait && runtime.terrainCapacity.bytes===bytes,
      'An obsolete input refusal reduced or parked its successor')
    assert.strictEqual(scheduled,before+1,'A superseded refusal did not resume current planning')
  }
  console.log('Imagery input/reference/output quotes, streaming grants, pressure refusal, cancellation and termination receipts passed')
}

if (require.main === module) module.exports().catch(error=>{console.error(error);process.exitCode=1})
