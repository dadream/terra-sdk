const assert=require('assert')
const {ImageryInputBatch}=require('../../sdk/js/resources/imagery_input_batch')
const {ImageryInputWorkspace}=require('../../sdk/js/resources/imagery_input_workspace')

function copy(rows) {
  const output=new Uint8Array(rows.length*176)
  for(let first=0;first<rows.length;first+=256)rows.copyTo(output,first*176,first,Math.min(256,rows.length-first))
  return output
}
module.exports=async function(abi,ledger,fixture,context,planId) {
  const baseline=abi.imageryInputPayloadBytes(),originalLimit=ledger.maximumBytes
  const stages=[],credits=new Map(),models=[],rows=[]
  let id=100000,task
  const batch=new ImageryInputBatch(()=>{const value=new ImageryInputWorkspace(++id);stages.push(value);return value})
  const workspace=()=>batch.stage()
  const receipt=()=>{
    for(const [stage,credit] of credits)if(stage.finished){abi.imageryInputBudget.finish(credit);credits.delete(stage)}
  }
  const grant=()=>{
    const stage=batch.pool,quote=stage.quote();assert(quote)
    const credit=abi.imageryInputBudget.beginPreferred(quote.bytes,quote.preferredBytes);assert(credit)
    credits.set(stage,credit);assert(stage.grant({id:quote.id,bytes:credit.bytes}));return credit
  }
  const run=value=>{
    for(let i=0;i<10000;++i) {
      const next=value.step();batch.finishGranted();receipt()
      if(next.done)return next.value
      if(next.waiting)grant()
    }
    assert.fail('Batched native input did not converge')
  }
  try {
    // Grant cancellation before consumption refunds only after the explicit
    // end-of-call receipt; other source/row owners keep their charged bytes.
    task=abi.createNativeSurfaceModelTask(fixture.draw,{planId,inputWorkspace:workspace})
    assert(task.step().waiting);grant();const held=ledger.bytes
    task.cancel();assert.strictEqual(ledger.bytes,held);receipt();assert(!credits.size)
    assert.strictEqual(abi.imageryInputPayloadBytes(),baseline)

    // A native failure and a failing observer must still end allocation
    // permission, preserving the first error and waiting for the real receipt.
    task=abi.createNativeSurfaceModelTask(fixture.draw,{planId,inputWorkspace:workspace})
    assert(task.step().waiting);grant()
    const nativeCall=abi.nativeCall,observe=abi.observeImageryInput
    const failure=new Error('Injected native model failure'),observerFailure=new Error('Injected input observer failure')
    let failedNative=false,failedObserver=false
    abi.nativeCall=function(name,...args) {
      if(name==='terra_open_surface_model'){failedNative=true;throw failure}
      return nativeCall.call(this,name,...args)
    }
    abi.observeImageryInput=function(...args) {
      const value=observe.apply(this,args)
      if(failedNative&&!failedObserver){failedObserver=true;throw observerFailure}
      return value
    }
    try {assert.throws(()=>task.step(),error=>error===failure&&error.cleanupError===observerFailure)}
    finally {abi.nativeCall=nativeCall;abi.observeImageryInput=observe}
    assert(failedNative&&failedObserver&&task.done)
    assert.strictEqual(batch.stats().activeAllocations,0,'Failed observer retained allocation permission')
    assert(credits.size,'Failure refunded before the ownership receipt')
    batch.finishGranted();receipt();assert(!credits.size)
    assert.strictEqual(abi.imageryInputPayloadBytes(),baseline)

    task=abi.createNativeSurfaceModelTask(fixture.draw,{planId,inputWorkspace:workspace,maximumOperations:31,maximumMilliseconds:0})
    task.maximumSteps=1;assert(task.step().waiting)
    ledger.setLimit(ledger.bytes+batch.pool.quote().bytes)
    const exact=grant();assert.strictEqual(exact.bytes,batch.pool.bytes,'Preferred grant displaced the exact minimum')
    const next=task.step();assert(!next.done)
    batch.finishGranted();receipt();ledger.setLimit(originalLimit)
    const model=run(task);models.push(model)
    const beforeReuse=batch.stats()
    const reused=run(abi.createNativeSurfaceModelTask(fixture.draw,{planId,reuseModel:model,
      inputWorkspace:workspace,maximumOperations:4096}));models.push(reused)
    assert(batch.stats().allocations-beforeReuse.allocations>batch.stats().grants-beforeReuse.grants,
      'Native metadata and reused-layout model did not share a grant')
    const actual=run(abi.createNativeSurfaceMeasurementTask(model,context,
      {inputWorkspace:workspace,maximumOperations:37,maximumMilliseconds:0}));rows.push(actual.regions)
    const expected=await abi.createNativeSurfaceMeasurementTask(model,context,
      {maximumOperations:37,maximumMilliseconds:0}).run();rows.push(expected.regions)
    assert.strictEqual(actual.pixelsPerUv,expected.pixelsPerUv)
    assert.strictEqual(actual.visible,expected.visible)
    assert.deepStrictEqual(copy(actual.regions),copy(expected.regions),'Grant batching changed canonical regions')
    assert(stages.every(stage=>stage.finished)&&!credits.size)

    task=abi.createNativeSurfaceModelTask(fixture.draw,{planId,inputWorkspace:workspace,maximumOperations:1})
    task.maximumSteps=1;assert(task.step().waiting);grant()
    assert(!task.step().done);assert(abi.imageryInputPayloadBytes()>baseline)
    task.cancel();batch.finishGranted();receipt();assert(!credits.size)
    console.log('Real Wasm batched input: exact fallback, multi-phase grants, immutable bytes and cancellation receipts passed')
  }finally {
    ledger.setLimit(originalLimit)
    if(task)task.cancel()
    batch.close();receipt()
    for(const value of rows)value.close()
    for(const model of models)model.close()
  }
  assert.strictEqual(abi.imageryInputPayloadBytes(),baseline,'Batched input retained peer or task allocations')
}
