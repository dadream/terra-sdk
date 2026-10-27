const assert = require('assert')

const common = require('../../sdk/js/core/terra_globe_common')

function bytes(value) {
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

function manifest() {
  return {
    schema: 'terra.dataset-manifest',
    schema_version: 1,
    dataset_id: 'globe',
    format_version: 1,
    patch_dim: 64,
    height_scale: 1,
    transform: {
      kind: 'cylindrical',
      bounds: [[-180, -90], [180, 90]],
      radius: 6378000
    },
    endpoints: {
      root: '/terra/v1/datasets/globe/root/{i}/{j}/{k}',
      detail: '/terra/v1/datasets/globe/detail/{i}/{j}/{k}'
    },
    textures: [{
      id: 'blue-marble',
      kind: 'global-geodetic',
      url_template: 'https://tiles.example/{z}/{x}/{y}.jpg',
      matrix_level_offset: 0,
      maximum_level: 8
    }]
  }
}

async function testScheduler() {
  const scheduler = new common.RequestScheduler(1)
  const events = []
  let resolveFirst = null
  scheduler.enqueue('first', () => ({
    promise: new Promise((resolve) => {
      resolveFirst = resolve
    }),
    abort() {
      events.push('first-aborted')
      resolveFirst()
    }
  }))
  scheduler.enqueue('second', () => ({
    promise: Promise.resolve(),
    abort() {}
  }))
  scheduler.cancelExcept(new Set(['second']))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepStrictEqual(events, ['first-aborted'])
  assert.strictEqual(scheduler.stats().active, 0)
  assert.strictEqual(scheduler.stats().queued, 0)
}

async function testSchedulerRestartsStaleKey() {
  const scheduler = new common.RequestScheduler(1)
  const events = []
  let resolveFirst = null
  scheduler.enqueue('tile', () => ({
    promise: new Promise((resolve) => { resolveFirst = resolve }),
    abort() {
      events.push('aborted')
      resolveFirst()
    }
  }))
  scheduler.cancelExcept(new Set())
  scheduler.enqueue('tile', () => {
    events.push('restarted')
    return { promise: Promise.resolve(), abort() {} }
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepStrictEqual(events, ['aborted', 'restarted'])
  assert.strictEqual(scheduler.stats().active, 0)
  assert.strictEqual(scheduler.stats().queued, 0)

  let resolveDiscarded = null
  scheduler.enqueue('discarded', () => ({
    promise: new Promise((resolve) => { resolveDiscarded = resolve }),
    abort() { resolveDiscarded() }
  }))
  scheduler.cancelExcept(new Set())
  scheduler.enqueue('discarded', () => {
    events.push('unexpected-restart')
    return { promise: Promise.resolve(), abort() {} }
  })
  scheduler.cancelExcept(new Set())
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert(!events.includes('unexpected-restart'))
}

async function testSchedulerPriority() {
  const scheduler = new common.RequestScheduler(1)
  const events = []
  let releaseActive = null
  scheduler.enqueue('active', () => {
    events.push('active')
    return {
      promise: new Promise((resolve) => { releaseActive = resolve }),
      abort() { releaseActive() }
    }
  })
  scheduler.enqueue('support', () => {
    events.push('support')
    return { promise: Promise.resolve(), abort() {} }
  }, 0)
  scheduler.enqueue('target', () => {
    events.push('target')
    return { promise: Promise.resolve(), abort() {} }
  }, 10)
  releaseActive()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepStrictEqual(events, ['active', 'target', 'support'])
}

async function testSchedulerCameraRevisionAndPause() {
  const scheduler = new common.RequestScheduler(1)
  const order = []
  let release
  scheduler.enqueue('active', () => ({ promise: new Promise(resolve => { release = resolve }),
    abort() { release() } }))
  const start = key => () => { order.push(key); return { promise: Promise.resolve(), abort() {} } }
  scheduler.enqueue('old-center', start('old-center'), 100)
  scheduler.enqueue('new-center', start('new-center'), 50)
  scheduler.enqueue('old-center', start('old-center'), 1)
  release()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepStrictEqual(order, ['new-center', 'old-center'])
  scheduler.pause()
  scheduler.enqueue('paused', start('paused'), 1)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert(!order.includes('paused'))
  scheduler.resume()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert(order.includes('paused'))
  scheduler.clear()
  assert.deepStrictEqual(scheduler.stats(), { active: 0, queued: 0 })
}

async function testSchedulerReentrantStart() {
  const scheduler = new common.RequestScheduler(1)
  const events = []
  let finish
  scheduler.enqueue('outer', () => {
    events.push('outer')
    scheduler.enqueue('inner', () => {
      events.push('inner')
      return {promise: Promise.resolve(), abort() {}}
    })
    return {promise: new Promise(resolve => { finish = resolve }), abort() { finish() }}
  })
  try {
    assert.deepStrictEqual(events, ['outer'], 'Reentrant start exceeded the request concurrency limit')
    assert.strictEqual(scheduler.stats().active, 1)
  } finally { finish() }
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepStrictEqual(events, ['outer', 'inner'])

  let aborted = false
  scheduler.enqueue('cancel-during-start', () => {
    scheduler.pause()
    return {promise: new Promise(resolve => { finish = resolve }), abort() { aborted = true; finish() }}
  })
  try { assert(aborted, 'Pause during start lost cancellation of the newly returned producer') }
  finally { finish() }
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepStrictEqual(scheduler.stats(), {active: 0, queued: 0})
  scheduler.resume()
  scheduler.enqueue('throw-during-start', () => {
    scheduler.enqueue('after-throw', () => {
      events.push('after-throw')
      return {promise: Promise.resolve(), abort() {}}
    })
    throw new Error('Producer failed before returning a task')
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepStrictEqual(events, ['outer', 'inner', 'after-throw'])
  assert.deepStrictEqual(scheduler.stats(), {active: 0, queued: 0})
}

async function main() {
  await testSchedulerReentrantStart()
  await require('./request_admission_wait_contract')()
  await testSchedulerPriority()
  await testSchedulerCameraRevisionAndPause()
  const hello = bytes('hello')
  assert.strictEqual(common.fnv1a64(hello), 'a430d84680aabd0b')
  assert.deepStrictEqual(Array.from(common.validateRecordPayload(hello, {
    'Content-Length': String(hello.byteLength),
    'X-Terra-Checksum': 'fnv1a64:a430d84680aabd0b'
  })), Array.from(hello))
  assert.throws(() => common.validateRecordPayload(hello, {
    'Content-Length': '3',
    'X-Terra-Checksum': 'fnv1a64:a430d84680aabd0b'
  }), /Content-Length/)
  const secretUrl = 'https://tiles.example/wmts?tk=0123456789abcdef'
  assert.strictEqual(common.redactSensitiveText(secretUrl),
    'https://tiles.example/wmts?tk=[redacted]')
  assert.deepStrictEqual(common.sanitizeDiagnosticDetail({
    message: secretUrl,
    key: '1/2/3'
  }), {
    message: 'https://tiles.example/wmts?tk=[redacted]',
    key: '1/2/3'
  })

  const selected = common.validateManifest(manifest(), 'blue-marble')
  assert.strictEqual(selected.radius, 6378000)
  assert.strictEqual(selected.rootEndpoint,
    '/terra/v1/datasets/globe/root/{i}/{j}/{k}')
  assert.strictEqual(common.joinServiceUrl('https://terrain.example/',
    '/manifest'), 'https://terrain.example/manifest')
  assert.strictEqual(common.replaceTemplate('/{i}/{j}/{k}', {
    i: -1,
    j: 2,
    k: 3
  }), '/-1/2/3')
  assert.strictEqual(common.joinServiceUrl(
    'http://localhost:18082', '/manifest'),
    'http://localhost:18082/manifest')
  assert.strictEqual(common.joinServiceUrl(
    'http://127.0.0.1:18082/', '/manifest'),
    'http://127.0.0.1:18082/manifest')
  assert.strictEqual(common.joinServiceUrl(
    'http://[::1]:18082', '/manifest'),
    'http://[::1]:18082/manifest')
  assert.throws(() => common.joinServiceUrl('http://terrain.example', '/manifest'),
    /HTTPS or a loopback HTTP address/)
  assert.throws(() => common.joinServiceUrl(
    'http://localhost.example:18082', '/manifest'), /loopback/)
  assert.throws(() => common.joinServiceUrl(
    'http://192.168.1.10:18082', '/manifest'), /loopback/)
  assert.throws(() => common.joinServiceUrl(
    'http://127.0.0.1:18082/path', '/manifest'), /loopback/)
  assert.throws(() => common.joinServiceUrl(
    'http://127.0.0.1:65536', '/manifest'), /loopback/)

  const disposed = []
  const cache = new common.ResourceCache({
    maximumEntries: 2,
    maximumBytes: 8,
    dispose: (value) => disposed.push(value)
  })
  cache.set('a', 'a', 2)
  cache.set('b', 'b', 2)
  assert.strictEqual(cache.get('a'), 'a')
  cache.set('c', 'c', 2)
  assert.deepStrictEqual(disposed, ['b'])
  assert.deepStrictEqual(cache.stats(), { entries: 2, bytes: 4,
    retainedEntries: 0, reservedEntries: 0, reservedBytes: 0, highWaterBytes: 6 })

  const protectedKeys = new Set(['a'])
  const protectedDisposed = []
  const protectedCache = new common.ResourceCache({
    maximumEntries: 2,
    canEvict: (key) => !protectedKeys.has(key),
    dispose: (value) => protectedDisposed.push(value)
  })
  protectedCache.set('a', 'a', 1)
  protectedCache.set('b', 'b', 1)
  protectedCache.set('c', 'c', 1)
  assert.strictEqual(protectedCache.has('a'), true)
  assert.strictEqual(protectedCache.has('b'), false)
  assert.strictEqual(protectedCache.has('c'), true)

  const admitted = new common.ResourceCache({ maximumBytes: 8, maximumEntries: 2,
    canEvict: key => key !== 'displayed' })
  assert(admitted.trySet('displayed', 'old mesh', 6))
  assert(admitted.trySet('idle', 'idle mesh', 2))
  assert.strictEqual(admitted.trySet('candidate', 'oversized transition', 4), false)
  assert(admitted.has('displayed') && admitted.has('idle'),
    'Rejected admission must retain the displayed resource and existing cache')
  assert(admitted.trySet('candidate', 'bounded transition', 2))
  assert(admitted.has('displayed') && !admitted.has('idle'))
  assert.strictEqual(admitted.stats().bytes, 8)
  assert.deepStrictEqual(protectedDisposed, ['b'])
  protectedKeys.add('c')
  protectedCache.maximumEntries = 1
  protectedCache.evict()
  assert.deepStrictEqual(protectedCache.stats(), { entries: 2, bytes: 2,
    retainedEntries: 0, reservedEntries: 0, reservedBytes: 0, highWaterBytes: 3 })
  protectedKeys.delete('a')
  protectedCache.evict()
  assert.deepStrictEqual(protectedCache.stats(), { entries: 1, bytes: 1,
    retainedEntries: 0, reservedEntries: 0, reservedBytes: 0, highWaterBytes: 3 })
  assert.strictEqual(protectedCache.has('c'), true)

  const budget = common.deriveFrameBudget({
    width: 1000,
    height: 1000,
    devicePixelRatio: 3
  }, { maxTextureSize: 1024 })
  assert.strictEqual(budget.physicalWidth, 1024)
  assert.strictEqual(budget.physicalHeight, 1024)
  assert.strictEqual(budget.maximumConcurrentRequests, 3)
  assert(!Object.prototype.hasOwnProperty.call(budget, 'maximumTextureEntries'),
    'Viewport imposed a source-independent image count')
  assert.strictEqual(budget.textureCacheBytes, 256 * 1024 * 1024)
  assert.strictEqual(budget.maximumResourceBytes, 768 * 1024 * 1024)
  assert.strictEqual(budget.geometryCacheBytes, 128 * 1024 * 1024)
  assert.strictEqual(budget.terrainPixelError, 1.25)
  assert(budget.lodThreshold > 0.001 && budget.lodThreshold < 0.0011)
  const coarseBudget = common.deriveFrameBudget({
    width: 800,
    height: 600,
    devicePixelRatio: 1
  }, { maxTextureSize: 2048 }, {
    terrainPixelError: 2.5,
    verticalFovRadians: Math.PI / 3
  })
  assert(Math.abs(coarseBudget.lodThreshold -
    (2.5 / 600 * 2 * Math.tan(Math.PI / 6))) < 1e-12)
  assert(!Object.prototype.hasOwnProperty.call(coarseBudget, 'maximumTextureEntries'),
    'Viewport imposed a source-independent image count')
  assert.strictEqual(coarseBudget.textureCacheBytes, 256 * 1024 * 1024)
  assert.strictEqual(coarseBudget.maximumResourceBytes, 768 * 1024 * 1024)
  assert.strictEqual(coarseBudget.geometryCacheBytes, 128 * 1024 * 1024)

  const relative = common.relativeProjectionView(new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ]), [10, 20, 30])
  assert.deepStrictEqual(Array.from(relative), [
    1, 0, 0, 10,
    0, 1, 0, 20,
    0, 0, 1, 30,
    0, 0, 0, 1
  ])
  assert.deepStrictEqual(Array.from(common.rowMajorToWebGlMatrix(relative)), [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    10, 20, 30, 1
  ])

  await testScheduler()
  await testSchedulerRestartsStaleKey()
  console.log('Mini Program globe common tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
