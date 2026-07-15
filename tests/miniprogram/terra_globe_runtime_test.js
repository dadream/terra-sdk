const assert = require('assert')

const common = require('../../apps/miniprogram/utils/terra_globe_common')
const runtimeModule = require('../../apps/miniprogram/utils/terra_globe_runtime')
const imageryProfiles = require('../../apps/miniprogram/utils/terra_imagery_profiles')

const recordRequest = {
  kind: runtimeModule.REQUEST_ROOT,
  key: { level: 0, i: 0, j: 134217728, k: 134217728 }
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

function payload() {
  return new Uint8Array([1, 2, 3, 4, 5])
}

function response(bytes) {
  return {
    statusCode: 200,
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    header: {
      'Content-Length': String(bytes.byteLength),
      'X-Terra-Checksum': `fnv1a64:${common.fnv1a64(bytes)}`
    }
  }
}

function identity() {
  return new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ])
}

class FakeAbi {
  constructor() {
    this.loadedManifest = null
    this.viewports = []
    this.cameras = []
    this.submissions = []
    this.failures = []
    this.updateCount = 0
    this.destroyed = false
  }

  loadManifest(value) {
    this.loadedManifest = value
  }

  setViewport(width, height, fovRadians) {
    this.viewports.push({ width, height, fovRadians })
  }

  setCamera(value) {
    this.cameras.push(Object.assign({}, value))
  }

  update() {
    this.updateCount += 1
    return {
      sequence: this.updateCount,
      patchCount: 1,
      requestCount: this.getRequests().length,
      loadedRecordCount: this.submissions.length,
      failedRecordCount: this.failures.length,
      drawCount: 0,
      vertexCount: 0,
      cameraPosition: [1, 2, 3],
      projectionView: identity()
    }
  }

  getRequests() {
    return this.submissions.length ? [] : [recordRequest]
  }

  getDrawRanges() {
    return []
  }

  getPositions() {
    return new Float32Array(0)
  }

  getTextureUv() {
    return new Float32Array(0)
  }

  getIndices() {
    return new Uint16Array(0)
  }

  submitRecord(kind, key, bytes) {
    this.submissions.push({ kind, key, bytes: Array.from(bytes) })
  }

  failRecord(kind, key) {
    this.failures.push({ kind, key })
  }

  destroy() {
    this.destroyed = true
  }
}

class FakeRenderer {
  constructor(options) {
    this.options = options
    this.frames = []
    this.budgets = []
    this.resizes = []
    this.renderCount = 0
    this.destroyed = false
    this.contextLost = false
  }

  capabilities() {
    return { maxTextureSize: 2048, maxVertexAttribs: 8, version: 'fake' }
  }

  setBudget(value) {
    this.budgets.push(value)
  }

  resize(width, height) {
    this.resizes.push({ width, height })
  }

  setFrame(frame, draws, positions, textureUv, indices) {
    this.frames.push({ frame, draws, positions, textureUv, indices })
  }

  render() {
    this.renderCount += 1
    return { submitted: 0, queued: 0 }
  }

  stats() {
    return {
      geometry: { entries: 0, bytes: 0 },
      textures: { entries: 0, bytes: 0, active: 0, queued: 0 },
      draws: { submitted: 0, queued: 0 }
    }
  }

  destroy() {
    this.destroyed = true
  }
}

function canvas() {
  return {
    width: 0,
    height: 0,
    requestAnimationFrame(callback) {
      callback()
      return 1
    }
  }
}

