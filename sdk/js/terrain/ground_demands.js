const {finiteNumber, invariant} = require('../core/terra_globe_common')

const dot = (a, b) => a.reduce((n, v, i) => n + v * b[i], 0)
const coordinate = unit => [Math.atan2(unit[0], unit[2]) * 180 / Math.PI,
  Math.asin(Math.max(-1, Math.min(1, unit[1]))) * 180 / Math.PI]
const same = (a, b) => a && b && a.u === b.u && a.v === b.v
const distance = (a, b, radius) => radius * Math.hypot(...a.unit.map((v, i) => v - b.unit[i]))

// Use the actual eye and projected viewing direction, not the orbit target.
// Great-circle projection also works across longitude seams and near poles.
function groundPoints(snapshot, radius, lookAheadMeters) {
  const length = Math.hypot(...snapshot.cameraPosition)
  const unit = snapshot.cameraPosition.map(v => v / length)
  const view = snapshot.viewMatrix
  const forward = [-view[8], -view[9], -view[10]]
  const radial = dot(unit, forward), tangent = forward.map((v, i) => v - radial * unit[i])
  const tangentLength = Math.hypot(...tangent), angle = lookAheadMeters / radius
  const ahead = tangentLength < 1e-8 ? unit : unit.map((v, i) =>
    v * Math.cos(angle) + tangent[i] / tangentLength * Math.sin(angle))
  const point = vector => { const [u, v] = coordinate(vector); return {u, v, unit: vector} }
  return {eyeHeightMeters: length - radius, eye: point(unit), front: point(ahead)}
}

function demandOptions(input = {}) {
  const options = {enabled: input.enabled !== false}
  for (const [name, fallback, maximum] of [['sampleSpacingMeters', 30, 10000],
    ['lookAheadMeters', 50, 10000], ['activationHeightMeters', 20000, 100000]]) {
    options[name] = finiteNumber(input[name] === undefined ? fallback : input[name], name)
    invariant(options[name] > 0 && options[name] <= maximum, 'Invalid terrain navigation ' + name)
  }
  return options
}

// Latest eye/front demand, one query owner. Nearby motion retains useful work;
// a late result can warm regions but is never reused as a scalar at a new point.
// Failed demand parks until explicit retry, region change, or capacity release.
class GroundDemands {
  constructor(runtime, onChange) {
    this.runtime = runtime; this.onChange = onChange
    this.options = demandOptions(runtime.options.terrainNavigation)
    this.revision = 0; this.completed = {}; this.blocked = {}; this.samples = {}
    this.active = false; this.suspended = false; this.destroyed = false
    this.releaseListener = runtime.resourceLedger.subscribe(() => {
      if (!this.active || this.suspended || this.destroyed) return
      let wake = false
      for (const role of ['eye', 'front']) {
        const block = this.blocked[role]
        if (block && block.code === 'terrain_query_capacity' &&
            block.revision !== runtime.resourceLedger.availabilityRevision) {
          delete this.blocked[role]; wake = true
        }
      }
      if (wake) this.schedule()
    })
  }

  update(snapshot) {
    const runtime = this.runtime
    const enabled = this.options.enabled && !this.suspended && !this.destroyed &&
      !runtime.destroyed && !runtime.paused && !runtime.workerRecovering && runtime.abi && !runtime.abi.destroyed &&
      runtime.manifest.transform === 'cylindrical'
    if (!enabled) { this.deactivate(); return }
    if (this.manifest !== runtime.manifest || this.origin !== runtime.serviceOrigin || this.abi !== runtime.abi) {
      this.reset(); this.manifest = runtime.manifest; this.origin = runtime.serviceOrigin; this.abi = runtime.abi
    }
    this.points = groundPoints(snapshot, runtime.manifest.radius, this.options.lookAheadMeters)
    if (this.points.eyeHeightMeters > this.options.activationHeightMeters) { this.deactivate(); return }
    this.active = true
    this.read()
    const job = this.job, radius = runtime.manifest.radius
    if (job && (distance(job.point, this.points[job.role], radius) > this.retentionDistance() ||
        job.role === 'front' && !this.samples.eye && !this.blocked.eye)) job.abort()
    this.schedule()
  }

