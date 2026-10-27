const assert=require('assert')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {ownPayload}=require('../../sdk/js/resources/mesh_ownership')
const {WorldDisplayPlan}=require('../../adapters/webgl/world_display_plan')
const {PartitionPublication}=require('../../adapters/webgl/partition_publication')
const {PartitionGroups}=require('../../adapters/webgl/partition_groups')
const {ResourceCache}=require('../../sdk/js/resources/resource_cache')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')

function verifyPreparationReceipt() {
  const ledger=new ResourceLedger(10000),root={level:0,matrix:0,row:0,column:0}
  const child={level:1,matrix:1,row:0,column:0},next={level:2,matrix:2,row:0,column:0}
  const geometry={key:'mesh:1',partitions:new Map([[key(child),{}]])}
  const r={resourceLedger:ledger,partitionGeneration:1,partitionReservedBytes:0,
    geometryPinnedKeys:new Set([geometry.key]),geometry:new ResourceCache({ledger}),
    textures:{generation:1,desired:new Map([[key(child),child]]),failed:new Set(),cache:new ResourceCache({ledger}),
      gpuReady(id){return this.cache.has(id)}}}
  r.geometry.set(geometry.key,geometry,100)
  r.textures.cache.set(key(root),{},100)
  r.renderDraws=[{geometryKey:geometry.key,texture:root,textureResourceId:1}]
  r.partitionPublication=new PartitionPublication(()=>geometry,id=>r.textures.gpuReady(id),()=> 'group')
  const rows=[{...r.renderDraws[0],texture:child,imageryTarget:root,imageryClipCell:true}]
  // A successor introduces another UV destination. Its full array is neither
  // the submitted cut nor the coarse stage that can make image slots reusable.
  r.partitionPublication.prepare([...rows,{...rows[0],texture:next}])
  const world=r.worldDisplay=new WorldDisplayPlan(r),groups=new PartitionGroups(r)
  const future=new Map([[key(child),child]])
  const ticket={generation:1,source:1,future,futureName:key(child),draws:r.renderDraws,
    sources:groups.sources(r.renderDraws,future),rows:new Map([[geometry.key,{
      geometry,owner:r.geometry.entries.get(geometry.key),partitions:geometry.partitions,
      cells:[{key:key(child)}]}]]),required:new Set([geometry.key+':'+key(child)]),pending:new Map(),
    images:[[key(root),r.textures.cache.entries.get(key(root))]],
    releases:[r.geometry.retain(geometry.key),r.textures.cache.retain(key(root))],
    metadata:ledger.reserve('imagery-footprint-work',512)}
  groups.prepared.set(ticket.futureName,ticket)
  const bytes=ledger.bytes
  try {
    groups.publish()
    assert.strictEqual(groups.prepared.size,1,'An unfinished image released preparation ownership')
    r.textures.cache.set(key(child),{},100)
    groups.publish()
    assert.strictEqual(groups.prepared.size,1,'Preparation adopted a cut that was never submitted')
    const cut=ownPayload({rows},ledger.reserve('display-cut',1024),1024,()=>{cut.rows=[]})
    world.commit(new Map([[geometry.key,cut]]));cut.ownership.retire()
    assert.strictEqual(geometry.partitionDraws,rows)
    assert.notStrictEqual(r.partitionPublication.meshes.get(geometry.key),rows)
    groups.publish()
    assert.strictEqual(groups.prepared.size,0,
      'Submitted immutable terrain retained an obsolete full-array preparation ticket')
    assert.strictEqual(r.textures.cache.entries.get(key(root)).holds,0)
    assert.strictEqual(ledger.bytes,bytes+100+1024-512,
      'Preparation acknowledgement refunded resident images or display metadata')
    assert(r.partitionPublication.required.has(geometry.key+':'+key(next)),
      'Preparation acknowledgement erased the successor UV dependency')
  }finally {
    groups.clear();world.clear();r.geometry.clear();r.textures.cache.clear()
    assert.strictEqual(ledger.bytes,0)
  }
}

module.exports=function verifyPublicationRetirement() {
  verifyPreparationReceipt()
  const ledger=new ResourceLedger(10000),geometry={partitions:new Map()}
  const r={resourceLedger:ledger,geometry:{entries:new Map([['mesh:1',{value:geometry}]])}}
  r.partitionPublication=new PartitionPublication(()=>geometry,()=>true,()=> 'root')
  const publication=new PartitionPublication(()=>geometry,()=>true,()=> 'root')
  const rows=[{geometryKey:'mesh:1',texture:{level:0,matrix:0,row:0,column:0}}]
  publication.prepare(rows);r.partitionPublication.adopt(publication)
  const cut=ownPayload({rows},ledger.reserve('display-cut',1024),1024,()=>{cut.rows=[]})
  geometry.partitionDraws=rows
  const record={cuts:new Map([['mesh:1',cut]]),publication},world=new WorldDisplayPlan(r)
  world.records=[record]
  world.entries.set('mesh:1',{current:cut,close:cut.ownership.hold()})
  world.releaseRecord(record)
  assert.strictEqual(ledger.bytes,1024,'Producer retirement refunded metadata still used by display')
  world.releaseEntry('mesh:1')
  assert.strictEqual(ledger.bytes,0)
  assert.strictEqual(r.partitionPublication.meshes.size,0,'Publication retained unowned retired rows')
  assert.strictEqual(r.partitionPublication.pending.size+r.partitionPublication.required.size,0,
    'Retired publication left obsolete UV demand')
  assert.strictEqual(r.partitionPublication.groupRows.size+r.partitionPublication.states.size,0,
    'Retired publication retained world-group rows or readiness')
}