async function settle(turns) {
  for (let index = 0; index < (turns || 1); ++index) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function createRuntime(options) {
  let renderer = null
  const runtime = await runtimeModule.TerraGlobeRuntime.create(Object.assign({
    canvas: canvas(),
    manifest: manifest(),
    serviceOrigin: 'https://terrain.example',
    viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
    rendererFactory(node, rendererOptions) {
      renderer = new FakeRenderer(rendererOptions)
      return renderer
    }
  }, options))
  return { runtime, renderer }
}

async function testSuccessfulLoadAndControls() {
  const abi = new FakeAbi()
  const requests = []
  const bytes = payload()
  const result = await createRuntime({
    abi,
    request(options) {
      requests.push(options)
      return { promise: Promise.resolve(response(bytes)), abort() {} }
    }
  })
  await settle(4)

  assert.strictEqual(abi.loadedManifest.datasetId, 'globe')
  assert.strictEqual(requests.length, 1)
  assert.strictEqual(requests[0].url,
    'https://terrain.example/terra/v1/datasets/globe/root/0/134217728/134217728')
  assert.strictEqual(abi.submissions.length, 1)
  assert.deepStrictEqual(abi.submissions[0].bytes, Array.from(bytes))
  assert.strictEqual(result.runtime.state().terrain.entries, 1)
  assert.strictEqual(result.runtime.textureUrl({ matrix: 3, row: 4, column: 5 }),
    'https://tiles.example/3/5/4.jpg')

  const initialCamera = Object.assign({}, result.runtime.camera)
  result.runtime.zoom(0.8)
  assert(result.runtime.camera.distance < initialCamera.distance)
  result.runtime.tilt45()
  assert.strictEqual(result.runtime.camera.tiltRadians, -Math.PI / 4)
  result.runtime.rotateYaw(0.5)
  assert.strictEqual(result.runtime.camera.yawRadians, 0.5)
  result.runtime.reset()
  assert.deepStrictEqual(result.runtime.camera, initialCamera)
  result.runtime.resize({ width: 1600, height: 900, devicePixelRatio: 2 })
  assert.strictEqual(result.runtime.scheduler.maximumConcurrent, 3)
  assert(result.renderer.budgets.length >= 2)
  assert.strictEqual(result.runtime.retryFailed(), false)
  result.runtime.destroy()
  assert.strictEqual(abi.destroyed, true)
  assert.strictEqual(result.renderer.destroyed, true)
}

async function testFailureRecovery() {
  const abi = new FakeAbi()
  const bytes = payload()
  let online = false
  const result = await createRuntime({
    abi,
    maximumTerrainRetries: 0,
    terrainRetryDelayMs: 0,
    request() {
      return {
        promise: online
          ? Promise.resolve(response(bytes))
          : Promise.reject(new Error('offline')),
        abort() {}
      }
    }
  })
  await settle(4)
  assert.strictEqual(abi.failures.length, 1)
  assert.strictEqual(result.runtime.state().terrain.failedRequestCount, 1)
  online = true
  assert.strictEqual(result.runtime.retryFailed(), true)
  await settle(4)
  assert.strictEqual(abi.submissions.length, 1)
  assert.strictEqual(result.runtime.state().terrain.failedRequestCount, 0)
  result.runtime.destroy()
}

async function testTiandituProfile() {
  const abi = new FakeAbi()
  const token = '0123456789abcdef0123456789abcdef'
  const imagery = imageryProfiles.resolveImageryProfile('tianditu-img-c', token)
  const result = await createRuntime({
    abi,
    imagery,
    request() {
      return { promise: Promise.resolve(response(payload())), abort() {} }
    }
  })
  await settle(4)
  assert.strictEqual(abi.loadedManifest.texture.matrix_level_offset, 1)
  assert.strictEqual(abi.loadedManifest.texture.maximum_level, 17)
  assert.strictEqual(result.runtime.state().imageryId, 'tianditu-img-c')
  const url = result.runtime.textureUrl({
    level: 0,
    matrix: 1,
    row: 0,
    column: 0
  })
  assert.strictEqual(url.indexOf('https://t0.tianditu.gov.cn/img_c/wmts?'), 0)
  result.runtime.diagnostic('texture_load_failed', { message: url })
  const report = JSON.stringify(result.runtime.state())
  assert.strictEqual(report.indexOf(token), -1)
  assert(report.indexOf('tk=[redacted]') >= 0)
  result.runtime.destroy()
}

async function testWxCancellation() {
  let aborts = 0
  global.wx = {
    request() {
      return {
        abort() {
          aborts += 1
        }
      }
    }
  }
  const task = runtimeModule.requestWithWx({
    url: 'https://terrain.example/record',
    responseType: 'arraybuffer'
  })
  task.abort()
  await assert.rejects(task.promise, /cancelled/)
  assert.strictEqual(aborts, 1)
  delete global.wx
}

async function main() {
  await testSuccessfulLoadAndControls()
  await testFailureRecovery()
  await testTiandituProfile()
  await testWxCancellation()
  console.log('Mini Program globe runtime tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
