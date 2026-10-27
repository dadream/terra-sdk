const {relativeProjectionView} = require('../core/terra_globe_common')

// Recover the clipping interval from the existing rigid perspective snapshot.
// Keep the double matrix: Float32 rounds the far/near coefficient to one in
// exactly the near-ground views which need more depth precision.
function depthEncoding(frame, supported) {
  const m = relativeProjectionView(frame.projectionView, frame.cameraPosition)
  const norm = m[12] * m[12] + m[13] * m[13] + m[14] * m[14]
  const a = (m[8] * m[12] + m[9] * m[13] + m[10] * m[14]) / norm
  const b = m[11] - a * m[15]
  const near = -b / (a + 1), far = -b / (a - 1)
  const perspective = Math.abs(norm - 1) < 1e-8 && a > 1 && near > 0 && far > near && Number.isFinite(far)
  const requested = perspective && far / near > 32768
  return {mode: requested && supported ? 'logarithmic' : 'perspective', supported: Boolean(supported),
    nearMeters: perspective ? near : null, farMeters: perspective ? far : null,
    factor: requested && supported ? Math.fround(1 / Math.log2(1 + far)) : 0,
    limitedReason: requested && !supported ? 'fragment-depth-unavailable' : null}
}

module.exports = {depthEncoding}
