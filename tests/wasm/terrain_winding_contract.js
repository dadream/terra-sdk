const partitionSurface = require('../js/reference/partition_surface')
const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

// Exercise actual ABI payload and both kinds of clipped output. Comparing the
// outward radial/up direction catches root, fragment and strip-parity changes;
// merely checking that JS copied the input winding would not establish CW.
module.exports = function terrainWinding(abi, globe) {
  const indices = abi.getIndices(), seen = new Set()
  const context=surface.projectionContext(abi.getFrame(),{width:1280,height:720},null)
  let triangles = 0, clipped = 0, indexed = 0
  const check = (positions, faces, origin) => {
    const count = faces ? faces.length : positions.length / 3
    for (let f = 0; f < count; f += 3) {
      const a = (faces ? faces[f] : f) * 3
      const b = (faces ? faces[f+1] : f+1) * 3
      const c = (faces ? faces[f+2] : f+2) * 3
      const u = [0,1,2].map(i => positions[b+i]-positions[a+i])
      const v = [0,1,2].map(i => positions[c+i]-positions[a+i])
      const n = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
      const up = globe ? [0,1,2].map(i => positions[a+i]+origin[i]) : [0,0,1]
      const product = Math.hypot(...n)*Math.hypot(...up)
      if (!product) continue // Collapsed polar vertices have no facing.
      assert(n.reduce((sum,x,i) => sum+x*up[i],0) <= product*1e-6,
        'CBDAM exterior/partition triangle lost clockwise winding')
      ++triangles
    }
  }
  for (const draw of abi.getMeshResources()) {
    if (seen.has(draw.resourceId)) continue
    seen.add(draw.resourceId)
    const mesh = abi.copyMeshResource(draw)
    const model = surface.prepareSurface(mesh.positions,mesh.textureUv,indices,draw.firstIndex,draw.indexCount)
    require('../js/reference/surface_facing_contract').verify(model,draw.origin,context,
      require('../../sdk/js/terrain/surface_facing'))
    check(mesh.positions,model.faces,draw.origin)
    const b = model.bounds, width=b.maximumU-b.minimumU, height=b.maximumV-b.minimumV
    const cells=[{key:'winding',bounds:{minimumU:b.minimumU+width*.173,maximumU:b.minimumU+width*.781,
      minimumV:b.minimumV+height*.219,maximumV:b.minimumV+height*.873}}]
    for (const part of partitionSurface(model,cells)) {
      check(mesh.positions,part.indices,draw.origin)
      check(part.positions,null,draw.origin)
      clipped+=part.positions.length;indexed+=part.indices.length
    }
  }
  assert(seen.size && triangles && clipped && indexed,
    'Winding contract did not exercise base, indexed and clipped terrain')
}
