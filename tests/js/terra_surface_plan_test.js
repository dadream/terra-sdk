const partitionSurface = require('./reference/partition_surface')
const assert = require('assert')
require('./surface_facing_test')
require('./frustum_bounds_test')()
require('./triangle_projection_test')()
require('./triangle_density_test')()
require('./surface_regions_test')()
require('./hierarchical_measurement_test')()
require('./surface_preparation_test')()
require('./surface_layout_test')()
require('./surface_derivative_bounds_test')()
require('./partition_fit_cache_test')()
const plan = require('../../sdk/js/terrain/terra_surface_plan')
const { CooperativeTask } = require('../../sdk/js/runtime/cooperative_task')
const { invertMatrix4 } = require('../../sdk/js/math/matrix')
const positions = new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0])
const uv = new Float32Array([0,0,1,0,0,1,1,1])
const indices = new Uint16Array([0,2,1,3])
const model = plan.prepareSurface(positions, uv, indices, 0, 4)
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
{
  const f=require('./reference/measurement_fixture')()
  const surface=plan.prepareSurface(f.positions,f.uv,f.indices,0,f.indices.length)
  const context=plan.projectionContext({projectionView:identity},{width:400,height:400},identity)
  const fast=plan.measureSurface(surface,[0,0,0],context)
  const work=plan.surfaceMeasurements(surface,[0,0,0],context,false,true)
  let result,steps=0
  do {result=work.next();++steps} while(!result.done)
  const tight=result.value
  assert(fast.refinable && !tight.refinable)
  assert(fast.pixelsPerUv/256<1.25 && tight.pixelsPerUv/256<1.25,
    'The centred derivative interval consumed unneeded texture resolution')
  assert(Math.abs(tight.pixelsPerUv-280)<0.001,
    'Tightened bound must agree with the independent maximum slope of 1.4')
  assert.strictEqual(tight.regions.length,fast.regions.length,
    'Precision refinement exported per-triangle data for a shallow block')
  assert(steps>1,'Precision refinement did not yield between blocks')
  const draws=[{resourceId:1,imageryPixelError:2},{resourceId:2,imageryPixelError:1}]
  const p={quality:{meetsTarget:false,targetPixelError:1.25},draws}
  assert.deepStrictEqual(plan.measurementRefinements(p,()=>fast),[draws[0]])
  assert.deepStrictEqual(plan.measurementRefinements(p,d=>d.resourceId===1?tight:fast),[draws[1]],
    'A passing upper bound may still consume the limited shared budget')
  assert.deepStrictEqual(plan.measurementRefinements(p,()=>tight),[])
  const safe = {...p, quality: {...p.quality, meetsTarget: true}}
  assert.deepStrictEqual(plan.measurementRefinements(safe,()=>fast),[])
  assert.deepStrictEqual(plan.measurementRefinements(safe,()=>fast,true),draws,
    'Shared working-set pressure accepted an unnecessarily expensive passing bound')
  assert.deepStrictEqual(plan.measurementRefinements(safe,()=>tight,true),[],
    'Shared pressure repeatedly tightened an already exact measurement')
}
function measure(model, matrix) {
  const frame = { projectionView: new Float64Array(matrix) }
  return plan.measureSurface(model, [0,0,0], plan.projectionContext(frame,
    {width:1024,height:1024,devicePixelRatio:1}, invertMatrix4(matrix)))
}
assert.strictEqual(measure(model, identity).pixelsPerUv, 1024)
for (const angle of [0.1,0.5,Math.PI/4,Math.PI/2,Math.PI]) {
  const c=Math.cos(angle),s=Math.sin(angle)
  const rotated=[c,-s,0,0,s,c,0,0,0,0,1,0,0,0,0,1]
  assert(Math.abs(measure(model,rotated).pixelsPerUv-1024)<1e-8,
    'Pure screen rotation must not increase texel density')
}
const huge = plan.prepareSurface(new Float32Array(Array.from(positions,v=>v*8)),uv,indices,0,4)
assert.strictEqual(measure(huge,identity).pixelsPerUv/256,32,
  'Clipping to the viewport must not clip the quality error')
