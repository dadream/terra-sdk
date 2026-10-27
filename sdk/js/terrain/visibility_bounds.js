const {relativeProjectionView, rowMajorToWebGlMatrix} = require('../core/terra_globe_common')

// A nearer screen rectangle contains every sample of a projected AABB. Querying
// the original triangles is not conservative: clipped/rounded UV partitions can
// win their own depth test against a separately transformed original triangle.
// Null means unknown, including eye/near-plane intersections and incomplete
// bounds. This data is frame-local, never part of the projection history cache.
function visibilityBounds(model, draw, frame, viewport, depth) {
  if (!(viewport.width > 0 && viewport.height > 0) ||
      !model || !model.faces || !model.blocks || !model.blocks.length || model.blocks.length > 16 ||
      model.blocks.reduce((n, b) => n + (b.faces ? b.faces.length * 3 : 0), 0) !== model.faces.length) return null
  const matrix = rowMajorToWebGlMatrix(relativeProjectionView(frame.projectionView, frame.cameraPosition))
  const origin = draw.origin.map((v, i) => Math.fround(v - frame.cameraPosition[i]))
  const rectangles = []
  for (const block of model.blocks) {
    let nearestW = Infinity
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity]
    // The shader adds two Float32 operands before multiplying by the matrix.
    // Bound that addition by its result's magnitude, not by the world-sized
    // operands which may cancel. Then bound every matrix product/sum order
    // (including fused operations). Eight relative rounding allowances exceed
    // the four-term dot product's error; the addition has its own allowance.
    // GLSL ES 3.00 sections 4.5.1, 5.9-5.11 define these operations. XY also
    // expands by a physical pixel to cover raster-edge rounding.
    const relativeMagnitude = [0, 1, 2].map(axis => Math.max(
      Math.abs(origin[axis] + block.minimum[axis]), Math.abs(origin[axis] + block.maximum[axis])))
    const error = [0, 1, 2, 3].map(row => {
      let magnitude = Math.abs(matrix[12 + row]) + 1
      for (let axis = 0; axis < 3; ++axis) magnitude += Math.abs(matrix[axis * 4 + row]) * relativeMagnitude[axis]
      return magnitude * 9 * Math.pow(2, -23)
    })
    for (let corner = 0; corner < 8; ++corner) {
      const p = origin.map((v, axis) => v + (corner & (1 << axis) ? block.maximum[axis] : block.minimum[axis]))
      const clip = [0, 1, 2, 3].map(row => matrix[12 + row] +
        matrix[row] * p[0] + matrix[4 + row] * p[1] + matrix[8 + row] * p[2])
      const loW = clip[3] - error[3], hiW = clip[3] + error[3]
      if (!(loW > 0) || clip[2] + clip[3] <= error[2] + error[3]) return null
      nearestW = Math.min(nearestW, loW)
      for (let axis = 0; axis < 3; ++axis) {
        const lo = clip[axis] - error[axis], hi = clip[axis] + error[axis]
        minimum[axis] = Math.min(minimum[axis], lo / loW, lo / hiW)
        maximum[axis] = Math.max(maximum[axis], hi / loW, hi / hiW)
      }
    }
    if (![...minimum, ...maximum].every(Number.isFinite)) return null
    const dx = 2 / viewport.width, dy = 2 / viewport.height
    const rectangle = [Math.max(-1, minimum[0] - dx), Math.max(-1, minimum[1] - dy),
      Math.min(1, maximum[0] + dx), Math.min(1, maximum[1] + dy), Math.max(-1, minimum[2] - 1e-5)]
    // Same monotone fragment encoding as the display. Bias toward the eye to
    // cover highp log/reciprocal and depth-buffer rounding. Never compare the
    // original perspective Z against a logarithmic display attachment.
    if (depth && depth.factor) rectangle[4] = Math.max(-1,
      2 * Math.log2(1 + nearestW) * depth.factor - 1 - 1e-5)
    if (rectangle[0] <= rectangle[2] && rectangle[1] <= rectangle[3] && minimum[2] <= 1) rectangles.push(rectangle)
  }
  return rectangles
}

module.exports = {visibilityBounds}
