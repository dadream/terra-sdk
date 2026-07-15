const assert = require('assert')

const common = require('../../apps/miniprogram/utils/terra_globe_common')

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

async function main() {
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
  assert.throws(() => common.joinServiceUrl('http://terrain.example', '/manifest'),
    /HTTPS/)

  const disposed = []
  const cache = new common.LruCache({
    maximumEntries: 2,
    maximumBytes: 8,
    dispose: (value) => disposed.push(value)
  })
  cache.set('a', 'a', 2)
  cache.set('b', 'b', 2)
  assert.strictEqual(cache.get('a'), 'a')
  cache.set('c', 'c', 2)
  assert.deepStrictEqual(disposed, ['b'])
  assert.deepStrictEqual(cache.stats(), { entries: 2, bytes: 4 })

  const budget = common.deriveFrameBudget({
    width: 1000,
    height: 1000,
    devicePixelRatio: 3
  }, { maxTextureSize: 1024 })
  assert.strictEqual(budget.physicalWidth, 1024)
  assert.strictEqual(budget.physicalHeight, 1024)
  assert.strictEqual(budget.maximumConcurrentRequests, 3)

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
  console.log('Mini Program globe common tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
