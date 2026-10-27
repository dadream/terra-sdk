const assert = require('assert')
const {SurfaceCommands} = require('../../adapters/webgl/surface_commands')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')

module.exports = function () {
  const ledger = new ResourceLedger(10000), cache = new SurfaceCommands(ledger)
  const r = {canvas:{width:64,height:64},cameraVersion:1,program:{},indexBuffer:{},mode:'texture',
    heightRange:[0,100],debugOptions:{textureState:false},atmosphereEnabled:false,atmosphere:{},
    planetRadius:6378000,overlays:{points:[]}}
  const command = {draw:{firstIndex:0,indexCount:3,flags:0,origin:[0,0,0]},
    geometry:{positionBuffer:{},uvBuffer:{}},part:null,
    binding:{texture:{},scale:1,offsetX:0,offsetY:0,kind:'exact'},
    oldBinding:{texture:{},scale:1,offsetX:0,offsetY:0},alpha:1}
  const plan = {relative:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),
    viewFrame:{cameraPosition:[0,0,0]},stencil:true,previewCoverage:false,commands:[command]}
  cache.retain(r,plan)
  const lease = cache.lease, revision = ledger.availabilityRevision
  assert(cache.matches(r,plan))
  cache.retain(r,plan)
  assert.strictEqual(cache.lease,lease,'Identical frames churned ledger ownership')
  assert.strictEqual(ledger.availabilityRevision,revision)
  const changed = (object,key,value) => {
    const old=object[key];object[key]=value
    assert(!cache.matches(r,plan),key+' changed without invalidating GPU command equality')
    object[key]=old
    assert(cache.matches(r,plan))
  }
  changed(command.binding,'texture',{}) // Same tile key can acquire a new GPU image.
  changed(command.binding,'offsetX',0.25)
  command.oldBinding.scale = 0.5
  assert(cache.matches(r,plan), 'An unused old sampler invalidated completed color')
  changed(command,'alpha',0.75)
  changed(command.geometry,'positionBuffer',{})
  changed(command.draw,'firstIndex',3)
  changed(command.draw,'origin',[0,1,0])
  changed(command.draw,'flags',1)
  changed(command.draw,'imageryDirectClip',true)
  changed(plan,'previewCoverage',true)
  changed(plan.relative,12,0.1)
  changed(r,'overlays',{points:[]})
  changed(r,'atmosphere',{})
  changed(r.canvas,'height',65)
  const shown = command.binding
  command.oldBinding = shown
  command.binding = {texture:{},scale:0.5,offsetX:0.25,offsetY:0.5,kind:'exact'}
  command.alpha = 0
  assert(cache.matches(r,plan), 'Starting a blend repainted its unchanged old endpoint')
  command.binding.texture = {}; command.binding.offsetY = 0.25
  assert(cache.matches(r,plan), 'Zero-weight destination changed displayed color')
  changed(command.oldBinding,'texture',{})
  changed(command.oldBinding,'offsetY',0.25)
  changed(command.binding,'kind','fallback')
  command.alpha = 0.5
  assert(!cache.matches(r,plan), 'An intermediate blend reused its old endpoint')
  cache.retain(r,plan)
  changed(command.binding,'texture',{})
  changed(command.binding,'offsetX',0.5)
  changed(command.oldBinding,'texture',{})
  changed(command.oldBinding,'scale',0.5)
  changed(command,'alpha',0.75)
  command.alpha = 1
  cache.retain(r,plan)
  command.oldBinding = {texture:{},scale:0.25,offsetX:0.5,offsetY:0.75}
  assert(cache.matches(r,plan), 'Completed blend retained inactive sampler inputs')
  // A display-only blend changes commands without freeing any new admission
  // capacity: the old optional snapshot was already immediately reclaimable.
  for (let i=0;i<20;++i) {
    command.alpha=(i+1)/20
    cache.retain(r,plan)
    assert(cache.matches(r,plan), 'A changing blend lost its exact command snapshot')
  }
  assert.strictEqual(ledger.availabilityRevision,revision,
    'Display-only updates woke capacity-blocked imagery producers')
  assert.strictEqual(ledger.bytes,cache.values.byteLength)
  const bytes=ledger.bytes
  cache.clear();ledger.setLimit(bytes-1)
  cache.retain(r,plan)
  assert.strictEqual(ledger.bytes,0,'Optional command storage exceeded its admitted bytes')
  assert(!cache.matches(r,plan),'Unadmitted snapshot suppressed rendering')
  ledger.setLimit(bytes)
  const competitor=ledger.reserve('real-image',bytes)
  competitor.reclaimable=()=>true
  competitor.reclaim=()=>{throw Error('Command cache evicted a real image')}
  cache.retain(r,plan)
  assert(!cache.values)
  competitor.release();cache.retain(r,plan)
  const admitted=ledger.reserve('terrain',bytes)
  assert(admitted && !cache.values,'Real work could not reclaim the optional snapshot')
  admitted.release();cache.clear();assert.strictEqual(ledger.bytes,0)
  const visit=cache.visit
  let visits=0
  cache.visit=function(...args){if (++visits===2) throw Error('Injected optional storage failure');return visit.apply(this,args)}
  cache.retain(r,plan)
  assert(!cache.values && !cache.lease && ledger.bytes===0,'Optional storage failure leaked credit or stopped publication')
  cache.visit=visit
}
