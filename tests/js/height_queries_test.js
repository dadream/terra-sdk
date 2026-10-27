const assert = require('assert')
const {TerrainTransport} = require('../../sdk/js/terrain/terrain_transport')
const {HeightQueries} = require('../../sdk/js/terrain/height_queries')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ResourceCache} = require('../../sdk/js/resources/resource_cache')
const {FrameCoordinator} = require('../../sdk/js/runtime/frame_coordinator')
const {fnv1a64} = require('../../sdk/js/core/terra_globe_common')

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = () => { let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return {promise, resolve, reject} }
class TestAbortController {
  constructor() {
    this.listeners = new Set()
    this.signal = {aborted: false, addEventListener: (type, callback) => this.listeners.add(callback),
      removeEventListener: (type, callback) => this.listeners.delete(callback)}
  }
  abort() { this.signal.aborted = true; this.listeners.forEach(callback => callback()) }
}
const options = url => ({url, method: 'GET', responseType: 'arraybuffer', maximumResponseBytes: 71696})
const response = () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  return {statusCode: 200, data: bytes.buffer, header: {'content-length': '4',
    'x-terra-checksum': 'fnv1a64:' + fnv1a64(bytes)}}
}
const region = () => ({dimension: 64, geometrySpacingMeters: 25, heightScale: 1,
  corners: [-134217728, 0, -134217728, -134217728, 268435456, -134217728, -134217728, 0, 134217728],
  heights: new Int32Array(2145).fill(123)})
async function completeInputs(f, offset = 0) {
  for (let i = offset; i < offset + 3; ++i) {
    for (let spin = 0; spin < 50 && f.started.length <= i; ++spin) await tick()
    f.started[i].resolve(response())
    for (let spin = 0; spin < 50 && f.submits.length <= i; ++spin) await tick()
    f.submits[i].resolve()
  }
}

async function sharedTransport() {
  const started = []
  const transport = new TerrainTransport(value => {
    const request = Object.assign(deferred(), {url: value.url, aborts: 0})
    started.push(request)
    return {promise: request.promise, abort: () => { ++request.aborts }}
  }, 1)
  const render = transport.request(options('a'))
  const query = transport.request(options('a'), 3)
  assert.strictEqual(started.length, 1)
  const cancelled = assert.rejects(query.promise, /cancelled/)
  query.abort(); await cancelled
  assert.strictEqual(started[0].aborts, 0, 'query cancellation aborted display-owned download')
  let done = false; query.done.then(() => { done = true })
  await tick(); assert(!done, 'producer credit refunded before producer exit')
  started[0].resolve(response()); await render.promise; await query.done
  const a = transport.request(options('a'))
  const b = transport.request(options('b'))
  const rejecting = assert.rejects(b.promise, /cancelled/)
  b.abort(); await rejecting; await b.done
  assert(!started.some(value => value.url === 'b'), 'cancelled queued GET started')
  const aCancelled = assert.rejects(a.promise, /cancelled/)
  transport.destroy(); await aCancelled
  assert.strictEqual(started[1].aborts, 1)
  started[1].reject(new Error('aborted')); await a.done; await tick()
  assert.strictEqual(transport.scheduler.stats().active, 0)
  assert.strictEqual(transport.entries.size, 0)
}

