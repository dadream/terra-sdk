const { monotonicNow } = require('../diagnostics/timing')

// One candidate's path to a submitted display cut. Planner freshness and image
// quality are independent of this ownership transaction. Only a real successful
// GPU submission can complete it and allow its predecessor to retire.
class SurfaceHandoff {
  constructor(now = monotonicNow) {
    this.now = now
    this.completed = 0
    this.clear()
  }

  clear() {
    this.sequence = null
    this.phase = 'idle'
    this.startedAt = this.changedAt = this.now()
    this.completedAt = null
    this.details = {}
  }

  prepare(sequence) {
    if (sequence === this.sequence) return
    this.sequence = sequence
    this.phase = 'prepared'
    this.startedAt = this.changedAt = this.now()
    this.completedAt = null
    this.details = {}
  }

  wait(reason, details = {}) {
    if (this.phase === 'presented') return false
    if (this.phase !== reason) this.changedAt = this.now()
    this.phase = reason
    this.details = details
    return false
  }

  ready() {
    if (this.phase !== 'presented') this.wait('gpu-submit')
    return true
  }

  submit(sequence) {
    if (sequence !== this.sequence || this.phase !== 'gpu-submit') return false
    this.phase = 'presented'
    this.completedAt = this.changedAt = this.now()
    this.details = {}
    ++this.completed
    return true
  }

  snapshot() {
    const now = this.now()
    return {sequence: this.sequence, phase: this.phase, completed: this.completed,
      ageMs: this.phase === 'idle' ? 0 : (this.completedAt === null ? now : this.completedAt) - this.startedAt,
      waitMs: this.completedAt === null && this.phase !== 'idle' ? now - this.changedAt : 0,
      details: this.details}
  }
}

module.exports = { SurfaceHandoff }
