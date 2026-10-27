const assert=require('assert')
const {TerraAbi}=require('../../adapters/wasm/terra_abi')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {ImageryInputWorkspace}=require('../../sdk/js/resources/imagery_input_workspace')
const {compactRegionSteps}=require('../../sdk/js/terrain/region_compaction')
const {grid}=require('../js/reference/compaction_fixture')
const {compactRegions:reference}=require('../js/reference/compact_regions_reference')
const {TASK_WAIT}=require('../../sdk/js/runtime/cooperative_task')

function drain(work){let next;do{next=work.next()}while(!next.done);return next.value}
function wait(work){let next;do{next=work.next()}while(!next.done&&next.value!==TASK_WAIT);assert.strictEqual(next.value,TASK_WAIT)}

module.exports=async function verifyImageryScratch(module) {
  const abi=new TerraAbi(module),ledger=new ResourceLedger(1)
  abi.setResourceLedger(ledger)
  const input=grid(16,'hole',true,true).regions,expected=drain(reference(input)),baseline=ledger.bytes
  let task
  const owner=abi.createImageryScratch(()=>{if(task)task.return()})
  try {
    task=compactRegionSteps(input,owner);wait(task)
    const bytes=owner.requiredBytes
    ledger.setLimit(baseline+bytes-1)
    assert.throws(()=>owner.allocate(),error=>error.status===9)
    assert.strictEqual(owner.buffer,undefined);assert.strictEqual(owner.allocations,0)
    assert.strictEqual(ledger.bytes,baseline)
    ledger.setLimit(baseline+bytes)
    assert(owner.allocate())
    assert.strictEqual(owner.buffer.byteLength,bytes)
    assert.strictEqual(abi.imageryInputPayloadBytes(),bytes)
    assert.strictEqual(ledger.bytes,baseline+bytes)
    module.exports.memory.grow(1)
    assert.deepStrictEqual(drain(task),expected)
    assert.strictEqual(owner.stats().bytes,0);assert.strictEqual(ledger.bytes,baseline)

    // A second live producer cannot borrow or refund the first producer's
    // allocation. Both use the same existing input budget without double charge.
    owner.request(bytes);owner.allocate()
    const previous=owner.request(bytes)
    assert.throws(()=>owner.request(bytes),/already borrowed/)
    const other=abi.createImageryScratch()
    other.request(bytes)
    assert.throws(()=>other.allocate(),error=>error.status===9)
    owner.close();assert(other.allocate());other.destroy()
    assert.strictEqual(ledger.bytes,baseline)
    owner.request(bytes);owner.allocate()
    const current=owner.request(bytes)
    previous.release()
    assert.strictEqual(owner.stats().bytes,bytes,'A stale borrower released a successor scratch buffer')
    current.release();assert.strictEqual(ledger.bytes,baseline)

    // A Worker quote is not credit. Its matching grant funds the actual JS
    // payload and finishes only when allocation commits an input receipt.
    const remote=abi.createImageryScratch(),workspace=new ImageryInputWorkspace(71)
    assert.strictEqual(remote.request(bytes),null)
    assert.strictEqual(remote.allocate(workspace),false)
    assert.deepStrictEqual(workspace.quote(),{id:71,bytes})
    assert.strictEqual(remote.stats().bytes,0)
    const credit=abi.imageryInputBudget.begin(bytes)
    assert(credit);assert(workspace.grant({id:71,bytes}));assert(remote.allocate(workspace))
    assert(workspace.finished);abi.imageryInputBudget.finish(credit)
    assert.strictEqual(ledger.bytes,baseline+bytes)
    remote.destroy();assert.strictEqual(ledger.bytes,baseline)

    const {TerrainWorkerHost}=require('../../adapters/wasm/terra_worker_host')
    const host=new TerrainWorkerHost({abi})
    await host.handle({type:'initialize',protocol:require('../../adapters/wasm/worker_protocol').WORKER_PROTOCOL})
    assert(host.measurementProduction&&abi.nativeSurfaceOwners.has(host.measurementProduction.registration),
      'Worker did not bind Native measurement production after delayed ABI initialization')
    host.clearPlanning()

    // ABI termination cancels a still-live iterator before retiring its buffer.
    task=compactRegionSteps(input,owner);wait(task);owner.allocate();assert(!task.next().done)
    abi.destroy()
    assert(owner.closed&&!owner.buffer);assert(task.next().done)
    assert.strictEqual(abi.imageryScratchOwners.size,0)
    assert.strictEqual(abi.imageryScratchBytes,0)
    assert.strictEqual(ledger.bytes,0)
    assert.throws(()=>owner.request(bytes),/Invalid imagery scratch request/)
    console.log('Real Wasm adapter scratch: preallocation refusal, exact credit, competing owners, Worker receipt, cancellation and ABI teardown passed',JSON.stringify({bytes}))
  }finally{abi.destroy()}
}

if(require.main===module) {
  const fs=require('fs'),loader=require('../../adapters/wasm/terra_wasm')
  loader.instantiateTerraWasmBytes(fs.readFileSync(process.argv[2])).then(module.exports)
    .catch(error=>{console.error(error);process.exitCode=1})
}
