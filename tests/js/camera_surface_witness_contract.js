const assert=require('assert')
const {FakeGl,FakeCanvas,frame}=require('./support/webgl_fixture')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {MeshOutputPlan}=require('../../adapters/webgl/mesh_output_plan')
const {WorldDisplayPlan}=require('../../adapters/webgl/world_display_plan')
const {TextureStore}=require('../../adapters/webgl/texture_store')

function verifyPressureDependencies() {
  const root={level:0,matrix:0,row:0,column:0},child={level:1,matrix:1,row:0,column:0}
  const ready=new Set([key(root)]),blocked=new Set([key(child)])
  const r={current:{imageryPlan:{quality:{}}},capacityHandover:new Map([[key(child),child]]),
    textures:{currentRoots:new Map([[key(root),root]]),availableKeys:ready,admissionBlocked:blocked,
      renderer:{presentedTextures:new Map()},gpuReady:id=>ready.has(id),
      presentationTileFor:TextureStore.prototype.presentationTileFor}}
  const world=new WorldDisplayPlan(r),initial=world.pressureState()
  ready.add('1/1/1/3')
  assert.strictEqual(world.pressureState(),initial,'Unrelated readiness changed the handoff dependency')
  ready.add(key(child))
  assert.notStrictEqual(world.pressureState(),initial,'A ready handoff image did not wake its topology')
  const active=world.pressureState();blocked.clear()
  assert.strictEqual(world.pressureState(),active,'Admission attempt flags revoked an active handoff')
  r.capacityHandover.clear()
  assert.strictEqual(world.pressureState(),0)
  blocked.add(key(child));ready.delete(key(root))
  const missing=world.pressureState();ready.add(key(root))
  assert.notStrictEqual(world.pressureState(),missing,'Coverage recovery did not wake pressure selection')
}

module.exports=async function verifyCameraSurfaceWitness(Renderer) {
  verifyPressureDependencies()
  for(const mode of ['height','texture']) {
    const gl=new FakeGl(),canvas=new FakeCanvas(gl);canvas.width=canvas.height=256
    const submitted=[]
    const r=new Renderer(canvas,{mode,scheduledImagery:true,terrainBoundImagery:false,
      requestResources(){},requestRender(){},maximumResourceBytes:4*1024*1024,
      textureTransitionMs:0,textureDescriptor:{kind:'global-geodetic',level_zero_columns:2,
        level_zero_rows:1,matrix_level_offset:1,tile_size:16,maximum_level:4},
      onSurfaceSubmitted:surface=>submitted.push(surface.frame.sequence),urlForTile:()=>null})
    r.textures.scheduler.pause()
    r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]]})
    r.measureTextureDraw=()=>0
    const publish=sequence=>{
      const resource={resourceId:sequence,positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
        textureUv:new Float32Array([0,0,1,0,0,1,1,1])}
      const draw={resourceId:sequence,textureResourceId:100+sequence,flags:0,
        key:{level:0,i:1,j:0,k:0},fragment:0,texture:{level:0,matrix:1,row:0,column:0},
        origin:[0,0,0],firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}
      r.setMeshFrame({...frame(),sequence,coverageComplete:true},[draw],new Map([[sequence,resource]]),
        new Uint16Array([0,2,1,3]),{modelRevision:sequence})
      if(mode==='texture')r.setImageryPlan(sequence,{draws:r.current.draws,levels:new Map(),
        quality:{planningComplete:true,cameraCurrent:true,targetPixelError:1.25}},[])
    }
    const prepare=async predicate=>{
      for(let n=0;n<300&&!predicate();++n){r.advanceResources();await Promise.resolve()}
      assert(predicate(),'Background did not prepare a complete surface')
    }
    try {
      for(const tile of r.textures.coverageTiles)r.textures.cache.set(key(tile),
        {image:{},texture:{},width:16,height:16},1364)
      publish(1)
      await prepare(()=>r.preparedSurfaceSource===r.current&&r.preparedSurface&&
        (mode==='height'||r.worldDisplay.targetPrepared()))
      if(mode==='texture') {
        const builds=r.worldDisplay.stats.builds
        const future=r.meshOutputPlan=new MeshOutputPlan(r,{nativePlan:{id:999}},d=>d.geometryKey)
        try {
          assert(r.worldDisplay.targetPrepared(),
            'An unaccepted terrain quote revoked the current funded world cut')
          for(let n=0;n<8;++n)r.advanceResources()
          assert.strictEqual(r.worldDisplay.stats.builds,builds,
            'An unrelated future terrain quote rebuilt the current display')
        }finally {future.release()}
        r.textures.admissionBlocked.add(key(r.current.draws[0].texture));r.textures.blockedByCapacity=true
        r.advanceResources()
        await prepare(()=>!r.worldDisplay.job&&r.worldDisplay.targetPrepared())
        const pressureBuilds=r.worldDisplay.stats.builds
        r.textures.cache.set('1/2/1/3',{image:{},texture:{},width:16,height:16},1364)
        r.worldDisplay.advance()
        assert.strictEqual(r.worldDisplay.stats.builds,pressureBuilds,
          'An unrelated image arrival rebuilt a funded world footprint under pressure')
        // The scheduler clears these attempt flags before retrying an image.
        // That must not revoke metadata already prepared on the resource clock.
        r.textures.admissionBlocked.clear();r.textures.blockedByCapacity=false
        assert(r.worldDisplay.targetPrepared(),
          'Transient admission flags revoked funded world metadata during the request attempt')
      }
      r.render()
      assert.deepStrictEqual(submitted,[1])
      let wakes=0
      const schedule=r.textures.scheduleAdvance
      if(mode==='texture') {
        r.textures.preparationWaiting=new Set([key(r.current.draws[0].texture)])
        r.textures.scheduleAdvance=()=>{++wakes}
      }
      publish(2)
      await prepare(()=>r.preparedSurfaceSource===r.current&&r.preparedSurface&&
        r.preparedSurface.current===r.current&&(mode==='height'||r.worldDisplay.targetPrepared()))
      if(mode==='texture') {
        assert(!r.textures.preparationWaiting.size&&wakes>0,
          'Completed world metadata left dependent image admission asleep')
        r.textures.scheduleAdvance=schedule
      }
      assert.deepStrictEqual(submitted,[1],'Background preparation published new terrain')
      const slices=r.worldDisplay.stats.slices
      for(let n=1;n<=10;++n) {
        const camera=frame();camera.projectionView[3]=n/100;r.setCameraFrame(camera)
        r.render(false)
        assert.strictEqual(r.displaySurface.current,r.current,
          'Latest camera discarded a prepared immutable surface and starved terrain publication')
        assert.strictEqual(r.submittedSequence,2)
      }
      assert.deepStrictEqual(submitted,[1,2])
      assert.strictEqual(r.worldDisplay.stats.slices,slices,'Camera submission rebuilt world topology')
    }finally {
      r.destroy();await Promise.resolve()
      assert.strictEqual(r.resourceLedger.bytes,0)
    }
  }
  process.stdout.write('Camera surface witness: background ownership, continuous latest camera, terrain publication and zero teardown passed\n')
}
