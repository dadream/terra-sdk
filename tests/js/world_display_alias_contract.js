const assert=require('assert')
const {TerraWebGlRenderer}=require('../../adapters/webgl/terra_webgl_renderer')
const {FakeGl,FakeCanvas,frame}=require('./support/webgl_fixture')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')
const {ImageTextureStore}=require('../../adapters/webgl/image_texture_store')

module.exports=async function (Renderer=TerraWebGlRenderer) {
  const canvas=new FakeCanvas(new FakeGl());canvas.width=canvas.height=256
  const r=new Renderer(canvas,{mode:'texture',scheduledImagery:true,terrainBoundImagery:false,
    requestResources(){},requestRender(){},textureTransitionMs:0,maximumResourceBytes:4*1024*1024,
    maximumTextureEntries:16,createTextureStore:(renderer,options)=>new ImageTextureStore(renderer,options),
    textureDescriptor:{kind:'global-geodetic',level_zero_columns:2,
      level_zero_rows:1,matrix_level_offset:1,tile_size:16,maximum_level:8},urlForTile:()=>null})
  const root={level:0,matrix:1,row:0,column:0},child=descendantTextureTile(root,1,0,0)
  r.textures.scheduler.pause()
  const resource=id=>({resourceId:id,positions:new Float32Array([-1,-1,id/100,1,-1,id/100,
    -1,1,id/100,1,1,id/100]),textureUv:new Float32Array([0,0,1,0,0,1,1,1])})
  const source=id=>({resourceId:id,textureResourceId:100+id,origin:[0,0,0],key:{level:0,i:id,j:0,k:0},
    fragment:0,texture:root,firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4})
  const select=()=>{r.setImageryPlan(r.current.frame.sequence,{draws:[{...r.current.draws[0],texture:child,sourceTexture:root}],
    levels:new Map(),quality:{planningComplete:true,cameraCurrent:true,targetPixelError:1.25}},[]);r.textures.recomputeAvailability()}
  const set=id=>{r.setMeshFrame({...frame(),sequence:id,coverageComplete:true},[source(id)],
    new Map([[id,resource(id)]]),new Uint16Array([0,2,1,3]),{modelRevision:id});select()}
  r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]]})
  r.measureTextureDraw=()=>0.5
  const step=async(display=true)=>{r.advanceResources();if(display)r.render(false);await Promise.resolve()}
  try {
    for(const tile of [...r.textures.coverageTiles,child])r.textures.cache.set(key(tile),
      {image:{},texture:{},width:16,height:16},1364)
    set(1)
    for(let n=0;n<200&&(!r.displaySurface||r.displaySurface.current!==r.current||!r.worldDisplay.targetPrepared());++n)await step()
    assert(r.displaySurface&&r.displaySurface.current===r.current)
    const previous=r.displaySurface.current,promote=r.promoteCurrentSurfaceIfReady
    r.promoteCurrentSurfaceIfReady=()=>false
    set(2)
    assert.strictEqual(r.worldDisplay.prepared(r.renderDraws),null,'An unprepared terrain source borrowed another model')
    for(let n=0;n<300&&(!r.worldDisplay.prepared(r.renderDraws)||r.partitionActive||r.partitionQueue.length||
        r.partitionUploads.length||!r.currentTargetGeometryReady());++n)await step(false)
    const record=r.worldDisplay.prepared(r.renderDraws)
    assert(record&&r.currentTargetGeometryReady()&&r.displaySurface.current===previous)
    r.promoteCurrentSurfaceIfReady=promote
    const before=r.worldDisplay.stats.slices
    const oldDraws=r.renderDraws
    select()
    assert.notStrictEqual(r.renderDraws,oldDraws,'Fixture did not publish a new goal-array description')
    assert(!record.aliases.has(r.renderDraws),'Fixture collected its new goals before the display turn')
    assert(r.promoteCurrentSurfaceIfReady(),
      'A new image-goal description hid a prepared immutable terrain source')
    assert.strictEqual(r.worldDisplay.targetState(),'waiting',
      'Display source reuse approved image demand before the resource clock checked its goals')
    r.render(false)
    assert.strictEqual(r.displaySurface.current,r.current,'Display did not publish the prepared new terrain')
    assert.strictEqual(r.lastSubmittedSurface,r.current)
    assert.strictEqual(r.qualityStats.missingCount,0)
    assert.strictEqual(r.worldDisplay.stats.slices,before,'Display lookup advanced a topology task')
    const wake=r.partitionGroups.wakeImagery
    let wakes=0
    r.partitionGroups.wakeImagery=function(){++wakes;return wake.call(this)}
    r.textures.preparationWaiting.add(key(child))
    r.worldDisplay.collect()
    assert.strictEqual(r.worldDisplay.targetState(),'ready','Equivalent goals did not regain their checked demand receipt')
    assert.strictEqual(r.textures.preparationWaiting.size,0,
      'Checking equivalent goals left image admission parked without another world build')
    assert.strictEqual(wakes,1,'Checked goals did not wake image admission once')
    r.worldDisplay.collect()
    assert.strictEqual(wakes,1,'An unchanged source created an admission wake loop')
  } finally {r.destroy();await new Promise(resolve=>setTimeout(resolve,0))}
  assert.strictEqual(r.resourceLedger.bytes,0,'Prepared-source lookup retained resource ownership')
  console.log('World display source lookup: fresh goal aliases publish prepared terrain before resource collection without approving unchecked demand')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
