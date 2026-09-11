const assert = require('assert')
const plan = require('../../apps/miniprogram/utils/terra_surface_plan')
const { invertMatrix4 } = require('../../apps/miniprogram/utils/terra_webgl_renderer')
const positions = new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0])
const uv = new Float32Array([0,0,1,0,0,1,1,1])
const indices = new Uint16Array([0,1,2,3])
const model = plan.prepareSurface(positions, uv, indices, 0, 4)
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
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
const perspective = [1,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0]
const stretched=plan.prepareSurface(new Float32Array([
  -1,-1,1,100,-100,100,-1,1,1,100,100,100]),uv,indices,0,4)
const bound=plan.measureSurface(stretched,[0,0,0],plan.projectionContext(
  {projectionView:perspective},{width:1024,height:1024},null))
assert(bound.visible && bound.pixelsPerUv/256>91,
  'Extreme perspective must not be reported as one pixel per texel')
const cells=[]
for(let y=0;y<4;y++) for(let x=0;x<4;x++) cells.push({key:x+'/'+y,
  bounds:{minimumU:x/4,maximumU:(x+1)/4,minimumV:y/4,maximumV:(y+1)/4}})
const parts=plan.partitionSurface(model,cells)
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
const whole=plan.partitionSurface(model,[{key:'whole',
  bounds:{minimumU:0,maximumU:1,minimumV:0,maximumV:1}}])[0]
assert.strictEqual(whole.positions.length,0,'Interior triangles must reuse existing vertices')
assert.strictEqual(whole.indices.length,6)
const triangular = plan.prepareSurface(positions, uv, indices, 0, 3)
assert.strictEqual(plan.intersectsCell(triangular.hull, 0.75, 0.75, 1, 1), false,
  'Empty cells outside a triangular patch must not consume texture budget')
assert.strictEqual(plan.intersectsCell(triangular.hull, 0, 0, 0.25, 0.25), true)
console.log('Surface projection and partition contracts passed.')
