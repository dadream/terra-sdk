const {visibilityBounds} = require('../../sdk/js/terrain/visibility_bounds')

// A missing UV cell cannot revoke depth evidence if every triangle that could
// occupy it is outside the physical viewport. The immutable blocks contain
// whole triangles, including those crossing a cell edge. Use the same expanded
// Float32 projection bounds as the query, never a triangle centroid or an
// unexpanded screen rectangle. Eye/near-plane intersections remain unknown.
// This proof belongs to one observe() call, with at most 128 block projections.
// No persistent geometry copy, new GPU query, or extra scheduling lane is used.
function offscreenCoverage(renderer) {
  const regions = new Map()
  let remaining = 128
  return (key, x, y, scale) => {
    if (!regions.has(key)) {
      const geometry = renderer.geometry.get(key), model = geometry && geometry.model
      const blocks = model && model.blocks
      const draw = renderer.current.draws.find(value => value.geometryKey === key && !(value.flags & 1))
      let visible = null
      if (draw && model && model.faces && blocks && blocks.length && blocks.length <= 16 && blocks.length <= remaining &&
          blocks.reduce((n, b) => n + (b.faces ? b.faces.length * 3 : 0), 0) === model.faces.length &&
          blocks.every(b => b.minimum && b.maximum && b.minimum.length === 3 && b.maximum.length === 3 &&
            b.minimum.every((v, i) => Number.isFinite(v) && Number.isFinite(b.maximum[i]) && v <= b.maximum[i]) &&
            b.uv && ['minimumU','minimumV','maximumU','maximumV'].every(k => Number.isFinite(b.uv[k])) &&
            b.uv.minimumU <= b.uv.maximumU && b.uv.minimumV <= b.uv.maximumV)) {
        remaining -= blocks.length
        visible = blocks.filter(block => {
          const bounds = visibilityBounds({faces: {length: block.faces.length * 3}, blocks: [block]}, draw,
            renderer.current.frame, {width: renderer.canvas.width, height: renderer.canvas.height})
          return !bounds || bounds.length
        }).map(block => block.uv)
      }
      regions.set(key, visible)
    }
    const visible = regions.get(key)
    // Zero-area UV contact creates no clipped triangles. Shared boundary
    // vertices remain covered by the retained adjacent cell.
    return visible !== null && visible.every(uv => uv.maximumU <= x / scale || uv.minimumU >= (x + 1) / scale ||
      uv.maximumV <= y / scale || uv.minimumV >= (y + 1) / scale)
  }
}

module.exports = {offscreenCoverage}
