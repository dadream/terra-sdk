const {finiteNumber, invariant, patchKeyString, joinServiceUrl, replaceTemplate,
  validateRecordPayload} = require('../core/terra_globe_common')
const {HeightRegions} = require('./height_regions')
const {ResourceWorkspace} = require('../resources/resource_workspace')
const {maximumEncodedRecordBytes, isMissingTerrainRecord} = require('./terrain_record')

const error = (code, message) => Object.assign(new Error(message), {code})
const reasonNames = [[1, 'no-data'], [2, 'request-failed'], [4, 'source-level'],
  [8, 'resource-budget'], [16, 'invalid-data']]

const defaultQueryBytes = manifest => Math.max(2 * 1024 * 1024, manifest.patchDimension ** 2 * 128)
function queryFootprint(manifest, maximumBytes) {
  const n = manifest.patchDimension + 1, ingressBytes = maximumEncodedRecordBytes(manifest.patchDimension, 1)
  // Two host responses, Worker clones, Native encoded buffers and region
  // export. The same quote funds both a default progress reserve and each job.
  const regionBytes = n * (n + 1) / 2 * 4 + 104
  return {ingressBytes, totalBytes: maximumBytes + 512 * 1024 + 6 * ingressBytes + 2 * regionBytes}
}

function queryOptions(u, v, options = {}) {
  const value = {u: finiteNumber(u, 'Query U'), v: finiteNumber(v, 'Query V'),
    sampleSpacingMeters: finiteNumber(options.sampleSpacingMeters === undefined ? 30 : options.sampleSpacingMeters,
      'Query sample spacing'),
    maximumLevel: options.maximumLevel === undefined ? 39 : options.maximumLevel,
    maximumBytes: options.maximumBytes === undefined ? 2 * 1024 * 1024 : options.maximumBytes,
    timeoutMs: options.timeoutMs === undefined ? 30000 : options.timeoutMs}
  invariant(value.sampleSpacingMeters > 0 && Number.isInteger(value.maximumLevel) &&
    value.maximumLevel >= 0 && value.maximumLevel < 40 && Number.isSafeInteger(value.maximumBytes) &&
    value.maximumBytes > 0 && value.maximumBytes <= 32 * 1024 * 1024 &&
    Number.isFinite(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 120000,
  'Invalid terrain query options')
  if (options.signal) invariant(typeof options.signal.addEventListener === 'function' &&
    typeof options.signal.removeEventListener === 'function', 'Invalid terrain query abort signal')
  return value
}

// One owned native reconstruction, with a bounded caller queue and two input
// slots. All continuation work uses the runtime's existing background clock.
class HeightQueries {
  constructor(runtime) {
    this.runtime = runtime; this.queue = []; this.active = null; this.next = 0
    this.absences = new Set()
    this.regions = new HeightRegions(runtime.resourceLedger)
    this.progress = null
  }

  // Navigation establishes this before display/detail production. A serial
  // default query then consumes owned credit, even when other pools are full.
  // This reserve is part of the existing ledger total, not extra headroom.
  reserveProgress() {
    const runtime = this.runtime
    if (this.progress && (this.progress.manifest !== runtime.manifest || this.progress.origin !== runtime.serviceOrigin)) {
      this.progress.workspace.retire(); this.progress = null
    }
    if (!this.progress) this.progress = {manifest: runtime.manifest, origin: runtime.serviceOrigin,
      bytes: queryFootprint(runtime.manifest, defaultQueryBytes(runtime.manifest)).totalBytes,
      workspace: new ResourceWorkspace('height-query')}
    const {workspace, bytes} = this.progress
    const missing = Math.max(0, bytes - workspace.bytes)
    if (!missing) return true
    const credit = runtime.resourceLedger.reserve('height-query', missing)
    if (!credit) return false
    workspace.accept(credit)
    return true
  }

  prepare(u, v, options = {}) {
    const value = queryOptions(u, v, options), runtime = this.runtime
    invariant(!runtime.destroyed && !runtime.paused && runtime.abi && !runtime.abi.destroyed,
      'Terrain query runtime is unavailable')
    if (this.manifest !== runtime.manifest || this.origin !== runtime.serviceOrigin) {
      this.manifest = runtime.manifest; this.origin = runtime.serviceOrigin
      this.absences.clear(); this.regions.clear()
      if (this.progress) this.reserveProgress()
    }
    const globe = runtime.manifest.transform === 'cylindrical'
    invariant(u >= (globe ? -180 : runtime.manifest.minimumU) && u <= (globe ? 180 : runtime.manifest.maximumU) &&
      v >= (globe ? -90 : runtime.manifest.minimumV) && v <= (globe ? 90 : runtime.manifest.maximumV),
    'Terrain query outside dataset coordinates')
    if (options.maximumBytes === undefined)
      value.maximumBytes = defaultQueryBytes(runtime.manifest)
    value.maximumLevel = Math.min(value.maximumLevel,
      runtime.manifest.maximumDataLevel === undefined ? 39 : runtime.manifest.maximumDataLevel)
    return value
  }

  peek(u, v, options = {}) {
    return this.regions.sample(this.prepare(u, v, options), this.runtime.manifest)
  }

  query(u, v, options = {}) {
    const value = this.prepare(u, v, options), runtime = this.runtime
    if (options.signal && options.signal.aborted)
      return Promise.reject(error('terrain_query_cancelled', 'Terrain query cancelled'))
    const cached = this.regions.sample(value, runtime.manifest)
    if (cached) return Promise.resolve(cached)
    invariant(this.queue.length < 16, 'Terrain query queue capacity exceeded')
    const job = {options: value, manifest: runtime.manifest, origin: runtime.serviceOrigin,
      key: 'height-query-' + ++this.next, inputs: new Map(),
      tasks: new Set(), producers: new Set(), waits: new Set(), signal: options.signal}
    const promise = new Promise((resolve, reject) => Object.assign(job, {resolve, reject}))
    job.abort = () => this.cancel(job, error('terrain_query_cancelled', 'Terrain query cancelled'))
    job.timer = setTimeout(() => this.cancel(job, error('terrain_query_timeout', 'Terrain query timed out')), value.timeoutMs)
    if (job.signal) job.signal.addEventListener('abort', job.abort, {once: true})
    this.queue.push(job)
    if (job.signal && job.signal.aborted) job.abort()
    this.pump()
    return promise
  }

  releaseListeners(job) {
    clearTimeout(job.timer)
    if (job.signal) job.signal.removeEventListener('abort', job.abort)
  }

  cancel(job, cause) {
    if (job.finished || job.cancelled) return
    job.cancelled = cause
    job.tasks.forEach(task => task.abort())
    job.waits.forEach(wake => wake())
    const index = this.queue.indexOf(job)
    if (index >= 0) {
      this.queue.splice(index, 1); job.finished = true
      this.releaseListeners(job); job.reject(cause)
    }
  }

  cancelAll(code = 'terrain_query_cancelled') {
    const cause = error(code, 'Terrain query runtime was paused, replaced or destroyed')
    if (this.active) this.cancel(this.active, cause)
    for (const job of this.queue.slice()) this.cancel(job, cause)
  }
  destroy() {
    this.cancelAll(); this.regions.clear(); this.absences.clear()
    if (this.progress) this.progress.workspace.retire()
    this.progress = null
  }

  check(job) {
    if (job.cancelled) throw job.cancelled
    if (job.closing) throw error('terrain_query_cancelled', 'Terrain query is closing')
    if (this.runtime.destroyed || this.runtime.paused || this.runtime.abi !== job.abi || job.abi.destroyed ||
      this.runtime.manifest !== job.manifest || this.runtime.serviceOrigin !== job.origin)
      throw error('terrain_query_cancelled', 'Terrain query runtime was replaced')
  }

  yield(job, delay = 0) {
    this.check(job)
    return new Promise(resolve => {
      const key = job.key + '-work-' + (job.nextWait = (job.nextWait || 0) + 1)
      const wake = () => {
        this.runtime.frameClock.cancelWork(key)
        job.waits.delete(wake); resolve()
      }
      job.waits.add(wake)
      this.runtime.frameClock.enqueueWork(key, wake, delay)
    })
  }

  pump() {
    if (this.active || !this.queue.length) return
    const job = this.active = this.queue.shift()
    job.abi = this.runtime.abi
    this.run(job).then(result => job.cancelled ? job.reject(job.cancelled) : job.resolve(result), job.reject).finally(() => {
      job.finished = true; this.releaseListeners(job)
      this.active = null; this.pump()
    })
  }

  async run(job) {
    const runtime = this.runtime, abi = job.abi
    const n = runtime.manifest.patchDimension + 1
    const {ingressBytes, totalBytes} = queryFootprint(job.manifest, job.options.maximumBytes)
    job.ingressBytes = ingressBytes
    const progress = this.progress
    const acquire = () => {
      if (!progress) return runtime.resourceLedger.reserve('height-query', totalBytes)
      const workspace = progress.workspace
      if (workspace.retired) return null
      const missing = Math.max(0, totalBytes - workspace.availableBytes)
      if (missing) {
        const extra = runtime.resourceLedger.reserve('height-query', missing)
        if (!extra) return null
        workspace.accept(extra)
      }
      return workspace.take(totalBytes)
    }
    let credit, id
    try {
      this.check(job)
      const cached = this.regions.sample(job.options, job.manifest)
      if (cached) return cached
      credit = acquire()
      if (!credit) { await runtime.resourceLedger.reclamation.pending; this.check(job)
        credit = acquire() }
      if (!credit) throw error('terrain_query_capacity', 'Terrain query resources are occupied')
      job.credit = credit
      this.check(job)
      const initial = await abi.beginHeightQuery(job.options)
      id = job.id = initial.id
      this.check(job)
      for (;;) {
        const state = await abi.stepHeightQuery(id, 32)
        this.check(job)
        if (state.state >= 4) {
          if (state.state === 7) throw error(state.reasons & 8 ? 'terrain_query_capacity' : 'terrain_query_failed',
            'Terrain query reconstruction failed: ' + state.reasons)
          const result = Object.assign({}, state.sample, {
            status: state.state === 4 ? 'ready' : state.state === 5 ? 'limited' : 'unavailable',
            source: 'cbdam-query', requestedSampleSpacingMeters: job.options.sampleSpacingMeters,
            verticalAccuracyMeters: null, reasons: reasonNames.filter(([flag]) => state.reasons & flag).map(([, name]) => name),
            peakBytes: state.peakBytes, cacheHit: false})
          if (result.available && !(state.reasons & (2 | 8 | 16))) {
            const reservation = this.regions.reserve(runtime.manifest.patchDimension)
            if (reservation) {
              try {
                const region = await abi.getHeightQueryRegion(id, n * (n + 1) / 2)
                this.check(job)
                this.regions.publish(reservation, region, result)
              } finally { reservation.cancel() }
            }
          }
          return result
        }
        for (const request of state.requests) {
          if (job.inputs.size >= 2) break
          const key = patchKeyString(request.kind, request.key)
          if (job.inputs.has(key)) continue
          const task = this.load(job, request).catch(cause => { if (!job.closing) this.cancel(job, cause) })
            .finally(() => job.inputs.delete(key))
          job.inputs.set(key, task)
        }
        if (state.state === 3) {
          invariant(job.inputs.size, 'Height query waits without a record producer')
          await Promise.race(job.inputs.values())
        } else await this.yield(job)
        this.check(job)
      }
    } finally {
      job.closing = true
      job.tasks.forEach(task => task.abort())
      job.waits.forEach(wake => wake())
      if (credit) credit.mark('retired')
      await Promise.allSettled(Array.from(job.inputs.values()))
      await Promise.allSettled(Array.from(job.producers))
      try { if (id && !abi.destroyed) await abi.endHeightQuery(id) }
      finally {
        if (credit) credit.release()
        if (progress) progress.workspace.trim(progress.bytes)
      }
    }
  }

  async load(job, request) {
    const runtime = this.runtime, key = patchKeyString(request.kind, request.key)
    const submit = async bytes => {
      this.check(job)
      invariant(bytes.byteLength <= job.ingressBytes, 'Height record exceeds ingress credit')
      await job.abi.submitHeightQueryRecord(job.id, request.kind, request.key, bytes)
    }
    const cached = runtime.recordCache.get(key)
    if (cached) { await submit(cached); return }
    const endpoint = request.kind === 1 ? runtime.manifest.rootEndpoint : runtime.manifest.detailEndpoint
    const url = joinServiceUrl(runtime.serviceOrigin, replaceTemplate(endpoint, request.key))
    if (this.absences.has(url)) {
      this.check(job)
      await job.abi.heightQueryUnavailable(job.id, request.kind, request.key, false)
      return
    }
    for (let attempt = 0; ; ++attempt) {
      this.check(job)
      const task = runtime.terrainTransport.request({url, method: 'GET', responseType: 'arraybuffer', timeout: 15000,
        maximumResponseBytes: maximumEncodedRecordBytes(job.manifest.patchDimension, request.kind)},
        request.kind === 1 ? 0x7fffffff : 0x50000000)
      job.tasks.add(task); job.producers.add(task.done)
      task.done.then(() => job.producers.delete(task.done))
      try {
        const response = await task.promise
        this.check(job)
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const noData = response.statusCode === 404 && isMissingTerrainRecord(response.data)
          if (noData) {
            this.absences.add(url)
            if (this.absences.size > 1024) this.absences.delete(this.absences.values().next().value)
            await job.abi.heightQueryUnavailable(job.id, request.kind, request.key, false); return
          }
          throw Object.assign(new Error('Terrain query HTTP ' + response.statusCode), {statusCode: response.statusCode})
        }
        const bytes = validateRecordPayload(response.data, response.header)
        await submit(bytes)
        this.check(job)
        const reservation = runtime.recordCache.reserve(key, bytes.byteLength)
        if (reservation) { try { reservation.commit(bytes.slice()) } finally { reservation.cancel() } }
        return
      } catch (cause) {
        this.check(job)
        if (cause.status === 5) throw error('terrain_query_capacity', cause.message)
        if (cause.status === 4) throw cause
        if (cause.retryable === false || attempt >= runtime.maximumTerrainRetries || cause.statusCode === 404 || cause.statusCode === 410) {
          await job.abi.heightQueryUnavailable(job.id, request.kind, request.key, true); return
        }
        await this.yield(job, (attempt + 1) * runtime.terrainRetryDelayMs)
      } finally { job.tasks.delete(task) }
    }
  }

  stats() { return {active: this.active ? 1 : 0, queued: this.queue.length,
    ownedBytes: this.active && this.active.credit ? this.active.credit.bytes : 0,
    progressBytes: this.progress ? this.progress.workspace.bytes : 0,
    progressAvailableBytes: this.progress ? this.progress.workspace.availableBytes : 0,
    progressRequiredBytes: this.progress ? this.progress.bytes : 0,
    requests: this.active ? this.active.inputs.size : 0, regions: this.regions.stats()} }
}

module.exports = {HeightQueries, queryOptions}
