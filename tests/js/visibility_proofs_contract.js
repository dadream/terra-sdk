const assert = require('assert')
const {offscreenCell} = require('../../sdk/js/terrain/visibility_footprint')
const {VisibilityProofs} = require('../../adapters/webgl/visibility_proofs')
const {offscreenCoverage} = require('../../adapters/webgl/visibility_dependencies')
const {coversVisibility, visibilityCoverage} = require('../../sdk/js/terrain/visibility_coverage')
const {TerrainVisibility} = require('../../adapters/webgl/terrain_visibility')
const {TerraWebGlRenderer} = require('../../adapters/webgl/terra_webgl_renderer')

module.exports = function () {
  const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
  const frame = {projectionView: identity, cameraPosition: [0,0,0]}
  const viewport = {width: 128, height: 128}, root = {x:0,y:0,scale:1}
  const draw = {geometryKey:'mesh:1', origin:[0,0,0], flags:0}
  const model = {positions:new Float32Array([.8,2,0, 2,.8,0, 2,2,0]),
    uv:new Float32Array([0,0, 1,0, 0,1]), faces:new Uint16Array([0,1,2]),
    blocks:[{minimum:[.8,.8,0],maximum:[2,2,0],faces:[0],
      uv:{minimumU:0,minimumV:0,maximumU:1,maximumV:1}}]}
  const drain = work => { let result; do {result=work.next()} while(!result.done); return result.value }
  const proof = (m=model,d=draw,v=frame,c=root) => drain(offscreenCell(m,d,v,viewport,c))
  assert(proof(), 'A corner outside two planes could not be proved offscreen')
  const visible = {...model, positions:new Float32Array([-.8,-.8,0, .8,-.8,0, 0,.8,0])}
  assert(!proof(visible), 'A visible triangle was removed')
  const crossing = {...model, positions:new Float32Array([-.8,-.8,-2, .8,-.8,0, 0,.8,0])}
  assert(!proof(crossing), 'A near-plane crossing lost visible geometry')
  assert(proof(visible,{...draw,origin:[0,0,-2]}), 'A wholly near-clipped triangle remained a dependency')
  assert(!proof({...visible,positions:new Float32Array([NaN])}))
  assert(!proof({...visible,faces:new Uint16Array([0,1,99])}))
  assert(!proof(model,draw,frame,{...root,scale:3}))
  assert(!drain(offscreenCell(model,draw,frame,{width:0,height:128},root)))
  // The required UV half is offscreen; the other half must remain an occluder.
  const span = {...model, positions:new Float32Array([0,-.5,0, 3,-.5,0, 0,.5,0])}
  assert(proof(span,draw,frame,{x:1,y:0,scale:2}))
  assert(!proof(span,draw,frame,{x:0,y:0,scale:2}))
  // A subpixel rim and world-coordinate cancellation remain conservative.
  assert(!proof({...model,positions:new Float32Array([1.001,-.1,0, 1.005,-.1,0, 1.001,.1,0])}))
  for (const world of [0, 6378000, -6378000]) {
    const camera=[world,world,world],view={cameraPosition:camera,
      projectionView:[1,0,0,-world,0,1,0,-world,0,0,1,-world,0,0,0,1]}
    assert(!proof(visible,{...draw,origin:camera},view))
    assert(proof(model,{...draw,origin:camera},view))
  }

  let holds=0,wakes=0,renders=0,visited=0
  const resource={ownership:{hold(){++holds;let active=true;return()=>{if(active){--holds;active=false}}}}}
  const many={...model,faces:new Uint16Array(Array.from({length:4096*3},(_,i)=>i%3))}
  const positions=many.positions
  many.positions=new Proxy(positions,{get(target,key){if(key==='0')++visited;return key==='length'?target.length:target[key]}})
  const geometry={model:many,resource}
  const r={current:{draws:[draw],frame},cameraVersion:1,partitionGeneration:1,canvas:{...viewport},
    geometry:new Map([[draw.geometryKey,geometry]]),
    requestResources(){++wakes},requestRender(){++renders},onDiagnostic(kind){throw Error(kind)}}
  const p=new VisibilityProofs(r)
  const key=draw.geometryKey,required=new Map([[key,1]]),empty=new Map()
  assert(!coversVisibility(required,empty,new Set(),offscreenCoverage(r)), 'Fixture did not exercise the coarse false positive')
  const check=()=>p.checkCoverage(key,1,0)
  assert(!check() && !check() && holds===1 && p.pending.size===1,'Pending work authorized reuse or duplicated ownership')
  p.advance()
  assert(visited<=512 && !check() && holds===1,'Proof work exceeded a bounded turn')
  for(let i=0;i<128 && p.pending.size;++i)p.advance()
  assert(check() && holds===0 && renders>0 && wakes>0,'A finished proof failed to release its mesh or wake presentation')
  assert(coversVisibility(required,empty,new Set(),()=>check() === true))
  const noop=()=>{}
  const enabled=new Set()
  const observer=Object.assign(Object.create(TerrainVisibility.prototype), {
    renderer:r,gl:{CULL_FACE:'cull',colorMask:noop,depthMask:noop,
      isEnabled:value=>enabled.has(value),enable:value=>enabled.add(value),disable:value=>enabled.delete(value),useProgram:noop},
    owner:r.current,version:r.cameraVersion,width:r.canvas.width,height:r.canvas.height,
    proofs:p,scope:required,pending:[],draws:[draw],index:1,hiddenKeys:new Set(),
    hiddenIds:new Set(),publishedIds:new Set(),reset(){throw Error('Completed offscreen proof restarted the actual observer')}
  })
  observer.observe({current:r.current},false,[])
  assert(!enabled.has('cull'),'Background visibility observation enabled face culling for the next sky draw')
  enabled.add('cull')
  observer.observe({current:r.current},false,[])
  assert(enabled.has('cull'),'Visibility observation disabled terrain face culling')
  enabled.delete('cull')
  assert(observer.done && !observer.invalidated)
  assert.strictEqual(observer.scope.size,0,'Completed sweep retained its obsolete coverage dependency')
  const known=p.results
  // Ordinary coverage resets have no effect on a proof's immutable inputs.
  p.advance();assert.strictEqual(p.results,known)
  for(const change of [()=>{++r.cameraVersion},()=>{r.canvas.width++},()=>{++r.partitionGeneration},
    ()=>{r.current={...r.current}},()=>{geometry.model={...many}}]) {
    assert(check())
    change();assert(!check() && holds===1,'Changed inputs reused a prior certificate')
    for(let i=0;i<128&&p.pending.size;++i)p.advance()
    assert(check() && holds===0)
  }
  p.clear();check();r.paused=true;p.advance()
  assert(holds===0 && p.pending.size===0 && !check(),'Pause retained an active mesh borrower')
  r.paused=false
  const cell = (x, scale=16) => scale===1 ? 1 :
    [0,1,2,3].map(i=>i===Math.floor(x/(scale/2)) ? cell(x%(scale/2),scale/2) : 0)
  for(let x=0;x<12;++x)assert.strictEqual(p.checkCoverage(key,cell(x),0),null)
  assert(p.pending.size===8 && holds===8,'Uncertain coverage created an unbounded proof queue')
  r.contextLost=true;p.advance();assert(holds===0 && !p.pending.size)
  r.contextLost=false;geometry.model=visible
  assert(!check());p.advance();assert(!check() && !p.pending.size && holds===0,'Visible cells repeatedly scheduled proof or became offscreen')
  p.clear();geometry.model=many;check();r.geometry.clear();p.advance()
  assert(holds===0 && !p.pending.size,'Geometry eviction left a suspended owner')
  p.clear()

  // A single change can remove more cells than the result-cache capacity.
  // Completion must be one certificate, not a simultaneous set of LRU cells.
  r.geometry.set(key,geometry);geometry.model=model
  const alternating = depth => depth ? [0,1,2,3].map(()=>alternating(depth-1)) : [0,1,0,1]
  const after=alternating(4)
  p.synchronize()
  for(let i=0;i<512;++i)p.results.set('old:'+i,false)
  assert.strictEqual(p.checkCoverage(key,1,after),null)
  for(let i=0;i<1024&&p.pending.size;++i)p.advance()
  assert(p.checkCoverage(key,1,after) && !p.pending.size && holds===0 && p.results.size===512,
    'A large coverage transaction starved on per-cell result eviction')
  p.clear()

  // Exercise the real renderer adoption boundary, with already prepared UV
  // buffers. Neither GPU readiness nor an image arriving may bypass this wait.
  geometry.model={...many,hull:[[0,0],[1,0],[0,1]]}
  const previous=[{...draw,resourceId:1,texture:{level:1,row:0,column:0}}]
  const proposed=[{...previous[0],imageryClipCell:true,imageryCellScale:2,
    imageryCellOffsetX:0,imageryCellOffsetY:0,texture:{level:2,row:0,column:0}}]
  geometry.partitionDraws=previous;geometry.partitions=new Map([['prepared',{}]])
  Object.assign(r,{visibility:observer,displaySurface:{current:r.current},
    partitionPublication:{prepare:draws=>new Map([[key,draws]])},partitionGroups:{publish:noop},
    partitionCell:()=>({key:'prepared'}),requestPartitionSet:noop,prunePartitionRequests:noop})
  Object.assign(observer,{scope:required,done:true,draws:[draw],index:1,
    owner:r.current,version:r.cameraVersion,width:r.canvas.width,height:r.canvas.height})
  const prepare=()=>TerraWebGlRenderer.prototype.preparePartitions.call(r,proposed)
  const held=prepare()
  assert.strictEqual(held[0],previous[0],'Unproved coverage loss was adopted before its proof')
  assert(held.coveragePending && geometry.partitionDraws===previous && p.pending.size===1)
  observer.observe({current:r.current},false,previous.map(d=>[d,false]))
  assert(!observer.invalidated && observer.scope.get(key)===1)
  r.pendingSubmission=true;r.submissions={poll:noop};r.wakeResources=noop
  for(let i=0;i<256&&p.pending.size;++i) {
    assert.strictEqual(TerraWebGlRenderer.prototype.prepareResources.call(r),false)
  }
  r.pendingSubmission=false
  assert.strictEqual(prepare()[0],proposed[0],'Completed proof did not unblock the actual renderer')
  observer.observe({current:r.current},false,proposed.map(d=>[d,true]))
  const footprint=visibilityCoverage(proposed.map(d=>[d,true]),r.geometry,new Set())
  assert.deepStrictEqual(observer.scope,footprint)
  p.clear()
  observer.observe({current:r.current},false,proposed.map(d=>[d,true]))
  assert(!observer.invalidated && !p.pending.size,'Unchanged coverage required an evicted historical certificate')

  // A negative proof also wakes publication; post-submission revocation stays
  // mandatory. Unknown coverage is never silently treated as screen-invisible.
  geometry.model={...visible,blocks:[],hull:[[0,0],[1,0],[0,1]]}
  geometry.partitionDraws=previous;observer.scope=required
  assert(prepare().coveragePending)
  const rendersBefore=renders
  for(let i=0;i<128&&p.pending.size;++i)p.advance()
  assert(renders>rendersBefore && prepare()[0]===proposed[0], 'Negative proof left publication blocked')
  let revoked=0
  observer.reset=function(...args){++revoked;TerrainVisibility.prototype.reset.apply(this,args)}
  observer.evidence={hidden:[2]};observer.hiddenIds=new Set([2]);observer.publishedIds=new Set([2])
  r.options={onImageryPlanningChange(){}}
  observer.observe({current:r.current},false,proposed.map(d=>[d,true]))
  assert(revoked>0 && observer.invalidated && !observer.evidence,'Visible loss retained stale occlusion evidence')

  geometry.model={...many,hull:[[0,0],[1,0],[0,1]]};geometry.partitionDraws=previous
  observer.scope=required;observer.failed=false
  assert(prepare().coveragePending)
  ++r.cameraVersion
  assert.strictEqual(prepare()[0],proposed[0],'A stale proof held back a new camera')
  p.advance();assert(!p.pending.size && holds===0)
  p.clear()
}
