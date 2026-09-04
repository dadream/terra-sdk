(function () {
  'use strict'

  const sdk = window.TerraWebSdk
  const canvas = document.getElementById('terra-canvas')
  const mode = document.body.dataset.mode
  const isGlobe = mode === 'globe'
  const parameters = new URLSearchParams(window.location.search)
  const embedded = parameters.get('embed') === '1'
  const publicHttp = window.location.protocol === 'http:' &&
    !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)
  const sdkOrigin = publicHttp ? 'http://127.0.0.1' : window.location.origin
  const elements = {
    mode: document.getElementById('mode-label'),
    runtime: document.getElementById('runtime-status'),
    frame: document.getElementById('frame-status'),
    attribution: document.getElementById('attribution'),
    debug: document.getElementById('debug-panel'),
    error: document.getElementById('error-banner'),
    imagery: document.getElementById('imagery-profile'),
    reset: document.getElementById('reset-view'),
    debugToggle: document.getElementById('debug-toggle'),
    move: document.getElementById('mode-move'),
    look: document.getElementById('mode-look')
  }
  const state = {
    viewer: null,
    interactionMode: 'move',
    gestureMode: 'move',
    debugVisible: false,
    diagnosticsTimer: null,
    resizeObserver: null,
    destroyed: false
  }

  document.body.dataset.embed = embedded ? 'true' : 'false'
  elements.mode.textContent = isGlobe ? 'Globe' : 'Planar 1k'
  if (!isGlobe) elements.reset.textContent = 'Reset'

  function installCanvasAdapter() {
    canvas.requestAnimationFrame = (callback) =>
      window.requestAnimationFrame(callback)
    canvas.createImage = () => {
      const image = new Image()
      image.decoding = 'async'
      if (publicHttp) {
        const descriptor = Object.getOwnPropertyDescriptor(
          window.HTMLImageElement.prototype, 'src')
        if (!descriptor || typeof descriptor.get !== 'function' ||
            typeof descriptor.set !== 'function') {
          throw new Error('Browser image URL adapter is unavailable')
        }
        Object.defineProperty(image, 'src', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() { return descriptor.get.call(image) },
          set(value) {
            descriptor.set.call(image, rewriteLoopbackUrl(value))
          }
        })
      }
      return image
    }
  }

  function rewriteLoopbackUrl(value) {
    if (!publicHttp) return value
    const parsed = new URL(value, window.location.href)
    if (parsed.origin === sdkOrigin) {
      return `${parsed.pathname}${parsed.search}`
    }
    return value
  }

  function browserRequest(options) {
    const controller = new AbortController()
    const promise = fetch(rewriteLoopbackUrl(options.url), {
      method: options.method || 'GET',
      signal: controller.signal,
      cache: 'no-store'
    }).then(async (response) => {
      let data
      if (options.responseType === 'arraybuffer') {
        data = await response.arrayBuffer()
      } else {
        const text = await response.text()
        data = text ? JSON.parse(text) : null
      }
      const header = {}
      response.headers.forEach((value, name) => { header[name] = value })
      return { statusCode: response.status, data, header }
    })
    return { promise, abort: () => controller.abort() }
  }

  function imageryProfile(name) {
    if (!isGlobe) {
      return sdk.imagery.resolvePlanarImageryProfile(sdkOrigin)
    }
    const supported = name === 'tianditu-img-c'
      ? 'tianditu-img-c' : 'blue-marble'
    return sdk.imagery.resolveImageryProfile(
      supported, '', supported, sdkOrigin)
  }

  async function instantiateWasm() {
    const response = await fetch('/assets/terra_sdk.wasm', { cache: 'no-store' })
    if (!response.ok) throw new Error(`Wasm HTTP ${response.status}`)
    const loaded = await WebAssembly.instantiate(
      await response.arrayBuffer(), sdk.wasm.createTerraImports())
    const instance = loaded.instance || loaded
    if (instance.exports && typeof instance.exports._initialize === 'function') {
      instance.exports._initialize()
    }
    if (instance.exports.terra_abi_version() !== 1) {
      throw new Error('Terra Wasm ABI is incompatible')
    }
    return new sdk.wasm.TerraWasmModule(instance)
  }

  function viewport() {
    const rect = canvas.getBoundingClientRect()
    return {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      devicePixelRatio: Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    }
  }

  function setInteractionMode(value) {
    state.interactionMode = value
    elements.move.setAttribute('aria-pressed', value === 'move' ? 'true' : 'false')
    elements.look.setAttribute('aria-pressed', value === 'look' ? 'true' : 'false')
  }

  function command(id, callback) {
    document.getElementById(id).addEventListener('click', () => {
      if (!state.viewer) return
      try {
        callback(state.viewer)
      } catch (error) {
        showError(error)
      }
    })
  }

  function wireControls() {
    elements.move.addEventListener('click', () => setInteractionMode('move'))
    elements.look.addEventListener('click', () => setInteractionMode('look'))
    command('pan-left', (viewer) => viewer.camera.panBy({ xPixels: -64, yPixels: 0 }))
    command('pan-right', (viewer) => viewer.camera.panBy({ xPixels: 64, yPixels: 0 }))
    command('pan-up', (viewer) => viewer.camera.panBy({ xPixels: 0, yPixels: -64 }))
    command('pan-down', (viewer) => viewer.camera.panBy({ xPixels: 0, yPixels: 64 }))
    command('zoom-out', (viewer) => viewer.camera.zoomBy(1.28))
    command('zoom-in', (viewer) => viewer.camera.zoomBy(0.78))
    command('top-down', (viewer) => viewer.camera.topDown())
    command('tilt-45', (viewer) => viewer.camera.setTilt(45))
    command('rotate-left', (viewer) => viewer.camera.orbitBy({
      headingDegrees: -15, tiltDegrees: 0
    }))
    command('rotate-right', (viewer) => viewer.camera.orbitBy({
      headingDegrees: 15, tiltDegrees: 0
    }))
    command('north-up', (viewer) => viewer.camera.northUp())
    command('reset-view', (viewer) => {
      if (isGlobe) viewer.camera.showGlobe()
      else viewer.camera.reset()
    })
    elements.debugToggle.addEventListener('click', () => {
      if (!state.viewer) return
      state.debugVisible = !state.debugVisible
      elements.debug.hidden = !state.debugVisible
      elements.debugToggle.setAttribute('aria-pressed',
        state.debugVisible ? 'true' : 'false')
      state.viewer.debug.setRendering({ textureState: state.debugVisible })
    })
    elements.imagery.addEventListener('change', () => {
      if (!state.viewer || !isGlobe) return
      try {
        const imagery = imageryProfile(elements.imagery.value)
        state.viewer.imagery.setSource(imagery)
        elements.attribution.textContent = imagery.attribution
      } catch (error) {
        showError(error)
      }
    })
  }

  function wirePointerInteraction() {
    const pointers = new Map()
    const point = (event) => {
      const rect = canvas.getBoundingClientRect()
      return {
        id: event.pointerId,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      }
    }
    const packet = () => ({
      pointers: Array.from(pointers.values()),
      timeMs: performance.now()
    })
    canvas.addEventListener('pointerdown', (event) => {
      if (!state.viewer) return
      event.preventDefault()
      canvas.setPointerCapture(event.pointerId)
      pointers.set(event.pointerId, point(event))
      if (pointers.size === 1) {
        state.gestureMode = event.button === 2 || event.shiftKey
          ? 'look' : state.interactionMode
        state.viewer.interaction.begin(Object.assign(packet(), {
          mode: state.gestureMode
        }))
      } else {
        state.viewer.interaction.update(packet())
      }
    })
    canvas.addEventListener('pointermove', (event) => {
      if (!state.viewer || !pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, point(event))
      state.viewer.interaction.update(packet())
    })
    const end = (event) => {
      if (!state.viewer || !pointers.has(event.pointerId)) return
      pointers.delete(event.pointerId)
      state.viewer.interaction.end(packet())
      if (!pointers.size) state.gestureMode = state.interactionMode
    }
    canvas.addEventListener('pointerup', end)
    canvas.addEventListener('pointercancel', end)
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())
    canvas.addEventListener('wheel', (event) => {
      if (!state.viewer) return
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const scale = Math.max(0.75, Math.min(1.33,
        Math.exp(event.deltaY * 0.001)))
      state.viewer.camera.zoomBy(scale, {
        anchor: { x: event.clientX - rect.left, y: event.clientY - rect.top }
      })
    }, { passive: false })
  }

  function number(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : '-'
  }

  function diagnostics() {
    if (!state.viewer) return
    const current = state.viewer.getState()
    const frame = current.frame || {}
    const renderer = current.renderer || {}
    const textures = renderer.textures || {}
    const quality = renderer.quality || {}
    const transition = renderer.transition || {}
    const view = current.view || {}
    const target = view.target || {}
    elements.frame.textContent = `frame ${frame.sequence || 0} · patches ` +
      `${frame.loadedRecordCount || 0} · draws ${frame.drawCount || 0} · ` +
      `textures ${textures.entries || 0}`
    const coverageReady = Boolean(textures.coverageReady) &&
      transition.coverageComplete !== false
    const pending = (current.terrain && current.terrain.active || 0) +
      (current.terrain && current.terrain.queued || 0) +
      (textures.active || 0) + (textures.queued || 0)
    elements.runtime.textContent = current.error
      ? 'Error' : (coverageReady && pending === 0 ? 'Ready' : 'Loading')
    if (coverageReady && frame.drawCount > 0) {
      document.documentElement.dataset.terraStatus = 'ready'
    }
    const targetText = isGlobe
      ? `${number(target.longitudeDegrees, 5)}, ${number(target.latitudeDegrees, 5)}`
      : `${number(target.x, 2)}, ${number(target.y, 2)}`
    elements.debug.textContent = [
      `mode ${mode} transport ${publicHttp ? 'same-origin IP adapter' : 'direct'}`,
      `target ${targetText}`,
      `range ${number(view.rangeMeters, 1)}m tilt ${number(view.tiltDegrees, 1)} heading ${number(view.headingDegrees, 1)}`,
      `terrain ${frame.loadedRecordCount || 0} records ${frame.failedRecordCount || 0} failed requests ${current.terrain ? current.terrain.active : 0}/${current.terrain ? current.terrain.queued : 0}`,
      `geometry expected ${transition.expectedGeometry || 0} missing ${transition.pendingGeometry || 0} omitted ${transition.omittedGeometry || 0} coverage ${transition.coverageComplete ? 'ready' : 'loading'}`,
      `imagery ${textures.state || '-'} roots ${textures.cachedRoots || 0}/${textures.rootDesired || 0} requests ${textures.active || 0}/${textures.queued || 0} failed ${textures.failed || 0}`,
      `imagery target ${number(quality.targetPixelError, 2)}px resolved ${number(quality.resolvedMaxPixelError, 2)}px exact ${number((quality.targetCoverage || 0) * 100, 1)}%`,
      `texture cache ${textures.entries || 0}/${textures.capacity || 0} presentation ${textures.presentationTiles || 0} fallback ${quality.fallbackCount || 0} missing ${quality.missingCount || 0}`
    ].join('\n')
  }

  function showError(error) {
    const message = sdk && sdk.common
      ? sdk.common.redactSensitiveText(error.message || String(error))
      : String(error)
    elements.error.hidden = false
    elements.error.textContent = message
    elements.runtime.textContent = 'Failed'
    document.documentElement.dataset.terraStatus = 'failed'
  }

  function destroy() {
    if (state.destroyed) return
    state.destroyed = true
    if (state.diagnosticsTimer) window.clearInterval(state.diagnosticsTimer)
    if (state.resizeObserver) state.resizeObserver.disconnect()
    if (state.viewer) state.viewer.destroy()
    state.viewer = null
  }

  async function main() {
    installCanvasAdapter()
    wireControls()
    wirePointerInteraction()
    const requestedImagery = parameters.get('imagery') === 'tianditu-img-c'
      ? 'tianditu-img-c' : 'blue-marble'
    elements.imagery.value = requestedImagery
    const imagery = imageryProfile(requestedImagery)
    const options = {
      mode,
      canvas,
      serviceOrigin: sdkOrigin,
      manifestPath: isGlobe
        ? '/terra/v1/datasets/globe/manifest'
        : '/terra/v1/datasets/ps-1k/manifest',
      terraModule: await instantiateWasm(),
      request: browserRequest,
      imagery,
      viewport: viewport(),
      interaction: { inertiaEnabled: true }
    }
    if (isGlobe) {
      options.initialTarget = {
        longitudeDegrees: 116.4074,
        latitudeDegrees: 39.9042
      }
    }
    state.viewer = await sdk.viewer.TerraViewer.create(options)
    elements.attribution.textContent = imagery.attribution
    state.resizeObserver = new ResizeObserver(() => {
      if (state.viewer) state.viewer.resize(viewport())
    })
    state.resizeObserver.observe(canvas)
    state.diagnosticsTimer = window.setInterval(diagnostics, 250)
    diagnostics()
    document.addEventListener('visibilitychange', () => {
      if (!state.viewer) return
      if (document.hidden) state.viewer.pause()
      else state.viewer.resume()
    })
    window.addEventListener('pagehide', destroy, { once: true })
    window.addEventListener('beforeunload', destroy, { once: true })
    window.__terraProductDemo = {
      mode,
      viewer: state.viewer,
      publicHttpAdapter: publicHttp,
      destroy
    }
  }

  main().catch(showError)
})()