const translated=identity.slice(); translated[3]=1.75
assert.strictEqual(measure(model,translated).pixelsPerUv,1024)
const hidden=identity.slice(); hidden[3]=20
assert.strictEqual(measure(model,hidden).visible,false)
// Relief along the orthographic viewing axis does not affect screen density.
// Fully visible shallow-depth blocks must use their cached bound, independently
// of the number of triangles and of nonzero height derivative residuals.
const reliefPositions=[],reliefUv=[],reliefFaces=[]
for(let row=0;row<24;row++) for(let col=0;col<24;col++) {
  const base=reliefPositions.length/3
  for(const [du,dv] of [[0,0],[1,0],[0,1]]) {
    const u=(col+du)/24,v=(row+dv)/24
    reliefPositions.push(u*1.8-0.9,v*1.8-0.9,((col+row+du+dv)%2)*0.01)
    reliefUv.push(u,v)
  }
  if(reliefFaces.length) reliefFaces.push(reliefFaces[reliefFaces.length-1],base)
  if(reliefFaces.length%2) reliefFaces.push(base)
  reliefFaces.push(base,base+2,base+1)
}
const relief=plan.prepareSurface(new Float32Array(reliefPositions),new Float32Array(reliefUv),
  new Uint16Array(reliefFaces),0,reliefFaces.length)
const reliefWork=plan.surfaceMeasurements(relief,[0,0,0],plan.projectionContext(
  {projectionView:identity},{width:1024,height:1024},identity))
let reliefSteps=0,reliefResult
do {reliefResult=reliefWork.next();++reliefSteps} while(!reliefResult.done)
assert(relief.blocks.some(block=>block.deviation>0))
assert(reliefSteps<=relief.blocks.length+1,
  'Distant relief triggered an unnecessary scan of every triangle')
assert(Math.abs(reliefResult.value.pixelsPerUv-921.6)<0.01)
const perspective = [1,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0]
const stretched=plan.prepareSurface(new Float32Array([
  -1,-1,1,100,-100,100,-1,1,1,100,100,100]),uv,indices,0,4)
const bound=plan.measureSurface(stretched,[0,0,0],plan.projectionContext(
  {projectionView:perspective},{width:1024,height:1024},null))
assert(bound.visible && bound.pixelsPerUv/256>91,
  'Extreme perspective must not be reported as one pixel per texel')
assert(bound.regions.length <= 64, 'This small fixture produced redundant projective regions')
assert.strictEqual(Math.max(...bound.regions.map(r => r.pixelsPerUv)), bound.pixelsPerUv,
  'UV aggregation must preserve the largest measured error')
const localCell={minimumU:6/64,maximumU:7/64,minimumV:0,maximumV:1/64}
const localError=bound.regions.reduce((n,region)=>Math.max(n,plan.regionError(region,localCell)),0)
// The lower triangle is X=-1+101u, Y=-1-99u+2v, W=1+99u.
// Its analytic derivative has magnitude below 1000 px/UV in this cell.
// The old envelope mixed in the other triangle and reported over 136000.
assert(localError>900 && localError<1000,
  'A distant triangle inflated the precision demand of an unrelated local cell')
const cells=[]
for(let y=0;y<4;y++) for(let x=0;x<4;x++) cells.push({key:x+'/'+y,
  bounds:{minimumU:x/4,maximumU:(x+1)/4,minimumV:y/4,maximumV:(y+1)/4}})
const parts=partitionSurface(model,cells)
const cachedBefore = plan.partitionCacheStats()
const uvPlan = plan.createUvPartitionPlanTask(uv, model.faces, cells)
let uvResult
do { uvResult = uvPlan.step() } while (!uvResult.done)
assert.deepStrictEqual(uvResult.value, cells.map(cell => ({key: cell.key,
  bytes: parts.filter(part => part.cell.key === cell.key).reduce((n, part) =>
    n + part.positions.byteLength + part.uv.byteLength + part.indices.byteLength, 0)})))
assert.deepStrictEqual(plan.partitionCacheStats(), cachedBefore,
  'Prepared UV costing retained scratch in the persistent cache')
const cancelledUvPlan = plan.createUvPartitionPlanTask(uv, model.faces, cells)
cancelledUvPlan.maximumSteps = 1
assert.strictEqual(cancelledUvPlan.step().done, false)
cancelledUvPlan.cancel()
assert.strictEqual(cancelledUvPlan.iterator, null)
assert.deepStrictEqual(plan.partitionCacheStats(), cachedBefore,
  'Cancelled prepared UV costing changed the persistent cache')
