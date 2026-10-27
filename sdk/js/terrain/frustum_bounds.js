// A plane's maximum over an axis-aligned box occurs at its support corner.
// Evaluate in world space without allocating/projecting eight corners. The
// scale-aware margin keeps cancellation at globe coordinates conservative.
function outsideFrustumBox(minimum, maximum, origin, planes) {
  if (!planes) return false
  for (const plane of planes) {
    let bound = plane[3], magnitude = Math.abs(bound) + 1
    for (let axis = 0; axis < 3; ++axis) {
      const value = plane[axis] * ((plane[axis] >= 0 ? maximum[axis] : minimum[axis]) + origin[axis])
      bound += value; magnitude += Math.abs(value)
    }
    if (Number.isFinite(bound) && bound < -magnitude * 1e-12) return true
  }
  return false
}

module.exports = {outsideFrustumBox}
