const assert = require('assert')
const {ImageryAdapter, createTmsImagerySource, createWmtsImagerySource} = require('../../sdk/js/imagery/terra_imagery_adapter')
const {regionError} = require('../../sdk/js/terrain/terra_surface_plan')
const descriptor = {id:'test', kind:'global-geodetic', tile_size:256,
  level_zero_columns:2, level_zero_rows:1, minimum_level:0, maximum_level:17,
  matrix_level_offset:1, origin:'top-left', bounds:[[-180,-90],[180,90]]}
const adapter = new ImageryAdapter(descriptor), resources = new Set()
for(let row=0;row<2;++row) for(let column=0;column<4;++column) {
  const node={level:0,root:row*4+column,row,column}
  const native=adapter.bind(node)
  assert.deepStrictEqual(native.resource,{level:1,matrix:2,row,column})
  assert.strictEqual(native.effectivePixels,256)
  const coarse=adapter.bind(node,0)
  resources.add(JSON.stringify(coarse.resource))
  assert.strictEqual(coarse.effectivePixels,128)
  assert.deepStrictEqual(coarse.uvOffset,[column%2/2,row/2])
}
assert.strictEqual(resources.size,2)
assert.strictEqual(adapter.maximumDepth,16)
const original=adapter.samplingTile({level:8,row:100,column:300})
assert.deepStrictEqual(adapter.nodesForResource(original)[0],{level:8,root:1,row:100,column:300})
const tms=createTmsImagerySource({id:'tms',url:'https://example.invalid/{z}/{x}/{y}.jpg',
  texture:Object.assign({},descriptor,{origin:'bottom-left'})})
const tmsAdapter=new ImageryAdapter(tms.texture)
assert.strictEqual(tms.resolveTile(tmsAdapter.requestTile({level:1,row:0,column:3})), 'https://example.invalid/2/3/1.jpg')
const wmts=createWmtsImagerySource({id:'wmts',url:'https://example.invalid/wmts',layer:'satellite',matrixSet:'geo',
  texture:Object.assign({},descriptor,{matrix_ids:['coarse','world-eight']})})
const url=wmts.resolveTile(new ImageryAdapter(wmts.texture).requestTile({level:1,row:1,column:2}))
assert(url.includes('TILEMATRIX=world-eight') && url.includes('TILEROW=1') && url.includes('TILECOL=2'))
assert.throws(()=>new ImageryAdapter({...descriptor,level_zero_columns:1}),/align/)
assert.throws(()=>new ImageryAdapter({...descriptor,bounds:[[-180,-80],[180,80]]}),/world/)
const region={projection:[-500,1000,0,-500,0,0,1,0,1000],triangle:[[0,0],[1,0],[1,1]],pixelsPerUv:600000}
const far=regionError(region,{minimumU:0.5,maximumU:0.5078125,minimumV:0.09375,maximumV:0.1015625})
assert(far>50 && far<80)
assert(regionError(region,{minimumU:0.5,maximumU:0.501,minimumV:0,maximumV:0.001})>100000)
// Keep numerator and depth correlated even inside one triangle. The distant
// vertex has a large numerator, but its projected texel density is small.
const narrow={projection:[0,1,0,0,0,1,1,0,99],
  triangle:[[0,0],[0.001,0],[0,1]],pixelsPerUv:100}
const unit={minimumU:0,maximumU:1,minimumV:0,maximumV:1}
assert(regionError(narrow,unit)<1.06)
assert.strictEqual(regionError(narrow,{minimumU:0.001,maximumU:1,minimumV:0,maximumV:1}),0,
  'A shared edge must not create texture demand outside the visible triangle')
const skewed={projection:[5.066,6.677,-6.708,-5.951,-8.324,9.883,0.183,28.443,8.974],
  triangle:[[0.02,0.6],[0.7,0.1],[0.3,0.15]]}
// Independently differentiate the projected coordinates and sample directions
// throughout both triangles. The analytic bound must cover all measurements.
for(const sample of [narrow,skewed]) {
  const limit=regionError(sample,unit),c=sample.projection
  const project=(u,v)=>[(c[0]+c[1]*u+c[2]*v)/(c[6]+c[7]*u+c[8]*v),
    (c[3]+c[4]*u+c[5]*v)/(c[6]+c[7]*u+c[8]*v)]
  for(let i=0;i<=32;i++) for(let j=0;j<=32-i;j++) {
    const weights=[i/32,j/32,1-(i+j)/32]
    const p=[0,1].map(axis=>weights.reduce((sum,w,k)=>sum+w*sample.triangle[k][axis],0))
    for(let direction=0;direction<24;direction++) {
      const angle=direction*Math.PI/12,du=Math.cos(angle)*1e-7,dv=Math.sin(angle)*1e-7
      const a=project(p[0]-du,p[1]-dv),b=project(p[0]+du,p[1]+dv)
      assert(Math.hypot(b[0]-a[0],b[1]-a[1])/2e-7<=limit*(1+1e-7),
        'The local error bound underestimated a projected derivative')
    }
  }
}
console.log('Imagery adapter, coarse resource sharing and local projective error passed')
