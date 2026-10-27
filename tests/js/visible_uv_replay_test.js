const assert=require('assert')
const {clipMeasurement,transitionWitness}=require('../../scripts/analyze_visible_uv')
const {regionError}=require('../../sdk/js/terrain/terra_surface_plan')
const uv={minimumU:0,minimumV:0,maximumU:1,maximumV:1}
const triangle=[[0,0],[1,0],[0,1]]
const projection=[0,100,0,0,0,100,1,0,2]
const measure={visible:true,pixelsPerUv:1000,regions:[{uv,triangle,projection,pixelsPerUv:1000}],hull:triangle}
const before=JSON.stringify(measure)
assert(!clipMeasurement(measure,[]).visible)
assert(!clipMeasurement(measure,[{scale:4,x:3,y:3}]).visible,'BBox clipping admitted a cell outside the actual triangle')
const cell={scale:2,x:0,y:1},clipped=clipMeasurement(measure,[cell])
assert(clipped.visible&&clipped.regions.length)
for(const r of clipped.regions)for(const [u,v] of r.triangle)
  assert(u>=0&&u<=.5&&v>=.5&&v<=1&&u+v<=1)
const area=clipped.regions.reduce((sum,r)=>{
  const [a,b,c]=r.triangle
  return sum+Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2
},0)
assert.strictEqual(area,.125,'Clipped polygon fan lost or duplicated area')
const bound=clipped.regions.reduce((n,r)=>Math.max(n,regionError(r,r.uv)),0)
assert(bound<regionError(measure.regions[0],uv),'Hidden near triangle density survived local clipping')
assert.strictEqual(JSON.stringify(measure),before,'Oracle filtering mutated reusable source measurements')
const scalar={visible:true,pixelsPerUv:200,regions:[{uv,pixelsPerUv:200}]}
const bounded=clipMeasurement(scalar,[cell])
assert.strictEqual(bounded.regions[0].pixelsPerUv,200,'A scalar bound was guessed tighter without a proof')
assert.deepStrictEqual(bounded.regions[0].uv,{minimumU:0,minimumV:.5,maximumU:.5,maximumV:1})
const tile=(level,row,column)=>({level,matrix:level,row,column}),root=tile(0,0,0)
const children=[0,1,2,3].map(i=>tile(1,Math.floor(i/2),i%2))
const old=children.map(cell=>({cell,a:root,b:root}))
const refined=transitionWitness(old,children,[],100)
assert.strictEqual(refined.peakGpuBytes,500,'Parent must coexist with all ready siblings')
assert.strictEqual(refined.finalGpuBytes,400)
assert.deepStrictEqual(refined.steps.map(s=>[s.added,s.retired]),[[4,1]])
const coarsened=transitionWitness(children.map(cell=>({cell,a:cell,b:cell})),[root],[],100)
assert.strictEqual(coarsened.peakGpuBytes,500)
assert.strictEqual(coarsened.finalGpuBytes,100)
assert.deepStrictEqual(coarsened.steps.map(s=>[s.added,s.retired]),[[1,4]])
const shared=transitionWitness(old,[...children,...children],[root],100)
assert.strictEqual(shared.peakGpuBytes,500,'Physical images were charged twice')
assert.strictEqual(shared.finalGpuBytes,500,'Root coverage was released')
console.log('Visible UV triangle/domain preservation and image-only transition ownership passed')
