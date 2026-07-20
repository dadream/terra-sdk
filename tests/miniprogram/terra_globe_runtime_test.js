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
    this.targets = []
    this.submissions = []
    this.failures = []
    this.retryRecords = []
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

  setGlobeTarget(longitudeDegrees, latitudeDegrees) {
    this.targets.push({ longitudeDegrees, latitudeDegrees })
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

  retryRecord(kind, key) {
    this.retryRecords.push({ kind, key })
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

function testGeographicCamera() {
  const target = {
    longitudeDegrees: 116.4074,
    latitudeDegrees: 39.9042
  }
  const camera = runtimeModule.geographicCamera(
    6378000, 1280, 720, 30 * Math.PI / 180, target)
  assert.strictEqual(camera.yawRadians, 0)
  assert.strictEqual(camera.tiltRadians, 0)
  assert.strictEqual(camera.longitudeDegrees, target.longitudeDegrees)
  assert.strictEqual(camera.latitudeDegrees, target.latitudeDegrees)
  assert.throws(() => runtimeModule.geographicCamera(
    6378000, 1280, 720, 0.5, { longitudeDegrees: 181, latitudeDegrees: 0 }),
  /longitude/)
}

async function testSuccessfulLoadAndControls() {
  const abi = new FakeAbi()
  const requests = []
  const bytes = payload()
  const initialTarget = {
    longitudeDegrees: 116.4074,
    latitudeDegrees: 39.9042
  }
  const result = await createRuntime({
    abi,
    initialTarget,
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
  assert.deepStrictEqual(abi.targets[0], initialTarget)
  assert.strictEqual(initialCamera.tiltRadians, 0)
  assert.strictEqual(initialCamera.yawRadians, 0)
  assert.strictEqual(initialCamera.longitudeDegrees, 116.4074)
  assert.strictEqual(initialCamera.latitudeDegrees, 39.9042)
  assert.deepStrictEqual(result.runtime.getView(), {
    schema: 'terra.view-state.v1',
    mode: 'globe',
    target: {
      longitudeDegrees: 116.4074,
      latitudeDegrees: 39.9042,
      heightMeters: 0
    },
    rangeMeters: initialCamera.distance,
    headingDegrees: 0,
    tiltDegrees: 0
  })
  const atomicUpdates = abi.updateCount
  result.runtime.setView({
    schema: 'terra.view-state.v1',
    mode: 'globe',
    target: {
      longitudeDegrees: 120,
      latitudeDegrees: 30,
      heightMeters: 0
    },
    rangeMeters: initialCamera.distance * 0.9,
    headingDegrees: 20,
    tiltDegrees: 35
  })
  assert.strictEqual(abi.updateCount, atomicUpdates + 1)
  assert.strictEqual(result.runtime.getView().tiltDegrees, 35)
  assert.throws(() => result.runtime.setView({
    schema: 'terra.view-state.v1',
    mode: 'globe',
    target: { longitudeDegrees: 200, latitudeDegrees: 30 },
    rangeMeters: initialCamera.distance,
    headingDegrees: 0,
    tiltDegrees: 0
  }), /outside globe bounds/)
  assert.strictEqual(result.runtime.camera.longitudeDegrees, 120)
  result.runtime.reset()
  result.runtime.applyCamera({ tiltDelta: -0.25, yawDelta: 0.5 })
  assert.strictEqual(result.runtime.camera.tiltRadians, -0.25)
  assert.strictEqual(result.runtime.camera.yawRadians, 0.5)
  result.runtime.reset()
  result.runtime.moveSurfacePixels(100, -50)
  assert(result.runtime.camera.longitudeDegrees < initialCamera.longitudeDegrees)
  assert(result.runtime.camera.latitudeDegrees < initialCamera.latitudeDegrees)
  result.runtime.setTargetDegrees(120, 30)
  assert.strictEqual(result.runtime.camera.longitudeDegrees, 120)
  assert.strictEqual(result.runtime.camera.latitudeDegrees, 30)
  result.runtime.focusInitialTarget()
  assert.strictEqual(result.runtime.camera.distance, 6378000 * 1.45)
  assert.strictEqual(result.runtime.camera.longitudeDegrees, 116.4074)
  assert.strictEqual(result.runtime.camera.latitudeDegrees, 39.9042)
  result.runtime.zoom(0.8)
  assert(result.runtime.camera.distance < 6378000 * 1.45)
  result.runtime.tilt45()
  assert.strictEqual(result.runtime.camera.tiltRadians, -Math.PI / 4)
  result.runtime.rotateYaw(0.5)
  assert.strictEqual(result.runtime.camera.yawRadians, 0.5)
  result.runtime.topDown()
  assert.strictEqual(result.runtime.camera.tiltRadians, 0)
  result.runtime.northUp()
  assert.strictEqual(result.runtime.camera.yawRadians, 0)
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
  assert.strictEqual(abi.retryRecords.length, 1)
  assert.deepStrictEqual(abi.retryRecords[0], recordRequest)
  assert.strictEqual(abi.submissions.length, 1)
  assert.strictEqual(result.runtime.state().terrain.failedRequestCount, 0)
  result.runtime.destroy()
}

async function testSparseNotFoundIsNotRetried() {
  const abi = new FakeAbi()
  let requests = 0
  const result = await createRuntime({
    abi,
    maximumTerrainRetries: 2,
    terrainRetryDelayMs: 0,
    request() {
      requests += 1
      return {
        promise: Promise.resolve({
          statusCode: 404,
          data: new ArrayBuffer(0),
          header: {}
        }),
        abort() {}
      }
    }
  })
  await settle(6)
  assert.strictEqual(requests, 1)
  assert.strictEqual(abi.failures.length, 1)
  assert.strictEqual(result.runtime.state().terrain.failedRequestCount, 1)
  assert(result.runtime.state().diagnostics.some((entry) =>
    entry.kind === 'terrain_request_failed' &&
    /HTTP 404/.test(entry.detail.message)))
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

async function testPublicImageryAndLifecycle() {
  const invalidMinimumRuntime = new runtimeModule.TerraGlobeRuntime({
    canvas: canvas(),
    imagery: {
      id: 'unsupported-minimum',
      tileScheme: 'global-geodetic',
      minimumLevel: 1,
      maximumLevel: 6,
      resolveTile: () => 'https://public.example/tile.png'
    }
  })
  assert.throws(() => invalidMinimumRuntime.validateRuntimeManifest(manifest()),
    /minimum level must be zero/)

  const abi = new FakeAbi()
  const result = await createRuntime({
    abi,
    imagery: {
      id: 'public-source',
      tileScheme: 'global-geodetic',
      minimumLevel: 0,
      maximumLevel: 6,
      resolveTile: (tile) =>
        `https://public.example/${tile.matrix}/${tile.column}/${tile.row}.png`
    },
    request() {
      return { promise: Promise.resolve(response(payload())), abort() {} }
    }
  })
  await settle(4)
  assert.strictEqual(abi.loadedManifest.texture.id, 'public-source')
  assert.strictEqual(abi.loadedManifest.texture.maximum_level, 6)
  assert.strictEqual(result.runtime.textureUrl({
    level: 1, matrix: 2, row: 3, column: 4
  }), 'https://public.example/2/4/3.png')
  const updateCount = abi.updateCount
  result.runtime.pause()
  result.runtime.panBy({ xPixels: 10, yPixels: 5 })
  assert.strictEqual(abi.updateCount, updateCount)
  assert.strictEqual(result.runtime.state().paused, true)
  result.runtime.resume()
  assert.strictEqual(abi.updateCount, updateCount + 1)
  assert.strictEqual(result.runtime.state().paused, false)
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
  testGeographicCamera()
  await testSuccessfulLoadAndControls()
  await testFailureRecovery()
  await testSparseNotFoundIsNotRetried()
  await testTiandituProfile()
  await testPublicImageryAndLifecycle()
  await testWxCancellation()
  console.log('Mini Program globe runtime tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
