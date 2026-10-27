const { triangles } = require('../../../sdk/js/terrain/terra_surface_plan')
const { CooperativeTask } = require('../../../sdk/js/runtime/cooperative_task')
const { ownMeshWork } = require('../../../sdk/js/resources/mesh_ownership')

// Replacement dependencies are a property of the two actual terrain surfaces,
// independent of camera visibility, imagery tiles and upload order. A shared
// boundary is a transaction boundary only when its old/new polylines agree.
function* replacementGroups(before, after, global) {
  const nodes = [], lines = new Map(), parents = []
  const root = i => {
    while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i] }
    return i
  }
  const join = values => {
    if (!values.length) return
    const first = root(values[0].id)
    values.forEach(value => { parents[root(value.id)] = first })
  }
  const gcd = (a, b) => { while (b) { const next = a % b; a = b; b = next } return a }
  for (const [side, surface] of [[0, before], [1, after]]) {
    for (const draw of surface.draws) {
      if (draw.flags & 1) continue
      const resource = surface.meshResources.get(draw.resourceId), anchor = draw.textureNode
      // A malformed/unsupported boundary cannot authorize a partial receipt.
      if (!resource || !anchor) return null
      const indices = triangles(surface.indices, draw.firstIndex, draw.indexCount, draw.vertexCount).boundary
      const scale = Math.pow(2, 28 - anchor.level), uv = resource.textureUv
      const points = indices.map(i => ({
        p: [(anchor.column + uv[i * 2]) * scale, (anchor.row + uv[i * 2 + 1]) * scale],
        w: draw.origin.map((v, axis) => v + resource.positions[i * 3 + axis])
      }))
      if (points.length < 3 || points.some(point =>
        !point.p.every(Number.isSafeInteger) || !point.w.every(Number.isFinite))) return null
      const centre = points.reduce((sum, point) => sum.map((v, i) => v + point.p[i] / points.length), [0, 0])
      points.sort((a, b) => Math.atan2(a.p[1] - centre[1], a.p[0] - centre[0]) -
        Math.atan2(b.p[1] - centre[1], b.p[0] - centre[0]))
      const id = nodes.length
      nodes.push({draw, side}); parents.push(id)
      for (let i = 0; i < points.length; ++i) {
        const a = points[i], b = points[(i + 1) % points.length]
        let dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1]
        const divisor = gcd(Math.abs(dx), Math.abs(dy))
        if (!divisor) return null
        const direction = dx > 0 || dx === 0 && dy > 0 ? 1 : -1
        dx /= divisor * direction; dy /= divisor * direction
        let intercept = dx * a.p[1] - dy * a.p[0]
        // The two longitude edges are one terrain boundary, not two islands.
        if (global && dx === 0 && a.p[0] === 4 * Math.pow(2, 28)) intercept = 0
        if (!Number.isSafeInteger(intercept)) return null
        const key = dx + '/' + dy + '/' + intercept
        const t = point => dx ? point.p[0] : point.p[1]
        const lo = direction > 0 ? a : b, hi = direction > 0 ? b : a
        const edge = {id, side, direction, lo: t(lo), hi: t(hi), a: lo.w, b: hi.w}
        if (!lines.has(key)) lines.set(key, [])
        lines.get(key).push(edge)
      }
      yield
    }
  }
  for (const edges of lines.values()) {
    const events = []
    edges.forEach(edge => { events.push({t: edge.lo, edge, start: true}, {t: edge.hi, edge, start: false}) })
    events.sort((a, b) => a.t - b.t)
    const active = new Set()
    for (let i = 0; i < events.length;) {
      const lo = events[i].t
      do {
        const event = events[i++]
        if (event.start) active.add(event.edge); else active.delete(event.edge)
      } while (i < events.length && events[i].t === lo)
      if (i === events.length) break
      const hi = events[i].t, values = Array.from(active)
      let compatible = true
      for (const direction of [-1, 1]) {
        const oriented = values.filter(edge => edge.direction === direction)
        if (!oriented.length) continue
        // Same-side old/new surfaces own the same footprint. New internal
        // edges and changed boundary heights also join the opposite side.
        join(oriented)
        const old = oriented.filter(edge => edge.side === 0), next = oriented.filter(edge => edge.side === 1)
        if (old.length !== 1 || next.length !== 1) { compatible = false; continue }
        const at = (edge, t, axis) => edge.a[axis] +
          (edge.b[axis] - edge.a[axis]) * (t - edge.lo) / (edge.hi - edge.lo)
        for (const t of [lo, hi]) for (let axis = 0; axis < 3; ++axis) {
          if (Math.abs(at(old[0], t, axis) - at(next[0], t, axis)) > 1e-6) compatible = false
        }
      }
      if (!compatible) join(values)
      if (i % 64 < 2) yield
    }
    yield
  }
  const groups = new Map()
  nodes.forEach((node, id) => {
    const key = root(id)
    if (!groups.has(key)) groups.set(key, {before: [], after: []})
    groups.get(key)[node.side ? 'after' : 'before'].push(node.draw)
  })
  return Array.from(groups.values())
}

function createReplacementTask(before, after, global) {
  return new CooperativeTask(ownMeshWork(replacementGroups(before, after, global),
    new Set([...before.meshResources.values(), ...after.meshResources.values()])))
}

module.exports = { createReplacementTask }
