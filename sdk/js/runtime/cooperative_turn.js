const {monotonicNow} = require('../diagnostics/timing')

// Amortize tiny iterator checkpoints within one bounded host turn. Timer-only
// platforms otherwise pay the host's timer floor for every cheap native round.
// A resolved promise is allowed only while this same 4ms CPU window has credit.
class CooperativeTurn {
  constructor(options = {}) {
    this.now = options.now || monotonicNow
    this.schedule = options.schedule || (callback => setTimeout(callback, 0))
    this.cancel = options.cancel || (handle => clearTimeout(handle))
    this.started = this.now()
    this.closed = false
    this.count = this.waitMs = 0
  }

  wait() {
    if (this.pending) return this.pending
    if (this.closed || this.now() - this.started < 4) return Promise.resolve()
    const queuedAt = this.now()
    this.pending = new Promise(resolve => {
      this.resume = () => {
        this.started = this.now()
        this.waitMs += this.started - queuedAt
        ++this.count
        this.pending = this.resume = this.handle = null
        resolve()
      }
      this.handle = this.schedule(this.resume)
    })
    return this.pending
  }

  close() {
    this.closed = true
    if (this.handle != null) this.cancel(this.handle)
    if (this.resume) this.resume()
  }
}

module.exports = {CooperativeTurn}
