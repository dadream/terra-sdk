const {PLANES} = require('../math/projection')

// Produce only clip coordinates and UVs. Rejected triangles need no copied
// positions, derivative vectors, or intermediate mapped/concatenated arrays.
function projectVertex(positions, uv, index, origin, matrix) {
  const j = index * 3, k = index * 2
  const x = positions[j] + origin[0], y = positions[j+1] + origin[1], z = positions[j+2] + origin[2]
  return [matrix[0]*x+matrix[1]*y+matrix[2]*z+matrix[3],
    matrix[4]*x+matrix[5]*y+matrix[6]*z+matrix[7],
    matrix[8]*x+matrix[9]*y+matrix[10]*z+matrix[11],
    matrix[12]*x+matrix[13]*y+matrix[14]*z+matrix[15], uv[k], uv[k+1]]
}

function projectTriangle(positions, uv, faces, first, origin, matrix) {
  return [projectVertex(positions, uv, faces[first], origin, matrix),
    projectVertex(positions, uv, faces[first+1], origin, matrix),
    projectVertex(positions, uv, faces[first+2], origin, matrix)]
}

// Clip only intersected planes. Fully accepted planes preserve the polygon;
// crossing edges keep the same homogeneous interpolation (including UVs).
// All buffers are call-local; nothing survives a measurement's cooperative yield.
function clipTriangle(polygon) {
  for (const plane of PLANES) {
    let inside = false, outside = false
    for (const point of polygon) {
      if (plane(point) >= 0) inside = true
      else outside = true
    }
    if (!inside) return []
    if (!outside) continue
    const clipped = []
    for (let i=0; i<polygon.length; ++i) {
      const a=polygon[i], b=polygon[(i+1)%polygon.length], da=plane(a), db=plane(b)
      if (da>=0) clipped.push(a)
      if ((da<0)!==(db<0)) {
        const t=da/(da-db)
        clipped.push(a.map((value,axis)=>value+(b[axis]-value)*t))
      }
    }
    polygon=clipped
  }
  return polygon
}

module.exports = {projectTriangle, clipTriangle}
