const assert = require('assert')

const common = require('../../apps/miniprogram/utils/terra_globe_common')
const runtimeModule = require('../../apps/miniprogram/utils/terra_globe_runtime')

function manifest() {
  return {
    schema: 'terra.dataset-manifest',
    schema_version: 1,
    dataset_id: 'ps-1k',
    format_version: 1,
    patch_dim: 64,
    height_scale: 0.0009765625,
    transform: {
      kind: 'planar',
      bounds: [[0, 0], [1025, 1025]],
      radius: 0
    },
    endpoints: {
      root: '/terra/v1/datasets/ps-1k/roots/{i}/{j}/{k}',
      detail: '/terra/v1/datasets/ps-1k/patches/{i}/{j}/{k}'
    },
    textures: [{
      id: 'ps-1k',
      kind: 'planar-single',
      url_template: '/terra/v1/datasets/ps-1k/textures/ps-1k',
      matrix_level_offset: 0,
      maximum_level: 0
    }]
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
    this.manifest = null
    this.levels = []
    this.targets = []
    this.cameras = []
    this.submitted = false
    this.destroyed = false
  }

  loadManifest(value) { this.manifest = value }
  setViewport() {}
  setCamera(value) { this.cameras.push(Object.assign({}, value)) }
  setPlanarTarget(x, y) { this.targets.push({ x, y }) }
  setPlanarLevel(value) { this.levels.push(value) }

  update() {
    return {
      sequence: this.cameras.length,
      patchCount: 4,
      requestCount: this.submitted ? 0 : 1,
      loadedRecordCount: this.submitted ? 1 : 0,
      failedRecordCount: 0,
      drawCount: 0,
      vertexCount: 0,
      cameraPosition: [512.5, 512.5, 2200],
      projectionView: identity()
    }
  }

  getRequests() {
    return this.submitted ? [] : [{
      kind: runtimeModule.REQUEST_ROOT,
      key: { level: 0, i: 0, j: 0, k: 268435456 }
    }]
  }

  getDrawRanges() { return [] }
  getPositions() { return new Float32Array(0) }
  getTextureUv() { return new Float32Array(0) }
  getIndices() { return new Uint16Array(0) }
  submitRecord() { this.submitted = true }
  failRecord() {}
  retryRecord() {}
  destroy() { this.destroyed = true }
}

class FakeRenderer {
  constructor(options) {
    this.options = options
    this.mode = options.mode || 'texture'
    this.contextLost = false
    this.destroyed = false
  }