function fixture() {
  const ledger = new ResourceLedger(), started = [], submits = [], releases = []
  const runtime = {resourceLedger: ledger, manifest: {patchDimension: 64, transform: 'cylindrical',
    rootEndpoint: '/root/{i}/{j}/{k}', detailEndpoint: '/detail/{i}/{j}/{k}'},
    serviceOrigin: 'http://localhost', maximumTerrainRetries: 1, terrainRetryDelayMs: 1,
    recordCache: new ResourceCache({ledger, owner: 'records', maximumBytes: 1024, maximumEntries: 16}),
    frameClock: new FrameCoordinator({requestFrame: () => { throw Error('Query requested display') },
      render: () => { throw Error('Query rendered') }})}
  runtime.terrainTransport = new TerrainTransport(value => {
    const request = Object.assign(deferred(), {url: value.url})
    started.push(request)
    return {promise: request.promise, abort: () => request.reject(new Error('cancelled'))}
  }, 2)
  let current, serial = 0
  runtime.abi = {
    beginHeightQuery: async value => {
      assert(ledger.bytes > 0, 'native query started before admission')
      current = {id: ++serial, pending: [0, 1, 2].map(i => ({kind: 1, key: {level: 0, i, j: 0, k: 0}})), value}
      return {id: current.id}
    },
    stepHeightQuery: async id => {
      assert.strictEqual(id, current.id)
      return {state: current.pending.length ? 3 : 4, requests: current.pending.slice(), reasons: 0,
        peakBytes: 1024, sample: {available: true, heightMeters: 123,
          level: 4, dataLevel: 4, sampleSpacingMeters: 25, revision: id}}
    },
    submitHeightQueryRecord: async (id, kind, key) => {
      assert.strictEqual(id, current.id)
      const waiter = deferred(); submits.push(waiter)
      await waiter.promise
      current.pending = current.pending.filter(r => r.key.i !== key.i)
    },
    heightQueryUnavailable: async (id, kind, key) => {
      current.pending = current.pending.filter(r => r.key.i !== key.i)
    },
    getHeightQueryRegion: async () => null,
    endHeightQuery: async id => {
      assert(ledger.bytes > 0, 'query credit released before native destruction receipt')
      releases.push(id); current = null
    }
  }
  const queries = new HeightQueries(runtime)
  const close = async () => {
    queries.destroy(); runtime.terrainTransport.destroy()
    submits.forEach(value => value.resolve())
    while (queries.active) await tick()
    runtime.frameClock.destroy(); runtime.recordCache.clear()
    assert.strictEqual(ledger.bytes, 0)
  }
  return {runtime, queries, started, submits, releases, close}
}

