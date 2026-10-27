const { TimingSeries, monotonicNow } = require('../diagnostics/timing')

// One display clock: animation -> input -> GPU submission -> notification.
// Background continuations use a separate bounded task queue. Display delivery
// is not a prerequisite for model preparation, uploads or completion receipts.
// Enqueuing work during either clock never recursively executes that phase.
class FrameCoordinator {
  constructor(options) {
    this.options = options
    this.now = options.now || monotonicNow
    this.setTask = options.setTask || ((callback, delay) => setTimeout(callback, delay))
    this.clearTask = options.clearTask || (handle => clearTimeout(handle))
    this.actors = { animation: new Map(), input: new Map() }
    this.work = new Map()
    this.nextId = 0
    this.frameHandle = null
    this.taskHandle = null
    this.pendingRender = false
    this.running = false
    this.paused = false
    this.destroyed = false
    this.pendingCameraAt = null
    this.lastSubmittedAt = null
    this.continuous = false
    this.metrics = {}
    for (const name of ['animation', 'input', 'queue', 'frameWait', 'submit', 'notify', 'frame', 'continuousInterval', 'cameraToSubmit', 'workQueue']) {
      this.metrics[name] = new TimingSeries()
    }
  }

  request(phase, callback) {
    if (!this.actors[phase]) throw new Error('Unknown frame phase: ' + phase)
    if (this.destroyed) return null
    const id = ++this.nextId
    this.actors[phase].set(id, { callback, queuedAt: this.now() })
    this.schedule()
    return id
  }

  cancel(id) {
    for (const phase of Object.values(this.actors)) phase.delete(id)
  }

  markCamera() {
    if (!this.paused && !this.destroyed && this.pendingCameraAt === null) this.pendingCameraAt = this.now()
  }

  invalidate() {
    if (this.destroyed) return
    this.pendingRender = true
    this.schedule()
  }

  enqueueWork(key, callback, delay = 0) {
    if (this.destroyed) return
    if (!Number.isFinite(delay) || delay < 0) throw new Error('Invalid background work delay')
    const now = this.now()
    const previous = this.work.get(key)
    this.work.set(key, { callback, queuedAt: previous ? previous.queuedAt : now,
      dueAt: previous ? Math.min(previous.dueAt, now + delay) : now + delay })
    this.scheduleWork()
  }

  cancelWork(key) {
    this.work.delete(key)
    this.scheduleWork()
  }

  schedule() {
    if (this.destroyed || this.paused || this.running || this.frameHandle !== null) return
    // Token also rejects a host callback that arrives after cancellation.
    const token = { queuedAt: this.now() }
    this.frameHandle = token
    token.handle = this.options.requestFrame(() => {
      if (this.frameHandle !== token) return
      this.frameHandle = null
      this.metrics.frameWait.record(this.now() - token.queuedAt)
      this.tick()
    })
  }

  invoke(callback, timestamp) {
    try { return callback(timestamp) }
    catch (error) {
      if (this.options.onError) this.options.onError(error)
      else throw error
    }
  }

  tick() {
    if (this.destroyed || this.paused) return
    this.running = true
    const startedAt = this.now()
    try {
      for (const phase of ['animation', 'input']) {
        const started = this.now()
        const jobs = Array.from(this.actors[phase])
        for (const [id, job] of jobs) {
          if (this.destroyed || this.paused) return
          if (!this.actors[phase].delete(id)) continue
          this.metrics.queue.record(this.now() - job.queuedAt)
          this.invoke(job.callback, startedAt)
        }
        if (jobs.length) this.metrics[phase].record(this.now() - started)
      }
      if (this.destroyed || this.paused) return
      if (this.pendingRender) {
        this.pendingRender = false
        const submittedAt = this.now()
        const cameraAt = this.pendingCameraAt
        const submitted = this.invoke(this.options.render, startedAt)
        this.metrics.submit.record(this.now() - submittedAt)
        if (submitted === true) {
          if (this.continuous && this.lastSubmittedAt !== null) {
            this.metrics.continuousInterval.record(submittedAt - this.lastSubmittedAt)
          }
          this.lastSubmittedAt = submittedAt
          if (cameraAt !== null) {
            this.metrics.cameraToSubmit.record(this.now() - cameraAt)
            this.pendingCameraAt = null
          }
        }
        if (!this.destroyed && !this.paused && this.options.notify) {
          const notifyAt = this.now()
          this.invoke(this.options.notify, startedAt)
          this.metrics.notify.record(this.now() - notifyAt)
        }
      }
    } finally {
      this.metrics.frame.record(this.now() - startedAt)
      this.running = false
      this.continuous = this.pendingRender || Object.values(this.actors).some(jobs => jobs.size)
      if (this.continuous) this.schedule()
      this.scheduleWork()
    }
  }

  scheduleWork() {
    if (this.working || this.paused || this.destroyed) return
    const dueAt = Math.min(...Array.from(this.work.values(), job => job.dueAt))
    if (this.taskHandle && this.taskHandle.dueAt === dueAt) return
    if (this.taskHandle) this.clearTask(this.taskHandle.handle)
    this.taskHandle = null
    if (!this.work.size) return
    const token = {dueAt}
    this.taskHandle = token
    token.handle = this.setTask(() => {
      if (this.taskHandle !== token) return
      this.taskHandle = null
      if (this.paused || this.destroyed) return
      this.working = true
      const started = this.now()
      const jobs = Array.from(this.work).filter(([, job]) => job.dueAt <= started)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)
      try {
        // At most one invocation of each captured key, with a 4ms host slice.
        // New/replaced continuations belong to another task, never this loop.
        for (const [key, job] of jobs) {
          if (this.paused || this.destroyed) break
          if (this.work.get(key) !== job) continue
          this.work.delete(key)
          this.metrics.workQueue.record(this.now() - job.queuedAt)
          this.invoke(job.callback, this.now())
          if (this.now() - started >= 4) break
        }
      } finally {
        this.working = false
        this.scheduleWork()
      }
    }, Math.max(0, dueAt - this.now()))
  }

  setPaused(paused) {
    this.paused = Boolean(paused)
    this.lastSubmittedAt = null
    this.pendingCameraAt = null
    this.continuous = false
    if (this.paused) {
      if (this.frameHandle !== null) this.options.cancelFrame(this.frameHandle.handle)
      this.frameHandle = null
      if (this.taskHandle) this.clearTask(this.taskHandle.handle)
      this.taskHandle = null
    } else {
      if (this.pendingRender || Object.values(this.actors).some(jobs => jobs.size)) this.schedule()
      this.scheduleWork()
    }
  }

  snapshot(exact = false) {
    const result = { pendingAnimations: this.actors.animation.size, pendingInputs: this.actors.input.size,
      pendingWork: this.work.size, pendingRender: this.pendingRender }
    const now = this.now()
    for (const [name, series] of Object.entries(this.metrics)) result[name] = series.snapshot(now, exact)
    return result
  }

  resetMetrics() {
    for (const series of Object.values(this.metrics)) series.reset()
    this.lastSubmittedAt = null
    this.pendingCameraAt = null
    this.continuous = false
  }

  destroy() {
    this.setPaused(true)
    this.destroyed = true
    this.pendingRender = false
    this.work.clear()
    for (const phase of Object.values(this.actors)) phase.clear()
  }
}

module.exports = { FrameCoordinator }