// Sparse imagery cells should not rescan every triangle of a prepared mesh.
{
  const gridUv = new Float32Array(65*65*2), gridFaces = []
  for (let y=0;y<=64;++y) for (let x=0;x<=64;++x) gridUv.set([x/64,y/64],(y*65+x)*2)
  for (let y=0;y<64;++y) for (let x=0;x<64;++x) {
    const a=y*65+x; gridFaces.push(a,a+1,a+65,a+1,a+66,a+65)
  }
  const sparse = Array.from({length:8},(_,i)=>({key:String(i),bounds:{
    minimumU:i/8,maximumU:i/8+1/64,minimumV:0.5,maximumV:0.5+1/64}}))
  let reads=0
  const counted = new Proxy(gridUv,{get(target,key) {
    if (/^\d+$/.test(String(key))) ++reads
    return Reflect.get(target,key,target)
  }})
  const task = plan.createUvPartitionPlanTask(counted,new Uint16Array(gridFaces),sparse)
  let result
  do {result=task.step()} while (!result.done)
  assert.deepStrictEqual(result.value,sparse.map(c=>({key:c.key,bytes:12})))
  assert(reads < gridFaces.length*4, 'Sparse prepared costs scanned the full mesh for every cell')
}
const prices = plan.createPartitionPlanTask(model, cells)
while (!prices.step().done) {}
assert.strictEqual(prices.value.reduce((sum, cell) => sum + cell.bytes, 0), parts.reduce((n, part) =>
  n + part.positions.byteLength + part.uv.byteLength + part.indices.byteLength, 0),
  'Admission estimates must match clipped GPU buffer sizes')
let area=0
function addArea(a,b,c) {
  area+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2
}
parts.forEach(part=>{
  const b=part.cell.bounds
  for(let i=0;i<part.uv.length;i+=2) {
    assert(part.uv[i]>=b.minimumU && part.uv[i]<=b.maximumU)
    assert(part.uv[i+1]>=b.minimumV && part.uv[i+1]<=b.maximumV)
  }
  for(let i=0;i<part.uv.length;i+=6) addArea(...[0,2,4].map(j=>[part.uv[i+j],part.uv[i+j+1]]))
  for(let i=0;i<part.indices.length;i+=3) addArea(...Array.from(part.indices.slice(i,i+3),
    j=>[uv[2*j],uv[2*j+1]]))
})
assert(Math.abs(area-1)<1e-8,'Partitions must cover the original domain exactly once')
const whole=partitionSurface(model,[{key:'whole',
  bounds:{minimumU:0,maximumU:1,minimumV:0,maximumV:1}}])[0]
assert.strictEqual(whole.positions.length,0,'Interior triangles must reuse existing vertices')
assert.strictEqual(whole.indices.length,6)
assert.deepStrictEqual(partitionSurface(Object.assign({},model,{blocks:null}),cells),parts,
  'UV spatial filtering changed the exact clipped topology')
const triangular = plan.prepareSurface(positions, uv, indices, 0, 3)
assert.strictEqual(plan.intersectsCell(triangular.hull, 0.75, 0.75, 1, 1), false,
  'Empty cells outside a triangular patch must not consume texture budget')
assert.strictEqual(plan.intersectsCell(triangular.hull, 0, 0, 0.25, 0.25), true)
// Polygon edge normals alone are not a complete rectangle/polygon SAT.
// A coarse cell can cross every edge's half-plane while lying wholly below
// or beside a tiny terrain UV hull. Those cells must never draw the mesh.
const slopingHull = [[0,0],[1,1],[0,1]]
assert.strictEqual(plan.intersectsCell(slopingHull, -5000, -9000, 4000, -700), false,
  'A disjoint coarse cell below the UV hull was retained')
assert.strictEqual(plan.intersectsCell(slopingHull, 2, -10, 3, 10), false,
  'A disjoint coarse cell beside the UV hull was retained')
assert.strictEqual(plan.intersectsCell(slopingHull, -10, -10, 10, 0), false,
  'An edge-only contact was treated as textured area')
assert.strictEqual(plan.intersectsCell(slopingHull, -10, -10, 10, 1e-6), true,
  'A thin positive-area intersection was discarded')
const frontier=require('./reference/imagery_frontier').planImageryFrontier
const descriptor={maximum_level:8,tile_size:256}
const budgetDraws=[0,1].map(column=>({geometryKey:'budget-'+column,
  texture:{level:0,matrix:1,row:0,column}}))
const budgetOptions={targetPixelError:1.25,maximumTextures:128,maximumDraws:1024,
  measureDraw:()=>Object.assign(measure(model,identity),{model})}
