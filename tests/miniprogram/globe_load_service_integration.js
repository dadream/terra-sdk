const assert = require('assert')
const fs = require('fs')
const http = require('http')

const imageryProfiles = require('../../apps/miniprogram/utils/terra_imagery_profiles')
const runtimeModule = require('../../apps/miniprogram/utils/terra_globe_runtime')
const wasmModule = require('../../apps/miniprogram/utils/terra_wasm')

const BEIJING_SHARED_DIAMOND = '/patches/-134217728/134217728/-134217728'

const requestEvidence = []

function requestWithNode(options) {
  let request = null
  const promise = new Promise((resolve, reject) => {
    const requestOptions = process.env.TERRA_TEST_HOST_HEADER
      ? {
          headers: { Host: process.env.TERRA_TEST_HOST_HEADER }
        }
      : {}
    request = http.get(options.url, requestOptions, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const body = Buffer.concat(chunks)
        const data = options.responseType === 'arraybuffer'
          ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
          : body.toString('utf8')
        requestEvidence.push({ url: options.url, status: response.statusCode })
        resolve({
          statusCode: response.statusCode,
          data,
          header: response.headers
        })
      })
    })
    request.setTimeout(options.timeout || 15000, () => {
      request.destroy(new Error(`Request timed out: ${options.url}`))
    })
    request.on('error', reject)
  })
  return {
    promise,
    abort() {
      if (request) {
        request.destroy(new Error('Terrain request was cancelled'))
      }
    }
  }
}

class CaptureRenderer {
  constructor() {
    this.contextLost = false
    this.frame = null
    this.draws = []
  }

  capabilities() {
    return { maxTextureSize: 4096, maxVertexAttribs: 8, version: 'node' }
  }

  setBudget() {}
  resize() {}

  setFrame(frame, draws) {
    this.frame = frame
    this.draws = draws.slice()
  }

  render() {
    return { submitted: this.draws.length, queued: 0 }
  }

  stats() {
    return {
      geometry: { entries: 0, bytes: 0 },
      textures: { entries: 0, bytes: 0, active: 0, queued: 0 },
      draws: { submitted: this.draws.length, queued: 0 }
    }
  }

  destroy() {}
}

function canvas() {
  return {
    width: 0,
    height: 0,
    requestAnimationFrame(callback) {
      return setTimeout(callback, 0)
    }
  }
}

async function settle(runtime, label, options) {
  const settings = options || {}
  const maximumAttempts = settings.maximumAttempts || 200
  let lastState = null
  for (let attempt = 0; attempt < maximumAttempts; ++attempt) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const state = runtime.state()
    if (settings.metrics && state.frame) {
      settings.metrics.maximumRequestCount = Math.max(
        settings.metrics.maximumRequestCount || 0,
        state.frame.requestCount)
      settings.metrics.maximumLodUpdateMs = Math.max(
        settings.metrics.maximumLodUpdateMs || 0,
        state.performance.lodUpdate.lastMs)
      settings.metrics.maximumWasmMemoryBytes = Math.max(
        settings.metrics.maximumWasmMemoryBytes || 0,
        runtime.abi.module.refreshMemory().bytes.byteLength)
    }
    if (state.error) {
      throw new Error(`${label} failed: ${state.error}`)
    }
    if (state.frame && state.frame.decisionsComplete === true &&
        state.frame.requestCount === 0 &&
        state.terrain.active === 0 && state.terrain.queued === 0) {
      return state
    }
    lastState = state
  }
  throw new Error(`${label} did not settle: ${JSON.stringify(lastState)}`)
}

function textureLevelRange(draws) {
  const levels = draws.map((draw) => draw.texture.level)
  return {
    minimum: Math.min.apply(null, levels),
    maximum: Math.max.apply(null, levels)
  }
}

function terrainLevelRange(draws) {
  const levels = draws.map((draw) => draw.key.level)
  return {
    minimum: Math.min.apply(null, levels),
    maximum: Math.max.apply(null, levels)
  }
}

async function instantiate(wasmPath) {
  const bytes = fs.readFileSync(wasmPath)
  const module = await WebAssembly.compile(bytes)
  const instance = await WebAssembly.instantiate(
    module, wasmModule.createTerraImports())
  if (instance.exports._initialize) {
    instance.exports._initialize()
  }
  return new wasmModule.TerraWasmModule(instance)
}

