const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = async function () {
  const model = surface.prepareSurface(new Float32Array([0,0,0,1,0,1,0,1,2,1,1,3]),
    new Float32Array([0,0,1,0,0,1,1,1]), new Uint16Array([1,0,3,2]), 0, 4)
  const cells = Array.from({length:64}, (_,i) => ({key:String(i),sourceUv:true,bounds:{
    minimumU:(i%8)/8,maximumU:(i%8+1)/8,minimumV:(i>>3)/8,maximumV:((i>>3)+1)/8}}))
  const run = task => task.run()
  const parts = await run(surface.createPartitionTask(model,cells))
  const bytes = parts.reduce((n,p) => n+p.indices.byteLength,0)
  assert(parts.every(p=>!p.positions.length && !p.uv.length && p.indices.length),
    'Source-UV output copied vertex data')
  const faces = new Set(Array.from({length:model.faces.length/3}, (_,i)=>model.faces.slice(i*3,i*3+3).join('/')))
  for (const p of parts) for (let i=0;i<p.indices.length;i+=3)
    assert(faces.has(Array.from(p.indices.slice(i,i+3)).join('/')), 'Partition changed a source face or winding')
  const prices = parts.map(p=>({key:p.cell.key,bytes:p.indices.byteLength}))
  assert.deepStrictEqual(await run(surface.createPartitionPlanTask(model,cells)),prices)
  assert.deepStrictEqual(await run(surface.createUvPartitionPlanTask(model.uv,model.faces,cells)),prices)
  assert.deepStrictEqual(await run(surface.createPartitionTask(model,cells,bytes-1)),{limited:true,requiredBytes:bytes})
  const changed = {...model,positions:null}
  assert.deepStrictEqual(await run(surface.createPartitionTask(changed,cells,bytes)),parts,
    'Index production depended on terrain heights')
  const clipped = await run(surface.createPartitionTask(model,cells.map(c=>({...c,sourceUv:false}))))
  const clippedBytes = clipped.reduce((n,p)=>n+p.indices.byteLength+p.uv.byteLength+p.positions.byteLength,0)
  assert(clipped.some(p=>p.positions.length) && clippedBytes>bytes,
    'Low-precision platform reused incompatible cached source topology')
  assert.deepStrictEqual(await run(surface.createPartitionTask(model,cells)),parts)
  console.log('Source UV index contract:',{bytes,clippedBytes})
}
