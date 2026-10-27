const {spectral2} = require('../math/projection')

// Exact per-triangle derivatives with a conservative minimum-depth bound.
// The caller owns one scratch result per measurement iterator. No vertex view,
// per-face derivative arrays or camera-dependent geometry survives this call.
function triangleDensity(positions, faces, first, clip, polygon, context, result) {
  const p = faces[first] * 3, q = faces[first + 1] * 3, r = faces[first + 2] * 3
  const u1 = clip[1][4] - clip[0][4], v1 = clip[1][5] - clip[0][5]
  const u2 = clip[2][4] - clip[0][4], v2 = clip[2][5] - clip[0][5]
  const det = u1 * v2 - u2 * v1
  if (!(Math.abs(det) >= 1e-16)) return false
  const ax = positions[q] - positions[p], ay = positions[q+1] - positions[p+1], az = positions[q+2] - positions[p+2]
  const bx = positions[r] - positions[p], by = positions[r+1] - positions[p+1], bz = positions[r+2] - positions[p+2]
  const ux = (ax*v2-bx*v1)/det, uy = (ay*v2-by*v1)/det, uz = (az*v2-bz*v1)/det
  const vx = (bx*u1-ax*u2)/det, vy = (by*u1-ay*u2)/det, vz = (bz*u1-az*u2)/det
  const m = context.matrix, sx = context.sx, sy = context.sy, uv = result.uv
  uv.minimumU = uv.minimumV = Infinity
  uv.maximumU = uv.maximumV = -Infinity
  result.pixelsPerUv = 0
  result.centerDistance = Infinity
  let depth = Infinity
  for (const point of polygon) depth = Math.min(depth, point[3])
  for (const point of polygon) {
    uv.minimumU = Math.min(uv.minimumU, point[4]); uv.maximumU = Math.max(uv.maximumU, point[4])
    uv.minimumV = Math.min(uv.minimumV, point[5]); uv.maximumV = Math.max(uv.maximumV, point[5])
    const nx = point[0]/point[3], ny = point[1]/point[3]
    result.centerDistance = Math.min(result.centerDistance, Math.hypot(nx, ny))
    const xx = sx*(m[0]-nx*m[12]), xy = sx*(m[1]-nx*m[13]), xz = sx*(m[2]-nx*m[14])
    const yx = sy*(m[4]-ny*m[12]), yy = sy*(m[5]-ny*m[13]), yz = sy*(m[6]-ny*m[14])
    result.pixelsPerUv = Math.max(result.pixelsPerUv, depth > 1e-9
      ? spectral2(xx*ux+xy*uy+xz*uz, xx*vx+xy*vy+xz*vz,
        yx*ux+yy*uy+yz*uz, yx*vx+yy*vy+yz*vz)/depth : Infinity)
  }
  return true
}

module.exports = {triangleDensity}