const initial=frontier(null,budgetDraws,null,null,{},descriptor,budgetOptions)
const priced=plan.fitImageryPartitionBudget(initial,{maximumPartitionBytes:1e9,targetPixelError:1.25},()=>model)
const fitted=plan.fitImageryPartitionBudget(initial,{
  maximumPartitionBytes:priced.quality.partitionBytes-1,targetPixelError:1.25},()=>model)
assert(fitted.quality.limitedByPartitionBudget && fitted.quality.partitionBytes<priced.quality.partitionBytes)
assert.strictEqual(fitted.quality.targetPixelError,1.25,'Capacity admission must retain the original goal')
assert(fitted.draws.filter(draw=>draw.geometryKey==='budget-1').every(draw=>draw.texture.level===2),
  'Partition capacity coarsened an unrelated region of the view')
// All actual points have W=10; the surrounding empty box crosses W=0.
// A box-only bound invents a near-plane surface and overestimates by 10x.
const oblique=[0.01,0,0,0,0,0.01,0,0,0,0,0,1,-1,0,1,0]
const correlated=plan.prepareSurface(new Float32Array([0,0,10,100,0,110,0,100,10]),
  new Float32Array([0,0,1,0,0,1]),new Uint16Array([0,2,1]),0,3)
const exact=measure(correlated,oblique)
assert(exact.visible && Math.abs(exact.pixelsPerUv-51.2)<1e-8,
  'Empty AABB space must not inflate visible-surface precision or texture demand')
function bounded(model, matrix) {
  let inverse = null
  try { inverse = invertMatrix4(matrix) } catch (error) { /* Intentional singular projection fixture. */ }
  const work = plan.surfaceMeasurements(model, [0,0,0], plan.projectionContext(
    {projectionView:matrix}, {width:1024,height:1024}, inverse), true)
  let result
  do { result = work.next() } while (!result.done)
  return result.value
}
for (const [surface, matrix] of [[model,identity],[huge,identity],[stretched,perspective],[correlated,oblique]]) {
  const fast = bounded(surface,matrix), precise = surface === stretched ? bound : measure(surface,matrix)
  assert(fast.visible && fast.pixelsPerUv >= precise.pixelsPerUv * (1 - 1e-12),
    'Early coverage underestimated visible texel density')
}
assert.strictEqual(bounded(model,hidden).visible,false)
assert.strictEqual(bounded(model,identity).pixelsPerUv,1024)
for (const [surface,matrix] of [[model,identity],[model,hidden],[huge,identity],
  [stretched,perspective],[correlated,oblique]]) {
  const preview=plan.previewSurface(surface,[0,0,0],plan.projectionContext({projectionView:matrix},{width:1024,height:1024}))
  if ((surface===stretched?bound:measure(surface,matrix)).visible) assert(preview.visible, 'Live bounds rejected visible terrain')
  if (preview.visible) assert.strictEqual(preview.pixelsPerUv,Infinity,
    'Visibility preview silently accepted an unmeasured texture error')
}
assert.strictEqual(plan.previewSurface(model,[0,0,0],plan.projectionContext(
  {projectionView:hidden},{width:1024,height:1024})).visible,false)
const unknownBlocks=Object.assign({},model,{blocks:[]})
assert(plan.previewSurface(unknownBlocks,[0,0,0],plan.projectionContext(
  {projectionView:hidden},{width:1024,height:1024})).visible,'Missing bounds must remain conservative')
const metadataOnly={blocks:model.blocks,faces:{length:model.faces.length}}
Object.defineProperty(metadataOnly,'positions',{get(){throw new Error('Preview touched vertex data')}})
assert(plan.previewSurface(metadataOnly,[0,0,0],plan.projectionContext(
  {projectionView:identity},{width:1024,height:1024})).visible)
const densePositions = new Float32Array(3000 * 9), denseUv = new Float32Array(3000 * 6)
for (let i = 0; i < 3000; ++i) {
  densePositions.set([0,0,10,100,0,110,0,100,10], i*9)
  denseUv.set([0,0,1,0,0,1], i*6)
}
const dense = plan.prepareSurface(densePositions, denseUv,
  new Uint16Array(Array.from({length:9000},(_,i)=>i)), 0, 9000)
const denseMeasurement = measure(dense, oblique)
assert(denseMeasurement.regions.length <= 64, 'Thousands of visible faces escaped the ABI region bound')
assert(Math.abs(denseMeasurement.pixelsPerUv - exact.pixelsPerUv) < 1e-8,
  'Region compaction changed the conservative maximum error')