  capabilities() {
    return { maxTextureSize: 2048, maxVertexAttribs: 8, version: 'fake' }
  }
  setBudget() {}
  resize() {}
  setFrame() {}
  render() { return { submitted: 0, queued: 0 } }
  setMode(mode) { this.mode = mode }
  destroy() { this.destroyed = true }
  stats() {
    return {
      geometry: { entries: 0, bytes: 0 },
      textures: { entries: 0, bytes: 0, active: 0, queued: 0, failed: 0 },
      draws: { submitted: 0, queued: 0 },
      mode: this.mode
    }
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

function response() {
  const bytes = new Uint8Array([1, 2, 3, 4])
  return {
    statusCode: 200,
    data: bytes.buffer,
    header: {
      'Content-Length': String(bytes.byteLength),
      'X-Terra-Checksum': `fnv1a64:${common.fnv1a64(bytes)}`
    }
  }
}

async function settle(turns) {
  for (let index = 0; index < turns; ++index) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function main() {
  const validated = common.validatePlanarManifest(manifest(), 'ps-1k')
  assert.strictEqual(validated.transform, 'planar')
  assert.strictEqual(validated.maximumU, 1025)
  const insecure = manifest()
  insecure.textures[0].url_template = 'http://terrain.example/texture.png'
  assert.throws(() => common.validatePlanarManifest(insecure, 'ps-1k'),
    /relative to the service or use HTTPS/)
  const publicRuntime = new runtimeModule.TerraPlanarRuntime({
    canvas: canvas(),
    serviceOrigin: 'http://127.0.0.1:18081',
    imagery: {
      id: 'planar-public',
      tileScheme: 'planar-single',
      minimumLevel: 0,
      maximumLevel: 0,
      resolveTile: () => 'https://public.example/planar.png'
    }
  })
  publicRuntime.manifest = publicRuntime.validateRuntimeManifest(manifest())
  assert.strictEqual(publicRuntime.manifest.texture.id, 'planar-public')
  assert.strictEqual(publicRuntime.textureUrl({
    level: 0, matrix: 0, row: 0, column: 0
  }), 'https://public.example/planar.png')

  const abi = new FakeAbi()
  let renderer = null
  const requests = []
  const runtime = await runtimeModule.TerraPlanarRuntime.create({
    canvas: canvas(),
    manifest: manifest(),
    serviceOrigin: 'http://127.0.0.1:18081',
    textureId: 'ps-1k',
    planarLevel: 1,
    abi,
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    rendererFactory(node, options) {
      renderer = new FakeRenderer(options)
      return renderer
    },
    request(options) {
      requests.push(options.url)
      return { promise: Promise.resolve(response()), abort() {} }
    }
  })
  await settle(4)

  assert.strictEqual(abi.manifest.transform, 'planar')
  assert.deepStrictEqual(abi.levels, [1])
  assert.strictEqual(requests[0],
    'http://127.0.0.1:18081/terra/v1/datasets/ps-1k/roots/0/0/268435456')
  assert.strictEqual(runtime.textureUrl(),
    'http://127.0.0.1:18081/terra/v1/datasets/ps-1k/textures/ps-1k')
  assert.strictEqual(runtime.camera.tiltRadians, -Math.PI / 4)
  assert.deepStrictEqual(runtime.getView(), {
    schema: 'terra.view-state.v1',
    mode: 'planar',
    target: { x: 512.5, y: 512.5, height: 0 },
    rangeMeters: runtime.camera.distance,
    headingDegrees: 0,
    tiltDegrees: 45
  })
  assert.deepStrictEqual(abi.targets[0], { x: 512.5, y: 512.5 })
  const initialDistance = runtime.camera.distance
  runtime.panBy({ xPixels: 40, yPixels: -20 })
  assert(runtime.camera.x < 512.5)
  assert(runtime.camera.y < 512.5)
  const panned = runtime.getView()
  const updatesBeforeView = abi.cameras.length
  runtime.setView({
    schema: 'terra.view-state.v1',
    mode: 'planar',
    target: { x: 600, y: 400, height: 0 },
    rangeMeters: initialDistance,
    headingDegrees: 30,
    tiltDegrees: 25
  })
  assert.strictEqual(abi.cameras.length, updatesBeforeView + 1)
  assert.strictEqual(runtime.camera.x, 600)
  assert.strictEqual(runtime.camera.y, 400)
  assert.strictEqual(runtime.getView().headingDegrees, 30)
  assert.throws(() => runtime.setView(Object.assign({}, panned, {
    target: { x: 5000, y: 400, height: 0 }
  })), /outside planar bounds/)
  assert.strictEqual(runtime.camera.x, 600)
  runtime.birdView()
  assert.strictEqual(runtime.camera.tiltRadians, 0)
  runtime.zoom(0.82)
  assert(runtime.camera.distance < initialDistance)
  runtime.tilt45()
  assert.strictEqual(runtime.camera.tiltRadians, -Math.PI / 4)
  runtime.setRenderMode('height')
  assert.strictEqual(renderer.mode, 'height')
  assert.strictEqual(runtime.state().schema,
    'terra.miniprogram.planar-runtime.v1')
  runtime.reset()
  assert.strictEqual(runtime.camera.distance, initialDistance)
  assert.strictEqual(runtime.camera.x, 512.5)
  assert.strictEqual(runtime.camera.y, 512.5)
  runtime.destroy()
  assert.strictEqual(abi.destroyed, true)
  assert.strictEqual(renderer.destroyed, true)
  console.log('Mini Program planar runtime tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
