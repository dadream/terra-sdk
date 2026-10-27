const assert=require('assert')
const {TerraWebGlRenderer}=require('../../adapters/webgl/terra_webgl_renderer')
const {FakeGl,FakeCanvas,frame}=require('./support/webgl_fixture')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')
const {MeshOutputPlan}=require('../../adapters/webgl/mesh_output_plan')

module.exports=async function (Renderer=TerraWebGlRenderer) {
  const canvas=new FakeCanvas(new FakeGl());canvas.width=canvas.height=256
  const r=new Renderer(canvas,{mode:'height',terrainBoundImagery:false,scheduledImagery:true,
    textureTransitionMs:200,requestResources(){},requestRender(){},maximumResourceBytes:4*1024*1024,
    maximumTextureEntries:16,textureDescriptor:{kind:'global-geodetic',level_zero_columns:2,
      level_zero_rows:1,matrix_level_offset:1,tile_size:16,maximum_level:8},urlForTile:()=>null})
  const root={level:0,matrix:1,row:0,column:0},child=descendantTextureTile(root,1,0,0)
  const oldCell=descendantTextureTile(root,1,1,1)
  const laterCell=descendantTextureTile(root,1,1,0)
  const resource={resourceId:1,positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
    textureUv:new Float32Array([0,0,1,0,0,1,1,1])}
  const source={resourceId:1,textureResourceId:101,origin:[0,0,0],key:{level:0,i:1,j:0,k:0},
    fragment:0,texture:root,firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}
  r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]]})
  r.measureTextureDraw=()=>0.5
  const turn=async(display=true)=>{r.advanceResources();if(display)r.render(false);await Promise.resolve()}
  const ready=async()=>{for(let n=0;n<300&&!r.worldDisplay.targetPrepared();++n)await turn(false)
    assert(r.worldDisplay.targetPrepared(),'World footprint did not finish')}
  const loans=[],reserve=()=>{}
  const rows=children=>{const work=r.worldDisplay.imageGroupRows(new Set(['mesh:1']),children,reserve,loans);let value
    do{value=work.next()}while(!value.done);return value.value}
  try {
    for(const tile of [...r.textures.coverageTiles,child,oldCell,laterCell])r.textures.cache.set(key(tile),
      {image:{},texture:{},width:16,height:16},1364)
    r.setMeshFrame(Object.assign(frame(),{sequence:1,coverageComplete:true}),[source],new Map([[1,resource]]),
      new Uint16Array([0,2,1,3]),{modelRevision:1})
    for(let n=0;n<20&&!r.displaySurface;++n)await turn()
    assert(r.displaySurface)
    r.setMode('texture')
    r.presentation.cells=new Map([[key(oldCell),{cell:oldCell,a:oldCell,b:root,alpha:0,goal:1,at:0}]])
    const target=Object.assign({},r.current.draws[0],{texture:child,sourceTexture:root})
    r.setImageryPlan(1,{draws:[target],levels:new Map(),quality:{targetPixelError:1.25,
      planningComplete:true,cameraCurrent:true,spatialCut:true}},[])
    await ready()
    for(let n=0;n<80&&(r.partitionActive||r.partitionQueue.length||r.partitionUploads.length);++n)await turn(false)
    assert(!r.partitionActive&&!r.partitionQueue.length&&!r.partitionUploads.length)
    const record=r.worldDisplay.prepared(r.renderDraws),before=r.worldDisplay.stats.builds
    const children=new Set([key(child)])
    const beforeRows=rows(children)
    assert(beforeRows.length,'Fixture has no complete image funding footprint')
    const oldRevision=r.presentation.coarseningRevision
    r.presentation.cells.set(key(laterCell),{cell:laterCell,a:laterCell,b:root,alpha:0,goal:1,at:950})
    r.presentation.beginSubmission(1000)
    r.presentation.resolve(oldCell,root,()=>true,true)
    r.presentation.resolve(laterCell,root,()=>true,true)
    r.presentation.endFrame()
    assert(r.presentation.coarseningRevision>oldRevision,'Fixture did not complete an actual coarsening fade')
    assert.strictEqual(r.presentation.active,1,'Fixture did not retain the staggered submitted fade')
    assert.strictEqual(r.worldDisplay.targetState(),'ready',
      'Completed coarsening withdrew unchanged, already funded image demand')
    assert.deepStrictEqual(rows(children),beforeRows,
      'Layout compaction changed the complete paid image footprint before its successor')
    assert.strictEqual(r.worldDisplay.stats.builds,before,'An admission query started synchronous world work')
    const start=r.worldDisplay.start
    r.worldDisplay.start=function(record){const result=start.call(this,record);if(this.job)this.job.task.maximumSteps=1;return result}
    r.worldDisplay.advance()
    assert.strictEqual(r.worldDisplay.stats.builds,before,
      'One completed fade rebuilt the whole world while another submitted fade was still active')
    assert(!r.worldDisplay.job,'Optional compaction retained work during the submitted fade batch')
    r.capacityHandover.set(key(child),child)
    r.worldDisplay.advance()
    assert(r.worldDisplay.job,'Coalescing optional compaction delayed an actual capacity handoff')
    assert.strictEqual(r.worldDisplay.targetState(),'waiting','An active fade hid changed capacity demand')
    r.worldDisplay.closeJob(true)
    r.capacityHandover.clear()
    r.worldDisplay.advance()
    assert(!r.worldDisplay.job,'Returning to unchanged demand restarted intermediate compaction')
    r.presentation.beginSubmission(1200)
    r.presentation.resolve(oldCell,root,()=>true,true)
    r.presentation.resolve(laterCell,root,()=>true,true)
    r.presentation.endFrame()
    assert.strictEqual(r.presentation.active,0,'The submitted fade batch did not finish')
    r.worldDisplay.advance()
    assert(r.worldDisplay.job,'Coarsening no longer prepares a compact successor')
    assert.strictEqual(r.worldDisplay.targetState(),'ready','Background compaction withdrew image demand')
    assert(rows(children).length,'A compacting successor hid the complete prior footprint')
    const selections=r.partitionGroups.pricing.footprintSelections
    r.partitionGroups.prepareImagery(new Map([[key(child),child]]),()=>null)
    assert.strictEqual(r.partitionGroups.pricing.footprintSelections,selections+1,
      'Image admission still waited for unrelated layout compaction')
    assert(r.partitionGroups.current&&r.partitionGroups.current.selection,
      'Image admission bypassed complete footprint selection')
    r.partitionGroups.clear()
    const plan=r.meshOutputPlan=new MeshOutputPlan(r,{nativePlan:{id:123}},d=>d.geometryKey)
    plan.accepted=true
    assert.strictEqual(r.worldDisplay.targetState(),'waiting','An old demand receipt ignored a new mesh output plan')
    assert.strictEqual(rows(children),null)
    plan.release()
    assert.strictEqual(r.worldDisplay.targetState(),'ready')
    r.capacityHandover.set(key(child),child)
    r.worldDisplay.advance()
    assert.strictEqual(r.worldDisplay.targetState(),'waiting','An old demand receipt ignored new capacity pressure')
    assert.strictEqual(rows(children),null)
    r.capacityHandover.clear()
    r.worldDisplay.advance()
    assert.strictEqual(r.worldDisplay.targetState(),'ready')
    const camera=frame();camera.projectionView[3]=0.1;r.setCameraFrame(camera)
    assert.strictEqual(r.worldDisplay.targetState(),'waiting','An old footprint authorized a new camera demand')
    assert.strictEqual(rows(children),null,'An old camera receipt became a current image quote')
    assert(!record.closed)
    assert.strictEqual(r.resourceLedger.stats().overBudgetBytes,0)
  } finally {
    for(const release of loans.splice(0))release()
    r.destroy();await new Promise(resolve=>setTimeout(resolve,0))
  }
  assert.strictEqual(r.resourceLedger.bytes,0,'Image demand receipt retained resources after destruction')
  console.log('World demand receipts: image pricing during compaction, real mesh/pressure/camera invalidation and exact teardown passed')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
