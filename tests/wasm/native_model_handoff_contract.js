const assert=require('assert')
const {NativeMeasurementProduction}=require('../../adapters/wasm/native_measurement_production')
const {ownMesh}=require('../../sdk/js/resources/mesh_ownership')
const {projectionContext}=require('../../sdk/js/terrain/terra_surface_plan')

// Real models, measurements and credits; only the CPU consumer wrappers are
// duplicated. Refused successors and pressure must not retain a Native model.
module.exports=function(abi,frames) {
  const before=abi.imageryInputPayloadBytes(),packet=frames.presented
  const draw=packet.draws.find(value=>!value.flags),original=packet.resources.get(draw.resourceId)
  const copies=[],production=new NativeMeasurementProduction(abi)
  const copy=()=>{
    const value=ownMesh({resourceId:draw.resourceId,textureResourceId:draw.textureResourceId,
      positions:original.positions.slice(),textureUv:original.textureUv,uvResource:original.uvResource},
    frames.ledger.reserve('model-handoff-copy',original.positions.byteLength))
    copies.push(value);return value
  }
  const drain=work=>{for(let i=0;i<10000;++i){const next=work.next();if(next.done)return next.value}throw new Error('Native model handoff did not finish')}
  const map=value=>new Map([[draw.resourceId,value]])
  let active
  try {
    const first=copy(),successor=copy(),refused=copy()
    const entry=drain(production.model(draw,first)),nativeId=entry.value.id
    production.shareModels(map(first),map(successor))
    production.shareModels(map(first),map(refused))
    refused.ownership.retire()
    first.ownership.retire()
    assert.strictEqual(entry.value.id,nativeId,'Retiring the original wrapper closed the successor model')
    const reused=production.model(draw,successor).next()
    assert(reused.done&&reused.value===entry,'Same immutable geometry rebuilt its model after handoff')
    assert.strictEqual(production.stats().modelsBuilt,1)
    const wrong=copy();wrong.resourceId+=1
    assert.throws(()=>production.shareModels(map(successor),map(wrong)),/source identity/)
    wrong.ownership.retire()
    active=production.measure(draw,successor,projectionContext(packet.frame,{width:640,height:360}),
      {viewRevision:1,sourceRevision:1,maximumOperations:1,maximumMilliseconds:0})
    const pending=active.next();assert(!pending.done,'Fixture needs an in-flight Native reader')
    assert.strictEqual(production.trim(Number.MAX_SAFE_INTEGER).released,0,'Pressure reclaimed an active reader')
    const measured=drain(active);active=null
    assert(measured.regions.length>0)
    production.settle([])
    assert(production.trim(Number.MAX_SAFE_INTEGER).released>0)
    assert.strictEqual(production.stats().models,0)
    const rebuilt=drain(production.model(draw,successor))
    assert(rebuilt.value.id&&production.stats().modelsBuilt===2,'Pressure did not detach all wrapper bindings')
    successor.ownership.retire()
    assert.strictEqual(production.stats().models,0,'Final geometry owner retained its Native model')
  } finally {
    if(active)active.return()
    production.destroy()
    copies.forEach(value=>value.ownership.retire())
  }
  assert.strictEqual(abi.imageryInputPayloadBytes(),before)
  console.log('Native model handoff: same source, original/refused retirement, active reader, pressure and final release passed')
}
