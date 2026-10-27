const assert=require('assert')
const {FakeGl,FakeCanvas,frame}=require('./support/webgl_fixture')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')
const {captureWorldView}=require('../../adapters/webgl/world_display_inputs')
const {selectImageryFootprints}=require('../../adapters/webgl/imagery_footprint_selection')

module.exports=async function verifyWorldGoals(Renderer,{snapshot=true}={}) {
  const gl=new FakeGl(),canvas=new FakeCanvas(gl);canvas.width=canvas.height=256
  const r=new Renderer(canvas,{mode:'texture',scheduledImagery:true,terrainBoundImagery:false,
    requestResources(){},requestRender(){},maximumResourceBytes:4*1024*1024,
    textureTransitionMs:0,urlForTile:()=>null,textureDescriptor:{kind:'global-geodetic',
      level_zero_columns:2,level_zero_rows:1,matrix_level_offset:1,tile_size:16,maximum_level:4}})
  r.textures.scheduler.pause()
  r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]]})
  r.measureTextureDraw=()=>0
  const root={level:0,matrix:1,row:0,column:0}
  const goals=[root,...[0,1,2,3].map(n=>descendantTextureTile(root,1,n>>1,n&1))],child=goals[1]
  const source={resourceId:1,textureResourceId:101,flags:0,key:{level:0,i:1,j:0,k:0},
    fragment:0,texture:root,origin:[0,0,0],firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}
  const select=tile=>{
    r.setImageryPlan(1,{draws:[{...r.current.draws[0],texture:tile,sourceTexture:root}],
      levels:new Map(),quality:{planningComplete:true,cameraCurrent:true,targetPixelError:1.25}},[])
    r.textures.recomputeAvailability()
  }
  try {
    for(const tile of [...r.textures.coverageTiles,...goals])r.textures.cache.set(key(tile),
      {image:{},texture:{},width:16,height:16},1364)
    r.setMeshFrame({...frame(),sequence:1,coverageComplete:true},[source],new Map([[1,{resourceId:1,
      positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
      textureUv:new Float32Array([0,0,1,0,0,1,1,1])}]]),new Uint16Array([0,2,1,3]),{modelRevision:1})
    select(root)
    for(let n=0;n<300&&(!r.displaySurface||!r.worldDisplay.targetPrepared()||r.worldDisplay.job);++n) {
      r.advanceResources();r.render(false);await Promise.resolve()
    }
    assert(r.displaySurface&&r.worldDisplay.targetPrepared()&&!r.worldDisplay.job)
    if(snapshot) {
      const expected=Array.from(r.textures.targetDesired.keys()),releases=[]
      const credit=r.resourceLedger.reserve('snapshot-contract',1024);let used=0
      const reserve=bytes=>{used+=bytes;if(used>credit.bytes)assert(credit.resize(used))}
      const work=captureWorldView(r,r.renderDraws,reserve,releases)
      try {
        assert(!work.next().done)
        select(child)
        let next
        do{next=work.next()}while(!next.done)
        assert.deepStrictEqual(Array.from(next.value.textures.targetDesired.keys()),expected,
          'A sliced world snapshot mixed later image goals into an earlier camera')
      }finally {work.return();releases.splice(0).forEach(close=>close());credit.release()}
    }
    select(child)
    for(let n=0;n<300&&(!r.worldDisplay.targetPrepared()||r.worldDisplay.job);++n) {
      r.advanceResources();r.render(false);await Promise.resolve()
    }
    assert(r.worldDisplay.targetPrepared())
    const children=new Map([[key(child),child]]),groups=r.partitionGroups
    const group={rows:new Map(),required:new Set(),images:[],releases:[],selectionReleases:[],inputs:new Map(),
      draws:r.renderDraws,sources:groups.sources(r.renderDraws,children)}
    group.members=new Set(group.sources.keys());group.metadata=r.resourceLedger.reserve('footprint-contract',512)
    let used=512,hullReads=0
    group.metadataUsed=used
    const reserve=bytes=>{used+=bytes;group.metadataUsed=used;if(used>group.metadata.bytes)assert(group.metadata.resize(used))}
    const model=r.geometry.get(r.current.draws[0].geometryKey).model
    const descriptor=Object.getOwnPropertyDescriptor(model,'hull'),hull=model.hull
    Object.defineProperty(model,'hull',{configurable:true,get(){++hullReads;return hull}})
    const selection=selectImageryFootprints(r,group,children,reserve)
    try {
      let next
      do{next=selection.next()}while(!next.done)
      assert(next.value,'Prepared target footprint did not admit its image group')
      assert.strictEqual(hullReads,0,'Image admission rebuilt already prepared world topology')
      const expected=new Set(Array.from(r.partitionPublication.required).filter(label=>
        Array.from(group.rows.keys()).some(id=>label.startsWith(id+':'))))
      assert.deepStrictEqual(group.required,expected,'Prepared group omitted complete mesh UV destinations')
    }finally {
      Object.defineProperty(model,'hull',descriptor);selection.return()
      group.selectionReleases.splice(0).forEach(close=>close())
      group.releases.splice(0).forEach(close=>close());group.metadata.release()
    }
    const world=r.worldDisplay
    world.request(r.renderDraws);world.collect()
    const record=world.records.find(v=>v.aliases.has(r.renderDraws))
    assert(world.start(record))
    const job=world.job,completed=world.stats.completed,cancelled=world.stats.cancelled
    // Deliver many more camera/goal updates than this one-step CPU job can
    // finish between. Geometry and physical source identity remain unchanged.
    job.task.maximumSteps=1
    r.advanceResources()
    for(let n=0;n<1000&&world.stats.completed===completed;++n) {
      r.setCameraFrame({...frame(),cameraPosition:[10+n/1000,20,30]})
      select(goals[(n+2)%goals.length])
      r.advanceResources();r.render(false);await Promise.resolve()
      assert.strictEqual(world.stats.cancelled,cancelled,
        'New camera/image goals cancelled work on an unchanged immutable source')
    }
    assert(world.stats.completed>completed,'Continuous camera goals starved a complete world result')
    assert.strictEqual(r.qualityStats.missingCount,0)
  }finally {
    r.destroy()
    for(let n=0;n<100&&r.resourceLedger.bytes;++n)await new Promise(resolve=>setTimeout(resolve,0))
    assert.strictEqual(r.resourceLedger.bytes,0)
  }
  process.stdout.write('World goals: coherent snapshots, continuous camera progress, source identity and zero teardown passed\n')
}
