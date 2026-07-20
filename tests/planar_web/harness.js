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
    'initial_45_texture',
    'bird_texture',
    'bird_zoom_texture',
    'tilt_45_height',
    'reset_texture'
  ]
  const checks = []
  const captures = []
  const requestCounts = new Map()
  let runtime = null

  const manifest = {
    schema: 'terra.dataset-manifest',
    schema_version: 1,
    dataset_id: 'ps-1k',
    format_version: 1,
    patch_dim: 64,
    height_scale: 0.0000976563,
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
      url_template: '/fixtures/ps_texture_1k.png',
      matrix_level_offset: 0,
      maximum_level: 0
    }]
  }

  const fixtureForPath = {
    '/terra/v1/datasets/ps-1k/roots/0/0/268435456':
      'fixtures/planar_root_record.bin',
    '/terra/v1/datasets/ps-1k/patches/0/0/268435456':
      'fixtures/planar_root_detail_record.bin'
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
      if (value) return value
      await wait(20)
    }
    throw new Error(`Timed out waiting for ${name}`)
  }

  function installBrowserCanvasAdapter() {
    canvas.requestAnimationFrame = (callback) =>
      window.requestAnimationFrame(callback)
    canvas.createImage = () => new Image()
  }

  function terrainRequest(options) {
    const path = new URL(options.url).pathname
    const fixture = fixtureForPath[path]
    requestCounts.set(path, (requestCounts.get(path) || 0) + 1)
    let cancelled = false
    const controller = new AbortController()
    let rejectPending = null
    const promise = new Promise((resolve, reject) => {
      rejectPending = reject
      if (!fixture) {
        reject(new Error(`No planar fixture for ${path}`))
        return
      }
      fetch(fixture, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`fixture returned ${response.status}`)
          return response.arrayBuffer()
        })
        .then((buffer) => {
          if (cancelled) return
          const bytes = new Uint8Array(buffer)
          resolve({
            statusCode: 200,
            data: buffer,
            header: {
              'Content-Length': String(buffer.byteLength),
              'X-Terra-Checksum': `fnv1a64:${sdk.common.fnv1a64(bytes)}`
            }
          })
        })
        .catch(reject)
    })
    return {
      promise,
      abort() {
        if (!cancelled) {
          cancelled = true
          controller.abort()
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
    if (typeof instance.exports._initialize === 'function') {
      instance.exports._initialize()
    }
    check('wasm_abi', instance.exports.terra_abi_version() === 1,
      `ABI ${instance.exports.terra_abi_version()}`)
    return {
      module: new sdk.wasm.TerraWasmModule(instance),
      byteLength: bytes.byteLength
    }
  }

  async function waitForRenderedFrame() {
    return waitFor('drawable planar frame', () => {
      runtime.renderer.render()
      const state = runtime.state()
      if (!state.frame || state.frame.loadedRecordCount !== 2 ||
        state.frame.drawCount !== 4 || state.frame.vertexCount !== 8580 ||
        state.renderer.draws.submitted !== 4 ||
        state.renderer.geometry.entries !== 4 ||
        state.renderer.textures.entries !== 1) {
        return null
      }
      return state
    }, 12000)
  }

  function framebufferStats(gl) {
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.finish()
    gl.readPixels(0, 0, canvas.width, canvas.height,
      gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    let hash = 0x811c9dc5
    let nonBackgroundPixels = 0
    const colors = new Set()
    for (let offset = 0; offset < pixels.length; offset += 4) {
      for (let channel = 0; channel < 4; ++channel) {
        hash ^= pixels[offset + channel]
        hash = Math.imul(hash, 0x01000193)
      }
      if (pixels[offset] > 12 || pixels[offset + 1] > 18 ||
        pixels[offset + 2] > 24) {
        nonBackgroundPixels += 1
      }
      if ((offset / 4) % 53 === 0) {
        colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`)
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      fnv1a32: hash >>> 0,
      nonBackgroundPixels,
      sampledColorCount: colors.size
    }
  }

  async function capture(name) {
    await wait(40)
    runtime.renderer.render()
    const framebuffer = framebufferStats(runtime.renderer.gl)
    const state = runtime.state()
    check(`${name}_draws`, state.renderer.draws.submitted === 4,
      `${state.renderer.draws.submitted} draws`)
    check(`${name}_nonblank`, framebuffer.nonBackgroundPixels > 500,
      `${framebuffer.nonBackgroundPixels} non-background pixels`)
    const requiredColors = name === 'tilt_45_height' ? 16 : 3
    check(`${name}_colors`, framebuffer.sampledColorCount >= requiredColors,
      `${framebuffer.sampledColorCount} sampled colors`)
    const dataUrl = canvas.toDataURL('image/png')
    captures.push({ name, state, framebuffer, dataUrl })
    const figure = document.createElement('figure')
    const image = document.createElement('img')
    image.setAttribute('data-capture', name)
    image.alt = `${name} Terra planar capture`
    image.src = dataUrl
    const caption = document.createElement('figcaption')
    caption.innerHTML = `<span>${name}</span><span>fnv1a32 ${framebuffer.fnv1a32}</span>`
    figure.append(image, caption)
    capturesElement.appendChild(figure)
    return captures[captures.length - 1]
  }

  function finish(report) {
    window.__terraPlanarEvidence = report
    resultElement.textContent = JSON.stringify(report)
    summaryElement.textContent = JSON.stringify(report, null, 2)
    document.documentElement.dataset.terraStatus = report.passed
      ? 'passed' : 'failed'
    statusElement.textContent = report.passed
      ? 'Automated planar evidence passed'
      : 'Automated planar evidence failed'
  }

  async function run() {
    check('sdk_bundle', Boolean(sdk && sdk.runtime && sdk.webgl && sdk.wasm),
      'Terra browser bundle loaded')
    installBrowserCanvasAdapter()
    const wasm = await instantiateWasm()
    runtime = await sdk.runtime.TerraPlanarRuntime.create({
      canvas,
      manifest,
      serviceOrigin: window.location.origin,
      terraModule: wasm.module,
      request: terrainRequest,
      textureId: 'ps-1k',
      planarLevel: 1,
      viewport: { width: 640, height: 360, devicePixelRatio: 1 },
      maximumTerrainRetries: 0,
      maximumTextureRetries: 0
    })
    await waitForRenderedFrame()
    const initial = await capture('initial_45_texture')
    check('initial_counts', initial.state.frame.drawCount === 4 &&
      initial.state.frame.vertexCount === 8580,
    `${initial.state.frame.drawCount}/${initial.state.frame.vertexCount}`)

    runtime.birdView()
    const bird = await capture('bird_texture')
    check('bird_state', approximatelyEqual(bird.state.camera.tiltRadians, 0, 1e-12),
      String(bird.state.camera.tiltRadians))

    runtime.zoom(0.82)
    const zoom = await capture('bird_zoom_texture')
    check('zoom_state', zoom.state.camera.distance < bird.state.camera.distance,
      `${bird.state.camera.distance} -> ${zoom.state.camera.distance}`)

    runtime.tilt45()
    runtime.setRenderMode('height')
    const height = await capture('tilt_45_height')
    check('height_state', height.state.renderMode === 'height' &&
      approximatelyEqual(height.state.camera.tiltRadians, -Math.PI / 4, 1e-12),
    `${height.state.renderMode}/${height.state.camera.tiltRadians}`)

    runtime.reset()
    runtime.setRenderMode('texture')
    const reset = await capture('reset_texture')
    check('reset_state',
      approximatelyEqual(reset.state.camera.distance,
        initial.state.camera.distance, 1e-9) &&
      approximatelyEqual(reset.state.camera.tiltRadians,
        initial.state.camera.tiltRadians, 1e-12),
    'Reset camera matches initial camera')
    check('reset_image', reset.framebuffer.fnv1a32 === initial.framebuffer.fnv1a32,
      `${initial.framebuffer.fnv1a32} -> ${reset.framebuffer.fnv1a32}`)
    check('action_images',
      initial.framebuffer.fnv1a32 !== bird.framebuffer.fnv1a32 &&
      bird.framebuffer.fnv1a32 !== zoom.framebuffer.fnv1a32 &&
      zoom.framebuffer.fnv1a32 !== height.framebuffer.fnv1a32,
    'Camera and height actions changed framebuffer hashes')
    check('capture_set', captures.length === expectedCaptures.length &&
      expectedCaptures.every((name, index) => captures[index].name === name),
    captures.map((item) => item.name).join(','))

    finish({
      schema: 'terra.web-sdk.planar-evidence.v1',
      passed: checks.every((entry) => entry.passed),
      durationMs: Math.round(performance.now() - startedAt),
      sdk: { abiVersion: 1, wasmBytes: wasm.byteLength, datasetId: 'ps-1k' },
      requests: Array.from(requestCounts.entries()),
      checks,
      captures: captures.map((item) => ({
        name: item.name,
        state: item.state,
        framebuffer: item.framebuffer
      }))
    })
    runtime.destroy()
  }

  run().catch((error) => {
    checks.push({
      name: 'harness_complete',
      passed: false,
      detail: error && error.message ? error.message : String(error)
    })
    finish({
      schema: 'terra.web-sdk.planar-evidence.v1',
      passed: false,
      durationMs: Math.round(performance.now() - startedAt),
      checks,
      runtimeState: runtime ? runtime.state() : null,
      captures: captures.map((item) => ({
        name: item.name,
        state: item.state,
        framebuffer: item.framebuffer
      }))
    })
    if (runtime) runtime.destroy()
  })
})()
