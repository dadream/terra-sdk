const assert=require('assert')
const {TerraWebGlRenderer}=require('../../adapters/webgl/terra_webgl_renderer')
const {FakeGl,FakeCanvas,frame}=require('./support/webgl_fixture')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')
const {MeshOutputPlan}=require('../../adapters/webgl/mesh_output_plan')

// Exercise the real renderer with independently delivered display/resource
// turns. The reference samples cover the entire square, including unrequested
// and initially invisible cells of the same immutable terrain mesh.
module.exports=async function verifyWorldDisplay(Renderer=TerraWebGlRenderer) {
  require('./world_publication_ownership_contract')()
  const root={level:0,matrix:1,row:0,column:0},child=descendantTextureTile(root,1,0,0)
  const gl=new FakeGl(),canvas=new FakeCanvas(gl)
  gl.getShaderPrecisionFormat=()=>({precision:23});gl.texStorage2D=()=>{}
  canvas.width=canvas.height=256
  const r=new Renderer(canvas,{mode:'height',terrainBoundImagery:false,
    scheduledImagery:true,textureTransitionMs:0,requestResources(){},requestRender(){},
    maximumResourceBytes:4*1024*1024,maximumTextureEntries:16,
    textureDescriptor:{kind:'global-geodetic',level_zero_columns:2,level_zero_rows:1,
      matrix_level_offset:1,tile_size:16,maximum_level:8},urlForTile:()=>null})
  const resource={resourceId:1,positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
    textureUv:new Float32Array([0,0,1,0,0,1,1,1])}
  const source={resourceId:1,textureResourceId:101,geometryKey:'mesh:1',origin:[0,0,0],
    key:{level:0,i:1,j:0,k:0},fragment:0,texture:root,firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}
  let roi={minimumU:0,maximumU:.49,minimumV:0,maximumV:.49},density=2
  r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]],regions:[{uv:roi}]})
  r.measureTextureDraw=(draw,level)=>density/2**level
  const seed=tile=>r.textures.cache.set(key(tile),{image:{},texture:{},width:16,height:16},1364)
  const step=async()=>{r.advanceResources();r.render(false);await Promise.resolve()}
  const until=async(message,predicate)=>{
    for(let n=0;n<300&&!predicate();++n)await step()
    assert(predicate(),message)
  }
  try {
    r.textures.coverageTiles.forEach(seed);seed(root);seed(child)
    r.setMeshFrame(Object.assign(frame(),{sequence:1,coverageComplete:true}),[source],new Map([[1,resource]]),
      new Uint16Array([0,2,1,3]),{modelRevision:1})
    const queued=r.uploadQueue.length
    r.render(false)
    assert.strictEqual(r.uploadQueue.length,queued,'Display turn performed a geometry upload')
    assert.strictEqual(r.worldDisplay.stats.slices,0,'Display turn advanced world topology')
    await until('Background never prepared the initial geometry',()=>!!r.displaySurface)
    r.setMode('texture')
    const target=Object.assign({},r.current.draws[0],{texture:child,sourceTexture:root})
    r.setImageryPlan(1,{draws:[target],levels:new Map(),quality:{targetPixelError:1.25,
      planningComplete:true,cameraCurrent:true,spatialCut:true}},[])
    r.render(false)
    assert(r.qualityStats.imageryCoverageSubmitted>0&&r.qualityStats.geometryCoverageSubmitted===0,
      'Image fallback changed the geometric precision classification')
    assert(r.renderedSurface.draws.every(d=>!(d.flags&1)),
      'Fine terrain using a root image became coarse geometry in ground queries')
    await until('World imagery cut did not commit',()=>!!r.worldDisplay.entries.get('mesh:1'))
    for(let n=0;n<20;++n)await step()
    const settledBuilds=r.worldDisplay.stats.builds
    for(let n=0;n<20;++n)await step()
    assert.strictEqual(r.worldDisplay.stats.builds,settledBuilds,'Returning input loans restarted an unchanged world cut')
    assert(Array.from(r.textures.cache.entries.values()).every(e=>!e.holds),
      'World metadata retained image payload loans after preparation')
    const cut=r.worldDisplay.entries.get('mesh:1').current
    for(let row=0;row<16;++row)for(let column=0;column<16;++column) {
      const u=(column+.5)/16,v=(row+.5)/16
      const count=cut.rows.filter(d=>{
        const s=d.imageryCellScale||1,x=d.imageryCellOffsetX||0,y=d.imageryCellOffsetY||0
        return u*s+x>=0&&u*s+x<1&&v*s+y>=0&&v*s+y<1
      }).length
      assert.strictEqual(count,1,`World footprint has a hole or overlap at ${u},${v}`)
    }
    assert(cut.rows.some(d=>key(d.imageryTarget)===key(child)),'Ready local detail was discarded')
    const preparedRow=cut.rows.find(d=>key(d.texture)===key(child))
    Object.freeze(preparedRow)
    const readChild=()=>r.worldDisplay.read(r.displaySurface.renderDraws).find(d=>key(d.texture)===key(child))
    assert.strictEqual(readChild(),preparedRow,'Stable display rebuilt an already-owned numeric descriptor')
    // Publication is live evidence, not a boolean copied into the prepared
    // descriptor. Both a withheld receipt and its completion must be observed
    // without replacing that descriptor or changing its numeric footprint.
    const state=preparedRow.imageryPublicationState,resolve=r.presentation.resolve,readiness=[]
    r.presentation.resolve=function(cell,target,ready,allowed){if(key(cell)===key(child))readiness.push(allowed);return resolve.call(this,cell,target,ready,allowed)}
    try {
      state.ready=false;r.render()
      state.ready=true;r.render()
      assert.deepStrictEqual(readiness,[false,true],'Borrowed descriptors lost live publication readiness')
      assert.strictEqual(readChild(),preparedRow)
    } finally {state.ready=true;r.presentation.resolve=resolve}
    // A committed ordinary source-UV cell may lose its cached index before
    // the background successor completes. Its original mesh is already a
    // valid highp triangle superset; keep the exact image on that same cell.
    const committedGeometry=r.geometry.get('mesh:1')
    assert(committedGeometry.partitions.has(key(child)))
    r.releasePartition(committedGeometry,key(child))
    const retained=r.worldDisplay.read(r.displaySurface.renderDraws)
      .find(d=>key(d.texture)===key(child))
    assert(retained&&retained.imageryDirectClip&&!retained.imageryIndexCell&&
      !retained.imagerySourceCoverage&&key(retained.imageryTarget)===key(child),
    'Committed fine cell fell back to root imagery while its UV successor was preparing')
    assert.notStrictEqual(retained,preparedRow,'Temporary UV fallback mutated the prepared descriptor')
    assert(!preparedRow.imageryDirectClip,'Temporary fallback leaked into the persistent footprint')
    r.render()
    assert.strictEqual(r.qualityStats.coverageSubmitted,0)
    r.requestResources()
    await until('Retired ordinary UV did not rebuild',()=>committedGeometry.partitions.has(key(child)))
    // A compatible source-UV index buffer is optional. Losing it must use
    // the resident original mesh with the same shader clip, never a hole or
    // a new unfunded partition requirement.
    const plan=r.meshOutputPlan=new MeshOutputPlan(r,{nativePlan:{id:123}},d=>d.geometryKey)
    plan.accepted=true // This fixture exercises an accepted mesh handoff.
    try {
      r.requestResources()
      await until('Inherited source-UV cut did not publish',()=>r.worldDisplay.entries.get('mesh:1').current.rows
        .some(d=>d.imageryDirectClip&&d.imageryIndexCell===key(child)))
      const geometry=r.geometry.get('mesh:1'),part=geometry.partitions.get(key(child))
      assert(part&&part.sourceUv)
      geometry.partitions.delete(key(child));r.partitionBytes-=part.byteSize;geometry.partitionBytes-=part.byteSize
      part.allocation.release()
      for(const buffer of [part.positionBuffer,part.uvBuffer,part.indexBuffer])if(buffer)gl.deleteBuffer(buffer)
      const visible=r.worldDisplay.read(r.displaySurface.renderDraws)
      assert(visible.some(d=>d.imageryDirectClip&&!d.imageryIndexCell),
        'Missing optional ancestor indices did not fall back to the original source mesh')
      r.render()
      assert(r.drawStats.submitted>0&&r.qualityStats.missingCount===0&&r.qualityStats.coverageSubmitted===0,
        'An optional index buffer blocked complete fine-image rendering')
    } finally {plan.release();r.meshOutputPlan=null}
    const slices=r.worldDisplay.stats.slices,builds=r.worldDisplay.stats.builds
    roi={minimumU:.51,maximumU:1,minimumV:.51,maximumV:1}
    for(let n=1;n<=20;++n) {
      const camera=frame();camera.projectionView[3]=n/100
      r.setCameraFrame(camera);r.render(false)
      assert.strictEqual(r.qualityStats.missingCount,0,'Camera exposed an unprepared part of the source mesh')
      assert(r.drawStats.submitted>0,'A prepared world cut produced an empty display')
    }
    assert.strictEqual(r.worldDisplay.stats.slices,slices,'Camera/display turns rebuilt world topology')
    assert.strictEqual(r.worldDisplay.stats.builds,builds,'Camera/display turns started world preparation')
    density=100;r.render()
    assert(!r.qualityStats.meetsTarget,'Old world topology became a stale current-camera precision proof')
    roi={minimumU:0,maximumU:.49,minimumV:0,maximumV:.49}
    r.render()
    let clock=0;r.presentation.duration=200;r.options.textureClock=()=>clock
    density=.1
    r.setImageryPlan(1,{draws:[r.rootImageryDraw(r.current.draws[0])],levels:new Map(),quality:{
      targetPixelError:1.25,planningComplete:true,cameraCurrent:true,coarsening:true}},
    [{resourceId:1,visible:true,pixelsPerUv:1.6}])
    await until('Coarsening did not start on the resident fine footprint',()=>r.presentation.active>0)
    clock=50;r.render()
    const before=r.presentation.previous(child).alpha
    density=100
    const changed=frame();changed.projectionView[3]=.4;r.setCameraFrame(changed)
    r.render(false)
    assert.strictEqual(r.presentation.previous(child).goal,0,'A stale coarse goal kept fading out still-needed fine imagery')
    clock=70;r.render(false)
    assert(r.presentation.previous(child).alpha<before,'A fast camera reversal restarted or continued the coarse fade')

    // A real quota refusal must stop I/O and retry only after capacity changes.
    const competitor=r.resourceLedger.reserve('fixture-capacity',r.resourceLedger.maximumBytes-r.resourceLedger.bytes)
    assert(competitor)
    try {
      const next=Object.assign({},target,{texture:descendantTextureTile(root,1,1,1)})
      r.setImageryPlan(1,{draws:[next],levels:new Map(),quality:{targetPixelError:1.25,
        planningComplete:true,cameraCurrent:true}},[{resourceId:1,visible:true,pixelsPerUv:1600}])
      r.worldDisplay.advance()
      assert.strictEqual(r.worldDisplay.targetState(),'blocked','An unfunded target topology became endless input waiting')
      assert(!r.worldDisplay.job,'A refused world cut retained partial work')
    } finally {competitor.release()}
    assert.notStrictEqual(r.worldDisplay.targetState(),'blocked','A real refund did not reopen target preparation')
    const record=r.worldDisplay.request(r.renderDraws)
    assert(r.worldDisplay.start(record))
    r.worldDisplay.job.task.maximumSteps=1
    for(let n=0;n<12&&!r.geometry.entries.get('mesh:1').holds;++n)r.worldDisplay.advance()
    assert(r.worldDisplay.job&&r.geometry.entries.get('mesh:1').holds,
      'Cancellation fixture did not suspend with a physical model loan')
    r.setPaused(true)
    assert.strictEqual(r.worldDisplay.records.length,0,'Pause retained unfinished world cuts')
    assert.strictEqual(r.worldDisplay.entries.size,0,'Pause retained submitted topology loans')
    assert.strictEqual(r.worldDisplay.snapshot().bytes,0,'Pause leaked world metadata credit')
    await new Promise(resolve=>setTimeout(resolve,0))
    assert(!r.geometry.entries.get('mesh:1').holds&&
      Array.from(r.textures.cache.entries.values()).every(e=>!e.holds),'Pause leaked suspended input loans')
  } finally {r.destroy();await new Promise(resolve=>setTimeout(resolve,0))}
  assert.strictEqual(r.resourceLedger.bytes,0,'World display leaked resource ownership after destruction')
  assert(!r.resourceTimer&&!r.textures.retryTimers.size,'World display leaked background timers')
  console.log('World display: independent clocks, full coverage, live precision, reversal, real quota and suspended teardown passed')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
