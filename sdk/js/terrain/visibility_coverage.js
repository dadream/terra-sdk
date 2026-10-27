const {intersectsCell} = require('./terra_surface_plan')

// Canonical coverage of the immutable UV hull, independent of image level.
// Replacing a parent with its complete children changes partition buffers, not
// the terrain's occluding footprint. A real missing child must remain visible
// in this signature or feedback could outlive the geometry that justified it.
function visibilityCoverage(submitted, geometry, hidden) {
  const groups = new Map()
  for (const [draw, clipped] of submitted) {
    if (draw.flags & 1 || hidden.has(draw.resourceId)) continue
    let group = groups.get(draw.geometryKey)
    if (!group) { group = {cells: [], full: false}; groups.set(draw.geometryKey, group) }
    if (!clipped) group.full = true
    else group.cells.push([draw.imageryCellScale || 1, draw.imageryCellOffsetX || 0, draw.imageryCellOffsetY || 0])
  }
  return new Map(Array.from(groups, ([key, group]) => {
    if (group.full) return [key, 1]
    const model = geometry.get(key), hull = model && model.model && model.model.hull
    const raw = () => [key, {cells: group.cells.map(cell => cell.join(':')).sort()}]
    if (!hull || hull.length < 3 || hull.some(p => p.some(v => !Number.isFinite(v) || v < 0 || v > 1))) return raw()
    const root = {}
    for (const [scale, offsetX, offsetY] of group.cells) {
      const depth = Math.log2(scale), x = -offsetX, y = -offsetY
      if (!Number.isInteger(depth) || depth < 0 || depth > 30 ||
          !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= scale || y >= scale) return raw()
      let node = root
      for (let level = 0; level < depth && !node.full; ++level) {
        const divisor = Math.pow(2, depth - level - 1)
        const child = Math.floor(x / divisor) % 2 + 2 * (Math.floor(y / divisor) % 2)
        if (!node.children) node.children = []
        if (!node.children[child]) node.children[child] = {}
        node = node.children[child]
      }
      node.full = true; node.children = null
    }
    const visit = (node, x, y, scale) => {
      if (!intersectsCell(hull, x / scale, y / scale, (x + 1) / scale, (y + 1) / scale)) return 1
      if (node && node.full) return 1
      if (!node || !node.children) return 0
      const children = [0,1,2,3].map(i => visit(node.children[i], x * 2 + i % 2,
        y * 2 + Math.floor(i / 2), scale * 2))
      return children.every(child => child === 1) ? 1 : children
    }
    return [key, visit(root, 0, 0, 1)]
  }))
}

// Evidence remains conservative when immutable occluders gain coverage. Raw
// fallback cells support equality only; never guess containment for them.
function coversVisibility(required, current, hiddenKeys, irrelevant) {
  const contains = (key, before, after, x, y, scale) => {
    if (before === 0 || after === 1) return true
    // Only canonical cells have a spatial meaning. Unknown/raw signatures
    // retain exact equality, even when a caller supplies an offscreen proof.
    const known = value => value === undefined || value === 0 || value === 1 || Array.isArray(value)
    if (!known(before) || !known(after)) return JSON.stringify(before) === JSON.stringify(after)
    if ((after === undefined || after === 0) && irrelevant && irrelevant(key, x, y, scale)) return true
    if (!Array.isArray(before) && !Array.isArray(after)) return false
    return [0,1,2,3].every(i => contains(key, Array.isArray(before) ? before[i] : 1,
      Array.isArray(after) ? after[i] : 0, x * 2 + i % 2, y * 2 + Math.floor(i / 2), scale * 2))
  }
  for (const [key, before] of required) {
    if (!hiddenKeys.has(key) && !contains(key, before, current.get(key), 0, 0, 1)) return false
  }
  return true
}

module.exports = {visibilityCoverage, coversVisibility}
