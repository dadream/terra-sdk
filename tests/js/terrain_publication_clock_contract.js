const assert=require('assert')
const {TerraWebGlRenderer}=require('../../adapters/webgl/terra_webgl_renderer')
const {AsyncGl,FakeCanvas,frame}=require('./support/webgl_fixture')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')

module.exports=async function (Renderer=TerraWebGlRenderer) {
  for(const mode of ['height','texture']) {
    const gl=new AsyncGl(),canvas=new FakeCanvas(gl),receipts=[];canvas.width=canvas.height=256
    const r=new Renderer(canvas,{mode,scheduledImagery:true,terrainBoundImagery:false,
      requestResources(){},requestRender(){},textureTransitionMs:0,maximumResourceBytes:4*1024*1024,
      maximumTextureEntries:16,textureDescriptor:{kind:'global-geodetic',level_zero_columns:2,
        level_zero_rows:1,matrix_level_offset:1,tile_size:16,maximum_level:8},urlForTile:()=>null,
      onSurfaceSubmitted:surface=>receipts.push(surface.frame.sequence)})
    const root={level:0,matrix:1,row:0,column:0},indices=new Uint16Array([0,2,1,3])
    r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]]})
    r.measureTextureDraw=()=>0.5
    const set=id=>{
      const draw={resourceId:id,textureResourceId:100+id,origin:[0,0,0],key:{level:0,i:id,j:0,k:0},
        fragment:0,texture:root,firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}
      r.setMeshFrame({...frame(),sequence:id,coverageComplete:true},[draw],new Map([[id,{resourceId:id,
        positions:new Float32Array([-1,-1,id/100,1,-1,id/100,-1,1,id/100,1,1,id/100]),
        textureUv:new Float32Array([0,0,1,0,0,1,1,1])}]]),indices,{modelRevision:id})
      if(mode==='texture')r.setImageryPlan(id,{draws:r.current.draws,levels:new Map(),quality:{
        planningComplete:true,cameraCurrent:true,targetPixelError:1.25}},[])
    }
    const step=async(display=true)=>{gl.complete();r.advanceResources();if(display)r.render(false);await Promise.resolve()}
    try {
      for(const tile of r.textures.coverageTiles)r.textures.cache.set(key(tile),
        {texture:gl.createTexture(),width:16,height:16},1364)
      set(1)
      for(let n=0;n<200&&(!r.displaySurface||r.displaySurface.current!==r.current||r.pendingSubmission);++n)await step()
      assert(r.displaySurface&&r.displaySurface.current===r.current)
      const previous=r.displaySurface.current,promote=r.promoteCurrentSurfaceIfReady
      r.promoteCurrentSurfaceIfReady=()=>false
      set(2)
      for(let n=0;n<300&&(!r.currentTargetGeometryReady()||!r.indices.ready(indices)||r.pendingSubmission||
          mode==='texture'&&!r.worldDisplay.prepared(r.renderDraws));++n)await step(false)
      assert(r.currentTargetGeometryReady()&&r.indices.ready(indices)&&!r.pendingSubmission)
      r.promoteCurrentSurfaceIfReady=promote
      r.render(true)
      assert(r.pendingSubmission&&r.pendingSubmission.drawn&&r.displaySurface.current===previous)
      const fence=r.pendingSubmission,submitted=receipts.length,draws=gl.calls.filter(c=>c.name==='drawElements').length
      const camera=frame();camera.projectionView[3]=0.1;r.setCameraFrame(camera)
      r.prepareResources(false)
      assert(r.preparedSurface&&r.preparedSurfaceSource===r.current&&r.preparedSurface.current===r.current,
        'An unrelated in-flight draw prevented CPU preparation of ready terrain '+JSON.stringify({mode,
          phase:r.handoff.phase,pending:r.geometryPublicationPending,prepared:r.preparedSurface&&r.preparedSurface.current.frame.sequence,
          current:r.current.frame.sequence,source:r.preparedSurfaceSource===r.current,
          geometry:r.currentGeometryReady(),target:r.currentTargetGeometryReady(),index:r.indices.ready(r.current.indices)}))
      assert.strictEqual(r.handoff.phase,'gpu-submit')
      assert.strictEqual(r.displaySurface.current,previous,'CPU preparation transferred display ownership')
      assert.strictEqual(receipts.length,submitted,'CPU preparation forged a terrain submission receipt')
      assert.strictEqual(gl.calls.filter(c=>c.name==='drawElements').length,draws,'Background preparation issued a draw')
      assert.strictEqual(r.pendingSubmission,fence,'CPU preparation consumed an unfinished GPU batch')
      assert.strictEqual(r.render(false),null,'Display ignored an unfinished GPU batch')
      gl.complete()
      r.render(false)
      assert.strictEqual(r.displaySurface.current,r.current,'Completed GPU receipt did not display prepared terrain')
      assert.strictEqual(receipts[receipts.length-1],2)
      assert.strictEqual(r.qualityStats.missingCount,0)
      assert(gl.syncs.size<=2,'CPU publication exceeded the GPU in-flight limit')
      assert.strictEqual(r.resourceLedger.stats().overBudgetBytes,0)
    } finally {r.destroy();await new Promise(resolve=>setTimeout(resolve,0))}
    assert.strictEqual(r.resourceLedger.bytes,0)
    assert.strictEqual(gl.syncs.size,0)
  }
  console.log('Terrain publication: CPU preparation survives unrelated GPU draws; real display/fence receipts and teardown remain required')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
