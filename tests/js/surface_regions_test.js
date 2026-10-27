const assert = require('assert')
const {compactRegions} = require('../../sdk/js/terrain/surface_regions')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {invertMatrix4} = require('../../sdk/js/math/matrix')

module.exports = function () {
  const input=[],size=12
  for(let y=0;y<size;++y) for(let x=0;x<size;++x) {
    if(x>=4 && x<8 && y>=4 && y<8) continue
    const density=x<6?256:1024
    for(const offsets of [[[0,0],[1,0],[0,1]],[[1,0],[1,1],[0,1]]]) {
      const triangle=offsets.map(([u,v])=>[(x+u)/size,(y+v)/size])
      input.push({triangle,pixelsPerUv:density,projection:[0,density,0,0,0,density,1,0,0],
        uv:{minimumU:x/size,maximumU:(x+1)/size,minimumV:y/size,maximumV:(y+1)/size}})
    }
  }
  // Duplicate coordinates and reversed triangle order must not count twice
  // toward the area proof or make a convex hull cover the central hole.
  input.push(...input.map(r=>({...r,triangle:r.triangle.slice().reverse().map(p=>p.slice())})))
  const original=JSON.stringify(input),work=compactRegions(input)
  let next,steps=0
  do{next=work.next();++steps}while(!next.done)
  assert(steps>2,'Region compaction lost cooperative checkpoints')
  assert.strictEqual(JSON.stringify(input),original)
  for(let y=0;y<size;++y) for(let x=0;x<size;++x) {
    const u=(x+0.23)/size,v=(y+0.37)/size
    const cell={minimumU:u,maximumU:u+1e-6,minimumV:v,maximumV:v+1e-6}
    const error=next.value.reduce((n,r)=>Math.max(n,surface.regionError(r,cell)),0)
    if(x>=4 && x<8 && y>=4 && y<8) assert.strictEqual(error,0,'Region hull filled an invisible hole')
    else assert(Math.abs(error-(x<6?256:1024))<1e-8,'Compaction changed local density')
  }

  const f=require('./reference/measurement_fixture')()
  const model=surface.prepareSurface(f.positions,f.uv,f.indices,0,f.indices.length)
  const memory=new WebAssembly.Memory({initial:1})
  new Float32Array(memory.buffer,0,f.positions.length).set(f.positions)
  let reads=0
  Object.defineProperty(model,'positions',{get(){++reads;return new Float32Array(memory.buffer,0,f.positions.length)}})
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0.8,0,0,1]
  const context=surface.projectionContext({projectionView:matrix},{width:400,height:400},invertMatrix4(matrix))
  const plain=surface.prepareSurface(f.positions,f.uv,f.indices,0,f.indices.length)
  const expected=surface.measureSurface(plain,[0,0,0],context,true)
  const measurement=surface.surfaceMeasurements(model,[0,0,0],context,false,true)
  do{next=measurement.next();if(!next.done)memory.grow(1)}while(!next.done)
  assert.deepStrictEqual(next.value,expected,'Growing Wasm invalidated a measured surface')
  assert(reads<model.faces.length,'Visibility hierarchy repeatedly reacquired borrowed position views')
  console.log('Region holes, duplicate coordinates, local density and bounded Wasm view borrowing passed')
}

if(require.main===module) module.exports()
