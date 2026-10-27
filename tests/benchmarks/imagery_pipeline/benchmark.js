const assert = require('assert')
const {EncodedTextureStore} = require('../../../adapters/browser/encoded_texture_store')
const {ResourceLedger} = require('../../../sdk/js/resources/resource_ledger')

// Virtual service/decode/GPU latency, real SDK scheduling and byte ownership.
// This isolates throughput policy; it is not a browser or network speed test.
class Clock {
  constructor() { this.now = 0; this.serial = 0; this.jobs = new Map() }
  schedule(callback, ms = 0) {
    const id = ++this.serial
    this.jobs.set(id, {at: this.now + ms, callback})
    return id
  }
  delay(ms) { return new Promise(resolve => this.schedule(resolve, ms)) }
  async drain() { await new Promise(resolve => setImmediate(resolve)) }
  async until(done) {
    await this.drain()
    for (let steps = 0; !done(); ++steps) {
      assert(steps < 50000 && this.now < 120000, 'Pipeline failed to converge within its observation bound')
      const next = Array.from(this.jobs).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      assert(next, 'Pipeline stalled without a producer or wakeup')
      this.jobs.delete(next[0]); this.now = next[1].at; next[1].callback()
      await this.drain()
    }
  }
}

async function run(options = {}) {
  const config = Object.assign({tiles: 384, requests: 8, headerMs: 20, bodyMs: 120,
    decodeMs: 8, receiptMs: 16, resourceTurnMs: 16, sharedBytes: 256 * 1048576}, options)
  const clock = new Clock(), native = {setTimeout, clearTimeout, dateNow: Date.now,
    performance: Object.getOwnPropertyDescriptor(global, 'performance'), bitmap: global.createImageBitmap,
    Blob: global.Blob, AbortController: global.AbortController}
  let store, result, resourceTimer = null, submission = null, turn = null, disposed = false
  const metrics = {requests: 0, bodies: 0, activeBodies: 0, peakBodies: 0, inputWaitMs: 0,
    bitmaps: 0, peakBitmaps: 0, uploads: 0, failed: []}
  global.setTimeout = (fn, ms, ...args) => clock.schedule(() => fn(...args), ms)
  global.clearTimeout = id => clock.jobs.delete(id)
  Date.now = () => clock.now
  Object.defineProperty(global, 'performance', {configurable: true, value: {now: () => clock.now}})
  if (!global.Blob) global.Blob = class { constructor(chunks) { this.size = chunks.reduce((n, c) => n + c.byteLength, 0) } }
  if (!global.AbortController) global.AbortController = class {
    constructor() { this.signal = {aborted: false} }
    abort() { this.signal.aborted = true }
  }
  global.createImageBitmap = async () => {
    await clock.delay(config.decodeMs)
    ++metrics.bitmaps; metrics.peakBitmaps = Math.max(metrics.peakBitmaps, metrics.bitmaps)
    let closed = false
    return {width: 256, height: 256, close() {
      assert(!closed, 'Bitmap closed twice'); closed = true; --metrics.bitmaps
    }}
  }
  const requestResources = () => {
    if (disposed || resourceTimer !== null) return
    resourceTimer = clock.schedule(() => {
      resourceTimer = null; turn = []
      store.processUploads(Infinity)
      if (turn.length) {
        submission = turn
        const submitted = submission
        clock.schedule(() => {
          for (const upload of submitted) { upload.commit({}); ++metrics.uploads }
          submission = null; requestResources()
        }, config.receiptMs)
      }
      turn = null
    }, config.resourceTurnMs)
  }
  const ledger = new ResourceLedger(config.sharedBytes)
  const renderer = {canvas: {ownerDocument: {}}, gl: {deleteTexture() {}}, presentedTextures: new Map(),
    resourceLedger: ledger, uploadBatch: true, requestResources, requestRender() {},
    uploadTexture(image, width, height, commit, cancel) {
      if (submission || turn.length >= 8) { cancel(); return false }
      turn.push({commit, cancel}); return true
    },
    options: {managedResources: true, textureDescriptor: {tile_size: 256},
      fetchTextures: async (url, {signal}) => {
        ++metrics.requests
        await clock.delay(config.headerMs)
        const headersAt = clock.now
        let read = false, active = false
        return {ok: true, headers: {get: () => 'image/png'}, body: {cancel: async () => {},
          getReader: () => ({
            read: async () => {
              if (read) return {done: true}
              read = active = true
              ++metrics.bodies; ++metrics.activeBodies
              metrics.peakBodies = Math.max(metrics.peakBodies, metrics.activeBodies)
              metrics.inputWaitMs += clock.now - headersAt
              await clock.delay(config.bodyMs)
              active = false; --metrics.activeBodies
              if (signal.aborted) throw Object.assign(new Error('Cancelled fixture body'), {name: 'AbortError'})
              return {done: false, value: new Uint8Array(16384)}
            }, cancel: async () => { if (active) throw new Error('Body released before its read receipt') },
            releaseLock() {}
          })}}
      }}}
  try {
    store = new EncodedTextureStore(renderer, {maximumBytes: 200 * 1048576, maximumEntries: 1024,
      maximumConcurrent: config.requests, maximumRetries: 0, prefetchAncestors: false, directTargets: true,
      urlForTile: tile => 'https://fixture.invalid/' + tile.row + '/' + tile.column,
      onDiagnostic: (name, detail) => { if (name === 'texture_load_failed') metrics.failed.push(detail) }})
    if (config.inputEnvelopes !== undefined) {
      store.maximumInputBytes = config.inputEnvelopes * store.inputEnvelopeBytes
      store.maximumPipelineBytes = store.maximumInputBytes + 2 * store.decodeBytes
    }
    const tiles = Array.from({length: config.tiles}, (_, i) =>
      ({level: 5, matrix: 6, row: Math.floor(i / 64), column: i % 64}))
    const keys = tiles.map(t => [t.level, t.matrix, t.row, t.column].join('/'))
    store.sync(tiles.map(texture => ({texture})), [])
    await clock.until(() => keys.every(key => store.gpuReady(key)) && !submission)
    assert.strictEqual(metrics.failed.length, 0)
    assert.strictEqual(metrics.uploads, config.tiles)
    assert.strictEqual(metrics.requests, config.tiles, 'Demand was fetched more than once')
    assert.strictEqual(metrics.bitmaps, 0, 'GPU receipt retained decoded pixels')
    result = {config, virtualCompletionMs: clock.now, metrics,
      inputHighWaterBytes: store.inputHighWaterBytes, maximumInputBytes: store.maximumInputBytes,
      maximumPipelineBytes: store.maximumPipelineBytes, managedHighWaterBytes: ledger.highWaterBytes}
    return result
  } finally {
    disposed = true
    if (resourceTimer !== null) clock.jobs.delete(resourceTimer)
    try {
      if (store) store.destroy()
      await clock.until(() => !clock.jobs.size)
      assert.strictEqual(ledger.bytes, 0, 'Pipeline teardown leaked resource credit')
      assert.strictEqual(metrics.bitmaps, 0)
      assert.strictEqual(metrics.activeBodies, 0)
      if (result) result.cleanup = {managedBytes: ledger.bytes, bitmaps: metrics.bitmaps,
        activeBodies: metrics.activeBodies, timers: clock.jobs.size}
    } finally {
      global.setTimeout = native.setTimeout; global.clearTimeout = native.clearTimeout
      Date.now = native.dateNow
      if (native.performance) Object.defineProperty(global, 'performance', native.performance)
      else delete global.performance
      global.createImageBitmap = native.bitmap; global.Blob = native.Blob; global.AbortController = native.AbortController
    }
  }
}

module.exports = {run}
if (require.main === module) {
  ;(async () => {
    const result = []
    for (const options of [{requests: 3, inputEnvelopes: 2}, {requests: 8, inputEnvelopes: 2},
      {requests: 8, inputEnvelopes: 8}, {requests: 8}]) result.push(await run(options))
    console.log(JSON.stringify({scope: 'Controlled SDK image pipeline; virtual milliseconds, no live network or physical GPU', result}, null, 2))
  })().catch(error => {console.error(error); process.exitCode = 1})
}
