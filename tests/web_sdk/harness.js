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
    'initial_world',
    'beijing_top',
    'beijing_zoom',
    'beijing_tilt_45',
    'beijing_heading_30',
    'beijing_north_45',
    'beijing_top_north',
    'reset_world',
    'context_restored'
  ]
  const checks = []
  const navigationScenarios = []
  const navigationFailures = []
  let navigationTerrain = null
  let networkNavigation = null
  let localNavigation = null, localNavigationNoFaults = null
  const captures = []
  const imageryTrace = []
  let rapidZoomEvidence = null
  const memoryReplay = {warmupLaps: 1, viewsPerLap: 8, samples: []}
  let imageryProgress = ''
  const requestAttempts = new Map()
  let viewer = null
  let runtime = null
  let terrainFrozen = false
  let simulatedRetryScheduled = false
  let simulatedRetryRecovered = false

  const manifest = {
    schema: 'terra.dataset-manifest',
    schema_version: 1,
    dataset_id: 'globe-web-evidence',
    format_version: 1,
    patch_dim: 64,
    // These records use the reviewed globe_terrain.xml quantization (1/64 m).
    // Treating raw heights as metres fabricates relief and texture demand.
    height_scale: 0.015625,
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
    // Retain the last completed check even if the outer browser deadline fires.
    statusElement.textContent = name
    window.__terraWebProgress = () => ({checks, runtimeState: runtime && runtime.state(), imageryTrace})
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

  const textureUrls = new Map()
  function makeTextureDataUrl(url) {
    const match = /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(new URL(url).pathname)
    const level = match ? Number(match[1]) : 0
    const column = match ? Number(match[2]) : 0
    const row = match ? Number(match[3]) : 0
    const key = level + '/' + column + '/' + row
    if (textureUrls.has(key)) return textureUrls.get(key)
    const size = 256 / Math.pow(2, level)
    // One geographic image at every LOD. SVG lets the browser decode the tile
    // asynchronously; generating PNG pixels here would block SDK scheduling.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" ' +
      'viewBox="' + column * size + ' ' + row * size + ' ' + size + ' ' + size + '">' +
      '<rect width="512" height="256" fill="#1d6590"/>' +
      '<g fill="#5fa65b"><path d="M25 58 Q65 23 113 48 L145 87 L108 110 ' +
      'L92 161 L63 125 L44 97 Z"/><path d="M120 138 L155 145 Q183 170 ' +
      '156 224 L137 242 L121 194 Z"/><path d="M217 68 Q271 27 326 44 ' +
      'L388 35 L451 71 L428 110 L387 137 L347 103 L304 119 L286 166 ' +
      'L257 188 L231 153 L235 104 Z"/><path d="M374 174 Q412 154 449 184 ' +
      'L430 218 L390 222 Z"/></g><g fill="#d8c66f">' +
      '<path d="M239 109 L285 100 L283 137 L251 149 Z"/>' +
      '<path d="M359 61 L410 69 L399 99 L367 95 Z"/></g>' +
      '<g fill="#f2f4f5"><rect width="512" height="12"/>' +
      '<rect y="244" width="512" height="12"/></g></svg>'
    const value = 'data:image/svg+xml;base64,' + btoa(svg)
    textureUrls.set(key, value)
    return value
  }


  function installBrowserCanvasAdapter() {
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
          sourceProperty.set.call(image, requestedUrl ? makeTextureDataUrl(requestedUrl) : '')
        }
      })
      return image
    }
  }

  function terrainRequest(options) {
    const path = new URL(options.url).pathname
    const fixture = fixtureForPath[path] ||
      (path.includes('/root/')
        ? 'fixtures/globe_root_0_record.bin'
        : path.includes('/detail/')
          ? 'fixtures/globe_patch_record.bin'
          : '')
    const attempt = (requestAttempts.get(path) || 0) + 1
    requestAttempts.set(path, attempt)

    let cancelled = false
    let controller = null
    let rejectPending = null
    const promise = new Promise((resolve, reject) => {
      rejectPending = reject
      if (terrainFrozen) {
        return
      }
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
        if (cancelled || terrainFrozen) {
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
    const module = await sdk.wasm.instantiateTerraWasmBytes(bytes)
    check('wasm_abi', module.exports.terra_abi_version() === sdk.wasm.TERRA_ABI_VERSION,
      `ABI ${module.exports.terra_abi_version()}`)
    return {
      module,
      byteLength: bytes.byteLength
    }
  }

  async function waitForRenderedFrame(previousSequence, minimumDraws, options) {
    const requiredDraws = minimumDraws === undefined ? 1 : minimumDraws
    const allowProgressiveImagery = Boolean(options &&
      options.allowProgressiveImagery)
    let progressSignature = '', lastProgressAt = performance.now(), stableIdentity = '', stableSince = 0
    return waitFor('loaded globe frame', () => {
      // The runtime owns the display clock. Polling must not enqueue an extra
      // synchronous frame beside RAF; that hides/creates scheduling stalls.
      // Pixel capture below still explicitly draws immediately before readback.
      if (!(options && options.requireStableAvailableTerrain)) runtime.renderer.requestRender()
      const state = runtime.state()
      const frame = state.frame
      const renderer = state.renderer
      const progress = JSON.stringify([frame && frame.sequence,
        frame && frame.loadedRecordCount, renderer && renderer.textures.cachedTarget, imageryProgress])
      if (progress !== progressSignature) {
        progressSignature = progress
        lastProgressAt = performance.now()
      }
      if (performance.now() - lastProgressAt > 12000) {
        throw new Error('Loaded globe frame stopped making progress')
      }
      const expectedDraws = renderer && renderer.quality
        ? renderer.quality.renderedDrawCount : 0
      const progressiveImageryReady = allowProgressiveImagery &&
        renderer && renderer.quality && renderer.quality.meetsTarget &&
        !renderer.quality.limitedByBudget &&
        !renderer.quality.limitedByLevel &&
        !renderer.quality.limitedByCache &&
        renderer.quality.targetCoverage >= 0.9 &&
        renderer.textures.fallbackRatio <= 0.1 &&
        renderer.textures.missingRatio === 0 &&
        renderer.textures.failed === 0
      const exactImageryReady = renderer && renderer.textures.idle &&
        !renderer.quality.transitioningCells &&
        renderer.textures.targetMissing === 0 &&
        renderer.textures.missingRatio === 0 &&
        renderer.textures.fallbackRatio === 0
      // Retained fine leaves may subdivide a fully resident planning target.
      // Their unused siblings bind that target through an ancestor UV transform;
      // this is not an unresolved target. As with the exact-binding path above,
      // a budget-limited cut can be captured, but its displayed error must stay
      // within the planner's admitted error and the existing transition bound.
      const admittedImageryReady = allowProgressiveImagery && renderer &&
        renderer.quality.planningComplete === true &&
        renderer.quality.limitedByBudget &&
        Number.isFinite(renderer.quality.resolvedMaxPixelError) &&
        renderer.quality.resolvedMaxPixelError <= renderer.quality.feasiblePixelError * 1.001 &&
        renderer.textures.idle && renderer.textures.targetMissing === 0 &&
        renderer.textures.frontierTiles === 0 && renderer.textures.stagedTiles === 0 &&
        renderer.textures.fallbackRatio <= 0.1 && renderer.textures.missingRatio === 0 &&
        renderer.textures.failed === 0
      if (!frame || !renderer || frame.loadedRecordCount < 8 ||
        frame.drawCount < requiredDraws ||
        expectedDraws < requiredDraws ||
        renderer.draws.submitted !== expectedDraws ||
        !renderer.quality.geometryCoverageReady ||
        !renderer.quality.terrainSelectionCurrent || renderer.quality.provisional ||
        renderer.quality.planningComplete !== true ||
        !renderer.quality.cameraCurrent || runtime.refreshing || runtime.meshFrames.candidate ||
        (!allowProgressiveImagery &&
          renderer.transition.displayingPreviousFrame) ||
        renderer.geometry.entries < requiredDraws ||
        renderer.textures.entries < 1 ||
        (!exactImageryReady && !progressiveImageryReady && !admittedImageryReady)) {
        return null
      }
      if (options && options.requireStableTerrain && (!renderer.quality.resourceStable ||
          renderer.quality.transitioningCells || !frame.decisionsComplete ||
          state.terrain.active || state.terrain.queued || runtime.terrainRefreshTimer !== null ||
          runtime.refreshPending || runtime.cameraRefreshTimer !== null)) return null
      if (options && options.requireStableAvailableTerrain) {
        // This memory fixture deliberately holds new terrain I/O unresolved.
        // Wait for the complete available cut, not those frozen requests; do
        // not sample halfway through native/GPU work or a world preparation
        // that still borrows those inputs. Rendering a cut is not quiescence.
        if (!terrainFrozen) throw new Error('Available-cut replay requires frozen terrain input')
        const resources=state.resources, partitions=renderer.transition.partitions
        const clock=state.performance.frameCoordinator
        const busy=runtime.refreshPending || runtime.terrainRefreshTimer!==null || runtime.cameraRefreshTimer!==null ||
          runtime.imageryRefreshing || runtime.imageryRefreshPending || runtime.abi.pending.size ||
          renderer.transition.worldDisplay.preparing ||
          runtime.renderer.worldDisplay.records.some(record=>record.maintenance) ||
          clock.pendingWork || clock.pendingRender || clock.pendingAnimations || clock.pendingInputs ||
          !resources || resources.pendingPriorityUpdateCount || resources.pendingMeshGroups ||
          renderer.quality.visibilityProofsPending || renderer.quality.transitioningCells ||
          renderer.transition.gpuSubmission.pending || partitions.queuedCells || partitions.activeMs || partitions.uploading ||
          renderer.textures.targetMissing || renderer.textures.stagedTiles || renderer.textures.frontierTiles
        if (busy) { stableSince=0;return null }
        const identity=runtime.meshFrames.presented.meshIdentity
        if (identity!==stableIdentity || !stableSince) {stableIdentity=identity;stableSince=performance.now();return null}
        if (performance.now()-stableSince<250) return null
      }
      if (previousSequence !== undefined && frame.sequence <= previousSequence) {
        return null
      }
      return state
    }, 30000)
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

  async function renderForReadback(renderer, accept) {
    // Pending WebGL2 work retains the composed canvas but does not issue a
    // new draw. Yield to the browser until an actual submission before reading
    // the default framebuffer; never force the fence with finish/wait timeouts.
    return window.TerraReadback(renderer, {drive: !runtime || renderer !== runtime.renderer, accept})
  }

  async function verifyTextureBlend(renderer, surface, fineDraws) {
    const gl = renderer.gl, pixel = new Uint8Array(4)
    const root = {level: 0, matrix: 1, row: 0, column: 1}
    const red = [240, 20, 0, 255], blue = [0, 40, 220, 255]
    renderer.textures.cache.entries.forEach((entry, key) => {
      const asset = entry.value
      if (!asset.texture) return
      const color = Number(key.split('/')[0]) > 1 ? red : blue
      const rgba = new Uint8Array(asset.width * asset.height * 4)
      for (let i = 0; i < rgba.length; i += 4) rgba.set(color, i)
      gl.bindTexture(gl.TEXTURE_2D, asset.texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, asset.width, asset.height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, rgba)
      gl.generateMipmap(gl.TEXTURE_2D)
    })
    const sample = async () => {
      await renderForReadback(renderer)
      gl.readPixels(surface.width / 2, surface.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      return Array.from(pixel)
    }
    const close = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) <= 2)
    const original = await sample()
    check('transition_fine_pixel', close(original, red), original)
    const source = fineDraws[0].sourceTexture, divisor = Math.pow(2, source.level)
    const coarse = Object.assign({}, fineDraws[0], {texture: root,
      imageryCellScale: 1 / divisor, imageryCellOffsetX: source.column / divisor - root.column,
      imageryCellOffsetY: source.row / divisor - root.row, imageryClipCell: false})
    const select = (draws, coarsening) => renderer.setImageryPlan(1, {draws, levels: new Set(), quality: {
      planningComplete: true, cameraCurrent: true, coarsening, targetPixelError: 1.25}},
      [{resourceId: 1, visible: true, pixelsPerUv: coarsening ? 1 : 1024, centerDistance: 0}])
    let now = 0
    renderer.options.textureClock = () => now
    renderer.options.scheduledImagery = true
    select([coarse], true)
    const first = await sample()
    now = 100
    const middle = await sample()
    const fading = renderer.stats().quality
    check('transition_coarse_pixels', close(first, red) && close(middle, [120, 30, 110, 255]) &&
      fading.transitioningCells > 0 && !fading.ready,
      JSON.stringify({first, middle, transitioning: fading.transitioningCells}))
    select(fineDraws, false)
    const reversed = await sample()
    now = 150
    const reverseMiddle = await sample()
    now = 201
    const fine = await sample()
    check('transition_reverse_pixels', close(reversed, middle) &&
      close(reverseMiddle, [180, 25, 55, 255]) && close(fine, red),
      JSON.stringify({reversed, reverseMiddle, fine}))
    select([coarse], true)
    await sample()
    now = 402
    const done = await sample()
    now = 403
    await sample()
    check('transition_release_after_submit', close(done, blue) && !renderer.presentation.active &&
      Array.from(renderer.presentedTextures.values()).every(tile => tile.level <= 1) &&
      renderer.stats().textures.entries <= renderer.textures.requestedMaximumEntries,
      JSON.stringify({done, cells: renderer.presentation.cells.size}))
    select(fineDraws, false)
    await sample()
    now = 604
    await sample()
    delete renderer.options.textureClock
  }

  // These synthetic pixel fixtures specify their cut explicitly. Selection
  // belongs to the native SDK planner, exercised by the main runtime below.
  const fixtureImagery = depth => (draws, measure, options) => {
    const result = [], scale = Math.pow(2, depth)
    let error = 0
    draws.forEach(draw => {
      const pixels = measure(draw).pixelsPerUv
      error = Math.max(error, Number.isFinite(pixels) ? pixels / (256*scale) : 0)
      for (let row=0; row<scale; ++row) for (let column=0; column<scale; ++column) {
        result.push(Object.assign({},draw, {
          sourceTexture: draw.texture,
          texture: {level:draw.texture.level+depth, matrix:draw.texture.matrix+depth,
            row:draw.texture.row*scale+row, column:draw.texture.column*scale+column},
          imageryCellScale: scale, imageryCellOffsetX: -column, imageryCellOffsetY: -row,
          imageryClipCell: depth>0, imageryPixelError: error
        }))
      }
    })
    return {draws: result, levels: new Set(), quality: {planningComplete: true, spatialCut: true,
      targetPixelError: options.targetPixelError, measuredMaxPixelError: error,
      sourceDrawCount: draws.length, renderedDrawCount: result.length}}
  }

  async function verifyNearCameraPixels(module, contextType = 'webgl2') {
    const surface = document.createElement('canvas')
    surface.width = surface.height = 128
    surface.createImage = canvas.createImage
    const abi = new sdk.runtime.TerraAbi(module)
    const descriptor = {kind:'global-geodetic', matrix_level_offset:1, maximum_level:1,
      level_zero_columns:2, level_zero_rows:1, tile_size:256}
    const renderer = new sdk.webgl.TerraWebGlRenderer(surface, {
      planImagery: fixtureImagery(0),
      gl: surface.getContext(contextType, {alpha: false, depth: true, stencil: true}),
      urlForTile: tile => `https://tiles.example/${tile.level}/${tile.column}/${tile.row}.png`,
      textureDescriptor:descriptor, terrainBoundImagery:false, maximumTextureEntries:16,
      textureCacheBytes:16*349524, maximumResourceBytes:32*1024*1024+16*349524, maximumTextureRetries:0
    })
    try {
      abi.loadManifest(runtime.manifest)
      abi.setViewport(128,128,0.6)
      abi.setGlobeTarget(0,0)
      const pixel = new Uint8Array(4), records = []
      let sequence = 0
      for (const height of [-400,1600]) {
        abi.setCamera({distance:2, targetHeightMeters:height, tiltRadians:-88*Math.PI/180, yawRadians:0})
        const camera = abi.getCameraSnapshot()
        const target = {resourceId:++sequence, textureResourceId:4294967296 + (sequence), flags:0, key:{level:0,i:1,j:2,k:3}, fragment:0,
          texture:{level:0,matrix:1,row:0,column:1}, origin:[0,0,runtime.manifest.radius+height],
          firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}
        renderer.setMeshFrame(Object.assign({sequence,coverageComplete:true},camera), [target],
          new Map([[sequence,{resourceId:sequence,
            positions:new Float32Array([-10,-10,0,10,-10,0,-10,10,0,10,10,0]),
            textureUv:new Float32Array([0,0,1,0,0,1,1,1])}]]), new Uint16Array([1,0,3,2]),
          {modelRevision:sequence,pendingPriorityUpdateCount:0})
        await waitFor('near-ground target pixel', () => {
          if (!renderer.render()) return false
          const gl=renderer.gl
          gl.readPixels(64,64,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel)
          return renderer.textures.availableKeys.size > 0 &&
            [6,11,18].some((v,i) => Math.abs(pixel[i]-v)>3)
        },10000)
        records.push({targetHeightMeters:height,rangeMeters:2,tiltDegrees:88,pixel:Array.from(pixel)})
      }
      check('near_ground_elevated_pixels_' + contextType, records.length===2 &&
        renderer.asyncGpu === (contextType === 'webgl2'), JSON.stringify(records))
    } finally {
      abi.destroy()
      const gl=renderer.gl
      renderer.destroy()
      const lose=gl && gl.getExtension('WEBGL_lose_context')
      if(lose)lose.loseContext()
      surface.remove()
    }
  }

  async function verifyGpuFrameAdmission() {
    const surface = document.createElement('canvas')
    surface.width = surface.height = 256
    const gl = surface.getContext('webgl2', {alpha: false, depth: true, stencil: true})
    // This fixture observes each individual GPU stage from its manual clock.
    const renderer = new sdk.webgl.TerraWebGlRenderer(surface, {gl, requestResources() {},
      mode: 'height', urlForTile: () => 'unused'})
    const drive=(force=true)=>{renderer.advanceResources();return renderer.render(force)}
    renderer.textures.scheduler.pause()
    const waitSync = gl.clientWaitSync.bind(gl), drawElements = gl.drawElements.bind(gl), getError = gl.getError.bind(gl)
    let held = false, draws = 0, checks = 0
    gl.clientWaitSync = (...args) => held ? gl.TIMEOUT_EXPIRED : waitSync(...args)
    gl.drawElements = (...args) => { ++draws; return drawElements(...args) }
    gl.getError = () => { ++checks; return getError() }
    try {
      const projectionView = new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1])
      const cameraPosition = [10,20,30]
      const target = {resourceId:1, textureResourceId:4294967296 + (1), flags: 0, key: {level: 0, i: 1, j: 2, k: 3}, fragment: 0,
        texture: {level: 0, matrix: 0, row: 0, column: 0}, origin: [0,0,0],
        firstVertex: 0, vertexCount: 4, firstIndex: 0, indexCount: 4}
      renderer.setMeshFrame({sequence: 1, coverageComplete: true, projectionView, cameraPosition},
        [target], new Map([[1, {resourceId: 1,
          positions: new Float32Array([-0.5,-0.5,0, 0.5,-0.5,0, -0.5,0.5,0, 0.5,0.5,0]),
          textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])}]]), new Uint16Array([1,0,3,2]),
        {modelRevision: 1, pendingPriorityUpdateCount: 0})
      await waitFor('GPU admission fixture upload', () => {drive(); return renderer.geometry.stats().entries === 1}, 10000)
      await waitFor('GPU admission fixture idle', () => {drive(false); return !renderer.pendingSubmission}, 10000)
      held = true
      drive()
      const before = draws, validations = checks, background = new Uint8Array(4)
      gl.readPixels(16,128,1,1,gl.RGBA,gl.UNSIGNED_BYTE,background)
      for (let i = 1; i <= 25; ++i) {
        const view = projectionView.slice(); view[3] = i / 50
        renderer.setCameraFrame({projectionView: view, cameraPosition})
        drive(false)
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      check('gpu_frame_admission', draws === before && checks === validations &&
        renderer.pendingSubmission && renderer.pendingSubmission.items.length === 0,
        '25 camera revisions produced no queued draws or synchronous validation behind a held frame-only fence')
      held = false
      await renderForReadback(renderer)
      const left = new Uint8Array(4), right = new Uint8Array(4)
      gl.readPixels(96,128,1,1,gl.RGBA,gl.UNSIGNED_BYTE,left)
      gl.readPixels(224,128,1,1,gl.RGBA,gl.UNSIGNED_BYTE,right)
      check('gpu_latest_camera_pixel', draws === before + 1 &&
        Array.from(left).every((value, i) => value === background[i]) &&
        Array.from(right).some((value, i) => Math.abs(value - background[i]) > 3),
        JSON.stringify({left: Array.from(left), right: Array.from(right), background: Array.from(background)}))
      await waitFor('GPU completion without redraw', () => {drive(false); return !renderer.pendingSubmission}, 10000)
      const idleDraws = draws
      for (let i = 0; i < 5; ++i) {
        drive(false)
        await new Promise(resolve => setTimeout(resolve, 16))
      }
      check('gpu_idle_no_draws', draws === idleDraws && checks === validations && !renderer.pendingSubmission,
        'Completion checks stop without extra draws or GL error queries when the view is unchanged')
      // Reflect only the camera projection to expose the same triangles' backs.
      // The resource, texture and GPU buffers stay unchanged.
      const reflected = projectionView.slice(); reflected[0] = -1; reflected[3] = 0.5
      renderer.setCameraFrame({projectionView: reflected, cameraPosition})
      await renderForReadback(renderer)
      const back = new Uint8Array(4)
      gl.readPixels(224,128,1,1,gl.RGBA,gl.UNSIGNED_BYTE,back)
      check('terrain_backface_pixel', Array.from(back).every((value,i) => value === background[i]),
        JSON.stringify({back:Array.from(back), background:Array.from(background)}))
      reflected[0] = 1
      renderer.setCameraFrame({projectionView: reflected, cameraPosition})
      await renderForReadback(renderer)
      gl.readPixels(224,128,1,1,gl.RGBA,gl.UNSIGNED_BYTE,back)
      check('terrain_frontface_restored', Array.from(back).every((value,i) => value === right[i]),
        'Restoring the exterior view renders the same resident terrain pixels')
      await waitFor('texture pump fixture idle', () => {drive(false); return !renderer.pendingSubmission}, 10000)
      const image = document.createElement('canvas')
      image.width = image.height = 256
      image.getContext('2d').fillRect(0,0,256,256)
      const store = renderer.textures, children = [0,1,2,3].map(i =>
        ({level: 1, matrix: 1, row: i >> 1, column: i & 1}))
      renderer.uploadTexture(image,256,256,texture => {
        store.cache.set('0/0/0/0',{image,texture,width:256,height:256},349524)
      }, () => {})
      store.buildRequirementTree(children.map(texture => ({texture})))
      store.recomputeAvailability()
      children.forEach(tile => store.cache.set(`1/1/${tile.row}/${tile.column}`,
        {image,texture:null,width:256,height:256},349524))
      store.scheduler.resume(); store.advance()
      // This contract deliberately needs several upload receipts. Keep its
      // small window explicit now that the default fits all four siblings.
      const savedUploadBytes = renderer.options.uploadBudgetBytes
      renderer.options.uploadBudgetBytes = 512 * 1024
      const beforeUploads = draws
      let partialUploads = 0, presentations = 0
      await waitFor('texture group upload without terrain redraw', () => {
        const submitted = drive(false)
        if (submitted && submitted.submitted) ++presentations
        const ready = children.filter(tile => store.gpuReady(`1/1/${tile.row}/${tile.column}`)).length
        if (ready > 0 && ready < 4) {
          ++partialUploads
          if (draws !== beforeUploads) throw new Error('Unchanged terrain redrawn for a partial image group')
        }
        return ready === 4 && presentations > 0
      }, 10000)
      check('texture_upload_without_redraw', partialUploads > 0 && presentations === 1 &&
        children.every(tile => store.gpuReady(`1/1/${tile.row}/${tile.column}`)),
        JSON.stringify({partialUploads, presentations, terrainDraws:draws-beforeUploads}))
      renderer.options.uploadBudgetBytes = savedUploadBytes
      await waitFor('partition fixture idle', () => {drive(false); return !renderer.pendingSubmission}, 10000)
      let finishPlan, finishPartition
      renderer.options.createPartitionPlanTask = () => ({cancel() {},
        promise: new Promise(resolve => {finishPlan = resolve})})
      renderer.options.createPartitionTask = () => ({cancel() {},
        promise: new Promise(resolve => {finishPartition = resolve})})
      const geometry = renderer.geometry.values()[0], cell = {key: 'preparation-fixture', bounds: {
        minimumU: 0, maximumU: 1, minimumV: 0, maximumV: 1}}
      const beforePartition = draws
      // Explicit retained demand keeps this non-displayed fixture valid while
      // the normal queue sweep removes work with no current or handoff owner.
      renderer.partitionPublication.handoff.add(geometry.key + ':' + cell.key)
      renderer.requestPartitionSet(geometry, [cell])
      await waitFor('partition pricing starts', () => {drive(false); return finishPlan}, 5000)
      finishPlan([{key:cell.key,bytes:12}])
      await waitFor('partition producer starts', () => {drive(false); return finishPartition}, 5000)
      for (let i = 0; i < 4; ++i) {drive(false); await wait(16)}
      check('partition_prepare_without_redraw', draws === beforePartition && !renderer.pendingSubmission,
        'Partition enqueue, pricing and delayed production leave the submitted terrain alone')
      finishPartition([{cell, indices:new Uint16Array([1,0,3,3,0,2]),
        positions:new Float32Array(0), uv:new Float32Array(0)}])
      await waitFor('partition resource submission', () => {
        drive(false); return renderer.pendingSubmission
      },5000)
      check('partition_upload_without_redraw', draws === beforePartition &&
        renderer.stats().transition.gpuSubmission.kind === 'resource',
        'Completed CPU output uploads without queuing unchanged terrain ahead of it')
      await waitFor('unused partition output becomes resident', () => {
        drive(false)
        return geometry.partitions.has(cell.key) && !renderer.pendingSubmission
      },10000)
      check('partition_unused_output_without_redraw', draws === beforePartition,
        'UV output outside the display cut consumes no terrain draw')
      // Explicit readback forces a draw; a preparation wake alone may be equal
      // to the last display and leave the discardable framebuffer untouched.
      const partitionPixel = new Uint8Array(4)
      await renderForReadback(renderer)
      gl.readPixels(224,128,1,1,gl.RGBA,gl.UNSIGNED_BYTE,partitionPixel)
      check('partition_unused_output_pixels', draws === beforePartition + 1 &&
        geometry.partitions.has(cell.key) && Array.from(partitionPixel).every((v,i) => v === right[i]),
        JSON.stringify({terrainDraws:draws-beforePartition,pixel:Array.from(partitionPixel)}))
    } finally {
      gl.clientWaitSync = waitSync; gl.drawElements = drawElements; gl.getError = getError
      renderer.destroy()
      check('gpu_frame_cleanup', !renderer.pendingSubmission && renderer.resourceLedger.stats().bytes === 0,
        'Submission handles and managed resources released')
      const lose = gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
      surface.remove()
    }
  }

  async function verifyLocalPreparation() {
    const surface = document.createElement('canvas')
    surface.width = surface.height = 256
    const gl = surface.getContext('webgl2', {alpha: false, depth: true, stencil: true})
    const receipts = [], local = []
    const renderer = new sdk.webgl.TerraWebGlRenderer(surface, {gl, mode: 'height',
      heightRange: [0, 0.5], managedResources: true, geometryCacheBytes: 240,
      maximumResourceBytes: 480 + 32*1024*1024,
      urlForTile: () => 'unused', onPresented: sequence => receipts.push(sequence),
      onSurfaceSubmitted: (value, partial) => { if (partial) local.push(value) }})
    renderer.textures.scheduler.pause()
    const waitSync = gl.clientWaitSync.bind(gl), drawElements = gl.drawElements.bind(gl)
    let held = false, draws = 0
    gl.clientWaitSync = (...args) => held ? gl.TIMEOUT_EXPIRED : waitSync(...args)
    gl.drawElements = (...args) => { ++draws; return drawElements(...args) }
    const indices = new Uint16Array([1,0,2,0,3,0,1])
    const patch = (id, upper, height) => {
      const corners = upper ? [[1,1],[0,1],[1,0]] : [[0,0],[1,0],[0,1]]
      const centre = upper ? 2 / 3 : 1 / 3
      const points = [[centre,centre]].concat(corners)
      return {draw: {resourceId:id, textureResourceId:4294967296 + (id), flags:0, key:{level:0,i:1,j:2,k:3}, fragment:upper ? 1 : 0,
        textureNode:{level:0,root:0,column:0,row:0}, texture:{level:0,matrix:0,column:0,row:0},
        origin:[0,0,0], firstVertex:0, vertexCount:4, firstIndex:0,indexCount:7},
      resource:{resourceId:id, positions:new Float32Array(points.flatMap((p,i)=>
        [p[0]*1.6-0.8,p[1]*1.6-0.8,i ? 0 : height])), textureUv:new Float32Array(points.flat())}}
    }
    // These synthetic triangles only change their interior height. Their exact
    // boundary proof has one independent replacement per unchanged footprint.
    // Real native proofs are compared against full arrays in Wasm/Worker tests.
    const publish = (sequence, patches, atomic = false) => {
      const before = renderer.displaySurface && renderer.displaySurface.current
      const replacementPlan = before ? {groups: patches.map(patch => ({
        before: before.draws.filter(draw => draw.fragment === patch.draw.fragment).map(draw => draw.resourceId),
        after: [patch.draw.resourceId]}))} : null
      if (atomic) {
        replacementPlan.atomic = true
        replacementPlan.groups = [{before: before.draws.map(draw=>draw.resourceId),
          after: patches.map(patch=>patch.draw.resourceId)}]
      }
      renderer.setMeshFrame({sequence,coverageComplete:true,
        projectionView:new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),cameraPosition:[10,20,30]},
        patches.map(p=>p.draw),new Map(patches.map(p=>[p.draw.resourceId,p.resource])),indices,
        {modelRevision:sequence,workerGeneration:1,pendingPriorityUpdateCount:1}, null, [],
        {replacementPlan,selectionCurrent:true,camera:{}})
    }
    const pixel = (x,y) => {const p=new Uint8Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p)}
    try {
      publish(1,[patch(1,false,0),patch(2,true,0)])
      await waitFor('retained scan cut',()=>{renderer.render();return receipts.includes(1)},10000)
      await renderForReadback(renderer)
      const beforeLower=pixel(96,96), beforeUpper=pixel(160,160)
      check('retained_cut_geometry_ready', !renderer.displaySurface.useGeometryCoverage &&
        !renderer.currentSelectionReady(), 'Resident geometry stays usable while terrain priorities remain pending')
      // Hold the existing display before candidate preparation can upload and
      // publish a local group. Preparation speed is not a synchronization gate.
      held=true
      const beforeDraws=draws
      publish(2,[patch(3,false,0.3),patch(4,true,0.3)])
      await waitFor('candidate upload submitted',()=>{renderer.render();return renderer.submissions.uploading},10000)
      const plan=renderer.current.replacementPlan
      for (let i=0;i<3;++i) { renderer.render(); await new Promise(resolve=>setTimeout(resolve,0)) }
      check('local_preparation_before_receipt',draws===beforeDraws && renderer.pendingSubmission &&
        plan.groups.length===2 && local.length===0 && receipts.length===1,
        'Admitted candidate upload retains its proof and old display until its own completion receipt')
      held=false
      await waitFor('local group submitted',()=>{const result=renderer.render();return result && local.length},10000)
      const lower=pixel(96,96), upper=pixel(160,160)
      check('local_preparation_pixels',local[0].meshResources.has(3) && local[0].meshResources.has(2) &&
        lower.some((v,i)=>Math.abs(v-beforeLower[i])>10) && upper.every((v,i)=>v===beforeUpper[i]) &&
        receipts.length===1,JSON.stringify({beforeLower,beforeUpper,lower,upper}))
      await waitFor('local preparation complete receipt',()=>{renderer.render();return receipts.includes(2)},10000)
      check('local_preparation_capacity',renderer.geometry.maximumBytes===240 &&
        renderer.geometry.bytes<=240 && !renderer.geometryPinnedKeys.has('mesh:1'),
        'The second group reused capacity released by the submitted first group')
      const localStart=local.length
      publish(3,[patch(5,false,0.45),patch(6,true,0.45)])
      await waitFor('mixed candidate to supersede',()=>{renderer.render();return local.length>localStart},10000)
      const token=renderer.holdCandidate(3), mixed=renderer.displaySurface
      const frozenLower=pixel(96,96), frozenUpper=pixel(160,160)
      await renderForReadback(renderer)
      check('candidate_hold_pixels',token && renderer.displaySurface===mixed && !receipts.includes(3) &&
        pixel(96,96).every((v,i)=>v===frozenLower[i]) && pixel(160,160).every((v,i)=>v===frozenUpper[i]),
        'Holding preparation preserved the actually submitted mixed display')
      renderer.discardCandidate(token)
      check('candidate_retirement_before_admission', renderer.heldCandidate === token &&
        renderer.uploadQueue.length === 0 && !renderer.geometryPinnedKeys.has('mesh:6') &&
        renderer.displaySurface === mixed && !receipts.includes(3),
        'CPU retirement surrendered queued GPU destinations before successor admission while retaining the submitted cut')
      renderer.releaseCandidate(token)
      await renderForReadback(renderer)
      check('candidate_refusal_pixels',!renderer.heldCandidate && !receipts.includes(3) &&
        renderer.current.meshResources.has(5) && renderer.current.meshResources.has(4) &&
        !renderer.current.meshResources.has(6) && !renderer.geometryPinnedKeys.has('mesh:6') &&
        pixel(96,96).every((v,i)=>v===frozenLower[i]) && pixel(160,160).every((v,i)=>v===frozenUpper[i]),
        'Failed successor publication retained only the acknowledged mixed cut without changing pixels')
      publish(4,[patch(5,false,0.45),patch(7,true,0.15)])
      renderer.releaseCandidate(token)
      await waitFor('successor of mixed display',()=>{renderer.render();return receipts.includes(4)},10000)
      await renderForReadback(renderer)
      const successorLower=pixel(96,96),successorUpper=pixel(160,160)
      check('candidate_successor_pixels',!receipts.includes(3) &&
        successorLower.every((v,i)=>v===frozenLower[i]) &&
        successorUpper.some((v,i)=>Math.abs(v-frozenUpper[i])>10) && renderer.geometry.bytes<=240,
        JSON.stringify({frozenLower,frozenUpper,successorLower,successorUpper}))
      // An atomic proof authorizes only the whole replacement. Even when one
      // destination is ready, neither its pixels nor its receipt may publish.
      const atomicLocal = local.length
      publish(5,[patch(8,false,0.1),patch(9,true,0.4)],true)
      await waitFor('one atomic destination ready',()=>{
        renderer.render()
        return renderer.geometry.has('mesh:8') && !renderer.geometry.has('mesh:9')
      },10000)
      await renderForReadback(renderer)
      check('atomic_preparation_pixels', !receipts.includes(5) && local.length===atomicLocal &&
        pixel(96,96).every((v,i)=>v===successorLower[i]) && pixel(160,160).every((v,i)=>v===successorUpper[i]),
        'A ready subset of an atomic cut leaves both old regions and their ownership intact')
      renderer.setBudget({geometryCacheBytes:320})
      await waitFor('complete atomic receipt',()=>{renderer.render();return receipts.includes(5)},10000)
      await renderForReadback(renderer)
      check('atomic_complete_pixels', pixel(96,96).some((v,i)=>Math.abs(v-successorLower[i])>10) &&
        pixel(160,160).some((v,i)=>Math.abs(v-successorUpper[i])>10),
        'Both regions change only after the complete atomic destination is available')
    } finally {
      gl.clientWaitSync=waitSync;gl.drawElements=drawElements
      renderer.destroy()
      check('local_preparation_cleanup',!renderer.replacement && !renderer.pendingSubmission &&
        renderer.resourceLedger.stats().bytes===0,'Boundary proofs and GPU resources were released')
      const lose=gl.getExtension('WEBGL_lose_context');if(lose)lose.loseContext()
      surface.remove()
    }
  }

  async function verifyIndependentImageryRoots(contextType) {
    const surface = document.createElement('canvas')
    surface.width = surface.height = 256
    const color = document.createElement('canvas')
    color.width = color.height = 256
    color.getContext('2d').fillStyle = 'rgb(240,20,10)'
    color.getContext('2d').fillRect(0, 0, 256, 256)
    const blob = await new Promise(resolve => color.toBlob(resolve))
    color.getContext('2d').fillStyle = 'rgb(10,20,240)'
    color.getContext('2d').fillRect(0, 0, 256, 256)
    const coarse = await new Promise(resolve => color.toBlob(resolve))
    let releaseRoot, attempts = 0
    const renderer = new sdk.webgl.TerraWebGlRenderer(surface, {
      planImagery: fixtureImagery(0),
      gl: surface.getContext(contextType, {alpha: false, depth: true, stencil: true}),
      urlForTile: tile => `https://controlled.invalid/${tile.level}/${tile.column}/${tile.row}`,
      fetchTextures: (url, options) => {
        if (url.endsWith('/0/1/0') && attempts++ === 0) {
          return new Promise((resolve, reject) => {
            const abort = () => reject(new DOMException('cancelled', 'AbortError'))
            options.signal.addEventListener('abort', abort, {once: true})
            releaseRoot = () => {
              options.signal.removeEventListener('abort', abort)
              resolve({ok: false, status: 404})
            }
          })
        }
        return Promise.resolve({ok: true, blob: () => Promise.resolve(
          new URL(url).pathname.startsWith('/0/') ? coarse : blob)})
      },
      textureDescriptor: {kind: 'global-geodetic', matrix_level_offset: 1,
        maximum_level: 1, level_zero_columns: 2, level_zero_rows: 1, tile_size: 256},
      terrainBoundImagery: true, maximumTextureRequests: 4,
      maximumTextureEntries: 32, textureCacheBytes: 32 * 349524, maximumTextureRetries: 0,
      maximumResourceBytes: 32*1024*1024 + 32*349524,
      textureTransitionMs: 0
    })
    try {
      const target = {resourceId:1, textureResourceId:4294967296 + (1), flags: 0, key: {level: 0, i: 1, j: 2, k: 3}, fragment: 0,
        texture: {level: 1, matrix: 2, row: 0, column: 0}, origin: [0,0,0],
        firstVertex: 0, vertexCount: 4, firstIndex: 0, indexCount: 4}
      renderer.setMeshFrame({sequence: 1, coverageComplete: true,
        projectionView: new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
        cameraPosition: [10,20,30]}, [target], new Map([[1, {resourceId: 1,
        positions: new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]),
        textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])}]]), new Uint16Array([1,0,3,2]),
        {modelRevision: 1, pendingPriorityUpdateCount: 0})
      await waitFor('independent regional GPU refinement', () => {
        renderer.render()
        return releaseRoot && renderer.textures.availableKeys.has('1/2/0/0')
      }, 10000)
      const pixel = new Uint8Array(4)
      const sample = async () => {
        await renderForReadback(renderer)
        const gl = renderer.gl
        gl.readPixels(128,128,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel)
        return pixel[0] > pixel[1] * 3 && pixel[0] > pixel[2] * 3 && renderer.stats().quality.covered
      }
      check('root_pending_region_' + contextType, await sample() && !renderer.textures.coverageReady(),
        `Ready region remains textured while an independent root waits: ${Array.from(pixel)}`)
      releaseRoot()
      await waitFor('controlled terminal root failure', () => renderer.textures.failed.has('0/1/0/1'), 5000)
      check('root_failed_region_' + contextType, await sample() && renderer.stats().textures.state === 'degraded',
        'Terminal root failure does not withdraw the visible ready region')
      renderer.retryTextures()
      await waitFor('controlled root retry', () => {renderer.render(); return renderer.textures.coverageReady()}, 10000)
      check('root_retry_region_' + contextType, await sample() && attempts === 2,
        'Retry restores the missing root without replacing the submitted ready region')
    } finally {
      const gl = renderer.gl
      renderer.destroy()
      await new Promise(resolve => setTimeout(resolve, 0))
      check('root_cleanup_' + contextType, renderer.textures.scheduler.active.size === 0 &&
        renderer.textures.cache.stats().reservedBytes === 0, 'Controlled requests and image reservations released')
      const lose = gl && gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
      surface.remove(); color.remove()
    }
  }

  async function verifyPanPixels() {
    const surface = document.createElement('canvas')
    surface.width = surface.height = 1024
    surface.createImage = canvas.createImage
    const renderer = new sdk.webgl.TerraWebGlRenderer(surface, {
      planImagery: fixtureImagery(2),
      urlForTile: tile => `https://tiles.example/${tile.level}/${tile.column}/${tile.row}.png`,
      textureDescriptor: {kind: 'global-geodetic', matrix_level_offset: 1,
        maximum_level: 8, level_zero_columns: 2, level_zero_rows: 1, tile_size: 256},
      terrainBoundImagery: false, maximumTextureEntries: 64,
      textureCacheBytes: 64 * 349524, maximumTextureRequests: 16,
      maximumResourceBytes: 32*1024*1024 + 64*349524,
      maximumTextureRetries: 0, prefetchTextureAncestors: false
    })
    try {
      const matrix = new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1])
      const frame = {sequence: 1, coverageComplete: true, projectionView: matrix, cameraPosition: [10,20,30]}
      const target = {resourceId:1, textureResourceId:4294967296 + (1), flags: 0, key: {level: 0, i: 1, j: 2, k: 3}, fragment: 0,
        texture: {level: 2, matrix: 3, row: 3, column: 4}, origin: [0,0,0],
        firstVertex: 0, vertexCount: 4, firstIndex: 0, indexCount: 4}
      const root = Object.assign({}, target, {resourceId:2, textureResourceId:4294967296 + (2), flags: 1, texture: {level: 0, matrix: 1, row: 0, column: 1}})
      renderer.setMeshFrame(frame, [target, root], new Map([[1, {resourceId: 1,
        positions: new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]),
        textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])}], [2, {resourceId: 2,
        positions: new Float32Array([-1,-1,0.5, 1,-1,0.5, -1,1,0.5, 1,1,0.5]),
        textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])}]]), new Uint16Array([1,0,3,2]),
        {modelRevision: 1, pendingPriorityUpdateCount: 0})
      await waitFor('pixel pan fixture', () => {renderer.render(); return renderer.stats().quality.ready}, 10000)
      const draws = renderer.renderDraws.slice(), geometry = renderer.geometry.get(draws[0].geometryKey)
      await verifyTextureBlend(renderer, surface, draws)
      const old = geometry.partitionDraws.slice(), cell = renderer.partitionCell(old[0])
      const pixel = new Uint8Array(4), retained = new Uint8Array(4)
      const x = Math.floor((cell.bounds.minimumU + cell.bounds.maximumU) * surface.width / 2)
      const y = Math.floor((cell.bounds.minimumV + cell.bounds.maximumV) * surface.height / 2)
      renderer.gl.readPixels(x,y,1,1,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,retained)
      const missing = renderer.partitionCell(old[1]).key, part = geometry.partitions.get(missing)
      geometry.partitions.delete(missing)
      geometry.partitionBytes -= part.byteSize; renderer.partitionBytes -= part.byteSize
      part.allocation.release()
      for (const buffer of [part.positionBuffer, part.uvBuffer, part.indexBuffer]) renderer.gl.deleteBuffer(buffer)
      geometry.partitionDraws = [old[0]]
      renderer.options.scheduledImagery = true
      renderer.setImageryPlan(1, {draws, levels: new Set(), quality: {
        planningComplete: true, cameraCurrent: true, targetPixelError: 1.25}},
        [{resourceId: 1, visible: true, pixelsPerUv: 1024, centerDistance: 0}])
      // Draw before the delayed partition's next upload. Query the same UV
      // cells whose real pixels are checked below. The global coarse mesh has
      // height0.5; source-image fallback must keep the fine mesh's height0.
      renderer.renderSurface()
      const query = {mode: 'planar', runtime: {renderedSurface: renderer.renderedSurface, renderedSurfaceRevision: 1}}
      const sampleCell = draw => {
        const bounds = renderer.partitionCell(draw).bounds
        return sdk.viewer.TerraViewer.prototype.sampleRenderedSurface.call(query,
          [bounds.minimumU + bounds.maximumU - 1, bounds.minimumV + bounds.maximumV - 1])
      }
      const detailSample = sampleCell(old[0]), fallbackSample = sampleCell(old[1])
      check('pan_submitted_surface_cells', detailSample.heightMeters === 0 && fallbackSample.heightMeters === 0,
        JSON.stringify({detailSample, fallbackSample}))
      await renderForReadback(renderer)
      renderer.gl.readPixels(x,y,1,1,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,pixel)
      check('pan_retained_pixel', Array.from(pixel).every((v,i) => v === retained[i]),
        'Stencil fallback preserves the actual retained fine pixel')
      let minimum = 1, coveredFrames = 0
      const pixels = new Uint8Array(surface.width * surface.height * 4)
      for (let i = 0; i < 8; ++i) {
        const moved = matrix.slice(); moved[3] = i % 2 ? -0.04 : 0.04
        renderer.setCameraFrame({projectionView: moved, cameraPosition: [11,20,30]})
        renderer.setImageryPlan(1, {draws, levels: new Set(), quality: {
          planningComplete: false, cameraCurrent: false, coarsening: true, targetPixelError: 1.25}}, [])
        await renderForReadback(renderer)
        renderer.gl.readPixels(0,0,surface.width,surface.height,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,pixels)
        let covered = 0
        for (let j=0;j<pixels.length;j+=4) if (Math.abs(pixels[j]-6)>3 ||
          Math.abs(pixels[j+1]-11)>3 || Math.abs(pixels[j+2]-18)>3) ++covered
        minimum = Math.min(minimum, covered / (surface.width * surface.height))
        if (renderer.stats().quality.geometryCoverageSubmitted > 0) ++coveredFrames
      }
      check('pan_pending_uv_pixels', minimum > 0.95 && coveredFrames === 8,
        `Eight stale-plan pan frames retain ${(minimum*100).toFixed(1)}% pixel coverage while a UV cell is delayed`)
      renderer.setImageryPlan(1, {draws, levels: new Set(), quality: {
        planningComplete: true, cameraCurrent: true, targetPixelError: 1.25}},
        [{resourceId: 1, visible: true, pixelsPerUv: 1024, centerDistance: 0}])
      await renderForReadback(renderer)
      check('pan_waits_for_terrain_selection', !renderer.stats().quality.terrainSelectionCurrent &&
        renderer.stats().quality.geometryCoverageSubmitted > 0,
        'A current imagery plan cannot retire terrain coverage for a stale model selection')
      const selected = renderer.current
      renderer.setMeshFrame(Object.assign({}, selected.frame, {sequence: 2}), selected.draws,
        selected.meshResources, selected.indices, selected.updateState, selected.imageryPlan,
        Array.from(selected.workerMeasurements.values()))
      await waitFor('pixel pan partition handover', () => {
        renderer.render(); return renderer.stats().quality.geometryCoverageSubmitted === 0
      }, 10000)
      check('pan_uv_handover', renderer.stats().quality.renderedDrawCount === draws.length,
        'Coarse coverage retires after compatible UV cells reach the GPU')
      check('pan_query_ownership', !renderer.renderedSurface.resources.has(2) &&
        renderer.lastSubmittedSurface.meshResources.has(2),
        'Submitted queries release hidden coarse meshes while the complete representation retains ownership')
      // A terrain handoff must not regenerate this unchanged mesh merely to
      // recover cells outside its old camera crop. Exercise both an existing
      // parent index superset and the original source strip in the real shader.
      check('handoff_source_uv_capability', renderer.sourceUvPartitions,
        'WebGL2 centroid/highp supports bounded source-UV cell clipping')
      await renderForReadback(renderer)
      const expectedPixels = new Uint8Array(surface.width * surface.height * 4)
      renderer.gl.readPixels(0,0,surface.width,surface.height,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,expectedPixels)
      const resident = geometry.partitionDraws.slice(), kept = resident[0], removed = resident[1]
      // Remove every containing cached index superset for this cell, so the
      // fixture necessarily exercises the original-strip fallback as well.
      for (let tile = removed.texture; tile.level >= target.texture.level; tile = {
        level: tile.level - 1, matrix: tile.matrix - 1, row: Math.floor(tile.row / 2), column: Math.floor(tile.column / 2)})
        renderer.releasePartition(geometry, [tile.level,tile.matrix,tile.row,tile.column].join('/'))
      geometry.partitionDraws = [kept]
      const tile = kept.texture, child = {level: tile.level + 1, matrix: tile.matrix + 1,
        row: tile.row * 2, column: tile.column * 2}
      renderer.presentation.cells.set([child.level,child.matrix,child.row,child.column].join('/'),
        {cell: child, a: root.texture, b: tile, alpha: 1, goal: 1, at: 0})
      renderer.options.createMeshPartitionPlanTask = () => { throw Error('Unchanged mesh repriced UV during handoff') }
      const packet = {draws: renderer.current.draws, nativePlan: {id: 100}}
      const plan = renderer.prepareMeshOutputs({...packet, draws: packet.draws.concat({...target, resourceId: 3})})
      let outputs
      try {
        outputs = await plan.admit(packet, 0)
        if (!outputs || !outputs.valid()) throw Error('Resident handoff was not admitted')
        const cells = plan.draws([renderer.current.draws[0]])
        check('handoff_resident_uv_sources', cells.some(d => d.imageryIndexCell === renderer.partitionCell(kept).key) &&
          cells.some(d => d.imageryDirectClip && !d.imageryIndexCell),
          JSON.stringify({borrowed: cells.filter(d => d.imageryIndexCell).length,
            original: cells.filter(d => d.imageryDirectClip && !d.imageryIndexCell).length,
            cells: cells.length, kept: renderer.partitionCell(kept).key}))
        await renderForReadback(renderer)
        const actualPixels = new Uint8Array(expectedPixels.length)
        renderer.gl.readPixels(0,0,surface.width,surface.height,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,actualPixels)
        check('handoff_resident_uv_pixels', actualPixels.every((v,i) => v === expectedPixels[i]),
          'Cropped old metadata and an absent child buffer preserve every terrain/image pixel')
        const inherited = {mode: 'planar', runtime: {renderedSurface: renderer.renderedSurface, renderedSurfaceRevision: 2}}
        const bounds = renderer.partitionCell(removed).bounds
        const sample = sdk.viewer.TerraViewer.prototype.sampleRenderedSurface.call(inherited,
          [bounds.minimumU + bounds.maximumU - 1, bounds.minimumV + bounds.maximumV - 1])
        check('handoff_resident_uv_height', sample.heightMeters === 0,
          'Newly covered cells query the original detailed terrain, not elevated coarse roots')
      } finally {
        if (outputs) {outputs.release(); outputs.credit.release()}
        else plan.release()
      }
    } finally {
      const gl = renderer.gl
      renderer.destroy()
      const lose = gl && gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
      surface.remove()
    }
  }

  async function capture(name, stable = false) {
    let snapshot
    await renderForReadback(runtime.renderer, () => {
      const state = runtime.state(), quality = state.renderer.quality
      if (stable && !(quality.resourceStable && !quality.transitioningCells && state.frame.decisionsComplete &&
          !runtime.refreshing && !runtime.meshFrames.candidate && !runtime.refreshPending &&
          !state.terrain.active && !state.terrain.queued && runtime.terrainRefreshTimer === null &&
          runtime.cameraRefreshTimer === null)) return false
      // Pixels and state belong to this accepted submission, before yielding to
      // another publication/receipt between readiness and pixel observation.
      snapshot = {state, framebuffer: framebufferStats(runtime.renderer.gl)}
      return true
    })
    const {state, framebuffer} = snapshot
    const memory = state.resourceMemory, resources = state.renderer
    const delivery=runtime.abi.isWorker ? runtime.abi.measurementDelivery :
      runtime.localExecution && runtime.localExecution.measurementDelivery
    const receiver=runtime.abi.isWorker ? runtime.abi.measurementReceiver : delivery && delivery.receiver
    const mirrorBytes=receiver ? receiver.stats().ownedBytes : 0
    const wireBytes=delivery ? typeof delivery.pendingBytes==='function' ? delivery.pendingBytes() :
      delivery.active && delivery.active.credit && delivery.active.credit.bytes || 0 : 0
    const kernel=runtime.renderer.measurementKernel
    const kernelBytes=kernel ? [kernel.a,kernel.b,kernel.depths,kernel.norms].reduce((n,a)=>n+(a?a.byteLength:0),0) : 0
    const accounted = state.terrain.bytes + state.terrain.reservedBytes +
      // The rendering input workspace reports both active loans and free
      // serial credit; neither is part of the encoded record cache.
      state.terrain.input.reservedBytes + state.terrain.decoded.creditedBytes +
      state.terrain.heights.creditedBytes +
      state.performance.imageryInput.creditedBytes +
      state.performance.imageryReferences.creditedBytes +
      state.performance.imageryOutput.creditedBytes +
      // Active loans plus unused protected credit are disjoint, including
      // a retiring old-source query while the replacement owns a new reserve.
      state.terrainQueries.ownedBytes + state.terrainQueries.progressAvailableBytes +
      state.terrainQueries.regions.bytes + state.terrainQueries.regions.reservedBytes +
      resources.geometry.bytes + resources.geometry.reservedBytes +
      runtime.renderer.indices.bytes +
      resources.textures.bytes + resources.textures.reservedBytes +
      (resources.textures.resourceShare ? resources.textures.resourceShare.unusedBytes : 0) +
      resources.textures.demandReservation.bytes +
      resources.performance.partitionBytes + resources.performance.partitionReservedBytes +
      resources.performance.partitionCpuBytes +
      // Independently reconcile the optional command payload with its lease.
      (runtime.renderer.surfaceCommands.values ? runtime.renderer.surfaceCommands.values.byteLength : 0) +
      runtime.renderer.worldDisplay.snapshot().bytes +
      // Reconcile mirror payloads from their independent physical owners,
      // in-flight grants and scratch arrays, rather than summing ledger labels.
      mirrorBytes + wireBytes + kernelBytes +
      (resources.transition.displayTarget ? resources.transition.displayTarget.bytes : 0)
    // Boundary planning is a separately admitted native scratch transaction;
    // capture can overlap it even after the current display submission finishes.
    const meshBytes = ['mesh-native', 'mesh-host', 'mesh-uv-host', 'mesh-transfer', 'mesh-preparation', 'terrain-boundary-work',
      'terrain-index-host', 'terrain-index-worker'].reduce((n, owner) => {
      const value = memory.owners[owner]
      return n + (value ? value.reserved + value.resident + value.retired : 0)
    }, 0)
    check(`${name}_memory_ownership`, memory.bytes === accounted + meshBytes &&
      state.performance.imageryInput.residentBytes <= state.performance.imageryInput.creditedBytes &&
      state.performance.imageryReferences.residentBytes <= state.performance.imageryReferences.creditedBytes &&
      state.performance.imageryOutput.residentBytes <= state.performance.imageryOutput.creditedBytes &&
      memory.bytes === memory.reservedBytes + memory.residentBytes + memory.retiredBytes &&
      memory.bytes <= memory.maximumBytes,
      `${memory.bytes}/${memory.maximumBytes} managed payload bytes; owners sum to ${accounted + meshBytes}`)
    const history = state.performance.workerMeasurementHistory
    check(`${name}_measurement_history`, history && history.views <= 3 &&
      history.numericPayloadBytes <= history.maximumNumericPayloadBytes,
      history ? `${history.views} views, ${history.numericPayloadBytes} numeric payload bytes` : 'Missing Worker history statistics')
    const upload = resources.transition.gpuSubmission, work = upload.budget
    check(`${name}_upload_admission`, work && work.maximumBytes === 2 * 1024 * 1024 && work.maximumObjects === 8 &&
      [work.bytes, work.objects, work.largestBytes, work.largestObjects, work.deferred]
        .every(value => Number.isSafeInteger(value) && value >= 0) &&
      work.bytes <= Math.max(work.maximumBytes, work.largestBytes) &&
      work.objects <= Math.max(work.maximumObjects, work.largestObjects) &&
      work.largestBytes <= work.bytes && work.largestObjects <= work.objects &&
      (!upload.pending || ['draw','resource'].includes(upload.kind)) &&
      upload.bytes === (upload.uploading ? work.bytes : 0),
      work ? `${work.bytes} bytes, ${work.objects} objects in the last upload batch` : 'Missing upload admission statistics')
    const expectedDraws = state.renderer && state.renderer.quality
      ? state.renderer.quality.renderedDrawCount : 0
    check(`${name}_draws`, state.frame && state.frame.drawCount >= 1 &&
      expectedDraws >= 1 &&
      state.renderer.draws.submitted === expectedDraws,
      state.frame ? `${state.renderer.draws.submitted}/${expectedDraws} ` +
        `imagery draws from ${state.frame.drawCount} terrain draws` :
        'Frame is missing')
    const dataUrl = canvas.toDataURL('image/png')
    const minimumNonBackgroundPixels = Math.max(100,
      state.frame.drawCount * 100)
    check(`${name}_nonblank`,
      framebuffer.nonBackgroundPixels > minimumNonBackgroundPixels,
      `${framebuffer.nonBackgroundPixels}/${minimumNonBackgroundPixels} ` +
        'non-background pixels')
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

  function publicReport(wasm, contextExtension) {
    const gl = runtime.renderer.gl
    const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      schema: 'terra.web-sdk.evidence.v1',
      passed: checks.every((entry) => entry.passed),
      durationMs: Math.round(performance.now() - startedAt),
      browser: {
        userAgent: navigator.userAgent,
        webglVersion: runtime.renderer.capabilities().version,
        renderer: gl.getParameter(rendererInfo ? rendererInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        rendererUnmasked: Boolean(rendererInfo),
        contextRecoveryExtension: contextExtension
      },
      sdk: {
        abiVersion: wasm.module.exports.terra_abi_version(),
        wasmBytes: wasm.byteLength,
        datasetId: runtime.state().datasetId
      },
      retry: {
        simulated: true,
        scheduled: simulatedRetryScheduled,
        recovered: simulatedRetryRecovered,
        rootZeroAttempts: requestAttempts.get(
          '/terra/v1/datasets/globe/root/0/134217728/134217728') || 0
      },
      checks,
      navigationScenarios,
      captures: captures.map((item) => ({
        name: item.name,
        state: item.state,
        framebuffer: item.framebuffer
      }))
    }
  }

  function finish(report) {
    report.durationMs = Math.round(performance.now() - startedAt)
    report.memoryReplay = memoryReplay
    report.navigationTerrain = navigationTerrain && navigationTerrain.stats()
    report.navigationFailures = navigationFailures
    report.networkNavigation = networkNavigation
    report.localNavigation = localNavigation
    report.localNavigationNoFaults = localNavigationNoFaults
    report.rapidZoom = rapidZoomEvidence
    if (!report.passed && runtime && runtime.renderer) {
      const r = runtime.renderer
      const world = r.worldDisplay, plan = r.meshOutputPlan
      const tileId = tile => tile && [tile.level, tile.matrix, tile.row, tile.column].join('/')
      const sourceId = draw => [draw.geometryKey,tileId(draw.sourceTexture||draw.texture),draw.textureResourceId||0,
        draw.resourceId||0,draw.firstIndex,draw.indexCount,draw.vertexCount,draw.flags||0,...draw.origin].join(':')
      const cutState = cut => {
        const entry = r.geometry.entries.get(cut.id), geometry = entry && entry.value
        const displayKeys = new Set((r.displaySurface ? r.displaySurface.renderDraws : [])
          .filter(draw => draw.geometryKey === cut.id).map(sourceId))
        const currentKeys = new Set(r.renderDraws.filter(draw => draw.geometryKey === cut.id).map(sourceId))
        return {id: cut.id, camera: cut.camera, rowCount: cut.rows.length,
          sourceCount: cut.sources.size, displayedSources: displayKeys.size, currentSources: currentKeys.size,
          matchesDisplay: cut.sources.size === displayKeys.size && Array.from(displayKeys).every(id => cut.sources.has(id)),
          matchesCurrent: cut.sources.size === currentKeys.size && Array.from(currentKeys).every(id => cut.sources.has(id)),
          missingParts: cut.rows.filter(row => row.imageryClipCell && !row.imageryDirectClip &&
            (!geometry || !geometry.partitions.has(row.imageryIndexCell || tileId(row.texture))))
            .map(row => tileId(row.texture)).slice(0, 8),
          coarsening: cut.coarsening.slice(0, 8).map(row => ({cell: tileId(row.texture),
            target: tileId(row.imageryTarget), handover: Boolean(row.imageryHandover),
            error: r.measureTextureDraw(row,(row.imageryTarget||row.texture).level),
            bridge: r.presentationBridges.some(tile => tileId(tile) === tileId(row.imageryTarget||row.texture))})),
          rows: cut.rows.slice(0, 4).map(row => ({texture: tileId(row.texture),
            target: tileId(row.imageryTarget), handover: Boolean(row.imageryHandover),
            ready: Boolean(row.imageryPublicationState && row.imageryPublicationState.ready)}))}
      }
      report.pendingWork = { refreshing: runtime.refreshing, refreshPending: runtime.refreshPending,
        // Inspect numeric identities before teardown. Do not resolve cached
        // resources or schedule work while recording the failed boundary.
        displayWorld: {
          currentIsDisplay: Boolean(r.displaySurface && r.displaySurface.current === r.current),
          sameTerrainDraws: Boolean(r.displaySurface && r.displaySurface.current.draws === r.current.draws),
          sameMeshResources: Boolean(r.displaySurface &&
            r.displaySurface.current.meshResources === r.current.meshResources),
          meshPlanId: plan ? plan.planId : null,
          meshPlanAccepted: Boolean(plan && plan.accepted), meshPlanValid: Boolean(plan && plan.valid()),
          forecastPlanId: r.forecastOutputPlan ? r.forecastOutputPlan.planId : null,
          resourcesRequested: r.resourcesRequested, renderRequested: r.renderRequested,
          bridges: r.presentationBridges.map(tileId),
          records: world.records.map(record => ({current: record.aliases.has(r.renderDraws),
            displayed: Boolean(r.displaySurface && record.aliases.has(r.displaySurface.renderDraws)),
            handoffPlanId: record.handoffPlanId || null, goalRevision: record.goalRevision,
            stampCurrent: record.stamp === world.signature(record),
            demandCurrent: record.demandStamp === world.demandSignature(record),
            cuts: record.cuts.size, coarseCuts: record.coarseCuts ? record.coarseCuts.size : 0,
            cutStates: Array.from(record.cuts.values()).sort((a,b) => {
              const priority = cut => {
                const entry = world.entries.get(cut.id)
                return entry && entry.current && entry.current.camera !== r.cameraVersion ? 0 : 1
              }
              return priority(a)-priority(b)
            }).slice(0, 24).map(cutState)})),
          cells: Array.from(r.presentation.cells.values()).slice(0, 16).map(state => ({
            cell: tileId(state.cell), a: tileId(state.a), b: tileId(state.b)})),
          cuts: Array.from(world.entries, ([id, entry]) => ({id,
            camera: entry.current && entry.current.camera,
            rows: entry.current && entry.current.rows.slice(0, 4).map(row => ({
              texture: tileId(row.texture), target: tileId(row.imageryTarget),
              handover: Boolean(row.imageryHandover),
              ready: Boolean(row.imageryPublicationState && row.imageryPublicationState.ready)}))})).slice(0, 16)
        },
        imageryTrace,
        imageryRefreshing: runtime.imageryRefreshing, imageryRefreshPending: runtime.imageryRefreshPending,
        candidate: runtime.meshFrames.candidate && runtime.meshFrames.candidate.frame.sequence,
        displayed: r.displaySurface && r.displaySurface.current.frame.sequence,
        workerMessages: runtime.abi.pending && runtime.abi.pending.size,
        partitionActive: r.partitionActive && { key: r.partitionActive.geometry.key, cells: r.partitionActive.cells },
        handover: Array.from(r.capacityHandover || []),
        presentation: Array.from(r.presentedTextures.values()),
        targets: r.renderDraws.map(draw => ({texture:draw.texture, resourceId: draw.resourceId,
          measurement: r.current.workerMeasurements && r.current.workerMeasurements.get(draw.resourceId) && {
            visible: r.current.workerMeasurements.get(draw.resourceId).visible,
            pixelsPerUv: r.current.workerMeasurements.get(draw.resourceId).pixelsPerUv},
          error:r.measureTextureDraw(draw,draw.texture.level)})),
        partitionQueue: r.partitionQueue.map(job => ({ key: job.geometry.key, cells: job.cells })),
        partitionUploads: r.partitionUploads.map(job => ({ key: job.geometry.key, cells: job.cells.length })),
        geometry: r.geometry.values().map(g => ({ key: g.key,
          pending: Array.from(g.partitionPending || []), blocked: Array.from(g.partitionBlocked || []),
          partitions: g.partitions && g.partitions.size })) }
    }
    window.__terraWebEvidence = report
    resultElement.textContent = JSON.stringify(report)
    summaryElement.textContent = JSON.stringify(report, null, 2)
    document.documentElement.dataset.terraStatus = report.passed ? 'passed' : 'failed'
    statusElement.textContent = report.passed
      ? 'Automated evidence passed'
      : 'Automated evidence failed'
  }

  async function run() {
    check('sdk_bundle', Boolean(sdk && sdk.runtime && sdk.viewer &&
      sdk.webgl && sdk.wasm),
      'Terra browser bundle loaded')
    check('webassembly_available', typeof WebAssembly === 'object',
      'WebAssembly global is available')
    installBrowserCanvasAdapter()
    const presentationContract = window.verifyCanvasPresentation()
    check('canvas_presentation_contract', presentationContract.restored, JSON.stringify(presentationContract))
    const wasm = await instantiateWasm()
    if(['#network','#network-local','#network-local-normal'].includes(location.hash)) {
      const [index,data]=await Promise.all([fetch('fixtures/navigation-terrain.json'),fetch('fixtures/navigation-terrain.bin')])
      try { networkNavigation=await window.TerraNetworkNavigation.verify({sdk,wasm,manifest,
        execution:location.hash==='#network' ? 'worker' : 'local',
        faults:location.hash!=='#network-local-normal',
        catalogue:await index.json(),payload:await data.arrayBuffer(),check}) }
      catch(error) {networkNavigation=error.networkReport;throw error}
      finish({schema:'terra.web-sdk.evidence.v1',passed:true,checks,captures:[]});return
    }
    const canvasReuse = await window.verifyCanvasReuse(sdk)
    check('canvas_reuse_vertex_inputs', canvasReuse.length === 2, JSON.stringify(canvasReuse))
    const sourceUv = await window.verifySourceUvPartitions(sdk)
    check('source_uv_partitions', true, JSON.stringify(sourceUv))
    const gpuProgress = await window.verifyGpuProgress(sdk)
    check('gpu_progress_during_fade', gpuProgress.maximumFences <= 2, JSON.stringify(gpuProgress))
    const backgroundProgress = await window.verifyBackgroundProgress(sdk)
    check('background_resource_progress', backgroundProgress.preparedWithoutDisplay, JSON.stringify(backgroundProgress))
    check('background_display_receipts', backgroundProgress.displayReceiptWithoutBackground, JSON.stringify(backgroundProgress))
    const visibility = await window.verifyTerrainVisibility(sdk)
    check('terrain_visibility_conservative', visibility.invalidated && visibility.maximumQueries <= 8, JSON.stringify(visibility))
    const footprint = await window.verifyVisibilityFootprint(sdk)
    check('terrain_visibility_footprint', footprint.proved > 0 && footprint.visible > 0, JSON.stringify(footprint))
    const displayTarget = await window.verifyDisplayTarget(sdk)
    check('retained_display_samples', displayTarget.independentQueries && displayTarget.receiptRetirement, JSON.stringify(displayTarget))
    const encoded = await window.verifyEncodedResidency(sdk)
    check('encoded_imagery_scheduled_recovery', encoded.recovered, JSON.stringify(encoded))
    const publication = await window.verifySurfacePublication(sdk)
    check('surface_publication_pixels', publication.length === 2, JSON.stringify(publication))
    viewer = await sdk.viewer.TerraViewer.create({
      mode: 'globe',
      canvas,
      dataset: manifest,
      serviceOrigin: 'https://terrain.example',
      terraModule: wasm.module,
      wasmUrl: 'generated/terra_sdk.wasm',
      workerUrl: 'generated/terra_worker.js',
      request: terrainRequest,
      viewport: { width: 640, height: 360, devicePixelRatio: 1 },
      maximumTerrainRequests: 4,
      maximumTerrainRetries: 1,
      terrainRetryDelayMs: 10,
      maximumTextureRetries: 0,
      // The geographic SVG fixture uses HTMLImageElement; the separate PNG
      // WebGL fixture above exercises browser encoded residency and recovery.
      fetchTextures: false,
      initialTarget: {
        longitudeDegrees: 116.4074,
        latitudeDegrees: 39.9042
      }
    })
    runtime = viewer.runtime
    const facingPixels=await window.verifySurfaceFacing(sdk,wasm.module,runtime.manifest)
    check('surface_facing_pixels',facingPixels.comparisons===5,JSON.stringify(facingPixels))
    const traceImagery = runtime.abi.planImagery
    runtime.abi.planImagery = async function (...args) {
      const [sequence, options, , planId] = args
      const result = await traceImagery.apply(this, args)
      imageryProgress = JSON.stringify([result.viewRevision, result.modelRevision, result.progress ||
        result.imageryPlan && [result.imageryPlan.quality.selectedLevelMinimum,
          result.imageryPlan.quality.selectedLevelMaximum, result.imageryPlan.quality.planningComplete]])
      if (!result.pending || !imageryTrace.length || performance.now() - imageryTrace[imageryTrace.length - 1].time > 500) {
        imageryTrace.push({sequence, planId, view: result.viewRevision, currentView: this.viewRevision,
          time: performance.now(), progress: result.progress,
          mesh: result.modelRevision, currentMesh: runtime.renderer.current &&
            runtime.renderer.current.updateState && runtime.renderer.current.updateState.modelRevision,
          admission: options.admissionRevision, maximumTextures: options.maximumTextures,
          complete: result.imageryPlan && result.imageryPlan.quality.planningComplete,
          levels: result.imageryPlan && [result.imageryPlan.quality.selectedLevelMinimum,
            result.imageryPlan.quality.selectedLevelMaximum],
          measurements: result.measurements && result.measurements.length})
        if (imageryTrace.length > 32) imageryTrace.shift()
      }
      return result
    }
    check('worker_owns_terrain', runtime.abi.isWorker === true,
      'Terrain selection and imagery planning execute in the Worker')

    await waitForRenderedFrame(undefined, 4)
    check('asynchronous_gpu_submission', runtime.renderer.stats().transition.gpuSubmission.asynchronous &&
      runtime.renderer.stats().performance.drawSubmissionWait.count > 0 &&
      viewer.diagnostics.snapshot().schema === 'terra.performance.v3',
      'The real WebGL2 context bounds draw/upload submissions and exposes classified completion observation in diagnostics v3')
    const terrainSample = await viewer.sampleTerrain([116.4074, 39.9042])
    check('resident_terrain_query', terrainSample.status === 'available' &&
      terrainSample.source === 'cbdam-cache' && Number.isFinite(terrainSample.heightMeters) &&
      terrainSample.sampleSpacingMeters > 0 && terrainSample.dataLevel <= terrainSample.level,
      JSON.stringify(terrainSample))
    const heightView = JSON.stringify(viewer.camera.getView())
    const independentHeight = await viewer.queryTerrain([-122.42, 37.77], {
      sampleSpacingMeters: 1e8, timeoutMs: 15000})
    const queryOwnership = runtime.heightQueries.stats()
    const queryPool = runtime.resourceLedger.stats().owners['height-query']
    check('independent_height_query', independentHeight.status === 'ready' &&
      independentHeight.source === 'cbdam-query' && independentHeight.level === 0 &&
      independentHeight.verticalAccuracyMeters === null && Number.isFinite(independentHeight.heightMeters) &&
      JSON.stringify(viewer.camera.getView()) === heightView &&
      queryOwnership.active === 0 && queryOwnership.queued === 0 && queryOwnership.ownedBytes === 0 &&
      queryOwnership.requests === 0 && queryOwnership.progressRequiredBytes > 0 &&
      queryOwnership.progressAvailableBytes === queryOwnership.progressRequiredBytes &&
      queryOwnership.progressBytes === queryOwnership.progressRequiredBytes && queryPool &&
      queryPool.reserved === queryOwnership.progressRequiredBytes && !queryPool.resident && !queryPool.retired,
      JSON.stringify({result: independentHeight, ownership: queryOwnership, pool: queryPool}))
    const nearbyHeight = await viewer.queryTerrain([-122.421, 37.771], {
      sampleSpacingMeters: 1e8, timeoutMs: 15000})
    check('independent_height_region_reuse', nearbyHeight.cacheHit && nearbyHeight.status === 'ready' &&
      Number.isFinite(nearbyHeight.heightMeters) && JSON.stringify(viewer.camera.getView()) === heightView &&
      runtime.state().terrainQueries.regions.hits > 0, JSON.stringify(nearbyHeight))
    simulatedRetryScheduled = runtime.state().diagnostics.some((entry) =>
      entry.kind === 'terrain_retry')
    check('terrain_retry_scheduled', simulatedRetryScheduled,
      'Transient root record failure entered retry scheduling')
    check('terrain_retry_recovered', simulatedRetryRecovered,
      'Transient root record failure recovered')
    await verifyNearCameraPixels(wasm.module)
    await verifyNearCameraPixels(wasm.module, 'webgl')
    const depthPixels = await window.verifyDepthEncoding(sdk)
    check('near_ground_depth_encoding', depthPixels.length === 2, JSON.stringify(depthPixels))
    await verifyGpuFrameAdmission()
    await verifyLocalPreparation()
    await verifyIndependentImageryRoots('webgl2')
    await verifyIndependentImageryRoots('webgl')
    await verifyPanPixels()
    const initial = await capture('initial_world')
    check('initial_target',
      approximatelyEqual(initial.state.camera.longitudeDegrees, 116.4074, 1e-12) &&
      approximatelyEqual(initial.state.camera.latitudeDegrees, 39.9042, 1e-12) &&
      approximatelyEqual(initial.state.camera.tiltRadians, 0, 1e-12) &&
      approximatelyEqual(initial.state.camera.yawRadians, 0, 1e-12),
    'Initial world view targets Beijing with top-down north-up orientation')

    const focusView = viewer.camera.getView()
    focusView.rangeMeters = manifest.transform.radius * 2.6
    viewer.camera.setView(focusView)
    await waitForRenderedFrame(initial.state.frame.sequence, 1)
    const focus = await capture('beijing_top')
    check('focus_sequence', focus.state.frame.sequence > initial.state.frame.sequence,
      'SDK frame sequence advanced')
    check('focus_state', approximatelyEqual(focus.state.camera.distance,
      manifest.transform.radius * 2.6, 1e-9), String(focus.state.camera.distance))

    viewer.setPois([{
      id: 'beijing-evidence',
      coordinate: [116.4074, 39.9042, 1000],
      priority: 10
    }])
    const projectedPoi = viewer.project([116.4074, 39.9042, 1000])
    const pickedPoi = viewer.pickPoi(projectedPoi)
    check('viewer_poi_projection', projectedPoi.visible,
      `${projectedPoi.x},${projectedPoi.y}`)
    check('viewer_poi_pick', pickedPoi &&
      pickedPoi.featureId === 'beijing-evidence',
    pickedPoi ? pickedPoi.featureId : 'none')
    viewer.setRoute({
      id: 'beijing-route-evidence',
      coordinates: [[116.2, 39.8, 1000], [116.6, 40.0, 1000]],
      color: '#2f7de1',
      widthPixels: 3
    })
    await waitFor('route overlay submission', () => {
      runtime.renderer.requestRender()
      return runtime.renderer.stats().overlays.routeVertices >= 2
    }, 10000)
    check('viewer_route_overlay',
      runtime.renderer.stats().overlays.routeVertices >= 2,
      `${runtime.renderer.stats().overlays.routeVertices} vertices`)
    check('viewer_route_view',
      viewer.getRouteView().schema === 'terra.view-state.v2',
      'Route view uses the public ViewState schema')
    viewer.clearRoute()
    viewer.clearPois()

    const progressiveImagery = { allowProgressiveImagery: true }
    viewer.camera.zoomBy(0.92)
    await waitForRenderedFrame(focus.state.frame.sequence, 1,
      progressiveImagery)
    check('zoom_sequence', runtime.state().frame.sequence > focus.state.frame.sequence,
      'SDK frame sequence advanced')
    const zoom = await capture('beijing_zoom')
    check('zoom_state', zoom.state.camera.distance < focus.state.camera.distance,
      `${focus.state.camera.distance} -> ${zoom.state.camera.distance}`)

    viewer.camera.setTilt(45)
    await waitForRenderedFrame(zoom.state.frame.sequence, 1,
      progressiveImagery)
    check('tilt_sequence', runtime.state().frame.sequence > zoom.state.frame.sequence,
      'SDK frame sequence advanced')
    const tilt = await capture('beijing_tilt_45')
    check('tilt_state', approximatelyEqual(tilt.state.camera.tiltRadians,
      -Math.PI / 4, 1e-12), String(tilt.state.camera.tiltRadians))
    terrainFrozen = true

    viewer.camera.orbitBy({ headingDegrees: 30 })
    await waitForRenderedFrame(tilt.state.frame.sequence, 1,
      progressiveImagery)
    check('yaw_sequence', runtime.state().frame.sequence > tilt.state.frame.sequence,
      'SDK frame sequence advanced')
    const yaw = await capture('beijing_heading_30')
    check('yaw_state', approximatelyEqual(yaw.state.camera.yawRadians,
      Math.PI / 6, 1e-12), String(yaw.state.camera.yawRadians))

    viewer.camera.northUp()
    await waitForRenderedFrame(yaw.state.frame.sequence, 1,
      progressiveImagery)
    const north = await capture('beijing_north_45')
    check('north_state',
      approximatelyEqual(north.state.camera.yawRadians, 0, 1e-12) &&
      approximatelyEqual(north.state.camera.tiltRadians, -Math.PI / 4, 1e-12),
    'North-up preserves the oblique pitch')

    viewer.camera.topDown()
    await waitForRenderedFrame(north.state.frame.sequence, 1,
      progressiveImagery)
    const top = await capture('beijing_top_north')
    check('top_state',
      approximatelyEqual(top.state.camera.yawRadians, 0, 1e-12) &&
      approximatelyEqual(top.state.camera.tiltRadians, 0, 1e-12),
    'Top-down preserves north-up heading')

    // Preserve one fixed warmup and two measured laps. Identical endpoints
    // need not populate the same transient cache: CPU slices can publish
    // different intermediate meshes. Audit owned bytes and actual refunds;
    // report the non-shrinking Wasm allocation separately from live payload.
    const viewsPerLap = memoryReplay.viewsPerLap
    const nativeOwners = {nativeMeshBytes:'mesh-native', decodedRecordBytes:'terrain-record-native',
      heightBytes:'terrain-height-native', imageryInputBytes:'imagery-input-native',
      imageryReferenceBytes:'imagery-reference-native', imageryOutputBytes:'imagery-output-native'}
    // Every lap includes the same final-heading -> first-heading transition.
    const entryView = viewer.camera.getView()
    entryView.rangeMeters = manifest.transform.radius * 2.6
    entryView.headingDegrees = 7 * 37
    entryView.tiltDegrees = 45
    viewer.camera.setView(entryView)
    await waitForRenderedFrame(undefined, 1, {allowProgressiveImagery: true, requireStableAvailableTerrain: true})
    for (let cycle = 0; cycle < (memoryReplay.warmupLaps + 2) * viewsPerLap; ++cycle) {
      viewer.resize(cycle % 2 ? { width: 640, height: 360, devicePixelRatio: 1 }
        : { width: 1280, height: 720, devicePixelRatio: 1 })
      const view = viewer.camera.getView()
      view.rangeMeters = manifest.transform.radius * (cycle % 2 ? 2.6 : 0.3)
      view.headingDegrees = (cycle % viewsPerLap) * 37
      view.tiltDegrees = cycle % 2 ? 45 : 0
      const previous = runtime.state().frame.sequence
      viewer.camera.setView(view)
      const settled = await waitForRenderedFrame(previous, 1, { allowProgressiveImagery: true, requireStableAvailableTerrain: true })
      const p = settled.renderer.performance
      const warmup = cycle < viewsPerLap
      const name = warmup ? `warmup_${cycle}` : `replay_${cycle - viewsPerLap}`
      check(`${name}_resource_policy`, runtime.budget.maximumResourceBytes === 768*1024*1024 &&
        runtime.budget.geometryCacheBytes === 128*1024*1024 &&
        runtime.budget.partitionCacheBytes === 16*1024*1024 &&
        runtime.budget.textureCacheBytes === 256*1024*1024,
      'Public resize changes resolution without rewriting instance resource shares')
      check(`${name}_capacity`, settled.renderer.geometry.bytes <= p.geometryCapacityBytes &&
        settled.renderer.textures.bytes <= p.textureCapacityBytes && p.partitionBytes <= p.partitionCapacityBytes,
      'Geometry, image/texture, and partition resources remain within admission capacities')
      check(`${name}_coverage`, settled.renderer.textures.missingRatio === 0,
        'Repeated zoom and heading changes retain complete displayed coverage')
      memoryReplay.samples.push({lap: Math.floor(cycle / viewsPerLap), view: cycle % viewsPerLap,
        warmup, memoryBytes: settled.performance.wasmMemoryBytes,
        capacity: {bytes:settled.resourceMemory.bytes, maximumBytes:settled.resourceMemory.maximumBytes,
          highWaterBytes:settled.resourceMemory.highWaterBytes, reservedBytes:settled.resourceMemory.reservedBytes,
          residentBytes:settled.resourceMemory.residentBytes, retiredBytes:settled.resourceMemory.retiredBytes,
          native:Object.fromEntries(Object.entries(nativeOwners).map(([key,owner]) =>
            [key,settled.resourceMemory.owners[owner].resident]))},
        ownership: {nativeMeshBytes: settled.resources.meshBytes,
          decodedRecordBytes: settled.resources.decodedRecordBytes,
          heightBytes: settled.resources.heightBytes,
          topologyNodes: settled.resources.topologyNodeCount,
          imageryInputBytes: runtime.abi.imageryInputPayloadBytes(),
          imageryReferenceBytes: runtime.abi.imageryReferencePayloadBytes(),
          imageryOutputBytes: runtime.abi.imageryOutputPayloadBytes(),
          measurementHistoryBytes: settled.performance.workerMeasurementHistory.numericPayloadBytes,
          nativeModels: settled.performance.workerImageryPlanning.work.nativeMeasurements.models},
        work: {worldPreparing: settled.renderer.transition.worldDisplay.preparing,
          worldMaintenance: runtime.renderer.worldDisplay.records.filter(record=>record.maintenance).length,
          pendingWork: settled.performance.frameCoordinator.pendingWork,
          pendingRender: settled.performance.frameCoordinator.pendingRender,
          pendingAnimations: settled.performance.frameCoordinator.pendingAnimations,
          pendingInputs: settled.performance.frameCoordinator.pendingInputs,
          nativeRequests: runtime.abi.pending.size},
        meshIdentity: runtime.meshFrames.presented.meshIdentity})
    }
    check('replay_quiescent_sampling', memoryReplay.samples.every(sample=>
      sample.work.worldPreparing===false && sample.work.worldMaintenance===0 &&
      sample.work.pendingWork===0 && sample.work.pendingRender===false &&
      sample.work.pendingAnimations===0 && sample.work.pendingInputs===0 && sample.work.nativeRequests===0),
    'Available-cut memory samples have no world preparation, native calls or queued display/background work')
    const measured = memoryReplay.samples.filter(sample => !sample.warmup)
    const firstLap = measured.slice(0, viewsPerLap), secondLap = measured.slice(viewsPerLap)
    const firstMaximumBytes = Math.max(...firstLap.map(sample => sample.memoryBytes))
    const secondMaximumBytes = Math.max(...secondLap.map(sample => sample.memoryBytes))
    memoryReplay.heapCapacity = {firstMaximumBytes,secondMaximumBytes,
      growthBytes:secondMaximumBytes-firstMaximumBytes, plateau:secondMaximumBytes<=firstMaximumBytes}
    check('replay_workset_repeatable', firstLap.every((sample, index) =>
      sample.meshIdentity === secondLap[index].meshIdentity),
    'Both measured laps display the same immutable geometry at corresponding views')
    // Reclaim only after the unmodified 24-point trajectory. The physical
    // refund must leave exactly the required display payload, never an
    // arbitrary allowance for leaked borrowers or extra cached meshes.
    const residentFrame = runtime.meshFrames.presented
    const requiredNative = window.TerraNativeResidency(residentFrame.draws)
    const nativeBefore = runtime.abi.nativeBudget.actual
    let pixelsBefore, pixelsAfter
    await renderForReadback(runtime.renderer, () => {pixelsBefore = framebufferStats(runtime.renderer.gl);return true})
    const nativeReleased = await runtime.abi.send({type:'trim-native',needed:nativeBefore})
    const afterReclamation = await waitForRenderedFrame(undefined, 1,
      {allowProgressiveImagery:true,requireStableAvailableTerrain:true})
    await renderForReadback(runtime.renderer, () => {pixelsAfter = framebufferStats(runtime.renderer.gl);return true})
    memoryReplay.nativeReclamation = {required:requiredNative, beforeBytes:nativeBefore,
      releasedBytes:nativeReleased, afterBytes:runtime.abi.nativeBudget.actual,
      ledgerBytes:afterReclamation.resourceMemory.owners['mesh-native'].resident,
      beforeSequence:residentFrame.frame.sequence, afterSequence:runtime.meshFrames.presented.frame.sequence,
      beforeIdentity:residentFrame.meshIdentity, afterIdentity:runtime.meshFrames.presented.meshIdentity,
      pixelsBefore,pixelsAfter}
    const reclaimed = memoryReplay.nativeReclamation
    check('replay_native_cache_refund', nativeReleased > 0 && nativeBefore - nativeReleased === reclaimed.afterBytes &&
      reclaimed.afterBytes === requiredNative.positionBytes + requiredNative.uvBytes &&
      reclaimed.ledgerBytes === reclaimed.afterBytes,
    JSON.stringify({required:requiredNative,before:nativeBefore,released:nativeReleased,after:reclaimed.afterBytes}))
    check('replay_native_cache_preserves_display', reclaimed.beforeSequence === reclaimed.afterSequence &&
      reclaimed.beforeIdentity === reclaimed.afterIdentity &&
      pixelsBefore.nonBackgroundPixels > 10000 && pixelsBefore.sampledColorCount >= 3 &&
      JSON.stringify(pixelsBefore) === JSON.stringify(pixelsAfter),
    'Actual Native refund leaves exactly the presented payload and identical rendered pixels')
    check('replay_managed_residency', memoryReplay.samples.every((sample,index,samples) => {
      const c=sample.capacity, previous=index ? samples[index-1].capacity : c
      return c.bytes===c.reservedBytes+c.residentBytes+c.retiredBytes && c.bytes<=c.highWaterBytes &&
        c.highWaterBytes<=c.maximumBytes && c.maximumBytes===previous.maximumBytes &&
        c.highWaterBytes>=previous.highWaterBytes && Object.keys(nativeOwners).every(key=>
          c.native[key]===sample.ownership[key]) &&
        Object.values(c.native).reduce((sum,bytes)=>sum+bytes,0)<=c.residentBytes
    }), 'All owned phases fit their configured capacity; physical Native payload agrees with its ledger')

    // Unlike the settled replays, these bursts reverse direction without
    // waiting for either terrain or imagery. DOM wheel handling is verified
    // separately in the deployed demo; here exercise the public SDK camera.
    terrainFrozen = false
    const continuitySequence = runtime.state().frame.sequence
    const originalFine = Array.from(runtime.renderer.presentedTextures)
      .filter(([, tile]) => tile.level > 1).map(([key]) => key)
    const planImagery = runtime.abi.planImagery
    let completedDuringMotion = 0, retainedDuringMotion = originalFine.length
    const panStart = viewer.camera.getView().target
    let panDisplacement = 0
    runtime.abi.planImagery = async function (...args) {
      const result = await planImagery.apply(this, args)
      if (!result.pending && !result.continuation && !result.superseded &&
          result.imageryPlan && result.imageryPlan.quality.planningComplete === true) completedDuringMotion++
      return result
    }
    runtime.setInteractionActive(true)
    try {
      // Completion includes exact measurement and partition admission, rather
      // than a usable preview. Keep a bounded pan running long enough for that
      // work while the synthetic terrain fixture continues publishing cuts.
      const motionStarted = performance.now()
      for (let i = 0; performance.now() - motionStarted < 30000; ++i) {
        runtime.applyInteraction({xPixels: i % 40 < 20 ? 4 : -4, yPixels: 0,
          headingDegrees: i % 2 ? -0.2 : 0.2})
        await wait(40)
        const target = viewer.camera.getView().target
        panDisplacement = Math.max(panDisplacement, Math.hypot(target.longitudeDegrees-panStart.longitudeDegrees,
          target.latitudeDegrees-panStart.latitudeDegrees))
        retainedDuringMotion = Math.min(retainedDuringMotion,
          originalFine.filter(key => runtime.renderer.presentedTextures.has(key)).length)
        if (i >= 39 && completedDuringMotion > 0) break
      }
    } finally {
      runtime.setInteractionActive(false)
      runtime.abi.planImagery = planImagery
    }
    check('interaction_fine_continuity', originalFine.length > 0 && retainedDuringMotion > 0,
      `${retainedDuringMotion}/${originalFine.length} original fine tiles remain presented during motion`)
    check('interaction_imagery_progress', completedDuringMotion > 0 &&
      runtime.state().frame.sequence > continuitySequence,
    `${completedDuringMotion} imagery snapshots completed while terrain and camera continued updating`)
    check('interaction_pan_target', panDisplacement > 0.01,
      `Continuous pan crosses ${panDisplacement.toFixed(2)} geographic degrees`)
    const beforeBurst = runtime.state().frame.sequence
    const zoomView = viewer.camera.getView()
    // Pan can cross different synthetic mountains. Reuse the original target
    // so the existing near-DEM clearance contract measures the same fixture.
    zoomView.target = Object.assign({}, initial.state.view.target)
    zoomView.rangeMeters = 300000
    zoomView.tiltDegrees = 76.3; zoomView.headingDegrees = 14.5
    viewer.camera.setView(zoomView)
    // Establish actual fine display before measuring its replacement. The
    // continuous pan can leave only global-level imagery, and a fast descent
    // need not download detail before reversing. Comparing global level 2
    // with itself would time out even after the final view is fully ready.
    // This setup has its own bound; the rapid motion and 4s ascent deadline
    // below remain unchanged and must still replace this displayed detail.
    await waitFor('fine display before rapid zoom', () => {
      const state = runtime.state(), quality = state.renderer.quality
      // This fixture ends at source level 8. Its complete finest display is a
      // valid starting point even when the requested SSE needs finer data.
      // Capacity, missing coverage and pending work are not accepted here.
      const sourceEnd = quality.limitationReasons.length === 1 &&
        quality.limitationReasons[0] === 'source-level' &&
        quality.resolvedLevelMaximum === runtime.manifest.texture.maximum_level
      return state.frame.sequence > beforeBurst && quality.cameraCurrent &&
        quality.terrainSelectionCurrent && (quality.targetMet || sourceEnd) &&
        quality.quiescent && quality.targetCoverage === 1 &&
        quality.geometryCoverageReady && quality.missingCount === 0 &&
        quality.resolvedLevelMaximum > 2
    }, 20000)
    const initialZoomState = runtime.state()
    const initialFineLevel = initialZoomState.renderer.quality.resolvedLevelMaximum
    let finestLevelDuringZoom = initialFineLevel
    check('rapid_zoom_fine_precondition', finestLevelDuringZoom > 2,
      `Current-view fine level ${finestLevelDuringZoom} is actually displayed before motion`)
    let minimumRange = Infinity, maximumRange = 0, minimumClearance = Infinity
    const zoomPlanner = runtime.abi.planImagery
    let latestZoomRevision = -1, latestZoomAt = 0, coarseHints = 0, coarseDisplay = null
    runtime.abi.planImagery = async function (sequence, options, onProgress, ...rest) {
      const observe = result => {
        if (result.imageryPlan && result.measurements && result.measurements.length &&
            result.viewRevision === this.viewRevision) {
          latestZoomRevision = result.viewRevision; latestZoomAt = performance.now()
          if (result.imageryPlan.quality.coarsening) ++coarseHints
        }
      }
      // Measurements are deltas: a usable coarse snapshot can arrive through
      // progress, leaving no measurements in the final stream response.
      const result = await zoomPlanner.call(this, sequence, options, value => {
        observe(value)
        if (onProgress) onProgress(value)
      }, ...rest)
      observe(result)
      return result
    }
    let finalMotionAt
    try {
      for (const direction of [-1, 1, -1, 1]) {
        // Reach a real global endpoint independently of DEM clearance clamps
        // during descent. Inverting the descent factor need not reach space.
        const factor = direction < 0 ? Math.exp(-0.288) :
          Math.pow(manifest.transform.radius * 4 / viewer.camera.getView().rangeMeters, 1 / 30)
        for (let i = 0; i < 30; ++i) {
          viewer.camera.zoomBy(factor)
          const range = viewer.camera.getView().rangeMeters
          minimumRange = Math.min(minimumRange, range); maximumRange = Math.max(maximumRange, range)
          const ground = runtime.state().cameraGround
          if (ground && ground.terrainSampleAvailable) minimumClearance = Math.min(minimumClearance,
            ground.eyeHeightMeters - ground.terrainHeightMeters)
          await wait(25)
          // Include any finer detail actually displayed during the descent.
          finestLevelDuringZoom = Math.max(finestLevelDuringZoom,
            ...Array.from(runtime.renderer.presentedTextures.values(), tile => tile.level))
        }
      }
      finalMotionAt = performance.now()
      // Accept actual current-view coarse display and target precision within
      // the same deadline. A changed terrain cut can finish coarsening without
      // emitting the transient same-mesh scheduling hint.
      await waitFor('latest scale coverage and coarsening', () => {
        const quality = runtime.state().renderer.quality
        if (latestZoomRevision !== runtime.abi.viewRevision || !quality.cameraCurrent ||
            !quality.terrainSelectionCurrent || !quality.targetMet || !quality.geometryCoverageReady ||
            quality.missingCount !== 0 || !(quality.resolvedLevelMaximum < finestLevelDuringZoom)) return false
        coarseDisplay = quality
        return true
      }, 4000)
    } finally {
      runtime.abi.planImagery = zoomPlanner
      rapidZoomEvidence = {latestZoomRevision, currentViewRevision: runtime.abi.viewRevision,
        latestZoomAt, finalMotionAt, observedAt: performance.now(),
        initialFineLevel, initialFrameSequence: initialZoomState.frame.sequence,
        initialViewRevision: initialZoomState.terrainSelection.presentedViewRevision,
        initialQuality: initialZoomState.renderer.quality,
        finestLevelDuringZoom, coarseHints, acceptedCoarseDisplay: Boolean(coarseDisplay)}
    }
    check('rapid_zoom_latest_imagery', Math.max(0,latestZoomAt-finalMotionAt) < 4000,
      `Latest camera received usable imagery after ${Math.round(Math.max(0,latestZoomAt-finalMotionAt))}ms`)
    check('rapid_zoom_coarsening', coarseDisplay && coarseDisplay.targetMet &&
      coarseDisplay.resolvedLevelMaximum < finestLevelDuringZoom,
      `Displayed level ${finestLevelDuringZoom} -> ${coarseDisplay.resolvedLevelMaximum}; ` +
      `error ${coarseDisplay.resolvedMaxPixelError}px; ${coarseHints} scheduling hints`)
    const afterBurst = await waitForRenderedFrame(beforeBurst, 1, progressiveImagery)
    // The synthetic mountain fixture can force a higher range than sea-level
    // minimum. Verify approach to the actual DEM as well as wide ascent.
    check('rapid_zoom_range', minimumRange < 100000 &&
      minimumClearance < 1000 && maximumRange > manifest.transform.radius * 3,
    `${minimumRange} .. ${maximumRange}; ground clearance ${minimumClearance}`)
    check('rapid_zoom_progress', afterBurst.frame.sequence > beforeBurst && !runtime.abi.destroyed,
      'Continuous near-ground descent, ascent, and reversal keep updating')
    check('rapid_zoom_coverage', afterBurst.renderer.textures.missingRatio === 0 &&
      afterBurst.renderer.quality.geometryCoverageReady, 'Rapid zoom retains complete displayed coverage')

    const failedWorker = runtime.abi
    const oldDisplay = runtime.renderer.displaySurface
    const oldQuerySurface = runtime.renderedSurface
    failedWorker.worker.onerror({message: 'injected Worker failure'})
    check('worker_failure_preserves_display', runtime.renderer.displaySurface === oldDisplay,
      'Worker termination retains the displayed GPU cut')
    check('worker_failure_preserves_query_surface', oldQuerySurface && runtime.renderedSurface === oldQuerySurface,
      'Worker termination retains the actual submitted query surface')
    await waitFor('Worker reconstruction', () => runtime.abi !== failedWorker &&
      !runtime.workerRecovering, 8000)
    const recovered = await waitForRenderedFrame(undefined, 1, progressiveImagery)
    check('worker_recovery_progress', runtime.lastFrame.coverageComplete &&
      failedWorker.destroyed && runtime.abi.generation !== failedWorker.generation,
      'Reconstruction reloads the manifest, replays requested cached records, and publishes a new cut')
    check('worker_recovery_ownership', Array.from(runtime.renderer.current.draws).every(draw =>
      draw.geometryKey.startsWith(`mesh:${runtime.abi.generation}:`)),
      'New Worker content IDs cannot collide with retained geometry')
    check('worker_partition_owner', runtime.renderer.geometry.values().filter(geometry =>
      geometry.key.startsWith(`mesh:${runtime.abi.generation}:`)).every(geometry =>
      Number.isInteger(geometry.resourceId) && geometry.resourceId > 0),
    'GPU resources retain native mesh IDs for Worker partition scheduling')
    viewer.pause()
    const pausedAttempts = Array.from(requestAttempts.values()).reduce((a, b) => a + b, 0)
    await wait(100)
    check('pause_request_idle', pausedAttempts === Array.from(requestAttempts.values()).reduce((a, b) => a + b, 0),
      'Pause stops test-owned terrain traffic')
    viewer.resume()
    terrainFrozen = false

    const beforeReset = runtime.state().frame.sequence
    viewer.camera.reset()
    await waitForRenderedFrame(beforeReset, 1, { requireStableTerrain: true })
    check('reset_sequence', runtime.state().frame.sequence > beforeReset,
      'SDK frame sequence advanced')
    const reset = await capture('reset_world', true)
    check('reset_state',
      approximatelyEqual(reset.state.camera.distance, initial.state.camera.distance, 1e-9) &&
      approximatelyEqual(reset.state.camera.tiltRadians,
        initial.state.camera.tiltRadians, 1e-12) &&
      approximatelyEqual(reset.state.camera.yawRadians,
        initial.state.camera.yawRadians, 1e-12) &&
      approximatelyEqual(reset.state.camera.longitudeDegrees,
        initial.state.camera.longitudeDegrees, 1e-12) &&
      approximatelyEqual(reset.state.camera.latitudeDegrees,
        initial.state.camera.latitudeDegrees, 1e-12),
      'Reset camera matches initial camera')
    check('reset_image',
      reset.framebuffer.width === initial.framebuffer.width &&
      reset.framebuffer.height === initial.framebuffer.height &&
      reset.framebuffer.sampledColorCount >= 3,
    `${reset.framebuffer.width}x${reset.framebuffer.height}, ` +
      `${reset.framebuffer.sampledColorCount} sampled colors`)

    check('focus_image_changed',
      focus.framebuffer.fnv1a32 !== initial.framebuffer.fnv1a32,
      `${initial.framebuffer.fnv1a32} -> ${focus.framebuffer.fnv1a32}`)
    check('zoom_image_changed', zoom.framebuffer.fnv1a32 !== focus.framebuffer.fnv1a32,
      `${focus.framebuffer.fnv1a32} -> ${zoom.framebuffer.fnv1a32}`)
    check('tilt_image_changed',
      tilt.framebuffer.fnv1a32 !== zoom.framebuffer.fnv1a32,
      `${zoom.framebuffer.fnv1a32} -> ${tilt.framebuffer.fnv1a32}`)
    check('yaw_image_changed',
      yaw.framebuffer.fnv1a32 !== tilt.framebuffer.fnv1a32,
      `${tilt.framebuffer.fnv1a32} -> ${yaw.framebuffer.fnv1a32}`)
    check('north_image_changed', north.framebuffer.fnv1a32 !== yaw.framebuffer.fnv1a32,
      `${yaw.framebuffer.fnv1a32} -> ${north.framebuffer.fnv1a32}`)
    check('top_image_changed', top.framebuffer.fnv1a32 !== north.framebuffer.fnv1a32,
      `${north.framebuffer.fnv1a32} -> ${top.framebuffer.fnv1a32}`)

    const extension = runtime.renderer.gl.getExtension('WEBGL_lose_context')
    check('context_extension', Boolean(extension), 'WEBGL_lose_context is available')
    const beforeLossRevision = runtime.renderedSurfaceRevision
    extension.loseContext()
    await waitFor('WebGL context loss', () => runtime.state().contextLost, 4000)
    check('context_loss_query_unavailable', runtime.renderedSurface === null &&
      runtime.renderedSurfaceRevision > beforeLossRevision &&
      viewer.sampleRenderedSurface([116.4074,39.9042]).status === 'unavailable',
      'Lost GPU terrain cannot be sampled through retained candidate meshes')
    const lossRevision = runtime.renderedSurfaceRevision
    extension.restoreContext()
    await waitFor('WebGL context restore', () => {
      const state = runtime.state()
      return !state.contextLost && state.renderer.draws.submitted >= 4
    }, 8000)
    await waitForRenderedFrame(undefined, 4, { requireStableTerrain: true })
    check('context_restore_query_surface', runtime.renderedSurface &&
      runtime.renderedSurfaceRevision > lossRevision &&
      viewer.sampleRenderedSurface([116.4074,39.9042]).status === 'approximate',
      'Restored ground queries wait for real draw submission')
    const restored = await capture('context_restored', true)
    check('context_restore_draw', restored.state.renderer.draws.submitted >= 4,
      `${restored.state.renderer.draws.submitted} draws`)
    check('context_restore_image',
      restored.framebuffer.fnv1a32 === reset.framebuffer.fnv1a32,
      `${reset.framebuffer.fnv1a32} -> ${restored.framebuffer.fnv1a32}`)

    check('capture_set', captures.length === expectedCaptures.length &&
      expectedCaptures.every((name, index) => captures[index].name === name),
    captures.map((item) => item.name).join(','))
    // Keep the repeated-residual stress, coverage and capacity checks above.
    // Application navigation needs coherent heights at their actual CBDAM keys;
    // repeating one nonzero detail at every depth invents steep terrain.
    const [indexResponse, payloadResponse] = await Promise.all([
      fetch('fixtures/navigation-terrain.json'), fetch('fixtures/navigation-terrain.bin')])
    check('navigation_snapshot_fetch', indexResponse.ok && payloadResponse.ok,
      `${indexResponse.status}/${payloadResponse.status}`)
    const catalogue=await indexResponse.json(),navigationPayload=await payloadResponse.arrayBuffer()
    navigationTerrain = window.TerraNavigationTerrain.create(catalogue,navigationPayload,sdk.common.fnv1a64)
    viewer.destroy()
    viewer = null
    runtime = null
    viewer = await sdk.viewer.TerraViewer.create({
      mode: 'globe', canvas,
      dataset: Object.assign({}, manifest, {dataset_id: 'globe-navigation-snapshot-20261013'}),
      serviceOrigin: 'https://terrain.example',
      terraModule: wasm.module, wasmUrl: 'generated/terra_sdk.wasm', workerUrl: 'generated/terra_worker.js',
      request: navigationTerrain.request,
      viewport: {width: 640, height: 360, devicePixelRatio: 1},
      maximumTerrainRequests: 4, maximumTerrainRetries: 0,
      maximumTextureRetries: 0, fetchTextures: false,
      initialTarget: {longitudeDegrees: 116.4074, latitudeDegrees: 39.9042}
    })
    runtime = viewer.runtime
    viewer.imagery.setSource(sdk.viewer.createTmsImagerySource({
      id: 'navigation-geographic-fixture',
      url: 'https://tiles.example/{z}/{x}/{y}.png',
      texture: {maximum_level: 17}
    }))
    // Public application trajectories run on actual display callbacks. Never
    // invoke renderer.render() or rewrite internal planner state in these cases.
    let navigationError = null
    for (const name of window.TerraNavigationScenarios.names) {
      const presentation = window.TerraCanvasPresentation.mount(canvas, {width:640,height:360,devicePixelRatio:1})
      try {
        let evidence
        const presentedPhases = []
        try {
          evidence = await window.TerraNavigationScenarios.run(viewer, name, {durationMs:1800,
            onPhase:phase=>presentedPhases.push({phase,...presentation.inspect()})})
        } finally {
          // Even a seemingly successful coarse fallback cannot validate a
          // trajectory if an ancestor or detail was absent from this snapshot.
          const stats = navigationTerrain.stats()
          check(`navigation_${name}_snapshot_complete`, stats.missingKeys.length === 0,
            JSON.stringify(stats))
        }
        navigationScenarios.push(evidence)
        evidence.canvasPresentation={schema:'terra.canvas-presentation.v1',phases:presentedPhases}
        check(`navigation_${name}_canvas_presented`,presentedPhases.length===4,JSON.stringify(evidence.canvasPresentation))
        evidence.comparison.environment = 'offline-keyed-terrain; synthetic-geographic-imagery'
        check(`navigation_${name}_frames`, evidence.performance.runtime.frameCoordinator.submit.count >= 4,
          JSON.stringify(evidence.performance.runtime.frameCoordinator.frame))
        check(`navigation_${name}_coverage`, evidence.blankSamples === 0 && evidence.missingSamples === 0,
          JSON.stringify({ blank: evidence.blankSamples, missing: evidence.missingSamples, samples: evidence.samples.length }))
        check(`navigation_${name}_terrain_progress`, evidence.performance.runtime.fullUpdate.count > 0 &&
          evidence.terrainPublicationCount > 0 && evidence.terrainMeshChangeCount > 0,
          JSON.stringify({ updates: evidence.performance.runtime.fullUpdate.count,
            publications: evidence.terrainPublicationCount, meshChanges: evidence.terrainMeshChangeCount }))
        for (const phase of ['preparation', 'settlement']) {
          const final = evidence[phase].final, q = final.quality, r = final.resources
          check(`navigation_${name}_${phase}_precision`, q.ready && q.settled &&
            q.geometryTargetComplete && q.targetMet && !r.limitedByCapacity &&
            Number.isFinite(r.achievedLodError) && r.achievedLodError <= r.requestedLodThreshold * 1.001 &&
            Number.isFinite(q.resolvedMaxPixelError) && q.resolvedMaxPixelError <= q.targetPixelError * 1.001,
          JSON.stringify({quality:q, terrain:r}))
        }
        if (name === 'roam') {
          const final = evidence.settlement.final, capacity = final.selection.capacity
          check('navigation_roam_terrain_precision_recovered', final.quality.geometryTargetComplete &&
            !final.resources.limitedByCapacity && capacity.workingMeshBytes === capacity.preferredMeshBytes &&
            (!capacity.reductions || capacity.restorations > 0), JSON.stringify({capacity,
              terrainTarget: final.quality.geometryTargetComplete, limited: final.resources.limitedByCapacity}))
        }
        if (name === 'oblique') {
          const gate = evidence.settlement.final.selection.demand
          const before = evidence.preparation.samples[0].state.selection.demand
          check('navigation_oblique_joint_demand', !gate.blocked && gate.pauses > before.pauses &&
            gate.resumptions > before.resumptions && gate.reason === null &&
            gate.planningWaits > before.planningWaits, JSON.stringify({before, final: gate}))
          const demand = evidence.settlement.final.ground
          check('navigation_oblique_independent_ground', demand && demand.active && !demand.pending &&
            ['eye', 'front'].every(role => demand[role] && Number.isFinite(demand[role].heightMeters) &&
              ['ready', 'limited'].includes(demand[role].status) &&
              demand[role].reasons.every(reason => ['no-data', 'source-level'].includes(reason))), JSON.stringify(demand))
        }
      } catch (error) {
        if (!navigationError) navigationError = error
        if (error.report) error.report.comparison.environment = 'offline-keyed-terrain; synthetic-geographic-imagery'
        navigationFailures.push({scenario: name, message: error.message, report: error.report || null})
        checks.push({name: `navigation_${name}_complete`, passed: false, detail: error.message})
      } finally {presentation.release()}
    }
    if (navigationError) throw navigationError
    const nearView = viewer.camera.getView()
    nearView.target = {longitudeDegrees: 116.5623, latitudeDegrees: 40.74863, heightMeters: 0}
    nearView.rangeMeters = 1; nearView.tiltDegrees = 89.5; nearView.headingDegrees = 14.5
    viewer.camera.setView(nearView)
    await waitFor('independent eye and front terrain', () => {
      const demand = viewer.camera.getTerrainState()
      const ground = runtime.state().cameraGround
      return demand.active && !demand.pending && ground && ground.appliedDemandRevision === demand.revision &&
        ground.queriedHeightMeters !== null && ['eye', 'front'].every(role =>
        demand[role] && Number.isFinite(demand[role].heightMeters) &&
        ['ready', 'limited'].includes(demand[role].status))
    }, 30000)
    const nearGround = runtime.state().cameraGround
    check('near_ground_independent_clearance', nearGround.queriedHeightMeters !== null &&
      nearGround.eyeHeightMeters - nearGround.terrainHeightMeters >= 1.99 &&
      viewer.camera.getView().rangeMeters === 1, JSON.stringify(nearGround))
    check('near_ground_snapshot_complete', navigationTerrain.stats().missingKeys.length === 0,
      JSON.stringify(navigationTerrain.stats()))
    const eyeStart = {schema: 'terra.eye-view.v1', mode: 'globe', position: {
      longitudeDegrees: 116.5623, latitudeDegrees: 40.74863, heightMeters: nearGround.queriedHeightMeters + 2},
      headingDegrees: 14.5, pitchDegrees: -5}
    viewer.camera.setView(eyeStart)
    const eyePosition = viewer.camera.getView().position
    viewer.camera.orbitBy({headingDegrees: 30, tiltDegrees: 10})
    check('eye_turn_position', JSON.stringify(viewer.camera.getView().position) === JSON.stringify(eyePosition),
      JSON.stringify(viewer.camera.getView()))
    viewer.camera.setView(eyeStart)
    const walkSamples = []
    const walkSubmits = runtime.performanceSnapshot().frameCoordinator.submit.count
    let walkDone = false, walkFailure = null
    const walking = viewer.camera.walkBy({forwardMeters: 6, speedMetersPerSecond: 4}).then(
      result => {walkDone = result}, error => {walkFailure = error})
    await waitFor('six metre ground walk', () => {
      if (walkFailure) throw walkFailure
      const state = runtime.state()
      walkSamples.push({view: state.view, walk: state.walk, ground: state.cameraGround,
        draws: state.renderer.draws.submitted, missing: state.renderer.textures.missing,
        bytes: state.resourceMemory.bytes, limit: state.resourceMemory.maximumBytes})
      return walkDone
    }, 30000)
    await walking
    check('eye_walk_distance', walkDone.distanceMeters === 6 && walkSamples.length >= 4 &&
      walkSamples.every(s => s.view.schema === 'terra.eye-view.v1' && s.bytes <= s.limit), JSON.stringify(walkDone))
    check('eye_walk_submissions', runtime.performanceSnapshot().frameCoordinator.submit.count - walkSubmits >= 4,
      String(runtime.performanceSnapshot().frameCoordinator.submit.count - walkSubmits))
    check('eye_walk_clearance', walkSamples.every(s => s.ground.terrainSampleAvailable &&
      s.ground.eyeHeightMeters - s.ground.terrainHeightMeters >= 1.99), JSON.stringify(walkSamples))
    let walkingImage, walkingDataUrl
    viewer.environment.setAtmosphere({enabled: false})
    await renderForReadback(runtime.renderer, () => {
      walkingImage = framebufferStats(runtime.renderer.gl);walkingDataUrl = canvas.toDataURL('image/png');return true
    })
    check('eye_walk_image', walkingImage.nonBackgroundPixels > 10000 && walkingImage.sampledColorCount >= 3,
      JSON.stringify(walkingImage))
    check('eye_walk_depth', runtime.renderer.stats().depth.mode === 'logarithmic' &&
      runtime.renderer.stats().depth.limitedReason === null, JSON.stringify(runtime.renderer.stats().depth))
    check('eye_walk_snapshot_complete', navigationTerrain.stats().missingKeys.length === 0,
      JSON.stringify(navigationTerrain.stats()))
    const report = publicReport(wasm, true)
    report.walking = {samples: walkSamples, result: walkDone, framebuffer: walkingImage,
      image: walkingDataUrl,
      scope: '6m sampled CBDAM ground following; not swept collision or device FPS acceptance'}
    viewer.destroy()
    viewer=null;runtime=null
    try { networkNavigation=await window.TerraNetworkNavigation.verify({sdk,wasm,manifest,catalogue,
      payload:navigationPayload,check}) }
    catch(error) {networkNavigation=error.networkReport;throw error}
    try {localNavigation=await window.TerraNetworkNavigation.verify({sdk,wasm,manifest,catalogue,
      payload:navigationPayload,execution:'direct',check:(name,...args)=>check('local_'+name,...args)})}
    catch(error) {localNavigation=error.networkReport;throw error}
    try {localNavigationNoFaults=await window.TerraNetworkNavigation.verify({sdk,wasm,manifest,catalogue,
      payload:navigationPayload,execution:'direct',faults:false,check:(name,...args)=>check('local_normal_'+name,...args)})}
    catch(error) {localNavigationNoFaults=error.networkReport;throw error}
    finish(report)
  }

  run().catch((error) => {
    checks.push({
      name: 'harness_complete',
      passed: false,
      stack: error && error.stack,
      detail: error && error.message ? error.message : String(error)
    })
    finish({
      schema: 'terra.web-sdk.evidence.v1',
      passed: false,
      durationMs: Math.round(performance.now() - startedAt),
      checks,
      navigationScenarios,
      navigationFailure: error && error.report || null,
      runtimeState: runtime ? runtime.state() : null,
      requestAttempts: Array.from(requestAttempts.entries()),
      captures: captures.map((item) => ({
        name: item.name,
        state: item.state,
        framebuffer: item.framebuffer
      }))
    })
    if (viewer) {
      viewer.destroy()
    } else if (runtime) {
      runtime.destroy()
    }
  })
})()
