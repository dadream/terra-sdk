const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {invertMatrix4} = require('../../sdk/js/math/matrix')
const {refineMeasurements} = require('./reference/measurement_refinement')
const {splitSurfaceBlock} = require('../../sdk/js/terrain/surface_blocks')

module.exports = function (refine = refineMeasurements) {
  const positions=[],uv=[],indices=[],size=48
  for(let y=0;y<size;++y) for(let x=0;x<size;++x) {
    for(const corners of [[[0,0],[0,1],[1,0]],[[1,0],[0,1],[1,1]]]) {
      const first=positions.length/3
      for(const [dx,dy] of corners) {
        const u=(x+dx)/size,v=(y+dy)/size
        positions.push(2*u-1,2*v-1,0);uv.push(u,v)
      }
      if(indices.length)indices.push(indices[indices.length-1],first)
      if(indices.length%2)indices.push(first)
      indices.push(first,first+1,first+2)
    }
  }
  const p=new Float32Array(positions),t=new Float32Array(uv),ii=new Uint16Array(indices)
  const model=surface.prepareSurface(p,t,ii,0,ii.length)
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0.8,0,0,1]
  const context=surface.projectionContext({projectionView:matrix},{width:640,height:360},invertMatrix4(matrix))
  const roots=model.blocks,original=JSON.stringify(roots)
  const memory=new WebAssembly.Memory({initial:Math.ceil((p.byteLength+t.byteLength)/65536)})
  new Float32Array(memory.buffer,0,p.length).set(p)
  new Float32Array(memory.buffer,p.byteLength,t.length).set(t)
  let positionReads=0,uvReads=0
  Object.defineProperties(model,{
    positions:{get:()=>{++positionReads;return new Float32Array(memory.buffer,0,p.length)}},
    uv:{get:()=>{++uvReads;return new Float32Array(memory.buffer,p.byteLength,t.length)}}
  })
  const parent=roots.find(block=>block.faces.length>64),split=splitSurfaceBlock(model,parent)
  let childStep,splitSteps=0
  do {
    childStep=split.next();++splitSteps
    if(!childStep.done)memory.grow(1)
  } while(!childStep.done)
  assert(splitSteps>1 && childStep.value && childStep.value.length<=4)
  assert.deepStrictEqual(childStep.value.flatMap(child=>child.faces).sort((a,b)=>a-b),
    parent.faces.slice().sort((a,b)=>a-b),'Subdivision lost or duplicated a terrain face')
  const drain=(work,grow=false,checkViews=false)=>{let result,steps=0;do{
    const beforePositions=positionReads,beforeUv=uvReads
    result=work.next();++steps
    if(checkViews) {
      // One acquisition per batch, plus an optional acceleration-tree build.
      // Cross-Wasm view validation must not scale with the triangle count.
      assert(positionReads-beforePositions<=2 && uvReads-beforeUv<=1,
        'A projection slice repeatedly reacquired its native vertex views')
    }
    if(grow && !result.done && (checkViews || steps%16===0))memory.grow(1)
  }while(!result.done);return result.value}
  const measured=drain(surface.surfaceMeasurements(model,[0,0,0],context),true,true)
  const precise=drain(surface.surfaceMeasurements(model,[0,0,0],context,false,true),true,true)
  assert(precise.regions.length<model.faces.length/12,'Difficult blocks still exported most triangles individually')
  assert(measured.refinable && !precise.refinable)
  assert.strictEqual(model.blocks,roots)
  assert.strictEqual(JSON.stringify(roots),original,'A camera measurement mutated persistent mesh summaries')
  const published=JSON.stringify(measured),projected=measured.regions.filter(region=>region.projection)
  const loose=measured.regions.filter(region=>!region.projection)
  assert(projected.length && loose.some(region=>!roots.some(block=>block.uv===region.uv)),
    'Refinement fixture omitted transient domains with already exact regions')
  const refined=drain(refine(model,[0,0,0],context,measured),true)
  assert.deepStrictEqual(refined.regions,precise.regions,
    'Hierarchical summaries prevented final precision refinement')
  assert(projected.every(region=>refined.regions.includes(region)),
    'Transient domains forced recomputation of already exact projection regions')
  assert.strictEqual(JSON.stringify(measured),published,'Refinement mutated published measurements')
  const foreign={...measured,regions:measured.regions.map(region=>({...region,uv:{...region.uv}}))}
  assert.deepStrictEqual(drain(refine(model,[0,0,0],context,foreign),true).regions,precise.regions,
    'Uncertified transient regions omitted an unknown measurement domain')
  const error=(result,u,v)=>{
    const cell={minimumU:u-1e-9,maximumU:u+1e-9,minimumV:v-1e-9,maximumV:v+1e-9}
    return result.regions.reduce((n,r)=>r.uv.minimumU<=cell.maximumU && r.uv.maximumU>=cell.minimumU &&
      r.uv.minimumV<=cell.maximumV && r.uv.maximumV>=cell.minimumV ? Math.max(n,surface.regionError(r,cell)):n,0)
  }
  let samples=0
  for(let y=0;y<25;++y)for(let x=0;x<25;++x) {
    const u=(x+0.37)/25,v=(y+0.29)/25,X=2*u-1,Y=2*v-1,W=1+0.8*X
    if(Math.abs(X)>W || Math.abs(Y)>W)continue
    // Independent analytic screen derivative of X/W, Y/W. Sample directions
    // rather than sharing the implementation's spectral-norm calculation.
    let actual=0
    for(let i=0;i<64;++i) {
      const a=Math.cos(i*Math.PI/32),b=Math.sin(i*Math.PI/32)
      actual=Math.max(actual,Math.hypot(640*a/(W*W),-288*Y*a/(W*W)+360*b/W))
    }
    for(const result of [measured,precise]) assert(error(result,u,v)>=actual*(1-1e-6),
      'Hierarchical error underestimated a visible surface derivative')
    ++samples
  }
  assert(samples>200)
  // Cancellation must leave reusable, camera-independent roots unchanged.
  const cancelled=surface.surfaceMeasurements(model,[0,0,0],context)
  for(let i=0;i<8;++i)cancelled.next()
  cancelled.return()
  const cancelledRefinement=refine(model,[0,0,0],context,measured)
  for(let i=0;i<3;++i)cancelledRefinement.next()
  cancelledRefinement.return()
  assert.strictEqual(JSON.stringify(roots),original)
  console.log('Hierarchical projection domains, conservative density, refinement and Wasm growth passed')
}

if(require.main===module) module.exports()
