const assert = require('assert')
const {visibilityBounds} = require('../../sdk/js/terrain/visibility_bounds')
const {visibilityMembers, hiddenResources} = require('../../sdk/js/terrain/visibility_evidence')
const {visibilityCoverage, coversVisibility} = require('../../sdk/js/terrain/visibility_coverage')
const {relativeProjectionView, rowMajorToWebGlMatrix} = require('../../sdk/js/core/terra_globe_common')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')
const {offscreenCoverage} = require('../../adapters/webgl/visibility_dependencies')

async function verifyTerrainVisibility() {
  require('./visibility_proofs_contract')()
  const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
  const frame = {sequence: 1, projectionView: identity, cameraPosition: [0,0,0]}
  const viewport = {width: 128, height: 128}
  const model = {faces: new Uint16Array([0,1,2]), blocks: [
    {minimum: [-.5,-.4,.1], maximum: [.3,.7,.2], faces: [0]}]}
  const draws = [1,2].map(id => ({resourceId: id, geometryKey: 'mesh:1:'+id,
    origin: [0,0,0], firstIndex: 0, indexCount: 3, flags: 0,
    texture: {level: 1, matrix: 2, row: 0, column: id-1},
    textureNode: {level: 0, root: id-1, row: 0, column: 0}}))
  const rectangle = visibilityBounds(model, draws[0], frame, viewport)[0]
  assert(rectangle[0] < -.5 && rectangle[1] < -.4 && rectangle[2] > .3 && rectangle[3] > .7 && rectangle[4] < .1)
  assert.strictEqual(visibilityBounds({...model, faces: new Uint16Array(6)}, draws[0], frame, viewport), null)
  assert.strictEqual(visibilityBounds(model, draws[0], {...frame, projectionView: identity.map((v,i)=>i===11?-2:v)}, viewport), null)
  assert.strictEqual(visibilityBounds(model, draws[0], frame, {width: 0, height: 1}), null)
  const near = {faces: model.faces, blocks: [{...model.blocks[0], minimum: [-.2,-.2,-1.1]}]}
  assert.strictEqual(visibilityBounds(near, draws[0], frame, viewport), null)

  // Float32 operands cancel before projection. A world-sized allowance would
  // move this near-camera query in front of every occluder, defeating demand
  // reduction despite an exactly representable relative position.
  const base = 2 ** 20
  const cancellation = {faces:model.faces,blocks:[{faces:[0],
    minimum:[base-.5,base-.5,base+.25],maximum:[base+.5,base+.5,base+.375]}]}
  const local = visibilityBounds(cancellation,{origin:[-base,-base,-base]},frame,viewport)[0]
  assert(local[0]>-.52 && local[1]>-.52 && local[2]<.52 && local[3]<.52 && local[4]>.24,
    'World-coordinate cancellation inflated the conservative query')

  // Sample Float32 shader arithmetic at different world magnitudes. Bounds
  // must enclose projected points and place their query depth nearer than all.
  for (const world of [0, 6378000, -6378000]) for (const distance of [2, 100, 1e6]) {
    const camera = [world, world, world], origin = [world+.1, world-.1, world-distance]
    const projectionView = [1,0,0,-world,0,1,0,-world,0,0,-1,world-1,0,0,-1,world]
    const view = {projectionView, cameraPosition: camera}, draw = {...draws[0], origin}
    const box = visibilityBounds(model, draw, view, viewport)
    assert(box && box.length === 1)
    const m = rowMajorToWebGlMatrix(relativeProjectionView(projectionView, camera))
    const f = Math.fround
    for (let i=0; i<=8; ++i) for (let j=0; j<=8; ++j) for (const z of [.1,.15,.2]) {
      const position = [-.5+i*.1,-.4+j*1.1/8,z]
      const p = position.map((v, axis) => f(f(v)+f(origin[axis]-camera[axis])))
      const clip = [0,1,2,3].map(row => f(f(f(f(m[row]*p[0])+f(m[4+row]*p[1]))+f(m[8+row]*p[2]))+m[12+row]))
      const x=clip[0]/clip[3],y=clip[1]/clip[3],depth=clip[2]/clip[3],r=box[0]
      assert(x>=r[0] && x<=r[2] && y>=r[1] && y<=r[3] && depth>=r[4], 'Conservative projection omitted a shader sample')
    }
  }
  const evidence = {schema: 'terra.terrain-visibility.v2', revision: 1, projectionView: identity.slice(),
    cameraPosition: [0,0,0], viewport: [128,128], members: visibilityMembers(draws), hidden: [1]}
  assert.deepStrictEqual([...hiddenResources(evidence,frame,draws,viewport)],[1])
  const changedNeighbor=draws.map(d=>({...d}));changedNeighbor[1].geometryKey='mesh:2:2'
  assert.strictEqual(hiddenResources(evidence,frame,changedNeighbor,viewport).size,0)
  assert.strictEqual(hiddenResources(evidence,{...frame,cameraPosition:[1e-10,0,0]},draws,viewport).size,0)
  assert.strictEqual(hiddenResources(evidence,frame,draws,{width:127,height:128}).size,0)
  assert.strictEqual(hiddenResources({...evidence,hidden:[99]},frame,draws,viewport).size,0)
  assert.strictEqual(hiddenResources({...evidence,revision:0},frame,draws,viewport).size,0)
  const instances=draws.concat({...draws[0],origin:[1,0,0]})
  assert.strictEqual(hiddenResources({...evidence,members:visibilityMembers(instances)},frame,instances,viewport).size,0)
  for (const hull of [[[0,0],[1,0],[1,1],[0,1]], [[0,0],[1,0],[0,1]]]) {
    const geometry = new Map([[draws[0].geometryKey, {model: {hull}}]])
    const full = visibilityCoverage([[draws[0], false]], geometry, new Set())
    const child = (scale,x,y) => [{...draws[0],imageryCellScale:scale,imageryCellOffsetX:-x,imageryCellOffsetY:-y},true]
    const children = [child(2,0,0),child(2,1,0),child(2,0,1)]
    if(hull.length===4)children.push(child(2,1,1))
    assert.deepStrictEqual(visibilityCoverage(children,geometry,new Set()),full,'Equivalent UV subdivision invalidated occluders')
    assert.notDeepStrictEqual(visibilityCoverage(children.slice(1),geometry,new Set()),full,'Missing geometry was mistaken for equivalent coverage')
    assert.deepStrictEqual(visibilityCoverage([child(2,0,0)],geometry,new Set()),
      visibilityCoverage([child(4,0,0),child(4,1,0),child(4,0,1),child(4,1,1)],geometry,new Set()))
    const partial=visibilityCoverage([child(2,0,0)],geometry,new Set())
    const all=visibilityCoverage(children,geometry,new Set())
    assert(coversVisibility(partial,all,new Set()),'Coverage expansion discarded valid evidence')
    assert(!coversVisibility(all,partial,new Set()),'Coverage loss preserved stale evidence')
    assert(coversVisibility(all,new Map(),new Set([draws[0].geometryKey])),
      'Proven hidden geometry became an occluder dependency')
    const raw=visibilityCoverage([child(3,0,0)],geometry,new Set())
    assert(coversVisibility(raw,raw,new Set()) && coversVisibility(raw,all,new Set()))
    assert(!coversVisibility(raw,partial,new Set()) && !coversVisibility(partial,raw,new Set()),
      'Unknown raw coverage guessed containment')
  }

  // Reproduce the real fixed-camera coverage loss without live services.
  // A whole hull becoming one quarter used to discard every pending query.
  const fixture = require('./reference/visibility_dependency_fixture')
  const blocks = fixture.blocks.map(b => ({...b, faces: new Array(b.triangleCount).fill(0)}))
  const captured = {hull: fixture.hull, blocks,
    faces: {length: blocks.reduce((n,b) => n+b.faces.length*3,0)}}
  const r = {current: {draws: [fixture.draw], frame: fixture.frame},
    canvas: {width: fixture.viewport[0], height: fixture.viewport[1]},
    geometry: new Map([[fixture.draw.geometryKey, {model: captured}]])}
  const required = new Map([[fixture.draw.geometryKey, fixture.before]])
  const available = new Map([[fixture.draw.geometryKey, fixture.after]])
  assert(!coversVisibility(required, available, new Set()))
  assert(coversVisibility(required, available, new Set(), offscreenCoverage(r)),
    'Offscreen imagery subdivision revoked fixed-view visibility')
  assert(!coversVisibility(required, new Map(), new Set(), offscreenCoverage(r)),
    'Losing the remaining visible quarter retained depth evidence')
  let guessedRaw = false
  assert(!coversVisibility(new Map([['raw',{cells:['2:0:0']}]]),new Map(),new Set(),
    () => {guessedRaw=true;return true}))
  assert(!guessedRaw,'Raw coverage was interpreted as a canonical UV cell')

  const fullUv = {minimumU:0,minimumV:0,maximumU:1,maximumV:1}
  const draw = draws[0], key = draw.geometryKey
  const outside = {faces:[0], minimum:[2,-.2,0],maximum:[3,.2,.2],uv:fullUv}
  const one = block => ({faces:{length:3}, blocks:[block]})
  const screen = {current:{draws:[draw],frame},canvas:{width:128,height:128},
    geometry:new Map([[key,{model:one(outside)}]])}
  assert(offscreenCoverage(screen)(key,0,0,1))
  for(const block of [
    {...outside,minimum:[1.001,-.2,0]}, // Physical pixel margin.
    {...outside,minimum:[2,-.2,-1.1]}, // Near-plane intersection is unknown.
    {...outside,uv:undefined},
    {...outside,minimum:[NaN,0,0]},
    {...outside,maximum:undefined}
  ]) {
    screen.geometry.set(key,{model:one(block)})
    assert(!offscreenCoverage(screen)(key,0,0,1),'Uncertain block discarded an occluder')
  }
  screen.geometry.clear()
  assert(!offscreenCoverage(screen)(key,0,0,1),'Absent geometry was treated as offscreen')
  screen.current.draws = Array.from({length:9},(_,i) => ({...draw,geometryKey:'block:'+i}))
  screen.current.draws.forEach(d => screen.geometry.set(d.geometryKey,
    {model:{faces:{length:48},blocks:Array.from({length:16},()=>outside)}}))
  const bounded = offscreenCoverage(screen)
  for(let i=0;i<8;++i)assert(bounded('block:'+i,0,0,1))
  assert(!bounded('block:8',0,0,1),'Dependency projection exceeded its 128-block allowance')
  assert(bounded('block:0',0,0,1),'Repeated cells consumed the block allowance again')

  const host = new TerrainWorkerHost()
  const raw = new Map(draws.map(d=>[d.resourceId,{visible:true,pixelsPerUv:100,regions:[]}]))
  const resources = new Map(draws.map(d=>[d.resourceId,{model:{bounds:{},hull:[]}}]))
  const descriptor={kind:'global-geodetic',matrix_level_offset:1,bounds:[[-180,-90],[180,90]],
    minimum_level:0,maximum_level:19,tile_size:256,level_zero_columns:2,level_zero_rows:1}
  const camera={distance:1}, imagery={descriptor,maximumTextures:8,maximumDraws:32,targetPixelError:1.25,visibility:evidence}
  const packet={frame,draws,resources,updateState:{modelRevision:1},meshIdentity:'1,2'}
  host.imageryJob={coarsening:false,exact:new Set(),precise:new Map(),releaseMeshes(){}}
  host.imageryMeasurements=raw;host.imagerySourceDraws=draws
  host.measurementSignature=JSON.stringify([camera,frame.projectionView,viewport,descriptor,undefined])
  host.measurementMeshIdentity='1,2'
  host.abi={...require('./reference/imagery_task_fixture'), async planImageryAsync(source,measure) {
    assert.strictEqual(measure(source[0]).visible,false)
    assert.strictEqual(measure(source[1]).visible,true)
    return {draws:[{...source[1],imageryPixelError:.4}],levels:new Set(),quality:{planningComplete:true,meetsTarget:true}}
  }}
  try {
    let result
    for(let i=0;i<100;i++) {
      result=await host.planImagery(packet,{camera,viewport,imagery})
      if(!result.pending && !result.continuation)break
    }
    assert(result.imageryPlan && result.imageryPlan.quality.occludedMeshCount===1 && result.imageryPlan.quality.visibilityRevision===1)
    assert(raw.get(1).visible && result.measurements.find(m=>m.resourceId===1).visible,
      'Scene occlusion contaminated reusable projection measurements')
  } finally {host.clearPlanning()}

  // Publish/revoke demand evidence while expensive projection work is paused.
  // The work and exact-refinement progress must survive both changes; only the
  // demand input changes. This exercises the real host message/epoch boundary.
  let cancelled=0
  const work={return(){++cancelled}}, measurement={work,draws:[],boundsIndex:0,index:3,measured:raw}
  const epoch={result:packet,message:{camera,viewport,imagery},viewRevision:1,
    scale:Math.tan(Math.PI/6)/viewport.height,started:Date.now(),
    exact:new Set([1]),precise:new Map([[1,raw.get(1)]]),releaseMeshes(){}}
  host.frames.candidate=packet;host.manifest={radius:6378000}
  host.imageryJob=epoch;host.measurementJob=measurement;host.imageryMeasurements=raw
  host.projectionChange={frame,revision:1,value:{rebase:false,coarsening:null}}
  const plan=host.planImagery
  let incoming
  host.planImagery=async function(result,message) {
    assert.strictEqual(cancelled,0,'Visibility feedback cancelled projection work')
    assert.strictEqual(this.measurementJob,measurement,'Visibility discarded a suspended measurement')
    assert.strictEqual(this.imageryJob,epoch,'Visibility reset the immutable projection epoch')
    assert.strictEqual(message.imagery.visibility,incoming)
    assert(epoch.exact.has(1) && epoch.precise.get(1)===raw.get(1))
    return {pending:true}
  }
  try {
    for(incoming of [{...evidence,revision:2},null]) {
      const result=await host.handle({type:'imagery',sequence:1,viewRevision:1,camera,viewport,
        imagery:{...imagery,visibility:incoming}})
      assert(result.pending && result.progress.index===3)
    }
    assert.strictEqual(imagery.visibility,evidence,'Feedback mutated the submitted snapshot')
  } finally {host.planImagery=plan;host.clearPlanning()}
  assert.strictEqual(cancelled,1,'Final teardown did not release suspended projection work')
}

module.exports=verifyTerrainVisibility
if(require.main===module)verifyTerrainVisibility().then(()=>console.log('Terrain visibility contracts passed'))
  .catch(error=>{console.error(error);process.exitCode=1})
