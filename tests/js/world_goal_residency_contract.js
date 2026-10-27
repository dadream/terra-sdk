const assert=require('assert')
const {TerraWebGlRenderer}=require('../../adapters/webgl/terra_webgl_renderer')
const {FakeGl,FakeCanvas,frame}=require('./support/webgl_fixture')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')

module.exports=async function(Renderer=TerraWebGlRenderer) {
  const canvas=new FakeCanvas(new FakeGl());canvas.width=canvas.height=256
  const r=new Renderer(canvas,{mode:'height',scheduledImagery:true,terrainBoundImagery:false,
    requestResources(){},requestRender(){},textureTransitionMs:0,maximumResourceBytes:4*1024*1024,
    maximumTextureEntries:16,textureDescriptor:{kind:'global-geodetic',level_zero_columns:2,
      level_zero_rows:1,matrix_level_offset:1,tile_size:16,maximum_level:8},urlForTile:()=>null})
  const root={level:0,matrix:1,row:0,column:0},wanted=descendantTextureTile(root,1,0,0)
  const historical=descendantTextureTile(root,1,0,1)
  const resource={resourceId:1,positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
    textureUv:new Float32Array([0,0,1,0,0,1,1,1])}
  const source={resourceId:1,textureResourceId:101,origin:[0,0,0],key:{level:0,i:1,j:0,k:0},
    fragment:0,texture:root,firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}
  r.textures.scheduler.pause()
  r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]],regions:[{
    uv:{minimumU:0.05,minimumV:0.05,maximumU:0.45,maximumV:0.45}}]})
  r.measureTextureDraw=(draw,level)=>key(draw.texture)===key(historical)?0:2/Math.pow(2,level)
  const turn=async(display=true)=>{r.advanceResources();if(display)r.render(false);await Promise.resolve()}
  const seed=tile=>r.textures.cache.set(key(tile),{image:{},texture:{},width:16,height:16},1364)
  try {
    for(const tile of [...r.textures.coverageTiles,historical])seed(tile)
    r.setMeshFrame({...frame(),sequence:1,coverageComplete:true},[source],new Map([[1,resource]]),
      new Uint16Array([0,2,1,3]),{modelRevision:1})
    for(let n=0;n<100&&!r.displaySurface;++n)await turn()
    assert(r.displaySurface)
    r.setMode('texture')
    r.textures.scheduler.pause()
    r.setImageryPlan(1,{draws:[{...r.current.draws[0],texture:wanted,sourceTexture:root}],
      levels:new Map(),quality:{targetPixelError:1.25,planningComplete:true,cameraCurrent:true,spatialCut:true}},
      [{resourceId:1,pixelsPerUv:32,visible:true,centerDistance:0}])
    assert.strictEqual(r.current.imageryPlan.quality.planningComplete,true,'Fixture has no authoritative current goal')
    r.presentedTextures=new Map([[key(historical),historical]])
    r.presentation.cells=new Map([[key(historical),{cell:historical,a:historical,b:historical,alpha:1,goal:1,at:0}]])
    r.textures.recomputeAvailability()
    for(let n=0;n<400&&(!r.worldDisplay.targetPrepared()||r.partitionActive||r.partitionQueue.length||
        r.partitionUploads.length);++n)await turn(false)
    assert(r.worldDisplay.targetPrepared())
    const record=r.worldDisplay.prepared(r.renderDraws)
    assert(record&&record.rows.some(d=>key(d.imageryTarget)===key(wanted)))
    assert(!r.textures.targetDesired.has(key(historical)),'Historical image is still a current demand')
    r.render(false)
    assert.strictEqual(r.qualityStats.missingCount,0,'Missing future imagery removed coarse coverage')
    assert(!r.presentedTextures.has(key(historical)),'Off-view history is still displayed')
    assert(!r.textures.protectedKeys.has(key(historical)),'Fixture evicted a protected historical image')
    r.textures.cache.delete(key(historical))
    assert(!r.textures.cache.has(key(historical)),'Completed world preparation still pins the historical image')
    seed(wanted);r.textures.recomputeAvailability()
    for(let n=0;n<400;++n)await turn()
    assert.strictEqual(r.textures.stats().targetMissing,0,'Current demand did not become resident '+JSON.stringify({
      desired:Array.from(r.textures.targetDesired.keys()),cached:Array.from(r.textures.cache.entries.keys()),
      available:Array.from(r.textures.availableKeys),failed:Array.from(r.textures.failed),
      wanted:key(wanted),rows:record.rows.map(d=>key(d.imageryTarget))}))
    assert(r.qualityStats.resolvedMaxPixelError<=1.25,
      'An unrequested historical image blocked resident current goals '+JSON.stringify({
        error:r.qualityStats.resolvedMaxPixelError,pending:Array.from(record.publication.pending.keys()),
        targets:record.rows.map(d=>key(d.imageryTarget)),wanted:key(wanted),historical:key(historical)}))
    assert.strictEqual(r.partitionQueue.length,0)
    assert.strictEqual(r.partitionUploads.length,0)
    assert(!r.partitionActive)
    assert(record.rows.some(d=>key(d.texture)===key(historical)),
      'Dropping a historical material also discarded its retained spatial footprint')
    assert(record.rows.every(d=>key(d.imageryTarget)===key(wanted)||d.imageryTarget.level===0),
      'Undemanded cached imagery remained a publication prerequisite')
    assert.strictEqual(r.qualityStats.missingCount,0)
    assert.strictEqual(r.resourceLedger.stats().overBudgetBytes,0)
  } finally {r.destroy();await new Promise(resolve=>setTimeout(resolve,0))}
  assert.strictEqual(r.resourceLedger.bytes,0)
  console.log('World image goals: off-view history cannot block fully resident current demand; coverage and teardown preserved')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
