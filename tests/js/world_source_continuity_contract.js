const assert = require('assert')
const {TerraWebGlRenderer} = require('../../adapters/webgl/terra_webgl_renderer')
const {FakeGl, FakeCanvas, frame} = require('./support/webgl_fixture')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')

module.exports = async function (Renderer = TerraWebGlRenderer) {
  const canvas = new FakeCanvas(new FakeGl());canvas.width = canvas.height = 256
  const r = new Renderer(canvas, {mode:'height', terrainBoundImagery:false, scheduledImagery:true,
    textureTransitionMs:0, requestResources(){}, requestRender(){}, maximumResourceBytes:4*1024*1024,
    maximumTextureEntries:16, textureDescriptor:{kind:'global-geodetic', level_zero_columns:2,
      level_zero_rows:1, matrix_level_offset:1, tile_size:16, maximum_level:8}, urlForTile:()=>null})
  const roots=[0,1].map(column=>({level:0,matrix:1,row:0,column}))
  const resource=id=>({resourceId:id, positions:new Float32Array([-1,-1,id/100, 1,-1,id/100,
    -1,1,id/100, 1,1,id/100]), textureUv:new Float32Array([0,0,1,0,0,1,1,1])})
  const draw=(id,column)=>({resourceId:id,textureResourceId:100+id,origin:[0,0,0],
    key:{level:0,i:id,j:0,k:0},fragment:0,texture:Object.assign({},roots[column],{matrix:0}),
    firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4})
  const indices=new Uint16Array([0,2,1,3])
  r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]]})
  r.measureTextureDraw=()=>0.5
  const turn=async()=>{r.advanceResources();r.render(false);await Promise.resolve()}
  try {
    for(const tile of roots)r.textures.cache.set(key(tile),{image:{},texture:{},width:16,height:16},1364)
    r.setMeshFrame(Object.assign(frame(),{sequence:1,coverageComplete:true}),[draw(1,0),draw(2,1)],
      new Map([[1,resource(1)],[2,resource(2)]]),indices,{modelRevision:1})
    for(let n=0;n<20&&!r.displaySurface;++n)await turn()
    assert(r.displaySurface,'Initial geometry did not publish')
    const start=r.worldDisplay.start
    r.worldDisplay.start=function(record){const result=start.call(this,record);if(this.job)this.job.task.maximumSteps=1;return result}
    r.setMode('texture')
    const identities = new Set()
    // The geometry is fixed. The visible imagery alternates between disjoint
    // meshes faster than a world task can finish, without withholding work.
    for(let n=0;n<240;++n) {
      const camera=frame();camera.projectionView[3]=n/10000;r.setCameraFrame(camera)
      const goal=Object.assign({},r.current.draws[n%2],{texture:roots[n%2],sourceTexture:roots[n%2]})
      r.setImageryPlan(1,{draws:[goal],levels:new Map(),quality:{
        targetPixelError:1.25,planningComplete:true,cameraCurrent:true,spatialCut:true}},[])
      // Exercise the world producer's input contract directly. Demand merging
      // may add its own roots; those must not supply the producer's identity.
      r.renderDraws=[goal]
      await turn()
      const identity=r.worldDisplay.request(r.renderDraws)
      if(identity)identities.add(identity)
    }
    assert(r.worldDisplay.stats.completed>0,
      'Changing visible imagery cancelled preparation for unchanged terrain sources')
    assert.strictEqual(r.worldDisplay.stats.cancelled,0,'Visible demand retired a fixed terrain source')
    assert.strictEqual(identities.size,1,'Visible goals created different records for the same terrain source')
    const record=r.worldDisplay.prepared(r.renderDraws)
    assert(record&&record.cuts.size===2,'World footprint omitted an unrequested source mesh')
    for(const source of r.current.draws) {
      const cut=record.cuts.get(source.geometryKey)
      assert(cut&&cut.rows.length&&cut.sources.size===1)
      assert(cut.rows.every(row=>row.resourceId===source.resourceId))
      assert(cut.rows.every(row=>(row.sourceTexture||row.texture).matrix===1),
        'World source matrix differs from the renderer source normalization')
    }
    const visibleGoals=r.renderDraws,displayGoals=r.displaySurface.renderDraws
    const slices=r.worldDisplay.stats.slices
    try {
      // Packet/view descriptions may carry different transport offsets for
      // the same immutable GPU mesh. They do not define its physical scope.
      r.renderDraws=visibleGoals.map(goal=>({...goal,firstVertex:99999}))
      const pending=r.worldDisplay.pending.size
      assert(r.worldDisplay.compatible(r.renderDraws),
        'View-goal metadata hid compatible submitted terrain sources')
      assert.strictEqual(r.worldDisplay.pending.size,pending,'Compatibility lookup scheduled unchecked image work')
      const current=r.worldDisplay.read(r.renderDraws)
      assert(!current.coveragePending&&current.chosen.size===new Set(visibleGoals.map(draw=>draw.geometryKey)).size,
        'View-goal metadata rejected a ready immutable terrain cut')
      assert(!r.worldDisplay.demandPrepared(record),
        'Canonical terrain reuse approved a new unchecked image demand')
      r.displaySurface.renderDraws=displayGoals.map(goal=>({...goal,firstVertex:88888}))
      const displayed=r.worldDisplay.read(r.displaySurface.renderDraws)
      assert(!displayed.coveragePending&&displayed.chosen.size===new Set(displayGoals.map(draw=>draw.geometryKey)).size,
        'Old display goals stopped a prepared terrain source from receiving its new image targets')
      assert.strictEqual(r.worldDisplay.stats.slices,slices,'Display lookup advanced world preparation')
    } finally {r.renderDraws=visibleGoals;r.displaySurface.renderDraws=displayGoals}
    assert.strictEqual(r.presentedCameraVersion,r.cameraVersion,'Preparation blocked the latest camera')
    assert(r.drawStats.submitted>0&&r.qualityStats.missingCount===0)
    assert(!r.qualityStats.meetsTarget||r.qualityStats.resolvedMaxPixelError<=1.25,
      'A retained world footprint forged precision')
    assert.strictEqual(r.resourceLedger.stats().overBudgetBytes,0)
    const valid=Object.assign({},r.current.draws[0],{texture:roots[0],sourceTexture:roots[0]})
    const foreign=Object.assign({},valid,{resourceId:99,geometryKey:'foreign'})
    r.renderDraws=[foreign,valid]
    for(let n=0;n<400&&!r.worldDisplay.targetPrepared();++n)await turn()
    assert(r.worldDisplay.targetPrepared(),'A foreign image goal blocked the valid terrain scope')
    assert(r.worldDisplay.prepared(r.renderDraws).rows.every(row=>row.resourceId!==99),
      'An image goal outside the terrain cut became a world source')
    r.worldDisplay.start=start
    // A real immutable-mesh change must create a new source record. Reusing
    // a view record must never alias different terrain data or UV resources.
    r.setMeshFrame(Object.assign(frame(),{sequence:2,coverageComplete:true}),[draw(1,0),draw(3,1)],
      new Map([[1,resource(1)],[3,resource(3)]]),indices,{modelRevision:2})
    r.setImageryPlan(2,{draws:r.current.draws.map((source,i)=>Object.assign({},source,
      {texture:roots[i],sourceTexture:roots[i]})),levels:new Map(),quality:{targetPixelError:1.25,
      planningComplete:true,cameraCurrent:true,spatialCut:true}},[])
    for(let n=0;n<80&&(!r.worldDisplay.prepared(r.renderDraws)||
        r.worldDisplay.prepared(r.renderDraws)===record||r.displaySurface.current!==r.current);++n)await turn()
    const changed=r.worldDisplay.prepared(r.renderDraws)
    assert(changed&&changed!==record&&r.displaySurface.current===r.current,'Different terrain source reused an old world cut')
    await turn()
    assert(record.closed,'Retired terrain source retained a world record')
    assert(changed.rows.some(row=>row.resourceId===3)&&!changed.rows.some(row=>row.resourceId===2))
  } finally {r.destroy();await new Promise(resolve=>setTimeout(resolve,0))}
  assert.strictEqual(r.resourceLedger.bytes,0)
  assert(!r.resourceTimer&&!r.textures.retryTimers.size)
  console.log('World sources: disjoint moving goals, persistent bounded work, complete mesh scope and teardown passed')
  console.log('World source identity: canonical terrain scope, mutable view metadata and unchecked demand isolation passed')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
