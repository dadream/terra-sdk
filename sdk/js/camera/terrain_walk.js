const {finiteNumber, invariant} = require('../core/terra_globe_common')
const eye = require('./eye_view')
const cancelled = () => Object.assign(new Error('Terrain walk cancelled'), {code: 'camera_walk_cancelled'})

// Ground-following movement owns a single path and at most one height query.
// Missing terrain pauses progress, and elapsed waiting time is never replayed
// as a large movement. This samples the CBDAM model; it is not a swept capsule.
class TerrainWalk {
  constructor(runtime) { this.runtime = runtime; this.serial = 0; this.active = null; this.last = {state: 'idle'} }

  async start(input = {}) {
    const runtime = this.runtime, start = runtime.getView()
    invariant(start.schema === eye.SCHEMA && !runtime.paused && !runtime.destroyed, 'Walking requires an active eye view')
    const forward = finiteNumber(input.forwardMeters || 0, 'Walk forward'), right = finiteNumber(input.rightMeters || 0, 'Walk right')
    const length = Math.hypot(forward, right)
    const speed = finiteNumber(input.speedMetersPerSecond === undefined ? 1.4 : input.speedMetersPerSecond, 'Walk speed')
    const height = finiteNumber(input.eyeHeightMeters === undefined ? 2 : input.eyeHeightMeters, 'Walking eye height')
    invariant(length > 0 && length <= 100 && speed > 0 && speed <= 20 &&
      height >= (runtime.options.minimumTerrainClearanceMeters === undefined ? 2 : runtime.options.minimumTerrainClearanceMeters) &&
      height <= 100, 'Invalid terrain walk distance, speed or eye height')
    const serial = ++this.serial, old = this.active
    this.stop()
    if (old) await old.done.catch(() => {})
    if (serial !== this.serial || runtime.destroyed || runtime.paused || runtime.getView().schema !== eye.SCHEMA) throw cancelled()
    const listeners = new Set(), signal = {aborted: false,
      addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn)}
    const job = this.active = {start, forward, right, length, speed, height, walked: 0, signal, listeners,
      previousAt: runtime.frameClock.now(), frame: null, query: null}
    job.done = new Promise((resolve, reject) => Object.assign(job, {resolve, reject}))
    this.last = {state: 'walking', distanceMeters: 0, requestedDistanceMeters: length}
    this.notify()
    this.schedule(job)
    return job.done
  }

  state() { return Object.assign({}, this.last, {pending: Boolean(this.active)}) }
  notify() {
    if (this.runtime.destroyed) return
    this.runtime.frameClock.enqueueWork('walk-notify', () => {
      if (this.runtime.destroyed) return
      this.runtime.cameraEvent('walkstate', this.state())
      this.runtime.publishState()
    })
  }

  schedule(job) {
    if (this.active !== job || job.signal.aborted || job.frame !== null) return
    job.frame = this.runtime.frameClock.request('animation', () => {
      job.frame = null
      try { this.step(job) } catch (cause) { this.finish(job, cause) }
    })
  }

  step(job) {
    const runtime = this.runtime, now = runtime.frameClock.now()
    if (runtime.destroyed || runtime.paused || runtime.workerRecovering || runtime.getView().schema !== eye.SCHEMA) {
      this.finish(job, cancelled()); return
    }
    const amount = Math.min(job.length - job.walked, job.speed * Math.min(50, Math.max(0, now - job.previousAt)) / 1000)
    job.previousAt = now
    if (!amount) { this.schedule(job); return }
    const next = job.walked + amount, t = next / job.length
    const pose = eye.offset(job.start, job.forward * t, job.right * t, runtime.manifest.radius)
    const options = {sampleSpacingMeters: runtime.groundDemands.options.sampleSpacingMeters, signal: job.signal}
    const point = pose.position
    const cached = runtime.heightQueries.peek(point.longitudeDegrees, point.latitudeDegrees, options)
    if (cached) { this.apply(job, pose, next, cached); return }
    this.last = Object.assign({}, this.last, {state: 'terrain-wait'})
    this.notify()
    job.query = runtime.heightQueries.query(point.longitudeDegrees, point.latitudeDegrees, options).then(sample => {
      if (!job.signal.aborted) this.apply(job, pose, next, sample)
    }).catch(cause => { if (!job.signal.aborted) this.finish(job, cause) }).finally(() => {
      job.query = null
      if (job.signal.aborted) this.finish(job, cancelled())
    })
  }

  apply(job, pose, next, sample) {
    if (this.active !== job || job.signal.aborted) return
    if (!sample.available || sample.reasons.some(reason => ['request-failed', 'invalid-data', 'resource-budget'].includes(reason))) {
      this.finish(job, Object.assign(new Error('Walking terrain unavailable'), {code: 'camera_walk_terrain_unavailable'})); return
    }
    const runtime = this.runtime, current = runtime.getView()
    if (runtime.destroyed || runtime.paused || current.schema !== eye.SCHEMA) { this.finish(job, cancelled()); return }
    pose.position.heightMeters = sample.heightMeters + job.height
    pose.headingDegrees = current.headingDegrees; pose.pitchDegrees = current.pitchDegrees
    runtime.assignView(pose)
    runtime.previewCamera(); runtime.scheduleRefresh()
    job.walked = next; job.previousAt = runtime.frameClock.now()
    this.last = {state: 'walking', distanceMeters: next, requestedDistanceMeters: job.length,
      terrainStatus: sample.status, sampleSpacingMeters: sample.sampleSpacingMeters, verticalAccuracyMeters: null}
    if (next >= job.length) this.finish(job)
    else this.schedule(job)
  }

  finish(job, cause) {
    if (this.active !== job) return
    if (job.frame !== null) this.runtime.frameClock.cancel(job.frame)
    job.frame = null; job.listeners.clear(); this.active = null
    this.last = Object.assign({}, this.last, {state: cause ? 'stopped' : 'complete', reason: cause ? cause.code || 'camera_walk_failed' : ''})
    this.notify()
    if (cause) job.reject(cause)
    else job.resolve({distanceMeters: job.walked, view: this.runtime.getView(), terrain: this.state()})
  }

  stop() {
    const job = this.active
    if (!job) return false
    if (job.frame !== null) this.runtime.frameClock.cancel(job.frame)
    job.frame = null; job.signal.aborted = true; job.listeners.forEach(fn => fn())
    if (!job.query) this.finish(job, cancelled())
    return true
  }
  cancel() { ++this.serial; return this.stop() }
}

module.exports = {TerrainWalk}
