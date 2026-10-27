const assert=require('assert')
const {NativeMeasurementProduction}=require('../../adapters/wasm/native_measurement_production')
const {ownPayload}=require('../../sdk/js/resources/mesh_ownership')
const surface=require('../../sdk/js/terrain/terra_surface_plan')
function number(rows){const page=new Uint8Array(176);rows.copyTo(page,0,0,1);return new DataView(page.buffer).getFloat64(0,true)}
function drain(work){let value;do{value=work.next()}while(!value.done);return value.value}

// Real candidate source and Native APIs; the JS model is an independent oracle.
module.exports=function(abi,ledger,fixture,context,planId) {
  const model=fixture.model,resource=ownPayload({model,positions:model.positions},
    ledger.reserve('fixture-production-host',model.positions.byteLength),model.positions.byteLength)
  const production=new NativeMeasurementProduction(abi),original=surface.surfaceMeasurements
  let first,second,release
  try {
    surface.surfaceMeasurements=function*(){throw new Error('Default Native production called the JS projection oracle')}
    first=drain(production.measure(fixture.draw,resource,context,{planId,viewRevision:1,sourceRevision:11}))
    production.settle([first]);assert(first.regions.length>0)
    const before=abi.imageryInputPayloadBytes(),trim=production.trim(1)
    assert(trim.released>0&&abi.imageryInputPayloadBytes()<before)
    assert.strictEqual(production.stats().models,0)
    assert(Number.isFinite(number(first.regions)),'Model reclamation retired numeric rows')
    second=drain(production.measure(fixture.draw,resource,context,
      {planId,viewRevision:2,sourceRevision:11,tight:true,previous:first}))
    release=second.regions.borrow();production.settle([second])
    assert.strictEqual(production.stats().modelsBuilt,2)
    assert.strictEqual(production.stats().refinements,1)
    resource.ownership.retire()
    assert.strictEqual(production.stats().models,0,'Geometry retirement kept its derived Native model')
    production.destroy()
    assert(Number.isFinite(number(second.regions)),'Producer shutdown retired an independent numeric loan')
    release();release=null
    assert.throws(()=>number(second.regions),/loan has ended/i)
  }finally {
    surface.surfaceMeasurements=original
    if(release)release()
    production.destroy();resource.ownership.retire()
    if(first)first.regions.close()
    if(second)second.regions.close()
  }
}
