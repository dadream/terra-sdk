const {CooperativeTask} = require('../runtime/cooperative_task')
const {surfaceBlockSteps} = require('./surface_blocks')
const {uvHull} = require('./surface_regions')
const {surfaceLayout, getSurfaceLayout, rememberSurfaceLayout, applySurfaceLayout} = require('./surface_layout')
const {invariant} = require('../core/terra_globe_common')

// Only completed topology is shared. Cancellation must not publish a partially
// populated strip or boundary to another surface using the same index buffer.
const topologyCache = new WeakMap()
function* triangleSteps(indices, first, count, vertexCount) {
  let cached = topologyCache.get(indices)
  if (!cached) { cached = new Map(); topologyCache.set(indices, cached) }
  const key = first + '/' + count + '/' + vertexCount
  if (cached.has(key)) return cached.get(key)
  const values = []
  for (let i = 2; i < count; ++i) {
    if (i % 64 === 0) yield
    const a = indices[first + i - 2], b = indices[first + i - 1], c = indices[first + i]
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount ||
        a === b || b === c || a === c) continue
    if (i % 2) values.push(b, a, c)
    else values.push(a, b, c)
  }
  const result = new Uint16Array(values), edges = new Map()
  for (let i = 0; i < result.length; i += 3) {
    if (i && i % 192 === 0) yield
    for (let e = 0; e < 3; ++e) {
      const a = result[i + e], b = result[i + (e + 1) % 3]
      const edge = Math.min(a, b) * vertexCount + Math.max(a, b)
      edges.set(edge, (edges.get(edge) || 0) + 1)
    }
  }
  const boundary = new Set()
  let visited = 0
  for (const [edge, count] of edges) {
    if (++visited % 192 === 0) yield
    if (count === 1) {
      boundary.add(Math.floor(edge / vertexCount)); boundary.add(edge % vertexCount)
    }
  }
  result.boundary = Array.from(boundary)
  cached.set(key, result)
  return result
}

function drain(work) {
  let result
  do { result = work.next() } while (!result.done)
  return result.value
}

function triangles(indices, first, count, vertexCount) {
  return drain(triangleSteps(indices, first, count, vertexCount))
}

// A source may borrow Wasm memory. Read views after each yield and return
// getters, never the typed-array view from a previous slice.
function* prepareSurfaceSteps(source, indices, firstIndex, indexCount, layout) {
  const vertexCount = source.positions.length / 3
  const faces = yield* triangleSteps(indices, firstIndex, indexCount, vertexCount)
  invariant(!layout || layout.faces === faces && layout.vertexCount === vertexCount, 'Surface layout differs from mesh topology')
  const bounds = layout ? layout.bounds : {minimumU: Infinity, minimumV: Infinity,
    maximumU: -Infinity, maximumV: -Infinity}
  for (let first = 0; !layout && first < vertexCount; first += 256) {
    if (first) yield
    const uv = source.uv, end = Math.min(vertexCount, first + 256)
    for (let i = first * 2; i < end * 2; i += 2) {
      bounds.minimumU = Math.min(bounds.minimumU, uv[i]); bounds.maximumU = Math.max(bounds.maximumU, uv[i])
      bounds.minimumV = Math.min(bounds.minimumV, uv[i + 1]); bounds.maximumV = Math.max(bounds.maximumV, uv[i + 1])
    }
  }
  const model = {faces, bounds}
  Object.defineProperties(model, {
    positions: {enumerable: true, configurable: true, get: () => source.positions},
    uv: {enumerable: true, configurable: true, get: () => source.uv}
  })
  model.blocks = yield* surfaceBlockSteps(model, bounds, 4, null, layout)
  // CBDAM boundaries have at most three patch edges (768 vertices at D256).
  model.hull = layout ? layout.hull : uvHull(source.uv, faces.boundary)
  model.layout = layout || surfaceLayout(model, vertexCount)
  return model
}

function createSurfaceTask(source, indices, firstIndex, indexCount) {
  return new CooperativeTask(prepareSurfaceSteps(source, indices, firstIndex, indexCount))
}
function prepareSurface(positions, uv, indices, firstIndex, indexCount) {
  const faces = triangles(indices, firstIndex, indexCount, positions.length / 3)
  const model = drain(prepareSurfaceSteps({positions, uv}, indices, firstIndex, indexCount, getSurfaceLayout(uv, faces)))
  rememberSurfaceLayout(uv, model.layout)
  return model
}

function attachSurface(summary, positions, uv, indices, firstIndex, indexCount) {
  const faces = triangles(indices, firstIndex, indexCount, positions.length / 3)
  const model = Object.assign({}, summary, {positions, uv, faces})
  if (Array.isArray(model.blocks) && model.hull) {
    const layout = getSurfaceLayout(uv, faces)
    if (layout) {
      invariant(layout.vertexCount === positions.length / 3 && layout.blocks.length === model.blocks.length,
        'Immutable surface layout changed')
      applySurfaceLayout(model, layout)
    } else {
      model.layout = surfaceLayout(model, positions.length / 3)
      rememberSurfaceLayout(uv, model.layout)
    }
  }
  return model
}

module.exports = {triangles, prepareSurface, prepareSurfaceSteps, createSurfaceTask, attachSurface}
