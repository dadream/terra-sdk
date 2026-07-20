const assert = require('assert')
const common = require('../../apps/miniprogram/utils/terra_globe_common')
const probe = require('../../apps/miniprogram/utils/terra_planar_load_probe')

function record(payload) {
  const bytes = new Uint8Array(payload.length + 4)
  const length = payload.length
  bytes[0] = length & 0xff
  bytes[1] = length >>> 8 & 0xff
  bytes[2] = length >>> 16 & 0xff
  bytes[3] = length >>> 24 & 0xff
  bytes.set(payload, 4)
  return bytes
}

function response(bytes) {
  return {
    statusCode: 200,
    data: bytes.buffer.slice(bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength),
    header: {
      'Content-Length': String(bytes.byteLength),
      'X-Terra-Checksum': `fnv1a64:${common.fnv1a64(bytes)}`
    }
  }
}

function manifest() {
  return {
    schema: 'terra.dataset-manifest',
    schema_version: 1,
    dataset_id: 'fixture-planar',
    format_version: 1,
    patch_dim: 64,
    height_scale: 0.25,
    transform: {
      kind: 'planar',
      bounds: [[0, 0], [1025, 1025]],
      radius: 0,
      root_count: 1
    },
    endpoints: {
      root: '/root/{i}/{j}/{k}',
      detail: '/detail/{i}/{j}/{k}'
    }
  }
}

async function testSuccess() {
  const rootBytes = record(new Uint8Array([1, 2, 3]))
  const detailBytes = record(new Uint8Array([4, 5, 6, 7]))
  const baseline = {
    datasetId: 'fixture-planar',
    patchDimension: 64,
    bounds: [[0, 0], [1025, 1025]],
    root: {
      key: { i: 0, j: 0, k: 1 },
      byteLength: rootBytes.byteLength,
      checksum: common.fnv1a64(rootBytes)
    },
    detail: {
      key: { i: -1, j: 0, k: 1 },
      byteLength: detailBytes.byteLength,
      checksum: common.fnv1a64(detailBytes)
    }
  }
  const urls = []
  const result = await probe.runPlanarLoadProbe({
    serviceOrigin: 'http://127.0.0.1:18081',
    manifestPath: '/manifest',
    baseline,
    request(options) {
      urls.push(options.url)
      if (options.url.endsWith('/manifest')) {
        return Promise.resolve({ statusCode: 200, data: manifest() })
      }
      if (options.url.indexOf('/root/') >= 0) {
        return Promise.resolve(response(rootBytes))
      }
      return Promise.resolve(response(detailBytes))
    }
  })
  assert.strictEqual(result.passed, true)
  assert.strictEqual(result.dataset.transform, 'planar')
  assert.strictEqual(result.root.byteLength, 7)
  assert.strictEqual(result.detail.byteLength, 8)
  assert.strictEqual(result.scope.wasmDecode, false)
  assert.strictEqual(result.scope.planarRendering, false)
  assert.deepStrictEqual(urls, [
    'http://127.0.0.1:18081/manifest',
    'http://127.0.0.1:18081/root/0/0/1',
    'http://127.0.0.1:18081/detail/-1/0/1',
    'http://127.0.0.1:18081/detail/-1/0/1'
  ])
  assert.strictEqual(probe.reportSummary(result),
    'manifest 200 | root 7 B | detail 8 B | repeat stable')
}

async function testCorruption() {
  const bytes = record(new Uint8Array([1, 2]))
  const invalid = response(bytes)
  invalid.header['X-Terra-Checksum'] = 'fnv1a64:0000000000000000'
  assert.throws(() => probe.validateRecordResponse(invalid, {
    byteLength: bytes.byteLength,
    checksum: common.fnv1a64(bytes)
  }, 'Fixture'), /checksum/)
}

async function testRequestWithWx() {
  global.wx = {
    request(options) {
      options.success({ statusCode: 200, data: new ArrayBuffer(1) })
    }
  }
  const result = await probe.requestWithWx({
    url: 'http://127.0.0.1/data',
    responseType: 'arraybuffer'
  })
  assert.strictEqual(result.statusCode, 200)
  delete global.wx
}

async function main() {
  await testSuccess()
  await testCorruption()
  await testRequestWithWx()
  console.log('Mini Program planar load probe tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
