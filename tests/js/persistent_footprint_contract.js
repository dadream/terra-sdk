const assert=require('assert')
const {ImageryFootprintCache}=require('./reference/imagery_footprint_cache')
const {ImageryPresentation}=require('../../sdk/js/imagery/terra_imagery_presentation')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {imageryDraws}=require('../../adapters/webgl/imagery_draws')
const reference=require('./reference/projected_imagery_draws').imageryDraws
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile,parentTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')

module.exports=function verifyPersistentFootprints() {
  const root={level:0,matrix:1,row:0,column:0},hull=[[0,0],[1,0],[1,1],[0,1]]
  const ledger=new ResourceLedger(4*1024*1024),cache=new ImageryFootprintCache(ledger)
  const measured=new Map(),ready=new Map([[key(root),root]])
  let regionTests=0
  const measurement=(lo,hi,visible=true)=>({visible,hull,pixelsPerUv:256,regions:{some(test){
    ++regionTests;return [{uv:{minimumU:lo,maximumU:hi,minimumV:0,maximumV:1}}].some(test)
  }}})
  const leaf=(row,column)=>descendantTextureTile(root,3,row,column)
  let draws=[]
  for(let mesh=0;mesh<8;++mesh) {
    measured.set(String(mesh),measurement(0,1))
    for(let column=0;column<4;++column)draws.push({geometryKey:String(mesh),resourceId:mesh+1,
      sourceTexture:root,texture:leaf(mesh,column),origin:[0,0,0]})
  }
  for(const draw of draws)ready.set(key(draw.texture),draw.texture)
  const store={targetDesired:new Map(draws.map(d=>[key(d.texture),d.texture])),admissionBlocked:new Set(),
    availableKeys:new Set(ready.keys()),cache:{has:id=>ready.has(id)},gpuReady:id=>ready.has(id),
    presentationTileFor:tile=>{
      for(let t=tile;t;t=parentTextureTile(t))if(ready.has(key(t)))return t
      return root
    },get(tile){return {resolvedTile:this.presentationTileFor(tile)}}}
  const renderer={current:{imageryPlan:{quality:{planningComplete:true}}},options:{imageryPixelError:1.25},
    cameraVersion:1,plannedCameraVersion:-1,terrainBoundImagery:false,presentedTextures:new Map(),
    presentationBridges:[],measureDraw:d=>measured.get(d.geometryKey),measureTextureDraw:()=>4,
    geometry:{get:()=>({model:{hull}})}}
  const compare=(inputs=draws,states=[])=>{
    const actual=new ImageryPresentation(),expected=new ImageryPresentation(),uncached=new ImageryPresentation()
    for(const state of states)for(const p of [actual,expected,uncached])p.cells.set(key(state.cell),{...state})
    actual.beginFrame(100);expected.beginFrame(100);uncached.beginFrame(100)
    const result=imageryDraws(renderer,inputs,store,actual,new Map(),true,undefined,cache)
    assert.deepStrictEqual(result,reference(renderer,inputs,store,expected,new Map()),
      'Persistent world rows changed the current projected cut, its UV transform or order')
    assert.deepStrictEqual(result,imageryDraws(renderer,inputs,store,uncached,new Map()),
      'Funded and unfunded world footprints produced different projected cuts')
    assert.deepStrictEqual([...actual.goals],[...expected.goals])
    return result
  }
  try {
    compare()
    const built=cache.stats().builtMeshes
    for(let step=0;step<8;++step) {
      ++renderer.cameraVersion
      for(const id of measured.keys())measured.set(id,measurement(step/16,(step+8)/16))
      draws=draws.map(d=>({...d,texture:{...d.texture},sourceTexture:{...d.sourceTexture}}))
      const result=compare()
      assert(result.every(d=>d.imageryCellOffsetX<=0))
      assert.strictEqual(cache.stats().builtMeshes,built,'Camera/object replacement rebuilt immutable world footprints')
    }
    // A second call with the same immutable projection reuses its numeric mask,
    // even when the surrounding descriptor objects were copied again.
    regionTests=0
    imageryDraws(renderer,draws.map(d=>({...d})),store,new ImageryPresentation(),new Map(),false,undefined,cache)
    assert.strictEqual(regionTests,0,'An unchanged projection repeated all region intersections')

    // Inserting/reordering unrelated meshes cannot change a local footprint's
    // identity. Cached row indices must rebind to this invocation's draw order.
    measured.set('new',measurement(0,1))
    const addition={...draws[0],geometryKey:'new',resourceId:100}
    compare([addition,...draws])
    assert.strictEqual(cache.stats().builtMeshes,built+1)
    const blocks=[]
    for(let mesh=7;mesh>=0;--mesh)blocks.push(...draws.filter(d=>d.geometryKey===String(mesh)))
    compare([addition,...blocks])
    assert.strictEqual(cache.stats().builtMeshes,built+1,'Another mesh moved a cached local row index')

    measured.set('0',measurement(0,1,false));compare()
    measured.set('0',measurement(0,1));compare()
    const oldFine=descendantTextureTile(draws[0].texture,2,1,1)
    ready.set(key(oldFine),oldFine);renderer.presentedTextures.set(key(oldFine),oldFine)
    const states=[{cell:oldFine,a:oldFine,b:root,alpha:0.5,goal:1,at:0}]
    for(const density of [Infinity,0.1,8,0.9]) {
      renderer.plannedCameraVersion=renderer.cameraVersion
      renderer.measureTextureDraw=()=>density
      compare(draws,states)
      renderer.plannedCameraVersion=-1
      compare(draws,states)
    }
    ready.delete(key(oldFine));renderer.presentedTextures.clear();compare()

    // Exercise the dependency decisions together, rather than accepting a
    // final settled frame after a transient wrong cut. Keep the old projected
    // algorithm independent of both new (cached and uncached) paths.
    const pool=[...new Map([...draws.map(d=>[key(d.texture),d.texture]),[key(oldFine),oldFine]]).values()]
    const triangle=[[0,0],[1,0],[0,1]]
    let seed=12345
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
    for(let step=0;step<64;++step) {
      ++renderer.cameraVersion
      renderer.plannedCameraVersion=step%3?renderer.cameraVersion:-1
      renderer.current.imageryPlan.quality={planningComplete:step%2===0,coarsening:step%4===0}
      store.blockedByCapacity=step%4===0
      store.admissionBlocked=new Set(step%7===0?[key(draws[0].texture)]:[])
      ready.clear();ready.set(key(root),root);renderer.presentedTextures.clear()
      for(const tile of pool) {
        if(random()<0.65)ready.set(key(tile),tile)
        if(random()<0.4)renderer.presentedTextures.set(key(tile),tile)
      }
      store.availableKeys=new Set([...ready.keys()].filter(id=>id===key(root)||random()<0.8))
      for(const id of measured.keys()) {
        const lo=random()*0.5
        measured.set(id,{visible:random()>0.15,hull:step%11===0?triangle:hull,
          pixelsPerUv:256*Math.pow(10,random()*5-2),regions:[
            {uv:{minimumU:lo,maximumU:lo+0.2,minimumV:0,maximumV:0.35}},
            {uv:{minimumU:0.6,maximumU:1,minimumV:0.55,maximumV:1}}]})
      }
      renderer.measureTextureDraw=(draw,level)=>measured.get(draw.geometryKey).pixelsPerUv/(256*Math.pow(2,level))
      renderer.presentationBridges=step%9===0?[root]:[]
      compare(step%2?draws.slice().reverse():draws,step%5===0?states:[])
    }

    const retained=compare(),producer=ledger.reserve('actual-producer',ledger.maximumBytes)
    assert(producer&&cache.bytes===0)
    assert.deepStrictEqual(compare(),retained)
    assert.strictEqual(cache.entries.size,0,'Unfunded world/mask metadata survived reclamation')
    producer.release();compare();cache.clear()
  }finally{cache.clear()}
  assert.strictEqual(ledger.bytes,0)
  console.log('Persistent world footprints: live projection, canonical cuts, UVs, semantic invalidation and reclamation passed')
}