async function main() {
  const serviceOrigin = process.argv[2] || 'http://127.0.0.1:18082'
  const wasmPath = process.argv[3] ||
    'workspace_old/package/miniprogram/wasm/terra_sdk.wasm'
  const imageryOrigin = process.argv[4] || serviceOrigin
  const terraModule = await instantiate(wasmPath)
  const abi = new runtimeModule.TerraAbi(terraModule)
  const renderer = new CaptureRenderer()
  const imagery = imageryProfiles.resolveImageryProfile(
    'blue-marble', '', 'blue-marble', imageryOrigin)
  const runtime = await runtimeModule.TerraGlobeRuntime.create({
    abi,
    canvas: canvas(),
    imagery,
    serviceOrigin,
    manifestPath: '/terra/v1/datasets/globe/manifest',
    viewport: { width: 390, height: 593, devicePixelRatio: 2 },
    initialTarget: {
      longitudeDegrees: 116.0,
      latitudeDegrees: 40.0
    },
    maximumTerrainRetries: 0,
    request: requestWithNode,
    rendererFactory() {
      return renderer
    }
  })

  const initial = await settle(runtime, 'initial globe load')
  assert(initial.frame.loadedRecordCount >= 8,
    'Initial globe load did not retain the root terrain records')
  assert(initial.frame.drawCount > 0,
    'Initial globe load produced no terrain draws')
  const initialTextureLevels = textureLevelRange(renderer.draws)
  const initialTerrainLevels = terrainLevelRange(renderer.draws)
  const terrainLodHistory = [initialTerrainLevels.maximum]
  const failedRequestHistory = [initial.terrain.failedRequestCount]
  let zoomed = initial
  for (let step = 1; step <= 10; ++step) {
    runtime.zoom(0.82)
    zoomed = await settle(runtime, `Beijing zoom ${step}`)
    assert.strictEqual(zoomed.error, '')
    assert.strictEqual(zoomed.frame.requestCount, 0)
    if (step < 10) {
      assert.strictEqual(zoomed.terrain.failedRequestCount, 0,
        `Beijing zoom ${step} encountered a missing terrain record`)
    }
    assert(zoomed.frame.drawCount > 0,
      `Beijing zoom ${step} lost all terrain draws`)
    terrainLodHistory.push(terrainLevelRange(renderer.draws).maximum)
    failedRequestHistory.push(zoomed.terrain.failedRequestCount)
  }

  const zoomedTextureLevels = textureLevelRange(renderer.draws)
  const zoomedTerrainLevels = terrainLevelRange(renderer.draws)
  assert(zoomedTextureLevels.maximum > initialTextureLevels.maximum,
    'Texture LOD did not increase after ten fixed Beijing zoom steps')
  assert(zoomedTerrainLevels.maximum > initialTerrainLevels.maximum,
    'Terrain LOD did not increase after ten fixed Beijing zoom steps')
  assert(requestEvidence.some((entry) =>
    entry.status === 200 && entry.url.endsWith(BEIJING_SHARED_DIAMOND)),
  'Beijing shared diamond detail was not loaded successfully')

  const stressStart = Date.now()
  const stressStartUpdates = runtime.state().performance.fullUpdate.count
  const stressMetrics = {}
  runtime.resize({ width: 751, height: 950, devicePixelRatio: 1 })
  runtime.setView({
    schema: 'terra.view-state.v1',
    mode: 'globe',
    target: {
      longitudeDegrees: 111.84012,
      latitudeDegrees: 31.05839,
      heightMeters: 0
    },
    rangeMeters: 7900237.5,
    headingDegrees: 0,
    tiltDegrees: 0
  })
  const stressed = await settle(runtime, 'desktop convergence stress', {
    maximumAttempts: 1200,
    metrics: stressMetrics
  })
  const stressElapsedMs = Date.now() - stressStart
  const stressUpdates = stressed.performance.fullUpdate.count -
    stressStartUpdates
  const stressedTerrainLevels = terrainLevelRange(renderer.draws)
  const stressMemoryMiB = Math.round(
    stressMetrics.maximumWasmMemoryBytes / (1024 * 1024))
  assert(stressed.frame.drawCount > 0 &&
    stressed.frame.decisionsComplete === true,
  'Desktop stress view did not produce a converged terrain surface')
  assert(stressMetrics.maximumRequestCount <= 64,
    `Terrain request frontier exceeded 64 records: ${stressMetrics.maximumRequestCount}`)
  assert(stressUpdates <= 256,
    `Desktop stress view required too many full updates: ${stressUpdates}`)
  assert(stressMetrics.maximumWasmMemoryBytes <= 128 * 1024 * 1024,
    `Desktop stress exceeded the 128 MiB operational memory gate: ` +
      `${stressMemoryMiB} MiB`)

  runtime.destroy()
  console.log(
    `Globe service integration passed: ${initial.frame.drawCount} initial, ` +
    `${zoomed.frame.drawCount} draws after ten Beijing zooms`)
  console.log(`Terrain LOD ${initialTerrainLevels.minimum}-` +
    `${initialTerrainLevels.maximum} -> ${zoomedTerrainLevels.minimum}-` +
    `${zoomedTerrainLevels.maximum}`)
  console.log(`Terrain LOD history: ${terrainLodHistory.join(',')}`)
  console.log(`Failed request history: ${failedRequestHistory.join(',')}`)
  console.log(`Terminal unavailable records: ${requestEvidence.filter(
    (entry) => entry.status !== 200).length}`)
  console.log(`Texture LOD ${initialTextureLevels.minimum}-` +
    `${initialTextureLevels.maximum} -> ${zoomedTextureLevels.minimum}-` +
    `${zoomedTextureLevels.maximum}`)
  console.log(`Desktop stress settled in ${stressElapsedMs}ms with ` +
    `${stressUpdates} full updates, request frontier ` +
    `${stressMetrics.maximumRequestCount}, maximum LOD update ` +
    `${stressMetrics.maximumLodUpdateMs.toFixed(2)}ms, terrain LOD ` +
    `${stressedTerrainLevels.minimum}-${stressedTerrainLevels.maximum}, ` +
    `Wasm memory ${stressMemoryMiB} MiB`)
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