new CooperativeTask(plan.surfaceMeasurements(correlated,[0,0,0],plan.projectionContext(
  {projectionView:oblique},{width:1024,height:1024},invertMatrix4(oblique)))).run().then(async asyncResult=>{
  assert.deepStrictEqual(asyncResult,exact,'Bounded measurement changed the original SSE goal')
  let yields = 0
  const repeatedPositions = new Float32Array(3000 * 9), repeatedUv = new Float32Array(3000 * 6)
  for (let i = 0; i < 3000; ++i) {
    repeatedPositions.set([0,0,0,1,0,0,0,1,0],i*9)
    repeatedUv.set([0,0,1,0,0,1],i*6)
  }
  const big = { positions: repeatedPositions, uv: repeatedUv,
    faces: Array.from({length:9000},(_,i)=>i) }
  const bigCells=[{key:'left',bounds:{minimumU:0,maximumU:0.5,minimumV:0,maximumV:1}}]
  const cancelled = plan.createPartitionTask(big, bigCells)
  assert.strictEqual(cancelled.step().done, false, 'A dense partition did not return to its scheduler')
  cancelled.cancel()
  assert.strictEqual(await cancelled.run(), null, 'Cancelled partition work published a partial or empty cell')
  const first=await plan.createPartitionTask(big,bigCells).run(async()=>{++yields})
  assert(yields>0,'Partition preparation must admit checkpoints between triangle batches')
  const required = first.reduce((n, part) => n + part.positions.byteLength + part.uv.byteLength + part.indices.byteLength, 0)
  assert.deepStrictEqual(await plan.createPartitionTask(big, bigCells, required - 1).run(),
    {limited: true, requiredBytes: required}, 'Partition output exceeded its caller-owned credit')
  assert.deepStrictEqual(await plan.createPartitionTask(big, bigCells, required).run(), first,
    'Exact output credit changed the partition geometry')
  assert.deepStrictEqual(await plan.createPartitionTask(big, bigCells).run(), first,
    'Resuming partition work changed its final topology')
  const before=plan.partitionCacheStats()
  const outputPlan = await plan.createPartitionPlanTask(big,bigCells).run()
  assert.deepStrictEqual(outputPlan, bigCells.map(cell => ({key:cell.key,
    bytes:first.filter(part=>part.cell.key===cell.key).reduce((n,part)=>
      n+part.positions.byteLength+part.uv.byteLength+part.indices.byteLength,0)})),
  'Cost-only planning differs from actual CPU/GPU output')
  const again=await plan.createPartitionTask(big,bigCells).run()
  assert.deepStrictEqual(again,first,'Cached UV topology changed the geometry')
  assert(plan.partitionCacheStats().hits>before.hits,'Repeated partitions did not reuse their topology')
  const heightChanged = Object.assign({}, big, { positions: big.positions.map(v => v + 2),
    uv: big.uv.slice(), faces: big.faces.slice() })
  const beforeHeight = plan.partitionCacheStats()
  const raised = await plan.createPartitionTask(heightChanged,bigCells).run()
  assert(plan.partitionCacheStats().hits>beforeHeight.hits,'New heights rebuilt unchanged UV topology')
  assert.deepStrictEqual(raised[0].uv,first[0].uv)
  assert.deepStrictEqual(raised[0].indices,first[0].indices)
  raised[0].positions.forEach((v,i)=>assert(Math.abs(v-first[0].positions[i]-2)<1e-6))
  assert(plan.partitionCacheStats().bytes<=2*1024*1024,'Derived partition cache exceeded its bound')
  for (let i=1;i<=4;++i) {
    const offset=i/16
    const shifted=Object.assign({},big,{uv:big.uv.map(v=>v+offset)})
    await plan.createPartitionTask(shifted,[{key:'shifted',bounds:{minimumU:offset,
      maximumU:offset+0.5,minimumV:offset,maximumV:offset+1}}]).run()
    const stats=plan.partitionCacheStats()
    assert(stats.bytes>=0 && stats.bytes<=2*1024*1024,'Template eviction broke bounded accounting')
  }
  const asynchronous=await new CooperativeTask(plan.fitPartitionSteps(initial,{
    maximumPartitionBytes:priced.quality.partitionBytes-1,targetPixelError:1.25},()=>model)).run()
  assert.deepStrictEqual(asynchronous,fitted,'Resumable admission changed the accepted cut')
  await require('./source_uv_partition_contract')()
  console.log('Surface projection and partition contracts passed.')
}).catch(error=>{console.error(error);process.exitCode=1})
