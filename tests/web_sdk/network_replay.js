(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraNetworkReplay = factory()
})(typeof self === 'undefined' ? this : self, function () {
  'use strict'
  const abortError = () => Object.assign(new Error('Replay request cancelled'), {name: 'AbortError'})
  const hash = text => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }

  // Key/attempt-based faults are repeatable even when Worker/GPU timing changes
  // request ordering. This is latency/chunk delivery injection, not a simulation
  // of a shared TCP link or a substitute for live-provider acceptance.
  class NetworkReplay {
    constructor(options = {}) {
      this.setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms))
      this.clearTimer = options.clearTimer || (id => clearTimeout(id))
      this.rule = options.rule || ((kind, key, attempt) => ({
        latencyMs: 40 + (hash(kind + key) % 7) * 35,
        chunkDelayMs: 20, chunkBytes: 4096,
        fail: attempt === 1 && (kind === 'terrain' ? key.includes('/root/') : hash(key) % 13 === 0)
      }))
      this.jobs = new Set(); this.attempts = new Map(); this.failed = new Set(); this.recovered = new Set()
      this.serial = 0; this.completedSerial = 0; this.closed = false
      this.counts = {terrain: 0, imagery: 0, transient503: 0, terrain503: 0, imagery503: 0,
        retrySuccess: 0, terrainRetrySuccess: 0, imageryRetrySuccess: 0,
        cancelled: 0, reordered: 0, bodyChunks: 0, bodyBytes: 0, maximumActive: 0}
    }

    open(kind, key, signal) {
      if (this.closed) throw new Error('Network replay is closed')
      const identity = kind + ':' + key, attempt = (this.attempts.get(identity) || 0) + 1
      this.attempts.set(identity, attempt); ++this.counts[kind]
      const rule = this.rule(kind, key, attempt), id = ++this.serial
      const job = {kind, id, identity, attempt, rule, signal, wait: null, controller: null, closed: false}
      const close = () => {
        if (job.closed) return
        job.closed = true; this.jobs.delete(job)
        if (signal) signal.removeEventListener('abort', job.abort)
      }
      job.abort = () => {
        if (job.closed) return
        ++this.counts.cancelled
        const error = abortError()
        if (job.wait) { this.clearTimer(job.wait.timer); job.wait.reject(error); job.wait = null }
        if (job.source) job.source.abort()
        if (job.controller) job.controller.error(error)
        close()
      }
      job.finish = success => {
        if (job.closed) return
        if (id < this.completedSerial) ++this.counts.reordered
        this.completedSerial = Math.max(this.completedSerial, id)
        if (success && this.failed.has(identity) && !this.recovered.has(identity)) {
          this.recovered.add(identity); ++this.counts.retrySuccess; ++this.counts[kind + 'RetrySuccess']
        }
        close()
      }
      this.jobs.add(job); this.counts.maximumActive = Math.max(this.counts.maximumActive, this.jobs.size)
      if (signal) signal.addEventListener('abort', job.abort, {once: true})
      if (signal && signal.aborted) job.abort()
      return job
    }

    delay(job, milliseconds) {
      if (job.closed) return Promise.reject(abortError())
      return new Promise((resolve, reject) => {
        job.wait = {reject, timer: this.setTimer(() => { job.wait = null; resolve() }, milliseconds)}
      })
    }

    failedResponse(job) {
      if (!job.rule.fail) return false
      ++this.counts.transient503; ++this.counts[job.kind + '503']; this.failed.add(job.identity); job.finish(false)
      return true
    }

    terrain(source, options) {
      const job = this.open('terrain', new URL(options.url).pathname)
      const promise = this.delay(job, job.rule.latencyMs).then(async () => {
        if (job.closed) throw abortError()
        if (this.failedResponse(job)) return {statusCode: 503, data: new ArrayBuffer(0), header: {}}
        job.source = source(options)
        const response = await job.source.promise
        if (job.closed) throw abortError()
        job.finish(response.statusCode === 200)
        return response
      }).catch(error => { job.finish(false); throw error })
      return {promise, abort: job.abort}
    }

    async imagery(url, options, bytes) {
      const job = this.open('imagery', new URL(url).pathname, options && options.signal)
      try {
        await this.delay(job, job.rule.latencyMs)
        if (job.closed) throw abortError()
        if (this.failedResponse(job)) return new Response(null, {status: 503})
        let offset = 0
        const body = new ReadableStream({
          start: controller => { job.controller = controller },
          pull: async controller => {
            try {
              await this.delay(job, job.rule.chunkDelayMs)
              if (job.closed) return
              const chunk = bytes.slice(offset, offset + job.rule.chunkBytes)
              offset += chunk.length; ++this.counts.bodyChunks; this.counts.bodyBytes += chunk.length
              controller.enqueue(chunk)
              if (offset === bytes.length) { job.controller = null; controller.close(); job.finish(true) }
            } catch (error) { if (!job.closed) { job.controller = null; controller.error(error); job.finish(false) } }
          },
          cancel: () => { job.controller = null; job.abort() }
        }, {highWaterMark: 0})
        return new Response(body, {headers: {'content-type': 'image/png', 'content-length': String(bytes.length)}})
      } catch (error) { job.finish(false); throw error }
    }

    snapshot() {
      return Object.assign({}, this.counts, {active: this.jobs.size,
        timers: Array.from(this.jobs).filter(job => job.wait).length,
        activeTerrain: Array.from(this.jobs).filter(job => job.kind === 'terrain').length,
        activeImagery: Array.from(this.jobs).filter(job => job.kind === 'imagery').length})
    }
    close() { this.closed = true; Array.from(this.jobs).forEach(job => job.abort()) }
  }
  return {NetworkReplay}
})
