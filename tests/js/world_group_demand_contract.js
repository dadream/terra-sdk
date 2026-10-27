const assert=require('assert')
const {TerraWebGlRenderer}=require('../../adapters/webgl/terra_webgl_renderer')
const {FakeGl,FakeCanvas,frame}=require('./support/webgl_fixture')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')
const {ImageTextureStore}=require('../../adapters/webgl/image_texture_store')
const {WorldDemandIndex}=require('../../adapters/webgl/world_demand_index')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')

function verifyIndex() {
  const ledger=new ResourceLedger(4*1024*1024),root={level:0,matrix:1,row:0,column:0}
  const a=descendantTextureTile(root,1,0,0),b=descendantTextureTile(root,1,0,1)
  const draws=Array.from({length:2048},(_,i)=>({geometryKey:'mesh:'+i,texture:i===2047?b:a,signature:'goal:'+i}))
  const record={goalRevision:1,draws,cuts:new Map(draws.map(d=>[d.geometryKey,{goals:[d.signature]}]))}
  record.cuts.get('mesh:2047').goals=['earlier']
  let clock=0,reads=0,slices=0
  const index=new WorldDemandIndex(record,ledger,draw=>{++reads;return draw.signature},()=>{clock+=.01;return clock})
  while(!index.complete){const before=clock;index.task.step();++slices;assert(clock-before<4.05)}
  assert(slices>1,'A large demand index ignored its CPU slices')
  assert.strictEqual(reads,draws.length)
  for(let n=0;n<10000;++n) {
    assert(index.allows(new Map([[key(a),a]])))
    assert(!index.allows(new Map([[key(root),root]])))
    const child=descendantTextureTile(b,3,1,1)
    assert(!index.allows(new Map([[key(child),child]])))
  }
  assert.strictEqual(reads,draws.length,'Admission rescanned terrain instead of querying the index')
  index.close();assert.strictEqual(ledger.bytes,0)
  const pending=new WorldDemandIndex(record,ledger,draw=>draw.signature,()=>{clock+=.01;return clock})
  pending.task.step();assert(!pending.complete);pending.close();assert.strictEqual(ledger.bytes,0)
}

module.exports=async function(Renderer=TerraWebGlRenderer) {
  verifyIndex()
  const canvas=new FakeCanvas(new FakeGl());canvas.width=canvas.height=256
  const r=new Renderer(canvas,{mode:'texture',terrainBoundImagery:false,scheduledImagery:true,
    textureTransitionMs:0,requestResources(){},requestRender(){},maximumResourceBytes:8*1024*1024,
    createTextureStore:(renderer,options)=>new ImageTextureStore(renderer,options),
    textureDescriptor:{kind:'global-geodetic',level_zero_columns:2,level_zero_rows:1,
      matrix_level_offset:1,tile_size:16,maximum_level:8},urlForTile:()=>null})
  r.textures.scheduler.pause()
  const roots=[0,1].map(column=>({level:0,matrix:1,row:0,column})),tiles=roots.map(root=>descendantTextureTile(root,1,0,0))
  const resource=id=>({resourceId:id,positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
    textureUv:new Float32Array([0,0,1,0,0,1,1,1])})
  const sources=roots.map((texture,i)=>({resourceId:i+1,textureResourceId:i+11,origin:[0,0,0],
    key:{level:0,i:i+1,j:0,k:0},fragment:0,texture,firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}))
  r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]]})
  r.measureTextureDraw=()=>.5
  const turn=async()=>{r.advanceResources();r.render(false);await Promise.resolve()}
  const select=values=>r.setImageryPlan(1,{draws:values,levels:new Map(),quality:{planningComplete:false,
    cameraCurrent:true,spatialCut:true,targetPixelError:1.25}},sources.map(s=>({resourceId:s.resourceId,visible:true,pixelsPerUv:100})))
  try {
    for(const tile of roots)r.textures.cache.set(key(tile),{image:{},texture:{},width:16,height:16},1364)
    r.setMeshFrame({...frame(),sequence:1,coverageComplete:true},sources,
      new Map([[1,resource(1)],[2,resource(2)]]),new Uint16Array([0,2,1,3]),{modelRevision:1})
    const initial=r.current.draws.map((draw,i)=>({...draw,texture:tiles[i],sourceTexture:roots[i]}))
    select(initial)
    for(let n=0;n<300&&(!r.worldDisplay.targetPrepared()||r.partitionActive||r.partitionQueue.length||r.partitionUploads.length);++n)await turn()
    assert(r.worldDisplay.targetPrepared(),'Initial complete footprints were not prepared')
    const world=r.worldDisplay,record=world.prepared(r.renderDraws),revision=record.goalRevision
    // Keep a successor pending while a different immutable mesh changes goals.
    const changed={...initial[1],texture:descendantTextureTile(tiles[1],1,0,0)}
    select([changed,initial[0]])
    const groupA=new Map([[key(tiles[0]),tiles[0]]]),groupB=new Map([[key(changed.texture),changed.texture]])
    assert.strictEqual(world.targetState(groupA),'waiting','Unchecked goals borrowed a receipt before collection')
    r.textures.preparationWaiting.add(key(tiles[0]))
    world.collect()
    assert(record.goalRevision>revision)
    assert.strictEqual(world.targetState(),'waiting','A partial receipt approved the whole new world')
    for(let n=0;n<100&&world.targetState(groupA)!=='ready';++n)world.advanceWork(Infinity)
    assert.strictEqual(world.targetState(groupA),'ready','Unrelated refinement blocked an unchanged image group')
    assert.strictEqual(world.targetState(groupB),'waiting','Changed mesh goals borrowed an older footprint')
    assert.strictEqual(r.textures.preparationWaiting.size,0,'Collection did not wake independently prepared demand')
    const loans=[],work=world.imageGroupRows(new Set(['mesh:1']),groupA,()=>{},loans)
    let next
    do{next=work.next()}while(!next.done)
    assert(next.value.length&&next.value.every(draw=>draw.geometryKey==='mesh:1'))
    loans.forEach(close=>close())
    const selected=r.partitionGroups.pricing.footprintSelections
    assert.strictEqual(r.partitionGroups.prepareImagery(groupA,()=>null),'waiting')
    assert.strictEqual(r.partitionGroups.pricing.footprintSelections,selected+1,
      'The request broker retained a whole-world prerequisite')
    r.partitionGroups.clear();await Promise.resolve();await Promise.resolve()
    r.capacityHandover.set(key(tiles[0]),tiles[0]);world.pressureStamp=world.pressureState()
    assert.strictEqual(world.targetState(groupA),'waiting','Scoped receipt ignored capacity pressure')
    r.capacityHandover.clear();world.pressureStamp=world.pressureState()
    assert.strictEqual(world.targetState(groupA),'ready')
    const camera=frame();camera.projectionView[3]=.1;r.setCameraFrame(camera)
    assert.strictEqual(world.targetState(groupA),'waiting','Scoped receipt approved another camera')
    assert.strictEqual(r.resourceLedger.stats().overBudgetBytes,0)
  } finally {r.destroy();await new Promise(resolve=>setTimeout(resolve,0))}
  assert.strictEqual(r.resourceLedger.bytes,0,'Scoped demand receipts retained resources after destruction')
  console.log('World group demand: independent refinement progresses, changed goals/camera/pressure wait, complete footprint pricing and zero ownership after teardown')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
