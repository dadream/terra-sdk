const assert=require('assert')
const {PartitionPublication}=require('../../adapters/webgl/partition_publication')
const {FakeGl,FakeCanvas,frame}=require('./support/webgl_fixture')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')
const {WorldDisplayPlan}=require('../../adapters/webgl/world_display_plan')

module.exports=async function verifyWorldGroupProgress(Renderer) {
  const root={level:0,matrix:1,row:0,column:0},child=descendantTextureTile(root,1,0,0)
  {
    let reads=0
    const parts=new Map(),has=parts.has.bind(parts)
    parts.has=id=>{++reads;return has(id)}
    const publication=new PartitionPublication(()=>({partitions:parts}),()=>true,d=>d.group)
    publication.prepare([{geometryKey:'mesh',texture:child,imageryTarget:child,
      imageryClipCell:true,group:'fine'}, {geometryKey:'other',texture:root,imageryTarget:root,
      imageryClipCell:true,group:'other'}])
    reads=0
    const work=publication.advanceWork()
    let next=work.next(),steps=1
    while(!next.done&&!reads&&steps++<64)next=work.next()
    assert(reads&&!next.done,'Fixture did not suspend after observing a missing UV')
    // The last GPU receipt arrives while the persistent scan is suspended.
    // Its one resource wake must not finish using the earlier false result.
    parts.set(key(child),{})
    do {next=work.next();assert(++steps<128,'Readiness scan did not park')}while(!next.done)
    assert(publication.needsAdvance(),'A changed UV dependency did not retain its continuation')
    publication.advance()
    assert(publication.ready('fine'),'A UV receipt during a sliced scan left its group parked forever')
  }
  {
    let reads=0
    const other=descendantTextureTile(root,1,0,1),resident=new Set()
    const publication=new PartitionPublication(()=>({partitions:new Map()}),id=>{
      ++reads;return resident.has(id)
    },d=>d.group)
    publication.prepare([{geometryKey:'one',texture:child,imageryTarget:child,group:'one'},
      {geometryKey:'two',texture:other,imageryTarget:other,group:'two'}])
    reads=0
    const work=publication.advanceWork();let next=work.next(),steps=1
    while(!next.done&&!reads&&steps++<64)next=work.next()
    assert(reads&&!next.done,'Fixture did not suspend between image groups')
    resident.add(key(child))
    do {next=work.next();assert(++steps<128,'Image scan did not park')}while(!next.done)
    assert(publication.needsAdvance(),'A changed image dependency did not retain its continuation')
    publication.advance()
    assert(publication.ready('one')&&!publication.ready('two'),
      'An image receipt was lost or approved a different unfinished group')
    reads=0
    assert.strictEqual(publication.advance(),false)
    assert.strictEqual(reads,1,'An unchanged missing image triggered repeated scans')
    resident.add(key(other))
    assert(publication.advance()&&publication.ready('two'))
  }
  {
    let scanned=false,wakes=0,draws=0
    const parts=new Map(),row={geometryKey:'mesh',texture:child,imageryTarget:child,
      imageryClipCell:true,group:'fine'}
    const publication=new PartitionPublication(()=>({partitions:parts}),()=>true,d=>d.group)
    publication.prepare([row])
    const advance=publication.advanceWork.bind(publication)
    publication.advanceWork=function*(){const changed=yield* advance();scanned=true;return changed}
    const renderer={geometry:{get:()=>({partitions:parts})},requestRender(){++draws},
      requestResources(){++wakes},partitionCell:()=>({key:key(child)}),requestPartitionSet(){}}
    const world=new WorldDisplayPlan(renderer),record={publication,
      cuts:new Map([['mesh',{rows:[row]}]]),aliases:new Set()}
    const work=world.maintain(record);let next=work.next(),steps=0
    while(!next.done&&!scanned&&steps++<64)next=work.next()
    assert(scanned&&!next.done,'Fixture did not pause after its publication scan')
    parts.set(key(child),{})
    do {next=work.next();assert(++steps<128)}while(!next.done)
    assert.strictEqual(wakes,1,'Maintenance consumed the last receipt after its readiness scan')
    const resume=world.maintain(record)
    do{next=resume.next();assert(++steps<256)}while(!next.done)
    assert(publication.ready('fine')&&draws===1,'The queued readiness pass did not publish its ready group')
    assert.strictEqual(wakes,1,'An unchanged completed group kept waking preparation')
  }
  {
    const other=descendantTextureTile(root,1,0,1),resident=new Set()
    const publication=new PartitionPublication(()=>({partitions:new Map()}),id=>resident.has(id),d=>d.group)
    publication.prepare([{geometryKey:'one',texture:child,imageryTarget:child,group:'one'},
      {geometryKey:'two',texture:other,imageryTarget:other,group:'two'}])
    resident.add(key(child))
    const work=publication.advanceWork();let next,steps=0
    do {
      next=work.next()
      if(!next.done){resident.add('unrelated-'+steps)}
      assert(++steps<64,'Unrelated GPU receipts delayed publication of a ready group')
    }while(!next.done)
    assert(next.value&&publication.ready('one')&&!publication.ready('two'))
    assert.strictEqual(publication.needsAdvance(),false,'Unrelated receipts restarted a blocked group')
  }
  {
    const geometry=new Map(),parts=new Map(),other=descendantTextureTile(root,1,0,1)
    const resident=new Set([key(child)])
    geometry.set('two',{partitions:new Map()})
    const publication=new PartitionPublication(id=>geometry.get(id),id=>resident.has(id),d=>d.group)
    publication.prepare([{geometryKey:'one',texture:child,imageryTarget:child,imageryClipCell:true,group:'one'},
      {geometryKey:'two',texture:other,imageryTarget:other,group:'two'}])
    assert.strictEqual(publication.needsAdvance(),false)
    geometry.set('one',{partitions:parts})
    assert(publication.needsAdvance(),'A previously absent required mesh did not resume its group')
    publication.advance()
    assert.strictEqual(publication.needsAdvance(),false,'An empty mesh was mistaken for ready UV')
    parts.set('unrelated',{})
    assert.strictEqual(publication.needsAdvance(),false,'Unrelated UV resumed an unavailable group')
    parts.set(key(child),{})
    assert(publication.needsAdvance())
    assert(publication.advance()&&publication.ready('one')&&!publication.ready('two'))
    geometry.delete('one');resident.add('unrelated')
    assert.strictEqual(publication.needsAdvance(),false,'Removed or unrelated assets restarted a blocked group')
    geometry.set('one',{partitions:parts})
    assert.strictEqual(publication.needsAdvance(),false,'A completed group invalidated another group')
    publication.clear()
    assert.strictEqual(publication.needsAdvance(),false,'Cleared publication retained blocked dependencies')
  }
  process.stdout.write('Publication readiness: last UV/image receipts during sliced scans and stable idle passed\n')
  process.stdout.write('Publication completion: maintenance-tail receipts, partial progress and unrelated streams passed\n')
  process.stdout.write('Publication dependencies: relevant recovery, unrelated additions/removals and teardown passed\n')
  const future=descendantTextureTile(root,2,0,2),images=new Set([key(root)])
  const geometry={partitions:new Map([[key(child),{}]])}
  const publication=new PartitionPublication(()=>geometry,id=>images.has(id),d=>d.group)
  const rows=[{geometryKey:'one',texture:root,imageryTarget:root,group:'coarse'},
    {geometryKey:'one',texture:future,imageryTarget:future,group:'fine'},
    {geometryKey:'two',texture:child,imageryTarget:root,imageryClipCell:true,group:'coarse'}]
  publication.prepare(rows)
  assert(publication.ready('coarse')&&!publication.ready('fine'),
    'A ready coarse world group waited for an unrelated image in the same mesh')
  geometry.partitions.clear();publication.prepare(rows)
  assert(!publication.ready('coarse'),'A world group skipped a participating mesh UV dependency')
  geometry.partitions.set(key(child),{});publication.advance()
  assert(publication.ready('coarse')&&!publication.ready('fine'))
  images.add(key(future));publication.advance();assert(publication.ready('fine'))

  const gl=new FakeGl(),canvas=new FakeCanvas(gl);canvas.width=canvas.height=256
  gl.getShaderPrecisionFormat=()=>({precision:23});gl.texStorage2D=()=>{}
  const r=new Renderer(canvas,{mode:'height',scheduledImagery:true,terrainBoundImagery:false,
    requestResources(){},requestRender(){},maximumResourceBytes:4*1024*1024,
    maximumTextureEntries:16,textureTransitionMs:0,urlForTile:()=>null,
    textureDescriptor:{kind:'global-geodetic',level_zero_columns:2,level_zero_rows:1,
      matrix_level_offset:1,tile_size:16,maximum_level:8}})
  r.textures.scheduler.pause()
  r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]]})
  let coarseView=false
  r.measureTextureDraw=(draw,level)=>{
    const tile=draw.texture,n=2**tile.level,u=(tile.column+.5)/n,v=(tile.row+.5)/n
    return (coarseView?(u>=.5&&v<.5?4:.1):2)/2**level
  }
  const seed=tile=>r.textures.cache.set(key(tile),{image:{},texture:{},width:16,height:16},1364)
  const until=async(message,predicate)=>{
    for(let n=0;n<300&&!predicate();++n){r.advanceResources();r.render(false);await new Promise(resolve=>setTimeout(resolve,0))}
    assert(predicate(),message+': '+JSON.stringify({world:r.worldDisplay.snapshot(),
      handoff:r.handoff.snapshot(),sources:r.renderDraws.map(d=>[d.geometryKey,key(d.texture)]),
      cells:Array.from(r.presentation.cells.keys()),cuts:r.worldDisplay.records.map(v=>({stamp:v.stamp,
        rows:v.rows&&v.rows.map(d=>[key(d.texture),key(d.imageryTarget),d.imageryPublicationState])})),
      pending:Array.from(r.partitionPublication.pending.keys()),queued:r.partitionQueue.length,
      active:!!r.partitionActive,uploading:r.partitionUploads.length,
      parts:Array.from((r.geometry.get('mesh:1')||{partitions:new Map()}).partitions.keys())}))
  }
  try {
    r.textures.coverageTiles.forEach(seed);seed(root);seed(child)
    r.setMeshFrame({...frame(),sequence:1,coverageComplete:true},[{resourceId:1,textureResourceId:101,
      flags:0,key:{level:0,i:1,j:0,k:0},fragment:0,texture:root,origin:[0,0,0],
      firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}],new Map([[1,{resourceId:1,
      positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
      textureUv:new Float32Array([0,0,1,0,0,1,1,1])}]]),new Uint16Array([0,2,1,3]),{modelRevision:1})
    await until('Initial geometry did not publish',()=>r.displaySurface)
    r.setMode('texture')
    const source=r.current.draws[0],detail={...source,texture:child,sourceTexture:root}
    const select=(draws,coarsening)=>{
      r.setImageryPlan(1,{draws,levels:new Map(),quality:{
        planningComplete:true,cameraCurrent:true,coarsening,targetPixelError:1.25}},[])
      // Only image I/O is withheld. Derive availability from the actual seeded
      // GPU cache while the network scheduler remains paused.
      r.textures.recomputeAvailability()
    }
    select([detail],false)
    await until('Initial fine image did not publish',()=>r.presentation.previous(child)&&
      key(r.presentation.previous(child).b)===key(child))
    coarseView=true
    select([r.rootImageryDraw(source),{...source,texture:future,sourceTexture:root}],true)
    await until('Coarsening waited for an unrelated future image',()=>
      r.presentation.previous(child)&&key(r.presentation.previous(child).b)===key(root))
    assert(!r.textures.gpuReady(key(future)),'Fixture accidentally completed the unrelated image')
    assert.strictEqual(r.qualityStats.missingCount,0)
    seed(future);r.textures.recomputeAvailability();r.requestResources()
    await until('A committed numerical cut treated an unfinished image group as ready forever',()=>
      r.presentation.previous(future)&&key(r.presentation.previous(future).b)===key(future))
  }finally {r.destroy();await Promise.resolve();assert.strictEqual(r.resourceLedger.bytes,0)}
  process.stdout.write('World groups: complete mesh UV, independent coarse/image readiness, delayed refinement and zero teardown passed\n')
}
