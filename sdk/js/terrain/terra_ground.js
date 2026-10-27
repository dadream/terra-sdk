const surfacePlan = require('./terra_surface_plan')
const surfaceBounds = new WeakMap()

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const subtract = (a, b) => a.map((v, i) => v - b[i])
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = a => { const n = Math.hypot(...a); return a.map(v => v / n) }

function cameraRay(snapshot, x, y, width, height, fov) {
  const v = snapshot.viewMatrix, t = Math.tan(fov / 2)
  const local = [(2 * x / width - 1) * t * width / height,
    (1 - 2 * y / height) * t, -1]
  return { origin: snapshot.cameraPosition, direction: unit([0, 1, 2].map(i =>
    v[i] * local[0] + v[4 + i] * local[1] + v[8 + i] * local[2])) }
}

function sphereHit(ray, radius) {
  const b = dot(ray.origin, ray.direction), c = dot(ray.origin, ray.origin) - radius * radius
  const d = b * b - c
  if (d < 0) return null
  const distance = -b - Math.sqrt(d)
  return distance >= 0 ? ray.origin.map((v, i) => v + distance * ray.direction[i]) : null
}

function boxHit(origin, direction, minimum, maximum) {
  let lo = 0, hi = Infinity
  for (let i = 0; i < 3; ++i) {
    if (Math.abs(direction[i]) < 1e-14) {
      if (origin[i] < minimum[i] || origin[i] > maximum[i]) return false
    } else {
      const a = (minimum[i] - origin[i]) / direction[i], b = (maximum[i] - origin[i]) / direction[i]
      lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b))
      if (hi < lo) return false
    }
  }
  return true
}

// Intersect the triangles of the owned display cut. A nearest vertex sample
// cannot establish either a drag anchor or clearance above the ground.
function groundModel(resource, surface, draw) {
  if (!resource.groundModel) resource.groundModel = resource.model
    ? surfacePlan.attachSurface(resource.model, resource.positions, resource.textureUv,
      surface.indices, draw.firstIndex, draw.indexCount)
    : surfacePlan.prepareSurface(resource.positions, resource.textureUv,
      surface.indices, draw.firstIndex, draw.indexCount)
  const model = resource.groundModel
  if (!model.groundBounds) {
    const bounds = {minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity]}
    model.blocks.forEach(block => {
      for (let i = 0; i < 3; ++i) {
        bounds.minimum[i] = Math.min(bounds.minimum[i], block.minimum[i])
        bounds.maximum[i] = Math.max(bounds.maximum[i], block.maximum[i])
      }
    })
    model.groundBounds = bounds
  }
  return model
}

function surfaceHit(surface, ray, maximumDistance = Infinity) {
  if (!surface || !surface.resources || !surface.indices) return null
  let hit = null, distance = maximumDistance, backgroundHit = false
  for (const draw of surface.draws) {
    // Submitted detail precedes stencil-only background coverage, even when
    // the coarse approximation happens to be higher along this query ray.
    const background = Boolean(surface.stencil && draw.flags & 1)
    if (hit && !backgroundHit && background) continue
    const resource = surface.resources.get(draw.resourceId)
    if (!resource) continue
    const model = groundModel(resource, surface, draw)
    const origin = subtract(ray.origin, draw.origin), direction = ray.direction
    if (!boxHit(origin, direction, model.groundBounds.minimum, model.groundBounds.maximum)) continue
    for (const block of model.blocks) {
      if (!boxHit(origin, direction, block.minimum, block.maximum)) continue
      for (const f of block.faces) {
        const points = [0, 1, 2].map(j => {
          const i = model.faces[f + j] * 3
          return [resource.positions[i], resource.positions[i + 1], resource.positions[i + 2]]
        })
        const e1 = subtract(points[1], points[0]), e2 = subtract(points[2], points[0])
        const p = cross(direction, e2), determinant = dot(e1, p)
        if (Math.abs(determinant) < 1e-10) continue
        const t = subtract(origin, points[0]), u = dot(t, p) / determinant
        if (u < -1e-8 || u > 1 + 1e-8) continue
        const q = cross(t, e1), v = dot(direction, q) / determinant
        if (v < -1e-8 || u + v > 1 + 1e-8) continue
        const d = dot(e2, q) / determinant
        if (d >= 0 && d < (backgroundHit && !background ? maximumDistance : distance)) {
          if (draw.cells) {
            const uv = [0, 1].map(axis => [1 - u - v, u, v].reduce((sum, weight, j) =>
              sum + weight * resource.textureUv[model.faces[f + j] * 2 + axis], 0))
            let included = false
            for (let i = 0; i < draw.cells.length; i += 3) {
              const x = uv[0] * draw.cells[i] + draw.cells[i + 1],
                y = uv[1] * draw.cells[i] + draw.cells[i + 2]
              if (x >= -1e-8 && x <= 1 + 1e-8 && y >= -1e-8 && y <= 1 + 1e-8) { included = true; break }
            }
            if (!included) continue
          }
          distance = d
          backgroundHit = background
          hit = ray.origin.map((value, i) => value + d * direction[i])
        }
      }
    }
  }
  return hit
}

function surfaceHeight(surface, coordinate, radius) {
  if (!surface || !surface.resources || !surface.indices) return null
  const lon = coordinate[0] * Math.PI / 180, lat = coordinate[1] * Math.PI / 180
  const up = radius ? [Math.sin(lon) * Math.cos(lat), Math.sin(lat),
    Math.cos(lon) * Math.cos(lat)] : [0, 0, 1]
  let bounds = surfaceBounds.get(surface)
  if (!bounds) {
    bounds = {radius: 0, top: -Infinity}
    for (const draw of surface.draws) {
      const resource = surface.resources.get(draw.resourceId)
      if (!resource) continue
      const model = groundModel(resource, surface, draw)
      if (!model.blocks.length) continue
      const b = model.groundBounds
      bounds.top = Math.max(bounds.top, draw.origin[2] + b.maximum[2])
      const far = b.minimum.map((v, i) => Math.max(Math.abs(v + draw.origin[i]),
        Math.abs(b.maximum[i] + draw.origin[i])))
      bounds.radius = Math.max(bounds.radius, Math.hypot(...far))
    }
    surfaceBounds.set(surface, bounds)
  }
  const top = radius ? bounds.radius : bounds.top
  if (!Number.isFinite(top) || radius && top <= 0) return null
  const origin = radius ? up.map(v => v * (top + 1)) : [coordinate[0], coordinate[1], top + 1]
  // Stop at the globe centre plane: a back-side mesh is not local coverage.
  const hit = surfaceHit(surface, {origin, direction: up.map(v => -v)}, radius ? top + 1 : Infinity)
  return hit ? (radius ? dot(hit, up) - radius : hit[2]) : null
}

function rotateBetween(point, from, to) {
  const a = unit(from), b = unit(to), axis = cross(a, b), c = dot(a, b)
  if (c < -0.999999) return null
  const first = cross(axis, point), second = cross(axis, first)
  return point.map((v, i) => v + first[i] + second[i] / (1 + c))
}

module.exports = { cameraRay, sphereHit, surfaceHit, surfaceHeight, rotateBetween }