  retentionDistance() { return Math.max(this.options.lookAheadMeters * 4, this.options.sampleSpacingMeters * 64) }

  read() {
    if (!this.active) return
    for (const role of ['eye', 'front']) {
      const point = this.points[role], block = this.blocked[role]
      const completed = Object.values(this.completed).find(value => same(value.point, point))
      if (block && distance(block.point, point, this.manifest.radius) > this.retentionDistance()) delete this.blocked[role]
      const cached = this.runtime.heightQueries.peek(point.u, point.v, this.options)
      this.samples[role] = cached || (completed && same(completed.point, point) ? completed.result : null)
      if (this.samples[role]) delete this.blocked[role]
    }
    if (same(this.points.eye, this.points.front) && this.blocked.eye) this.blocked.front = this.blocked.eye
  }

  schedule() {
    if (!this.active || this.job || this.suspended || this.destroyed) return
    if (['eye', 'front'].every(role => this.samples[role] || this.blocked[role])) return
    this.runtime.frameClock.enqueueWork('ground-demand', () => this.pump())
  }

  pump() {
    if (!this.active || this.job || this.suspended || this.destroyed) return
    this.read()
    const role = ['eye', 'front'].find(name => !this.samples[name] && !this.blocked[name])
    if (!role) return
    const point = this.points[role], listeners = new Set()
    const signal = {aborted: false, addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn)}
    const job = this.job = {role, point, signal, abort: () => {
      if (signal.aborted) return
      signal.aborted = true; listeners.forEach(fn => fn())
    }}
    // Promise boundary handles synchronous validation/admission errors as well.
    Promise.resolve().then(() => this.runtime.heightQueries.query(point.u, point.v,
      Object.assign({}, this.options, {signal}))).then(result => {
      if (!this.accepts(job)) return
      this.completed[role] = {point, result}
      if (!result.available) this.blocked[role] = {point, code: 'terrain_query_unavailable', result}
    }, cause => {
      if (!this.accepts(job)) return
      this.blocked[role] = {point, code: cause.code || 'terrain_query_failed',
        revision: this.runtime.resourceLedger.availabilityRevision}
    }).finally(() => {
      this.job = null; listeners.clear()
      if (!this.active || this.destroyed || this.suspended) return
      this.read(); ++this.revision; this.onChange(); this.schedule()
    })
  }

  accepts(job) { return !job.signal.aborted && this.active && !this.suspended && !this.destroyed }

  state() {
    const result = {active: this.active, pending: Boolean(this.job), revision: this.revision}
    for (const role of ['eye', 'front']) {
      const point = this.points && this.points[role], sample = this.samples[role], block = this.blocked[role]
      result[role] = !this.active || !point ? null : {longitudeDegrees: point.u, latitudeDegrees: point.v,
        status: sample ? sample.status : block ? block.code === 'terrain_query_capacity' ? 'limited' : 'unavailable' : 'pending',
        heightMeters: sample && sample.available ? sample.heightMeters : null,
        sampleSpacingMeters: sample && sample.available ? sample.sampleSpacingMeters : null,
        verticalAccuracyMeters: null, reasons: sample ? sample.reasons.slice() : block ? [block.code] : []}
    }
    return result
  }

  retry() { this.blocked = {}; this.completed = {}; ++this.revision; this.read(); this.schedule() }
  deactivate() {
    this.active = false; this.samples = {}
    this.runtime.frameClock.cancelWork('ground-demand')
    if (this.job) this.job.abort()
  }
  reset() { this.deactivate(); this.completed = {}; this.blocked = {}; ++this.revision }
  pause() { this.suspended = true; this.reset() }
  resume() { this.suspended = false; this.reset() }
  destroy() { this.destroyed = true; this.reset(); this.releaseListener() }
}

module.exports = {GroundDemands, groundPoints, demandOptions}
