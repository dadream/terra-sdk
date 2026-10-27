function monotonicNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now() : Date.now()
}

// Bounded recent samples; lifetime counters remain useful during a long session.
// Percentiles are computed lazily, at most four times a second per series.
class TimingSeries {
  constructor(capacity = 240) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4096) throw new Error('Invalid timing sample capacity')
    this.samples = new Float64Array(capacity)
    this.reset()
  }

  reset() {
    this.count = 0
    this.lastMs = 0
    this.averageMs = 0
    this.maximumMs = 0
    this.over50Ms = 0
    this.summary = null
    this.summaryAt = -Infinity
  }

  record(elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return
    this.samples[this.count % this.samples.length] = elapsedMs
    ++this.count
    this.lastMs = elapsedMs
    this.averageMs += (elapsedMs - this.averageMs) / this.count
    this.maximumMs = Math.max(this.maximumMs, elapsedMs)
    if (elapsedMs > 50) ++this.over50Ms
  }

  snapshot(now = monotonicNow(), exact = false) {
    if (!this.summary || exact || now - this.summaryAt >= 250) {
      const values = Array.from(this.samples.subarray(0, Math.min(this.count, this.samples.length))).sort((a, b) => a - b)
      const percentile = p => values.length ? values[Math.max(0, Math.ceil(p * values.length) - 1)] : 0
      this.summary = { windowCount: values.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95),
        p99Ms: percentile(0.99), windowMaxMs: percentile(1), windowEndingCount: this.count }
      this.summaryAt = now
    }
    return Object.assign({ count: this.count, lastMs: this.lastMs, averageMs: this.averageMs,
      maximumMs: this.maximumMs, over50Ms: this.over50Ms }, this.summary)
  }
}

function recordTiming(series, elapsedMs) { series.record(elapsedMs) }

module.exports = { TimingSeries, recordTiming, monotonicNow }
