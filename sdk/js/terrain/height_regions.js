const {ResourceCache} = require('../resources/resource_cache')
const {invariant} = require('../core/terra_globe_common')

const GRID = 268435456
function queryGrid(u, v, manifest) {
  if (manifest.transform !== 'cylindrical') return [
    -GRID + 2 * GRID * (u - manifest.minimumU) / (manifest.maximumU - manifest.minimumU),
    -GRID + 2 * GRID * (v - manifest.minimumV) / (manifest.maximumV - manifest.minimumV), GRID]
  const h = GRID / 2, latitude = v * GRID / 90
  if (u < -90) return [-h + (u + 180) * GRID / 90, latitude, h]
  if (u < 0) return [h, latitude, h - (u + 90) * GRID / 90]
  if (u < 90) return [h - u * GRID / 90, latitude, -h]
  return [-h, latitude, -h + (u - 90) * GRID / 90]
}

// Same triangular CBDAM lattice as Native height_query.cpp, including face
// membership. No rendering geometry, nearest-point or cross-triangle extrapolation.
function sampleRegion(region, point) {
  const a = region.corners, n = region.dimension
  const ab = [a[3] - a[0], a[4] - a[1], a[5] - a[2]]
  const ac = [a[6] - a[0], a[7] - a[1], a[8] - a[2]]
  const ap = [point[0] - a[0], point[1] - a[1], point[2] - a[2]]
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
  const aa = dot(ab, ab), cc = dot(ac, ac), bc = dot(ab, ac), d = aa * cc - bc * bc
  if (!(d > 0)) return null
  let u = (cc * dot(ap, ab) - bc * dot(ap, ac)) / d
  let v = (aa * dot(ap, ac) - bc * dot(ap, ab)) / d
  if (!Number.isFinite(u) || !Number.isFinite(v) || u < -1e-10 || v < -1e-10 || u + v > 1 + 1e-10 ||
    ap.some((value, i) => Math.abs(value - u * ab[i] - v * ac[i]) > 1e-5)) return null
  u = Math.max(0, Math.min(1, u)); v = Math.max(0, Math.min(1 - u, v))
  const px = u * n, py = v * n
  let x = Math.floor(px), y = Math.floor(py)
  if (x + y >= n) { if (x) --x; else --y }
  const dx = px - x, dy = py - y
  const at = (x, y) => region.heights[y * (2 * n + 3 - y) / 2 + x]
  const b = at(x + 1, y), c = at(x, y + 1)
  const height = dx + dy <= 1 || x + y + 1 === n
    ? (1 - dx - dy) * at(x, y) + dx * b + dy * c
    : (dx + dy - 1) * at(x + 1, y + 1) + (1 - dy) * b + (1 - dx) * c
  return height * region.heightScale
}

class HeightRegions {
  constructor(ledger) {
    this.cache = new ResourceCache({ledger, owner: 'height-regions', maximumEntries: 32,
      maximumBytes: 2 * 1024 * 1024})
    this.serial = 0; this.hits = 0
  }
  reserve(dimension) {
    return this.cache.reserve(++this.serial, (dimension + 1) * (dimension + 2) / 2 * 4 + 1024)
  }
  publish(reservation, region, result) {
    if (!region) return
    const n = region.dimension
    invariant(Number.isInteger(n) && n > 0 && n <= 256 && region.heights instanceof Int32Array &&
      region.heights.length === (n + 1) * (n + 2) / 2 && region.corners.length === 9 &&
      region.corners.every(Number.isFinite) && Number.isFinite(region.heightScale) && region.heightScale > 0 &&
      Number.isFinite(region.geometrySpacingMeters) && region.geometrySpacingMeters > 0 &&
      region.heights.byteLength + 1024 <= reservation.lease.bytes, 'Invalid admitted height region')
    reservation.commit({region, result: Object.assign({}, result, {reasons: result.reasons.slice()})})
  }
  sample(options, manifest) {
    const point = queryGrid(options.u, options.v, manifest)
    let selected = null, selectedKey
    for (const [key, entry] of this.cache.entries) {
      const {region, result} = entry.value
      if (result.level > options.maximumLevel || (selected && selected.level > result.level) ||
        (region.geometrySpacingMeters > options.sampleSpacingMeters && result.level !== options.maximumLevel)) continue
      const heightMeters = sampleRegion(region, point)
      if (heightMeters === null) continue
      const ready = result.sampleSpacingMeters <= options.sampleSpacingMeters
      const reasons = result.reasons.filter(reason => reason !== 'source-level')
      if (!ready && region.geometrySpacingMeters > options.sampleSpacingMeters) reasons.push('source-level')
      selected = Object.assign({}, result, {heightMeters, status: ready ? 'ready' : 'limited', reasons,
        requestedSampleSpacingMeters: options.sampleSpacingMeters, cacheHit: true, peakBytes: 0})
      selectedKey = key
    }
    if (selected) { this.cache.get(selectedKey); ++this.hits }
    return selected
  }
  // Clearing a dataset/destroying the consumer retires resident regions, but
  // an export already producing a destination still owns its reservation.
  // Its query continuation cancels that reservation after the actual receipt.
  clear() { this.cache.clear({retainReservations: true}) }
  stats() { return Object.assign({hits: this.hits}, this.cache.stats()) }
}
module.exports = {HeightRegions, queryGrid, sampleRegion}
