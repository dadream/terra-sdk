const {visibilityBounds} = require('./visibility_bounds')

function clip(points, axis, bound, sign) {
  const output = []
  for (let i = 0; i < points.length; ++i) {
    const a = points[i], b = points[(i+1) % points.length]
    const da = sign * (a[axis]-bound), db = sign * (b[axis]-bound)
    if (da >= 0) output.push(a)
    if ((da < 0) !== (db < 0)) {
      const t = da / (da-db)
      output.push(a.map((v,j) => v + (b[j]-v)*t))
    }
  }
  return output
}

// Conservative UV-local query geometry. Clip contributing triangles in double
// precision, then enclose clipping error and Float32 storage before projecting
// nearer rectangles. Do not query independently rounded triangles at their own
// depth. No topology, geometry copy or persistent cache is produced here.
// The caller owns the immutable model until completion/cancellation and must
// schedule this generator; each step visits at most 64 triangle candidates.
function* visibilityCellBounds(model, draw, frame, viewport, cell) {
  if (!cell || !Number.isInteger(Math.log2(cell.scale)) || cell.scale < 1 || cell.scale > 2 ** 30 ||
      !Number.isInteger(cell.x) || !Number.isInteger(cell.y) || cell.x < 0 || cell.y < 0 ||
      cell.x >= cell.scale || cell.y >= cell.scale || !model || !model.faces ||
      !model.positions || !model.uv || !model.blocks || !model.blocks.length || model.blocks.length > 16 ||
      model.blocks.reduce((n, b) => n + (b.faces ? b.faces.length * 3 : 0), 0) !== model.faces.length) return null
  const loU = cell.x / cell.scale, hiU = (cell.x + 1) / cell.scale
  const loV = cell.y / cell.scale, hiV = (cell.y + 1) / cell.scale
  const rectangles = []
  let processed = 0
  for (const block of model.blocks) {
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity]
    let included = false
    for (const f of block.faces) {
      if (!Number.isInteger(f) || f < 0 || f + 2 >= model.faces.length) return null
      const ids = [model.faces[f], model.faces[f + 1], model.faces[f + 2]]
      let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity
      for (const id of ids) {
        if (!Number.isInteger(id) || id < 0 || id * 3 + 2 >= model.positions.length || id * 2 + 1 >= model.uv.length) return null
        const u = model.uv[id * 2], v = model.uv[id * 2 + 1]
        if (!Number.isFinite(u) || !Number.isFinite(v)) return null
        minU = Math.min(minU, u); maxU = Math.max(maxU, u)
        minV = Math.min(minV, v); maxV = Math.max(maxV, v)
      }
      // Retain UV edge contact and Float32 rounding uncertainty. Selecting by
      // centroid, or by a block's nominal grid cell, loses crossing triangles.
      const margin = Math.max(1, Math.abs(minU), Math.abs(maxU), Math.abs(minV), Math.abs(maxV)) * 64 * 2 ** -23
      if (maxU + margin >= loU && minU - margin <= hiU && maxV + margin >= loV && minV - margin <= hiV) {
        let polygon = ids.map(id => [model.uv[id*2], model.uv[id*2+1],
          model.positions[id*3],model.positions[id*3+1],model.positions[id*3+2]])
        if (polygon.some(p => p.some(v => !Number.isFinite(v)))) return null
        // A large original coordinate can cancel to a small clipped position.
        // Its rounding allowance must not be derived from that small result.
        const padding = [0,1,2].map(axis => Math.max(1, ...polygon.map(p => Math.abs(p[axis+2]))) * 64 * Number.EPSILON)
        polygon = clip(polygon,0,loU-margin,1)
        polygon = clip(polygon,0,hiU+margin,-1)
        polygon = clip(polygon,1,loV-margin,1)
        polygon = clip(polygon,1,hiV+margin,-1)
        for (const p of polygon) for (let axis = 0; axis < 3; ++axis) {
          minimum[axis] = Math.min(minimum[axis], Math.fround(p[axis+2]-padding[axis]))
          maximum[axis] = Math.max(maximum[axis], Math.fround(p[axis+2]+padding[axis]))
        }
        included = included || polygon.length > 0
      }
      if (++processed % 64 === 0) yield
    }
    if (included) {
      const bounds = visibilityBounds({faces: {length: 3}, blocks: [{minimum, maximum, faces: [0]}]}, draw, frame, viewport)
      if (!bounds) return null
      rectangles.push(...bounds)
    }
  }
  return rectangles
}

module.exports = {visibilityCellBounds}