async function main() {
  await require('./terrain_input_contract')()
  await sharedTransport()

  // A default navigation query keeps a funded serial path even when pinned
  // imagery occupies every remaining byte. Completion returns the same credit
  // to the next query, instead of racing image admission for a fresh reserve.
  const protectedQuery = fixture()
  let imagery
  try {
    assert(protectedQuery.queries.reserveProgress())
    const memory = protectedQuery.runtime.resourceLedger
    const initial = protectedQuery.queries.stats(), required = initial.progressRequiredBytes
    assert.strictEqual(initial.progressBytes, required)
    assert.strictEqual(initial.progressAvailableBytes, required)
    assert(required > 2 * 1024 * 1024, 'Progress quote omitted query input/export workspace')
    memory.setLimit(required + 20)
    imagery = memory.reserve('displayed-imagery', 20)
    assert(imagery)
    assert.strictEqual(memory.reserve('detail', 1), null)
    for (let i = 0; i < 2; ++i) {
      const result = protectedQuery.queries.query(116 + i, 40)
      await completeInputs(protectedQuery, i * 3)
      assert.strictEqual((await result).status, 'ready')
      await tick()
      const state = protectedQuery.queries.stats()
      assert.strictEqual(state.progressBytes, required)
      assert.strictEqual(state.progressAvailableBytes, required)
      assert.strictEqual(state.ownedBytes, 0)
      assert.strictEqual(memory.bytes, memory.maximumBytes, 'Funded query charged a second envelope or lost its reserve')
      assert.strictEqual(memory.reserve('detail', 1), null)
    }
    assert.strictEqual(memory.highWaterBytes, memory.maximumBytes)
  } finally { if (imagery) imagery.release(); await protectedQuery.close() }

  // An explicit larger query may borrow spare global space. Only its default
  // continuation reserve survives; a source change/destroy cannot refund a
  // still-running input or native submission to another module.
  const larger = fixture()
  try {
    assert(larger.queries.reserveProgress())
    const original = larger.queries.stats().progressBytes
    const pending = larger.queries.query(116, 40, {maximumBytes: 4 * 1024 * 1024})
    await completeInputs(larger)
    await pending; await tick()
    assert.strictEqual(larger.queries.stats().progressBytes, original,
      'An exceptional query permanently enlarged the navigation reserve')
    const controller = new TestAbortController()
    larger.runtime.recordCache.clear()
    const delayed = larger.queries.query(0, 0, {signal: controller.signal})
    const rejected = assert.rejects(delayed, cause => cause.code === 'terrain_query_cancelled')
    for (let i = 0; i < 20 && larger.started.length < 5; ++i) await tick()
    larger.started[3].resolve(response())
    for (let i = 0; i < 20 && larger.submits.length < 4; ++i) await tick()
    larger.queries.destroy()
    assert(larger.runtime.resourceLedger.stats().retiredBytes >= original,
      'Destroy refunded the protected query before its input/native receipts')
    larger.submits[3].resolve(); await rejected; await tick()
    assert.strictEqual(larger.queries.stats().progressBytes, 0)
    assert(!Array.from(larger.runtime.resourceLedger.leases).some(v => v.owner === 'height-query'))
  } finally { await larger.close() }

  const insufficient = fixture()
  try {
    insufficient.runtime.resourceLedger.setLimit(16)
    assert.strictEqual(insufficient.queries.reserveProgress(), false)
    assert.strictEqual(insufficient.queries.stats().progressBytes, 0)
    await assert.rejects(insufficient.queries.query(0, 0), cause => cause.code === 'terrain_query_capacity')
    assert.strictEqual(insufficient.started.length, 0)
  } finally { await insufficient.close() }

  const replaced = fixture()
  try {
    assert(replaced.queries.reserveProgress())
    const oldProgress = replaced.queries.progress
    const pending = replaced.queries.query(116, 40)
    const rejected = assert.rejects(pending, cause => cause.code === 'terrain_query_cancelled')
    for (let i = 0; i < 20 && replaced.started.length < 2; ++i) await tick()
    replaced.started[0].resolve(response())
    for (let i = 0; i < 20 && !replaced.submits.length; ++i) await tick()
    replaced.runtime.manifest = Object.assign({}, replaced.runtime.manifest)
    replaced.runtime.serviceOrigin = 'http://replacement.invalid'
    assert(replaced.queries.reserveProgress())
    assert(oldProgress.workspace.retired)
    assert.strictEqual(oldProgress.workspace.bytes, oldProgress.bytes,
      'Replacing the source refunded an in-flight native query')
    replaced.submits[0].resolve(); await rejected; await tick()
    assert.strictEqual(oldProgress.workspace.bytes, 0)
    assert.strictEqual(replaced.queries.stats().progressAvailableBytes, replaced.queries.stats().progressRequiredBytes)
    assert.strictEqual(replaced.runtime.recordCache.entries.size, 0,
      'An old query published a late record into the replacement source cache')
  } finally { await replaced.close() }
  const f = fixture()
  try {
    const result = f.queries.query(116, 40)
    for (let i = 0; i < 20 && f.started.length < 2; ++i) await tick()
    assert.strictEqual(f.started.length, 2, 'input concurrency is not bounded by two slots')
    f.started[1].resolve(response()); f.started[0].resolve(response())
    for (let i = 0; i < 20 && f.submits.length < 2; ++i) await tick()
    assert.strictEqual(f.started.length, 2, 'network completion released slot before Worker submission')
    f.submits[1].resolve(); f.submits[0].resolve()
    for (let i = 0; i < 20 && f.started.length < 3; ++i) await tick()
    assert.strictEqual(f.started.length, 3)
    f.started[2].resolve(response())
    for (let i = 0; i < 20 && f.submits.length < 3; ++i) await tick()
    f.submits[2].resolve()
    const value = await result
    assert.strictEqual(value.status, 'ready'); assert.strictEqual(value.heightMeters, 123)
    assert.strictEqual(value.verticalAccuracyMeters, null)
    assert.deepStrictEqual(f.releases, [1])
    assert(!Array.from(f.runtime.resourceLedger.leases).some(v => v.owner === 'height-query'))
  } finally { await f.close() }

  const cancelled = fixture()
  try {
    const controller = new TestAbortController()
    const pending = cancelled.queries.query(116, 40, {signal: controller.signal})
    const rejected = assert.rejects(pending, cause => cause.code === 'terrain_query_cancelled')
    for (let i = 0; i < 20 && cancelled.started.length < 2; ++i) await tick()
    cancelled.started[0].resolve(response())
    for (let i = 0; i < 20 && !cancelled.submits.length; ++i) await tick()
    controller.abort(); await tick()
    assert.strictEqual(cancelled.releases.length, 0, 'in-flight native submission was released early')
    assert(Array.from(cancelled.runtime.resourceLedger.leases).some(v => v.owner === 'height-query' && v.phase === 'retired'))
    cancelled.submits[0].resolve(); await rejected
    assert.deepStrictEqual(cancelled.releases, [1])
  } finally { await cancelled.close() }

  const limited = fixture()
  try {
    limited.runtime.resourceLedger.setLimit(16)
    await assert.rejects(limited.queries.query(0, 0), cause => cause.code === 'terrain_query_capacity')
    assert.strictEqual(limited.started.length, 0); assert.strictEqual(limited.releases.length, 0)
  } finally { await limited.close() }

  const absent = fixture()
  try {
    const first = absent.queries.query(0, 0)
    for (let i = 0; i < 3; ++i) {
      for (let spin = 0; spin < 50 && absent.started.length <= i; ++spin) await tick()
      absent.started[i].resolve({statusCode: 404, data: new Uint8Array(Buffer.from(JSON.stringify({error: {code: 'patch_not_found'}}))).buffer})
    }
    await first
    await absent.queries.query(0, 0)
    assert.strictEqual(absent.started.length, 3, 'Confirmed absence was requested again')
    // The same URLs under a new dataset lifetime must be queried again.
    absent.runtime.manifest = Object.assign({}, absent.runtime.manifest)
    const next = absent.queries.query(0, 0)
    for (let i = 3; i < 6; ++i) {
      for (let spin = 0; spin < 50 && absent.started.length <= i; ++spin) await tick()
      absent.started[i].resolve({statusCode: 404, data: new Uint8Array(Buffer.from(JSON.stringify({error: {code: 'patch_not_found'}}))).buffer})
    }
    await next
    assert.strictEqual(absent.started.length, 6)
  } finally { await absent.close() }

  const reused = fixture()
  try {
    reused.runtime.abi.getHeightQueryRegion = async () => region()
    const first = reused.queries.query(116, 40)
    await completeInputs(reused)
    assert.strictEqual((await first).cacheHit, false)
    const original = await reused.queries.query(116.001, 40.001)
    assert(original.cacheHit && original.heightMeters === 123)
    assert.strictEqual(reused.started.length, 3)
    assert.deepStrictEqual(reused.releases, [1], 'Nearby sampling reconstructed another native query')
    assert.strictEqual(reused.queries.stats().regions.entries, 1)
    assert.strictEqual(reused.queries.peek(116.002, 40.002).heightMeters, 123)
    assert.strictEqual(reused.queries.peek(0, 0), null)
    assert.strictEqual(reused.queries.peek(116, 40, {sampleSpacingMeters: 1}), null)
    assert.throws(() => reused.queries.peek(181, 0), /outside dataset/)
    const controller = new TestAbortController(); controller.abort()
    await assert.rejects(reused.queries.query(116, 40, {signal: controller.signal}),
      cause => cause.code === 'terrain_query_cancelled')
    assert.throws(() => reused.queries.query(181, 40), /outside dataset/)
    // Global pressure may reclaim the unpinned cache, without a hidden owner.
    const bytes = reused.runtime.resourceLedger.bytes
    reused.runtime.resourceLedger.setLimit(bytes)
    const lease = reused.runtime.resourceLedger.reserve('pressure', bytes)
    assert(lease)
    assert.strictEqual(reused.queries.stats().regions.entries, 0, 'Global pressure cannot reclaim height regions')
    lease.release()
    assert.strictEqual(reused.queries.stats().regions.bytes, 0)
  } finally { await reused.close() }

  for (const cancellation of ['abort', 'destroy']) {
    const exported = fixture()
    try {
      const transfer = deferred(), controller = new TestAbortController()
      let copying = false
      exported.runtime.abi.getHeightQueryRegion = async () => { copying = true; return transfer.promise }
      const pending = exported.queries.query(116, 40, {signal: controller.signal})
      const rejected = assert.rejects(pending, cause => cause.code === 'terrain_query_cancelled')
      await completeInputs(exported)
      for (let spin = 0; spin < 50 && !copying; ++spin) await tick()
      assert(copying)
      if (cancellation === 'abort') controller.abort()
      else exported.queries.destroy()
      await tick()
      assert.strictEqual(exported.releases.length, 0, 'Export credit refunded before transfer receipt')
      assert(exported.queries.stats().ownedBytes > 0, 'Pending query ownership disappeared from diagnostics')
      assert.strictEqual(exported.queries.stats().regions.reservedEntries, 1)
      transfer.resolve(region()); await rejected
      assert.strictEqual(exported.queries.stats().regions.entries, 0, 'Cancelled result entered cache')
      assert.strictEqual(exported.queries.stats().regions.reservedBytes, 0)
      assert.strictEqual(exported.queries.stats().ownedBytes, 0)
      assert.deepStrictEqual(exported.releases, [1])
    } finally { await exported.close() }
  }
  console.log('Independent height admission, shared GET ownership, input slots and cancellation receipts passed')
}
main().catch(cause => { console.error(cause.stack); process.exitCode = 1 })
