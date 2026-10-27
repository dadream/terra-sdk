const {relativeProjectionView, rowMajorToWebGlMatrix} = require('../core/terra_globe_common')

function clip(points, distance) {
  const result = []
  for (let i = 0; i < points.length; ++i) {
    const a = points[i], b = points[(i + 1) % points.length]
    const da = distance(a), db = distance(b)
    if (da >= 0) result.push(a)
    if ((da < 0) !== (db < 0)) {
      const t = da / (da - db)
      result.push(a.map((v, j) => v + (b[j] - v) * t))
    }
  }
  return result
}

// Prove that a removed UV cell contains no physical viewport samples. Unlike
// an AABB, a triangle can be rejected across several frustum planes, including
// the near plane. Unknown input or a surviving polygon cannot authorize reuse.
// The caller owns the immutable model and schedules/cancels this generator.
function* offscreenCell(model, draw, frame, viewport, cell) {
  if (!cell || !Number.isInteger(Math.log2(cell.scale)) || cell.scale < 1 || cell.scale > 2 ** 30 ||
      !Number.isInteger(cell.x) || !Number.isInteger(cell.y) || cell.x < 0 || cell.y < 0 ||
      cell.x >= cell.scale || cell.y >= cell.scale || ![viewport.width, viewport.height].every(v => Number.isFinite(v) && v > 0) ||
      !model || !model.faces || !model.faces.length || model.faces.length % 3 || !model.positions || !model.uv) return false
  const matrix = rowMajorToWebGlMatrix(relativeProjectionView(frame.projectionView, frame.cameraPosition))
  const origin = draw.origin.map((v, i) => Math.fround(v - frame.cameraPosition[i]))
  if (![...matrix, ...origin].every(Number.isFinite)) return false
  const epsilon = 2 ** -23
  const lo = [cell.x / cell.scale, cell.y / cell.scale], hi = [(cell.x + 1) / cell.scale, (cell.y + 1) / cell.scale]
  for (let f = 0; f < model.faces.length; f += 3) {
    if (f && f % 192 === 0) yield
    let polygon = []
    for (let j = 0; j < 3; ++j) {
      const id = model.faces[f + j]
      if (!Number.isInteger(id) || id < 0 || id * 3 + 2 >= model.positions.length || id * 2 + 1 >= model.uv.length) return false
      polygon.push([model.uv[id * 2], model.uv[id * 2 + 1],
        model.positions[id * 3], model.positions[id * 3 + 1], model.positions[id * 3 + 2]])
    }
    if (polygon.some(p => p.some(v => !Number.isFinite(v)))) return false
    const uvError = Math.max(1, ...polygon.flatMap(p => p.slice(0, 2).map(Math.abs))) * 64 * epsilon
    if ([0, 1].some(axis => lo[axis] > 0 && polygon.every(p => p[axis] < lo[axis] - uvError) ||
        hi[axis] < 1 && polygon.every(p => p[axis] > hi[axis] + uvError))) continue
    // Bound the original vertex operations before clipping. Large operands can
    // cancel at a clipped point; deriving error only from that point is unsafe.
    const magnitude = [0, 1, 2].map(axis => Math.max(...polygon.map(p => Math.abs(p[axis + 2] + origin[axis]))))
    const storage = [0, 1, 2].map(axis => Math.max(1, ...polygon.map(p => Math.abs(p[axis + 2]))) * 4 * epsilon)
    const error = [0, 1, 2, 3].map(row => {
      let value = (Math.abs(matrix[12 + row]) + 1) * 9 * epsilon
      for (let axis = 0; axis < 3; ++axis) value += Math.abs(matrix[axis * 4 + row]) *
        (magnitude[axis] * 9 * epsilon + storage[axis])
      return value
    })
    // Match source-UV clipping: outer mesh edges are not fragment cut planes.
    for (let axis = 0; axis < 2; ++axis) {
      if (lo[axis] > 0) polygon = clip(polygon, p => p[axis] - lo[axis] + uvError)
      if (hi[axis] < 1) polygon = clip(polygon, p => hi[axis] - p[axis] + uvError)
    }
    polygon = polygon.map(p => [0, 1, 2, 3].map(row => matrix[12 + row] +
      matrix[row] * (p[2] + origin[0]) + matrix[4 + row] * (p[3] + origin[1]) + matrix[8 + row] * (p[4] + origin[2])))
    if (polygon.some(p => p.some(v => !Number.isFinite(v)))) return false
    const w = Math.max(0, ...polygon.map(p => Math.abs(p[3]))) + error[3]
    // Intersect the nominal polygon with an expanded frustum. Every rounded
    // shader sample lies inside these planes, including a physical pixel rim.
    for (let axis = 0; axis < 3 && polygon.length; ++axis) {
      const margin = error[axis] + error[3] + (axis < 2 ? 2 * w / (axis ? viewport.height : viewport.width) : 0)
      for (const sign of [-1, 1]) polygon = clip(polygon, p => p[3] + sign * p[axis] + margin)
    }
    if (polygon.length) return false
  }
  return true
}

// One publication depends on all removed cells. Accumulate the certificate in
// the suspended job, so an LRU entry per cell cannot starve a large footprint.
function* offscreenCells(model, draw, frame, viewport, cells) {
  for (const cell of cells) {
    if (!(yield* offscreenCell(model, draw, frame, viewport, cell))) return false
    yield
  }
  return true
}

module.exports = {offscreenCell, offscreenCells}
