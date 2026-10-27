const assert=require('assert')
const {NativeMeasurementProduction}=require('../../adapters/wasm/native_measurement_production')
const {ownPayload}=require('../../sdk/js/resources/mesh_ownership')
const {ImageryInputWorkspace}=require('../../sdk/js/resources/imagery_input_workspace')
const {TASK_WAIT}=require('../../sdk/js/runtime/cooperative_task')

function copy(rows) {
  const result=new Uint8Array(rows.length*176)
  for(let first=0;first<rows.length;first+=256)rows.copyTo(result,first*176,first,Math.min(256,rows.length-first))
  return result
}

// Real distinct CBDAM meshes share a UV layout. Metadata admission yields before
// the second model opens, while ordinary pressure can retire the idle first one.
module.exports=async function(abi,ledger,fixtures,context,planId) {
  const first=fixtures[0],peer=fixtures.find(f=>f.draw.resourceId!==first.draw.resourceId&&
    f.draw.textureResourceId===first.draw.textureResourceId)
  assert(peer,'Fixture needs distinct meshes with the same UV layout')
  const baseline=abi.imageryInputPayloadBytes(),stages=[],credits=new Map(),resources=[],rows=[],opened=[]
  let id=200000,work,cold
  const workspace=()=>{const stage=new ImageryInputWorkspace(++id);stages.push(stage);return stage}
  const production=new NativeMeasurementProduction(abi,workspace),nativeCall=abi.nativeCall
  abi.nativeCall=function(name,...args) {
    if(name==='terra_open_surface_model')opened.push({resource:args[2],reuse:args[3]})
    return nativeCall.call(this,name,...args)
  }
  const resource=fixture=>{
    const positions=fixture.model.positions
    const value=ownPayload({model:fixture.model,positions},
      ledger.reserve('fixture-reuse-host',positions.byteLength),positions.byteLength)
    resources.push(value);return value
  }
  const receipt=()=>{for(const [stage,credit] of credits)if(stage.finished){abi.imageryInputBudget.finish(credit);credits.delete(stage)}}
  const grant=()=>{
    const stage=stages[stages.length-1],quote=stage.quote();assert(quote)
    const credit=abi.imageryInputBudget.begin(quote.bytes);assert(credit)
    credits.set(stage,credit);assert(stage.grant({id:quote.id,bytes:credit.bytes}))
  }
  const run=iterator=>{
    work=iterator
    for(let i=0;i<10000;++i){const next=iterator.next();receipt();if(next.done){work=null;return next.value}if(next.value===TASK_WAIT)grant()}
    assert.fail('Model reuse did not converge')
  }
  try {
    const a=resource(first),b=resource(peer),original=run(production.model(first.draw,a,{planId}))
    const retired=original.value
    work=production.model(peer.draw,b,{planId})
    const waiting=work.next();assert(!waiting.done&&waiting.value===TASK_WAIT)
    assert(production.trim(1).released>0,'Idle reusable model was not reclaimed during metadata admission')
    assert.strictEqual(retired.id,0)
    const rebuilt=run(work)
    assert(rebuilt.value.id,'Reclaimed optional layout prevented model production')
    assert.deepStrictEqual(opened.slice(0,2).map(v=>v.reuse),[0,0],
      'A retired optional model ID crossed the allocation wait')
    assert.strictEqual(production.stats().layoutReuses,0,'Retired layout was counted as reused')

    const actual=run(production.measure(peer.draw,b,context,{planId,viewRevision:1,sourceRevision:1}));rows.push(actual.regions)
    cold=await abi.createNativeSurfaceModelTask(peer.draw,{planId}).run()
    const expected=await abi.createNativeSurfaceMeasurementTask(cold,context,{viewRevision:1,sourceRevision:1}).run();rows.push(expected.regions)
    assert.strictEqual(actual.pixelsPerUv,expected.pixelsPerUv)
    assert.deepStrictEqual(copy(actual.regions),copy(expected.regions),'Optional layout reclamation changed canonical measurements')

    run(production.model(first.draw,a,{planId}))
    assert(opened[opened.length-1].reuse>0,'A live compatible layout stopped being reused')
    assert.strictEqual(production.stats().layoutReuses,1)
    assert(stages.every(stage=>stage.finished)&&!credits.size)
  }finally {
    if(work)work.return()
    production.destroy();receipt()
    for(const value of rows)value.close()
    if(cold)cold.close()
    for(const value of resources)value.ownership.retire()
    abi.nativeCall=nativeCall
  }
  assert.strictEqual(credits.size,0,'Model reuse retained an unacknowledged input grant')
  assert.strictEqual(abi.imageryInputPayloadBytes(),baseline,'Model reuse retained Native allocations')
  console.log('Native model reuse: admission wait, idle reclamation, live reuse, exact measurements and receipts passed')
}
