(function () {
  'use strict'

  const sdk = window.TerraWebSdk
  const canvas = document.getElementById('live-canvas')
  const capturesElement = document.getElementById('captures')
  const summaryElement = document.getElementById('summary')
  const resultElement = document.getElementById('automation-result')
  const statusElement = document.getElementById('status')
  const startedAt = performance.now()

  const expectedCaptures = [
    'initial',
    'zoom',
    'tilt_45',
    'yaw_30',
    'reset',
    'context_restored'
  ]
  const checks = []
  const captures = []
  const requestAttempts = new Map()
  let runtime = null
  let simulatedRetryRecovered = false

  const manifest = {
    schema: 'terra.dataset-manifest',
    schema_version: 1,
    dataset_id: 'globe-web-evidence',
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
      id: 'blue-marble-web-fixture',
      kind: 'global-geodetic',
      url_template: 'https://tiles.example/{z}/{x}/{y}.png',
      matrix_level_offset: 0,
      maximum_level: 8
    }]
  }

  const fixtureForPath = {
    '/terra/v1/datasets/globe/root/0/134217728/134217728':
      'fixtures/globe_root_0_record.bin',
    '/terra/v1/datasets/globe/detail/0/134217728/134217728':
      'fixtures/globe_root_0_detail_record.bin',
    '/terra/v1/datasets/globe/root/-134217728/134217728/0':
      'fixtures/globe_root_3_record.bin',
    '/terra/v1/datasets/globe/root/134217728/134217728/0':
      'fixtures/globe_root_0_record.bin',
    '/terra/v1/datasets/globe/root/0/-134217728/134217728':
      'fixtures/globe_root_3_record.bin',
    '/terra/v1/datasets/globe/root/134217728/-134217728/0':
      'fixtures/globe_root_0_record.bin',
    '/terra/v1/datasets/globe/root/-134217728/-134217728/0':
      'fixtures/globe_root_3_record.bin',
    '/terra/v1/datasets/globe/root/0/134217728/-134217728':
      'fixtures/globe_root_0_record.bin',
    '/terra/v1/datasets/globe/root/0/-134217728/-134217728':
      'fixtures/globe_root_3_record.bin',
    '/terra/v1/datasets/globe/detail/-134217728/134217728/0':
      'fixtures/globe_root_3_detail_record.bin',
    '/terra/v1/datasets/globe/detail/-134217728/134217728/134217728':
      'fixtures/globe_patch_record.bin'
  }

  function check(name, passed, detail) {
    checks.push({ name, passed: Boolean(passed), detail: String(detail || '') })
    if (!passed) {
      throw new Error(`${name}: ${detail}`)
    }
  }

  function approximatelyEqual(left, right, tolerance) {
    return Math.abs(left - right) <= tolerance
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  async function waitFor(name, predicate, timeoutMilliseconds) {
    const deadline = performance.now() + timeoutMilliseconds
    while (performance.now() < deadline) {
      const value = predicate()
      if (value) {
        return value
      }
      await wait(20)
    }
    throw new Error(`Timed out waiting for ${name}`)
  }

  function makeTextureDataUrl() {
    const texture = document.createElement('canvas')
    texture.width = 16
    texture.height = 16
    const context = texture.getContext('2d')
    context.fillStyle = '#1d6590'
    context.fillRect(0, 0, 16, 16)
    context.fillStyle = '#5fa65b'
    context.fillRect(0, 0, 8, 8)
    context.fillStyle = '#d8c66f'
    context.fillRect(8, 8, 8, 8)
    context.fillStyle = '#f2f4f5'
    context.fillRect(6, 6, 4, 4)
    return texture.toDataURL('image/png')
  }

  function installBrowserCanvasAdapter() {
    const textureDataUrl = makeTextureDataUrl()
    const sourceProperty = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype, 'src')
    canvas.requestAnimationFrame = (callback) => window.requestAnimationFrame(callback)
    canvas.createImage = () => {
      const image = new Image()
      let requestedUrl = ''
      Object.defineProperty(image, 'src', {
        configurable: true,
        get() {
          return requestedUrl
        },
        set(value) {
          requestedUrl = String(value || '')
          sourceProperty.set.call(image, requestedUrl ? textureDataUrl : '')
        }
      })
      return image
    }
  }

  function terrainRequest(options) {
    const path = new URL(options.url).pathname
    const fixture = fixtureForPath[path]
    const attempt = (requestAttempts.get(path) || 0) + 1
    requestAttempts.set(path, attempt)

    let cancelled = false
    let controller = null
    let rejectPending = null
    const promise = new Promise((resolve, reject) => {
      rejectPending = reject
      if (path.endsWith('/root/0/134217728/134217728') && attempt === 1) {
        setTimeout(() => {
          if (!cancelled) {
            reject(new Error('simulated transient terrain failure'))
          }
        }, 15)
        return
      }
      if (!fixture) {
        setTimeout(() => {
          if (!cancelled) {
            reject(new Error('fixture intentionally unavailable'))
          }
        }, 5)
        return
      }
      controller = new AbortController()
      fetch(fixture, { signal: controller.signal }).then((response) => {
        if (!response.ok) {
          throw new Error(`fixture returned HTTP ${response.status}`)
        }
        return response.arrayBuffer()
      }).then((buffer) => {
        if (cancelled) {
          return
        }
        const bytes = new Uint8Array(buffer)
        if (path.endsWith('/root/0/134217728/134217728') && attempt > 1) {
          simulatedRetryRecovered = true
        }
        resolve({
          statusCode: 200,
          data: buffer,
          header: {
            'Content-Length': String(buffer.byteLength),
            'X-Terra-Checksum': `fnv1a64:${sdk.common.fnv1a64(bytes)}`
          }
        })
      }).catch(reject)
    })
    return {
      promise,
      abort() {
        if (!cancelled) {
          cancelled = true
          if (controller) {
            controller.abort()
          }
          if (rejectPending) {
            rejectPending(new Error('Terrain request was cancelled'))
          }
        }
      }
    }
  }

  async function instantiateWasm() {
    const response = await fetch('generated/terra_sdk.wasm')
    check('wasm_fetch', response.ok, `HTTP ${response.status}`)
    const bytes = await response.arrayBuffer()
    const loaded = await WebAssembly.instantiate(bytes,
      sdk.wasm.createTerraImports())
    const instance = loaded.instance || loaded
    if (instance.exports && typeof instance.exports._initialize === 'function') {
      instance.exports._initialize()
    }
    check('wasm_abi', instance.exports.terra_abi_version() === 1,
      `ABI ${instance.exports.terra_abi_version()}`)
    return {
      module: new sdk.wasm.TerraWasmModule(instance),
      byteLength: bytes.byteLength
    }
  }

  async function waitForRenderedFrame(previousSequence, minimumDraws) {
    const requiredDraws = minimumDraws === undefined ? 1 : minimumDraws
    return waitFor('loaded globe frame', () => {
      runtime.renderer.render()
      const state = runtime.state()
      const frame = state.frame
      const renderer = state.renderer
      if (!frame || !renderer || frame.loadedRecordCount < 8 ||
        frame.drawCount < requiredDraws ||
        renderer.draws.submitted !== frame.drawCount ||
        renderer.geometry.entries < requiredDraws || renderer.textures.entries < 1) {
        return null
      }
      if (previousSequence !== undefined && frame.sequence <= previousSequence) {
        return null
      }
      return state
    }, 12000)
  }

  function framebufferStats(gl) {
    const width = canvas.width
    const height = canvas.height
    const pixels = new Uint8Array(width * height * 4)
    gl.finish()
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    let hash = 0x811c9dc5
    let nonBackgroundPixels = 0
    const colors = new Set()
    const background = [6, 11, 18]
    for (let offset = 0; offset < pixels.length; offset += 4) {
      hash ^= pixels[offset]
      hash = Math.imul(hash, 0x01000193)
      hash ^= pixels[offset + 1]
      hash = Math.imul(hash, 0x01000193)
      hash ^= pixels[offset + 2]
      hash = Math.imul(hash, 0x01000193)
      hash ^= pixels[offset + 3]
      hash = Math.imul(hash, 0x01000193)
      if (Math.abs(pixels[offset] - background[0]) > 3 ||
        Math.abs(pixels[offset + 1] - background[1]) > 3 ||
        Math.abs(pixels[offset + 2] - background[2]) > 3) {
        nonBackgroundPixels += 1
      }
      if ((offset / 4) % 53 === 0) {
        colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`)
      }
    }
    return {
      width,
      height,
      fnv1a32: hash >>> 0,
      nonBackgroundPixels,
      sampledColorCount: colors.size
    }
  }

  async function capture(name) {
    runtime.renderer.render()
    const gl = runtime.renderer.gl
    const framebuffer = framebufferStats(gl)
    const state = runtime.state()
    check(`${name}_draws`, state.frame && state.frame.drawCount >= 1 &&
      state.renderer.draws.submitted === state.frame.drawCount,
    state.frame ? `${state.renderer.draws.submitted}/${state.frame.drawCount} draws` :
      'Frame is missing')
    const dataUrl = canvas.toDataURL('image/png')
    check(`${name}_nonblank`, framebuffer.nonBackgroundPixels > 500,
      `${framebuffer.nonBackgroundPixels} non-background pixels`)
    check(`${name}_colors`, framebuffer.sampledColorCount >= 3,
      `${framebuffer.sampledColorCount} sampled colors`)
    captures.push({ name, state, framebuffer, dataUrl })

    const figure = document.createElement('figure')
    const image = document.createElement('img')
    image.setAttribute('data-capture', name)
    image.alt = `${name} Terra globe capture`
    image.src = dataUrl
    const caption = document.createElement('figcaption')
    const label = document.createElement('span')
    label.textContent = name
    const hash = document.createElement('span')
    hash.textContent = `fnv1a32 ${framebuffer.fnv1a32}`
    caption.append(label, hash)
    figure.append(image, caption)
    capturesElement.appendChild(figure)
    return captures[captures.length - 1]
  }

  function publicReport(wasmByteLength, contextExtension) {
    return {
      schema: 'terra.web-sdk.evidence.v1',
      passed: checks.every((entry) => entry.passed),
      durationMs: Math.round(performance.now() - startedAt),
      browser: {
        userAgent: navigator.userAgent,
        webglVersion: runtime.renderer.capabilities().version,
        contextRecoveryExtension: contextExtension
      },
      sdk: {
        abiVersion: 1,
        wasmBytes: wasmByteLength,
        datasetId: runtime.state().datasetId
      },
      retry: {
        simulated: true,
        recovered: simulatedRetryRecovered,
        rootZeroAttempts: requestAttempts.get(
          '/terra/v1/datasets/globe/root/0/134217728/134217728') || 0
      },
      checks,
      captures: captures.map((item) => ({
        name: item.name,
        state: item.state,
        framebuffer: item.framebuffer
      }))
    }
  }

  function finish(report) {
    window.__terraWebEvidence = report
    resultElement.textContent = JSON.stringify(report)
    summaryElement.textContent = JSON.stringify(report, null, 2)
    document.documentElement.dataset.terraStatus = report.passed ? 'passed' : 'failed'
    statusElement.textContent = report.passed
      ? 'Automated evidence passed'
      : 'Automated evidence failed'
  }

  async function run() {
    check('sdk_bundle', Boolean(sdk && sdk.runtime && sdk.webgl && sdk.wasm),
      'Terra browser bundle loaded')
    check('webassembly_available', typeof WebAssembly === 'object',
      'WebAssembly global is available')
    installBrowserCanvasAdapter()
    const wasm = await instantiateWasm()
    runtime = await sdk.runtime.TerraGlobeRuntime.create({
      canvas,
      manifest,
      serviceOrigin: 'https://terrain.example',
      terraModule: wasm.module,
      request: terrainRequest,
      viewport: { width: 640, height: 360, devicePixelRatio: 1 },
      maximumTerrainRequests: 4,
      maximumTerrainRetries: 1,
      terrainRetryDelayMs: 10,
      maximumTextureRetries: 0
    })

    await waitForRenderedFrame(undefined, 4)
    check('terrain_retry_recovered', simulatedRetryRecovered,
      'Transient root record failure recovered')
    const initial = await capture('initial')

    runtime.zoom(0.82)
    check('zoom_sequence', runtime.state().frame.sequence > initial.state.frame.sequence,
      'SDK frame sequence advanced')
    const zoom = await capture('zoom')
    check('zoom_state', zoom.state.camera.distance < initial.state.camera.distance,
      `${initial.state.camera.distance} -> ${zoom.state.camera.distance}`)

    runtime.tilt45()
    check('tilt_sequence', runtime.state().frame.sequence > zoom.state.frame.sequence,
      'SDK frame sequence advanced')
    const tilt = await capture('tilt_45')
    check('tilt_state', approximatelyEqual(tilt.state.camera.tiltRadians,
      -Math.PI / 4, 1e-12), String(tilt.state.camera.tiltRadians))

    runtime.rotateYaw(Math.PI / 6)
    check('yaw_sequence', runtime.state().frame.sequence > tilt.state.frame.sequence,
      'SDK frame sequence advanced')
    const yaw = await capture('yaw_30')
    check('yaw_state', approximatelyEqual(yaw.state.camera.yawRadians,
      Math.PI / 6, 1e-12), String(yaw.state.camera.yawRadians))

    runtime.reset()
    check('reset_sequence', runtime.state().frame.sequence > yaw.state.frame.sequence,
      'SDK frame sequence advanced')
    const reset = await capture('reset')
    check('reset_state',
      approximatelyEqual(reset.state.camera.distance, initial.state.camera.distance, 1e-9) &&
      approximatelyEqual(reset.state.camera.tiltRadians,
        initial.state.camera.tiltRadians, 1e-12) &&
      approximatelyEqual(reset.state.camera.yawRadians,
        initial.state.camera.yawRadians, 1e-12),
      'Reset camera matches initial camera')
    check('reset_image', reset.framebuffer.fnv1a32 === initial.framebuffer.fnv1a32,
      `${initial.framebuffer.fnv1a32} -> ${reset.framebuffer.fnv1a32}`)

    check('zoom_image_changed',
      zoom.framebuffer.fnv1a32 !== initial.framebuffer.fnv1a32,
      `${initial.framebuffer.fnv1a32} -> ${zoom.framebuffer.fnv1a32}`)
    check('tilt_image_changed',
      tilt.framebuffer.fnv1a32 !== zoom.framebuffer.fnv1a32,
      `${zoom.framebuffer.fnv1a32} -> ${tilt.framebuffer.fnv1a32}`)
    check('yaw_image_changed',
      yaw.framebuffer.fnv1a32 !== tilt.framebuffer.fnv1a32,
      `${tilt.framebuffer.fnv1a32} -> ${yaw.framebuffer.fnv1a32}`)

    const extension = runtime.renderer.gl.getExtension('WEBGL_lose_context')
    check('context_extension', Boolean(extension), 'WEBGL_lose_context is available')
    extension.loseContext()
    await waitFor('WebGL context loss', () => runtime.state().contextLost, 4000)
    extension.restoreContext()
    await waitFor('WebGL context restore', () => {
      const state = runtime.state()
      return !state.contextLost && state.renderer.draws.submitted >= 4
    }, 8000)
    const restored = await capture('context_restored')
    check('context_restore_draw', restored.state.renderer.draws.submitted >= 4,
      `${restored.state.renderer.draws.submitted} draws`)
    check('context_restore_image',
      restored.framebuffer.fnv1a32 === reset.framebuffer.fnv1a32,
      `${reset.framebuffer.fnv1a32} -> ${restored.framebuffer.fnv1a32}`)

    check('capture_set', captures.length === expectedCaptures.length &&
      expectedCaptures.every((name, index) => captures[index].name === name),
    captures.map((item) => item.name).join(','))
    const report = publicReport(wasm.byteLength, true)
    finish(report)
    runtime.destroy()
  }

  run().catch((error) => {
    checks.push({
      name: 'harness_complete',
      passed: false,
      detail: error && error.message ? error.message : String(error)
    })
    finish({
      schema: 'terra.web-sdk.evidence.v1',
      passed: false,
      durationMs: Math.round(performance.now() - startedAt),
      checks,
      runtimeState: runtime ? runtime.state() : null,
      requestAttempts: Array.from(requestAttempts.entries()),
      captures: captures.map((item) => ({
        name: item.name,
        state: item.state,
        framebuffer: item.framebuffer
      }))
    })
    if (runtime) {
      runtime.destroy()
    }
  })
})()
