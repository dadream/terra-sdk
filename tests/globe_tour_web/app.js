(function () {
  'use strict'

  const sdk = window.TerraWebSdk
  const urlParameters = new URLSearchParams(window.location.search)
  const verifyMode = urlParameters.get('verify') === '1'
  const imageryProfileName = urlParameters.get('imagery') === 'blue-marble'
    ? 'blue-marble' : 'tianditu-img-c'
  const canvas = document.getElementById('globe-canvas')
  const runtimeStatus = document.getElementById('runtime-status')
  const frameStatus = document.getElementById('frame-status')
  const routeSummary = document.getElementById('route-summary')
  const poiList = document.getElementById('poi-list')
  const poiLabels = document.getElementById('poi-labels')
  const attribution = document.getElementById('attribution')
  const errorBanner = document.getElementById('error-banner')
  const automationResult = document.getElementById('automation-result')
  const debugPanel = document.getElementById('debug-panel')
  const controls = {
    overview: document.getElementById('overview'),
    previous: document.getElementById('previous'),
    next: document.getElementById('next'),
    orbitCounterclockwise: document.getElementById('orbit-ccw'),
    orbitClockwise: document.getElementById('orbit-cw'),
    stop: document.getElementById('stop'),
    routePlay: document.getElementById('route-play'),
    routePause: document.getElementById('route-pause'),
    modeMove: document.getElementById('mode-move'),
    modeLook: document.getElementById('mode-look'),
    panLeft: document.getElementById('pan-left'),
    panRight: document.getElementById('pan-right'),
    panUp: document.getElementById('pan-up'),
    panDown: document.getElementById('pan-down'),
    tiltDown: document.getElementById('tilt-down'),
    tiltUp: document.getElementById('tilt-up'),
    rotateLeft: document.getElementById('rotate-left'),
    rotateRight: document.getElementById('rotate-right'),
    northUp: document.getElementById('north-up'),
    globeView: document.getElementById('globe-view'),
    debugToggle: document.getElementById('debug-toggle')
  }
  const state = {
    currentIndex: -1,
    fixture: null,
    motion: { mode: 'idle', progress: 0, paused: false, reason: '' },
    routeDestination: -1,
    orbitDirection: '',
    interactionMode: 'move',
    gestureMode: 'move',
    debugVisible: false,
    verificationStage: '',
    motionPhases: [],
    viewer: null,
    imagery: null,
    labelElements: new Map(),
    poiButtons: []
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
  }

  async function waitFor(label, predicate, timeoutMilliseconds) {
    state.verificationStage = label
    const deadline = performance.now() + timeoutMilliseconds
    while (performance.now() < deadline) {
      const value = predicate()
      if (value) return value
      await delay(50)
    }
    const finalValue = predicate()
    if (finalValue) return finalValue
    throw new Error(`等待 ${label} 超时`)
  }

  function installCanvasAdapter() {
    canvas.requestAnimationFrame = (callback) =>
      window.requestAnimationFrame(callback)
    canvas.createImage = () => {
      const image = new Image()
      image.decoding = 'async'
      return image
    }
  }

  function browserRequest(options) {
    const controller = new AbortController()
    const promise = fetch(options.url, {
      method: options.method || 'GET',
      signal: controller.signal,
      cache: 'no-store'
    }).then(async (response) => {
      const data = options.responseType === 'arraybuffer'
        ? await response.arrayBuffer()
        : await response.json()
      const header = {}
      response.headers.forEach((value, name) => { header[name] = value })
      return { statusCode: response.status, data, header }
    })
    return { promise, abort: () => controller.abort() }
  }

  async function instantiateWasm() {
    const response = await fetch('generated/terra_sdk.wasm', {
      cache: 'no-store'
    })
    if (!response.ok) throw new Error(`Wasm HTTP ${response.status}`)
    const loaded = await WebAssembly.instantiate(
      await response.arrayBuffer(), sdk.wasm.createTerraImports())
    const instance = loaded.instance || loaded
    if (instance.exports && typeof instance.exports._initialize === 'function') {
      instance.exports._initialize()
    }
    if (instance.exports.terra_abi_version() !== 1) {
      throw new Error('Terra Wasm ABI 不兼容')
    }
    return new sdk.wasm.TerraWasmModule(instance)
  }

  function viewport() {
    const rect = canvas.getBoundingClientRect()
    return {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      devicePixelRatio: Math.min(2, Math.max(1,
        window.devicePixelRatio || 1))
    }
  }

  function activePoi() {
    return state.currentIndex >= 0 && state.fixture
      ? state.fixture.pois[state.currentIndex] : null
  }

  function syncControls() {
    const last = state.fixture ? state.fixture.pois.length - 1 : -1
    const motionMode = state.motion.mode
    const moving = motionMode !== 'idle' && motionMode !== 'route-paused'
    const selected = state.currentIndex >= 0
    controls.previous.disabled = !selected || state.currentIndex === 0 || moving
    controls.next.disabled = state.currentIndex >= last || moving
    controls.orbitClockwise.disabled = !selected || moving
    controls.orbitCounterclockwise.disabled = !selected || moving
    controls.stop.disabled = motionMode === 'idle'
    controls.routePlay.disabled = !selected || state.currentIndex >= last ||
      moving
    controls.routePause.disabled = motionMode !== 'route-playing'
    controls.routePlay.textContent = motionMode === 'route-paused'
      ? '继续路线' : '沿路线'
    controls.orbitClockwise.setAttribute('aria-pressed',
      motionMode === 'orbiting' && state.orbitDirection === 'clockwise'
        ? 'true' : 'false')
    controls.orbitCounterclockwise.setAttribute('aria-pressed',
      motionMode === 'orbiting' && state.orbitDirection === 'counterclockwise'
        ? 'true' : 'false')
    controls.modeMove.setAttribute('aria-pressed',
      state.interactionMode === 'move' ? 'true' : 'false')
    controls.modeLook.setAttribute('aria-pressed',
      state.interactionMode === 'look' ? 'true' : 'false')
    controls.debugToggle.setAttribute('aria-pressed',
      state.debugVisible ? 'true' : 'false')
    state.poiButtons.forEach((button, index) => {
      button.setAttribute('aria-current',
        index === state.currentIndex ? 'true' : 'false')
      button.disabled = moving
    })
  }

  function setCurrentIndex(index) {
    state.currentIndex = index
    syncControls()
  }

  function buildPoiList() {
    poiList.replaceChildren()
    state.poiButtons = state.fixture.pois.map((poi, index) => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.title = `飞行到${poi.name}`
      const name = document.createElement('span')
      name.className = 'poi-name'
      name.textContent = poi.name
      const address = document.createElement('span')
      address.className = 'poi-address'
      address.textContent = poi.address
      const coordinate = document.createElement('span')
      coordinate.className = 'poi-coordinate'
      coordinate.textContent = `${poi.coordinate[0].toFixed(5)}, ` +
        `${poi.coordinate[1].toFixed(5)}`
      button.append(name, address, coordinate)
      button.addEventListener('click', () => flyToIndex(index))
      item.appendChild(button)
      poiList.appendChild(item)
      return button
    })
    routeSummary.textContent = `${state.fixture.summary.distanceMeters} 米 · ` +
      `${Math.round(state.fixture.summary.durationSeconds / 60)} 分钟`
  }

  function buildPoiLabels() {
    poiLabels.replaceChildren()
    state.labelElements.clear()
    state.fixture.pois.forEach((poi) => {
      const label = document.createElement('span')
      label.className = 'poi-label'
      label.textContent = poi.name
      label.hidden = true
      poiLabels.appendChild(label)
      state.labelElements.set(poi.id, label)
    })
  }

  function routeView() {
    return state.viewer.getRouteView({ paddingPixels: 64 })
  }

  function showOverview() {
    state.routeDestination = -1
    state.viewer.camera.stopMotion()
    setCurrentIndex(-1)
    state.viewer.camera.setView(routeView(), verifyMode
      ? undefined : { animate: true, durationMs: 1600 })
  }

  function flyToIndex(index) {
    if (index < 0 || index >= state.fixture.pois.length) return
    const poi = state.fixture.pois[index]
    state.routeDestination = -1
    setCurrentIndex(index)
    state.viewer.camera.flyTo(poi.coordinate, {
      durationMs: verifyMode ? 450 : undefined,
      heightAboveTargetMeters: 12000,
      tiltDegrees: 45,
      headingDegrees: 0
    })
  }

  function showGlobe() {
    state.routeDestination = -1
    setCurrentIndex(-1)
    state.viewer.camera.showGlobe({
      durationMs: verifyMode ? 900 : undefined
    })
  }

  function orbit(direction) {
    const poi = activePoi()
    if (!poi) return
    state.orbitDirection = direction
    state.viewer.camera.startOrbit(poi.coordinate, {
      direction,
      speedDegreesPerSecond: 12,
      heightAboveTargetMeters: 12000,
      tiltDegrees: 45
    })
  }

  function playRoute() {
    if (state.motion.mode === 'route-paused') {
      state.viewer.camera.resumeMotion()
      return
    }
    if (state.currentIndex < 0 ||
      state.currentIndex >= state.fixture.legs.length) return
    const leg = state.fixture.legs[state.currentIndex]
    state.routeDestination = state.currentIndex + 1
    state.viewer.camera.playRoute(leg.coordinates, {
      durationMs: verifyMode ? 1200 : undefined,
      heightAboveTargetMeters: 10000,
      tiltDegrees: 55,
      lookAheadMeters: 60
    })
  }

  function wireControls() {
    controls.overview.addEventListener('click', showOverview)
    controls.previous.addEventListener('click', () =>
      flyToIndex(state.currentIndex - 1))
    controls.next.addEventListener('click', () =>
      flyToIndex(state.currentIndex + 1))
    controls.orbitClockwise.addEventListener('click', () =>
      orbit('clockwise'))
    controls.orbitCounterclockwise.addEventListener('click', () =>
      orbit('counterclockwise'))
    controls.stop.addEventListener('click', () =>
      state.viewer.camera.stopMotion())
    controls.routePlay.addEventListener('click', playRoute)
    controls.routePause.addEventListener('click', () =>
      state.viewer.camera.pauseMotion())
    controls.modeMove.addEventListener('click', () => {
      state.interactionMode = 'move'
      syncControls()
    })
    controls.modeLook.addEventListener('click', () => {
      state.interactionMode = 'look'
      syncControls()
    })
    controls.panLeft.addEventListener('click', () =>
      state.viewer.camera.panBy({ xPixels: -64, yPixels: 0 }))
    controls.panRight.addEventListener('click', () =>
      state.viewer.camera.panBy({ xPixels: 64, yPixels: 0 }))
    controls.panUp.addEventListener('click', () =>
      state.viewer.camera.panBy({ xPixels: 0, yPixels: -64 }))
    controls.panDown.addEventListener('click', () =>
      state.viewer.camera.panBy({ xPixels: 0, yPixels: 64 }))
    controls.tiltDown.addEventListener('click', () =>
      state.viewer.camera.topDown())
    controls.tiltUp.addEventListener('click', () =>
      state.viewer.camera.setTilt(45))
    controls.rotateLeft.addEventListener('click', () =>
      state.viewer.camera.orbitBy({ headingDegrees: -15, tiltDegrees: 0 }))
    controls.rotateRight.addEventListener('click', () =>
      state.viewer.camera.orbitBy({ headingDegrees: 15, tiltDegrees: 0 }))
    controls.northUp.addEventListener('click', () =>
      state.viewer.camera.northUp())
    controls.globeView.addEventListener('click', showGlobe)
    controls.debugToggle.addEventListener('click', () => {
      state.debugVisible = !state.debugVisible
      debugPanel.hidden = !state.debugVisible
      state.viewer.debug.setRendering({ textureState: state.debugVisible })
      syncControls()
    })
  }

  function wirePointerInteraction() {
    const pointers = new Map()
    const pointForEvent = (event) => {
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
      event.preventDefault()
      canvas.setPointerCapture(event.pointerId)
      pointers.set(event.pointerId, pointForEvent(event))
      if (pointers.size === 1) {
        state.gestureMode = event.button === 2 || event.shiftKey
          ? 'look' : state.interactionMode
        state.viewer.interaction.begin(Object.assign(packet(), {
          mode: state.gestureMode
        }))
      }
      else state.viewer.interaction.update(packet())
    })
    canvas.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, pointForEvent(event))
      state.viewer.interaction.update(packet())
    })
    const endPointer = (event) => {
      if (!pointers.has(event.pointerId)) return
      pointers.delete(event.pointerId)
      state.viewer.interaction.end(packet())
      if (!pointers.size) state.gestureMode = state.interactionMode
    }
    canvas.addEventListener('pointerup', endPointer)
    canvas.addEventListener('pointercancel', endPointer)
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const scale = Math.max(0.75, Math.min(1.33,
        Math.exp(event.deltaY * 0.001)))
      state.viewer.camera.zoomBy(scale, {
        anchor: { x: event.clientX - rect.left, y: event.clientY - rect.top }
      })
    }, { passive: false })
  }

  function wireViewerEvents() {
    state.viewer.on('cameramotion', (motion) => {
      state.motion = motion
      if (motion.phase && state.motionPhases.indexOf(motion.phase) < 0) {
        state.motionPhases.push(motion.phase)
      }
      if (motion.mode !== 'orbiting') state.orbitDirection = ''
      if (motion.reason === 'route-playing_complete' &&
        state.routeDestination >= 0) {
        setCurrentIndex(state.routeDestination)
        state.routeDestination = -1
      }
      runtimeStatus.textContent = motion.mode === 'idle'
        ? '就绪' : `${motion.mode} ${Math.round(motion.progress * 100)}%`
      syncControls()
    })
    state.viewer.on('featureposition', (feature) => {
      const label = state.labelElements.get(feature.featureId)
      if (!label) return
      label.hidden = !feature.visible
      if (feature.visible) {
        label.style.left = `${feature.x}px`
        label.style.top = `${feature.y}px`
      }
    })
    state.viewer.on('featureclick', (feature) => {
      const index = state.fixture.pois.findIndex((poi) =>
        poi.id === feature.featureId)
      if (index >= 0) flyToIndex(index)
    })
  }

  function startDiagnostics() {
    window.setInterval(() => {
      if (!state.viewer) return
      const current = state.viewer.getState()
      const frame = current.frame
      const renderer = current.renderer
      const textures = renderer && renderer.textures
      const quality = renderer && renderer.quality
      const transition = renderer && renderer.transition
      frameStatus.textContent = frame
        ? `frame ${frame.sequence} · patches ${frame.loadedRecordCount} · ` +
          `draws ${quality ? quality.renderedDrawCount : frame.drawCount} · ` +
          `textures ${textures ? textures.entries : 0}`
        : 'frame -'
      if (state.motion.mode === 'idle' && quality) {
        runtimeStatus.textContent = textures.state === 'degraded'
          ? 'imagery degraded'
          : (textures.state === 'blocked-capacity'
            ? 'imagery blocked'
            : (textures.state === 'bootstrapping'
              ? `roots ${textures.cachedRoots}/${textures.rootDesired}`
              : (quality.state === 'limited' ? 'imagery limited'
                : (quality.ready ? 'ready'
                  : (quality.interactionActive ? 'interacting'
                    : `imagery ${textures.cachedTarget}/${textures.targetDesired}`)))))
      }
      debugPanel.textContent = current.view && quality && textures ? [
        `target ${current.view.target.longitudeDegrees.toFixed(5)}, ` +
          `${current.view.target.latitudeDegrees.toFixed(5)}`,
        `range ${(current.view.rangeMeters /
          state.viewer.runtime.manifest.radius).toFixed(3)}R ` +
          `tilt ${current.view.tiltDegrees.toFixed(1)} ` +
          `heading ${current.view.headingDegrees.toFixed(1)}`,
        `terrain ${current.frame ? current.frame.loadedRecordCount : 0} records ` +
          `${current.frame ? current.frame.failedRecordCount : 0} failed ` +
          `${current.terrain.active}/${current.terrain.queued} requests`,
        `surface ${transition && transition.displayingPreviousFrame
          ? 'previous' : 'current'} geometry ` +
          `${transition ? transition.pendingGeometry : 0} missing / ` +
          `${transition ? transition.omittedGeometry : 0} omitted of ` +
          `${transition ? transition.expectedGeometry : 0} / ` +
          `${transition ? transition.queuedGeometry : 0} queued / ` +
          `${transition ? transition.pinnedGeometry : 0} pinned / root ` +
          `${transition ? transition.coverageGeometry : 0} ` +
          `${transition && transition.coverageComplete
            ? 'ready' : 'loading'}`,
        `imagery target ${quality.targetPixelError.toFixed(2)}px ` +
          `resolved ${Number.isFinite(quality.resolvedMaxPixelError)
            ? quality.resolvedMaxPixelError.toFixed(2) : 'missing'}px`,
        `levels ${quality.resolvedLevelMinimum === null ? '-' :
          quality.resolvedLevelMinimum}..${quality.resolvedLevelMaximum === null
          ? '-' : quality.resolvedLevelMaximum} ` +
          `tiles ${textures.cachedTarget}/${textures.targetDesired} ` +
          `budget ${quality.selectedTextureCount}/${textures.targetCapacity}`,
        `texture ${textures.state} roots ${textures.cachedRoots}/` +
          `${textures.rootDesired} coverage ${textures.coverageReady
            ? 'ready' : 'loading'} requests ${textures.active}/` +
          `${textures.queued} failed ${textures.failed}`,
        `cut current ${textures.presentationTiles} frontier ` +
          `${textures.frontierTiles} staged ${textures.stagedTiles} ` +
          `cached ${textures.entries}/${textures.capacity} base ` +
          `${quality.coverageDrawCount || 0} clip ` +
          `${quality.clippedDrawCount || 0}`,
        `transition ${textures.transitionGroups} groups ` +
          `${textures.transitionReserved}/${textures.transitionCapacity} slots ` +
          `blocked ${textures.blockedGroupCount}/${textures.blockedTileCount}`,
        `quality ${quality.ready ? 'ready' : quality.state} coverage ` +
          `${quality.covered ? 'ready' : 'loading'} geometry ` +
          `${quality.geometryTargetComplete ? 'target' : 'refining'} exact ` +
          `${(quality.targetCoverage * 100).toFixed(1)}%`,
        `fallback ${quality.fallbackCount || 0} missing ` +
          `${quality.missingCount || 0} limits ` +
          `${quality.limitedByTextureBudget ? 'texture-budget ' :
            (quality.limitedByBudget ? 'draw-budget ' : '')}` +
          `${quality.limitedByLevel ? 'level' :
            (quality.meetsTarget ? 'ok' : 'pixel-error')}`,
        `motion ${state.motion.mode} ${state.motion.phase || '-'} ` +
          `${Math.round((state.motion.progress || 0) * 100)}%`
      ].join('\n') : 'waiting for render state'
    }, 250)
  }

  function framebufferStats() {
    const renderer = state.viewer.runtime.renderer
    renderer.render()
    const gl = renderer.gl
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.finish()
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA,
      gl.UNSIGNED_BYTE, pixels)
    let nonBackgroundPixels = 0
    const colors = new Set()
    const background = [6, 11, 18]
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (Math.abs(pixels[offset] - background[0]) > 3 ||
        Math.abs(pixels[offset + 1] - background[1]) > 3 ||
        Math.abs(pixels[offset + 2] - background[2]) > 3) {
        nonBackgroundPixels += 1
      }
      if ((offset / 4) % 97 === 0) {
        colors.add(`${pixels[offset]},${pixels[offset + 1]},` +
          `${pixels[offset + 2]}`)
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      nonBackgroundPixels,
      sampledColorCount: colors.size
    }
  }

  function targetDistanceDegrees(left, right) {
    const averageLatitude = 0.5 * (left.target.latitudeDegrees +
      right.target.latitudeDegrees) * Math.PI / 180
    const longitudeDelta = ((right.target.longitudeDegrees -
      left.target.longitudeDegrees + 540) % 360) - 180
    const latitudeDelta = right.target.latitudeDegrees -
      left.target.latitudeDegrees
    return Math.hypot(longitudeDelta * Math.cos(averageLatitude),
      latitudeDelta)
  }

  async function runVerification() {
    const checks = []
    const detailColorThreshold = state.imagery.id === 'blue-marble'
      ? (canvas.width < 700 ? 24 : 32) : 64
    let dragFramebuffer = null
    let zoomOutFramebuffer = null
    let zoomInFramebuffer = null
    let globalFramebuffer = null
    let globalTransitionFramebuffer = null
    const check = (name, passed, detail) => {
      checks.push({ name, passed: Boolean(passed), detail: String(detail || '') })
      if (!passed) throw new Error(`${name}: ${detail}`)
    }
    await waitFor('首帧与纹理', () => {
      const current = state.viewer.getState()
      return current.frame && current.frame.loadedRecordCount > 0 &&
        current.frame.drawCount > 0 && current.renderer &&
        current.renderer.textures.entries > 0
    }, 45000)
    check('attribution', attribution.textContent ===
      (state.imagery.attribution || ''), attribution.textContent)
    check('pois', state.viewer.getState().featureCount === 4,
      state.viewer.getState().featureCount)
    check('route', state.viewer.getState().routeId === state.fixture.route.id,
      state.viewer.getState().routeId)
    check('navigation_controls', Object.keys(controls).every(
      (name) => Boolean(controls[name])), Object.keys(controls).join(','))

    const beforeDrag = state.viewer.camera.getView()
    const dragStartedAt = performance.now()
    state.viewer.interaction.begin({
      pointers: [{ id: 'verify-drag', x: 420, y: 320 }],
      timeMs: dragStartedAt
    })
    state.viewer.interaction.update({
      pointers: [{ id: 'verify-drag', x: 516, y: 360 }],
      timeMs: dragStartedAt + 120
    })
    state.viewer.interaction.end({
      pointers: [],
      timeMs: dragStartedAt + 121
    })
    await delay(500)
    const afterDragState = await waitFor('drag coverage ready', () => {
      const current = state.viewer.getState()
      return current.frame && current.frame.drawCount > 4 &&
        current.renderer.quality &&
        current.renderer.quality.geometryCoverageReady &&
        current.renderer.quality.terrainBound &&
        !current.renderer.quality.limitedByTextureBudget &&
        !current.renderer.quality.limitedByBudget &&
        current.renderer.quality.targetCoverage >= 0.75 &&
        current.renderer.textures &&
        current.renderer.textures.coverageReady &&
        current.renderer.textures.missingRatio === 0 &&
        !current.renderer.textures.blockedByFailure
        ? current : null
    }, 30000)
    const afterDrag = state.viewer.camera.getView()
    const dragDistance = targetDistanceDegrees(beforeDrag, afterDrag)
    dragFramebuffer = framebufferStats()
    check('drag_texture', dragDistance > 0.001 && dragDistance < 0.5 &&
      afterDragState.frame.drawCount > 4 &&
      afterDragState.renderer.textures.entries > 0 &&
      dragFramebuffer.sampledColorCount > detailColorThreshold,
    `${dragDistance.toFixed(4)} degrees, ` +
      `${afterDragState.frame.drawCount} draws, ` +
      `${dragFramebuffer.sampledColorCount} colors`)

    const zoomStart = state.viewer.camera.getView()
    const radius = state.viewer.runtime.manifest.radius
    const zoomStartAltitude = zoomStart.rangeMeters - radius
    const canvasRect = canvas.getBoundingClientRect()
    const wheelAtAnchor = (deltaY) => canvas.dispatchEvent(new WheelEvent(
      'wheel', {
        deltaY,
        clientX: canvasRect.left + canvasRect.width * 0.65,
        clientY: canvasRect.top + canvasRect.height * 0.45,
        bubbles: true,
        cancelable: true
      }))
    for (let index = 0; index < 3; ++index) {
      wheelAtAnchor(180)
      await delay(50)
    }
    const zoomOutState = await waitFor('zoom out coverage ready', () => {
      const current = state.viewer.getState()
      return current.frame && current.frame.drawCount > 0 &&
        current.renderer.quality &&
        current.renderer.quality.geometryCoverageReady &&
        current.renderer.quality.targetCoverage >= 0.75 &&
        current.renderer.textures &&
        current.renderer.textures.coverageReady &&
        current.renderer.textures.missingRatio === 0 &&
        !current.renderer.textures.blockedByFailure
        ? current : null
    }, 30000)
    const zoomedOut = state.viewer.camera.getView()
    const zoomOutRatio = (zoomedOut.rangeMeters - radius) /
      zoomStartAltitude
    zoomOutFramebuffer = framebufferStats()

    for (let index = 0; index < 3; ++index) {
      wheelAtAnchor(-180)
      await delay(50)
    }
    const zoomInState = await waitFor('zoom in coverage ready', () => {
      const current = state.viewer.getState()
      return current.frame && current.frame.drawCount > 0 &&
        current.renderer.quality &&
        current.renderer.quality.geometryCoverageReady &&
        current.renderer.quality.targetCoverage >= 0.75 &&
        current.renderer.textures &&
        current.renderer.textures.coverageReady &&
        current.renderer.textures.missingRatio === 0 &&
        !current.renderer.textures.blockedByFailure
        ? current : null
    }, 30000)
    const zoomedIn = state.viewer.camera.getView()
    const zoomReturnError = Math.abs((zoomedIn.rangeMeters - radius) -
      zoomStartAltitude) / zoomStartAltitude
    const zoomTargetError = targetDistanceDegrees(zoomStart, zoomedIn)
    zoomInFramebuffer = framebufferStats()
    check('zoom_texture', zoomOutRatio > 1.5 && zoomOutRatio < 2 &&
      zoomReturnError < 0.05 && zoomTargetError < 0.05 &&
      zoomOutState.frame.drawCount > 4 && zoomInState.frame.drawCount > 4 &&
      zoomOutFramebuffer.sampledColorCount > detailColorThreshold &&
      zoomInFramebuffer.sampledColorCount > detailColorThreshold,
    `${zoomOutRatio.toFixed(3)}x out, ` +
      `${(zoomReturnError * 100).toFixed(2)}% range error, ` +
      `${zoomTargetError.toFixed(4)} degrees target error, ` +
      `${zoomOutFramebuffer.sampledColorCount}/` +
      `${zoomInFramebuffer.sampledColorCount} colors`)

    const globalRange = radius * 2.5
    const globalStartSequence = state.viewer.getState().frame.sequence
    let globalZoomSteps = 0
    while (state.viewer.camera.getView().rangeMeters < globalRange &&
      globalZoomSteps < 48) {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 240,
        clientX: canvasRect.left + canvasRect.width * 0.5,
        clientY: canvasRect.top + canvasRect.height * 0.5,
        bubbles: true,
        cancelable: true
      }))
      globalZoomSteps += 1
      await delay(25)
    }
    const globalTransitionState = await waitFor('global transition frame', () => {
      const current = state.viewer.getState()
      return current.frame && current.frame.sequence > globalStartSequence &&
        current.frame.drawCount > 4 && current.view &&
        current.view.rangeMeters >= globalRange
        ? current : null
    }, 10000)
    globalTransitionFramebuffer = framebufferStats()
    check('global_zoom_transition',
      globalTransitionState.renderer.textures.missingRatio < 0.05 &&
      globalTransitionFramebuffer.sampledColorCount > detailColorThreshold,
    `${globalTransitionState.frame.drawCount} draws, ` +
      `${globalTransitionState.renderer.textures.fallbackRatio.toFixed(3)} ` +
      'fallback, ' +
      `${globalTransitionState.renderer.textures.missingRatio.toFixed(3)} ` +
      'missing, ' +
      `${globalTransitionFramebuffer.sampledColorCount} colors`)

    const globalState = await waitFor('global texture ready', () => {
      const current = state.viewer.getState()
      const transition = current.renderer && current.renderer.transition
      return current.frame && current.frame.drawCount > 4 &&
        current.renderer.quality && current.renderer.quality.ready &&
        current.renderer.textures.state === 'settled' &&
        transition && !transition.displayingPreviousFrame &&
        transition.coverageComplete
        ? current : null
    }, 120000)
    globalFramebuffer = framebufferStats()
    const globalTextureDetail =
      `${(state.viewer.camera.getView().rangeMeters / radius).toFixed(2)}R, ` +
      `${globalZoomSteps} steps, ${globalState.frame.drawCount} draws, ` +
      `${globalState.renderer.textures.entries} textures, ` +
      `${globalState.renderer.textures.cachedDesired}/` +
      `${globalState.renderer.textures.desired} desired, ` +
      `${globalState.renderer.textures.fallbackRatio.toFixed(3)} fallback, ` +
      `${globalState.renderer.textures.missingRatio.toFixed(3)} missing, ` +
      `${globalFramebuffer.sampledColorCount} colors`
    check('global_zoom_texture', globalZoomSteps > 0 &&
      state.viewer.camera.getView().rangeMeters >= globalRange &&
      globalState.frame.drawCount > 4 &&
      globalState.renderer.textures.entries > 0 &&
      globalState.renderer.textures.missingRatio < 0.05 &&
      globalFramebuffer.sampledColorCount > detailColorThreshold,
    globalTextureDetail)
    check('imagery_quality', globalState.renderer.quality.ready &&
      globalState.renderer.quality.terrainBound &&
      (globalState.renderer.quality.meetsTarget ||
        globalState.renderer.quality.limitedByLevel) &&
      !globalState.renderer.quality.limitedByTextureBudget &&
      globalState.renderer.quality.targetCoverage >= 0.95 &&
      globalState.renderer.textures.targetDesired <=
        globalState.renderer.textures.targetCapacity &&
      globalState.renderer.quality.selectedTextureCount <=
        globalState.renderer.textures.targetCapacity,
    `${globalState.renderer.quality.measuredMaxPixelError.toFixed(3)}px / ` +
      `${globalState.renderer.quality.targetPixelError.toFixed(3)}px, ` +
      `${globalState.renderer.textures.cachedTarget}/` +
      `${globalState.renderer.textures.targetDesired} target tiles, ` +
      `${globalState.renderer.quality.selectedTextureCount}/` +
      `${globalState.renderer.textures.targetCapacity} budget, ` +
      `${(globalState.renderer.quality.targetCoverage * 100).toFixed(1)}% exact`)
    check('hierarchical_imagery',
      globalState.renderer.textures.state === 'settled' &&
      globalState.renderer.textures.coverageReady &&
      globalState.renderer.textures.cachedRoots ===
        globalState.renderer.textures.rootDesired &&
      globalState.renderer.textures.missingRatio === 0 &&
      !globalState.renderer.textures.blockedByFailure &&
      globalState.renderer.textures.presentationTiles > 0,
    `${globalState.renderer.textures.state}, roots ` +
      `${globalState.renderer.textures.cachedRoots}/` +
      `${globalState.renderer.textures.rootDesired}, presentation ` +
      `${globalState.renderer.textures.presentationTiles}, frontier ` +
      `${globalState.renderer.textures.frontierTiles}, staged ` +
      `${globalState.renderer.textures.stagedTiles}`)

    const dragTransition = afterDragState.renderer.transition
    const globalTransition = globalState.renderer.transition
    check('geometry_transition',
      !dragTransition.displayingPreviousFrame &&
      dragTransition.expectedGeometry > 0 &&
      dragTransition.omittedGeometry === 0 &&
      dragTransition.coverageComplete &&
      !globalTransition.displayingPreviousFrame &&
      globalTransition.expectedGeometry > 0 &&
      globalTransition.omittedGeometry === 0 &&
      globalTransition.coverageComplete,
    `drag previous=${dragTransition.displayingPreviousFrame} ` +
      `missing=${dragTransition.pendingGeometry} ` +
      `queued=${dragTransition.queuedGeometry}; ` +
      `global previous=${globalTransition.displayingPreviousFrame} ` +
      `missing=${globalTransition.pendingGeometry} ` +
      `queued=${globalTransition.queuedGeometry}`)

    state.motionPhases = []
    controls.globeView.click()
    await waitFor('staged globe flight', () => {
      const motion = state.viewer.getState().cameraMotion
      if (motion && motion.reason === 'flying_complete') {
        state.motion = motion
        return motion
      }
      return null
    }, 30000)
    const globeView = state.viewer.camera.getView()
    check('staged_flight', state.motion.path === 'staged' &&
      ['ascend', 'cruise', 'descend'].every((phase) =>
        state.motionPhases.indexOf(phase) >= 0) &&
      Math.abs(globeView.target.longitudeDegrees - 116.4074) < 0.001 &&
      Math.abs(globeView.target.latitudeDegrees - 39.9042) < 0.001,
    `${state.motion.path} ${state.motionPhases.join('>')}`)

    state.viewer.camera.setView(zoomedIn)
    await waitFor('local view restore', () => {
      const current = state.viewer.getState()
      return current.frame && current.frame.drawCount > 4 &&
        current.renderer.quality && current.renderer.quality.ready
    }, 15000)
    showOverview()
    await waitFor('overview restore', () => {
      const current = state.viewer.getState()
      return current.frame && current.frame.drawCount > 4 &&
        current.renderer.textures.entries > 0
    }, 5000)

    controls.next.click()
    await waitFor('飞行到虎丘', () =>
      state.motion.reason === 'flying_complete', 5000)
    check('fly_to', state.currentIndex === 0, state.currentIndex)

    const headingBeforeOrbit = state.viewer.camera.getView().headingDegrees
    controls.orbitClockwise.click()
    await waitFor('orbit heading change', () =>
      Math.abs(state.viewer.camera.getView().headingDegrees -
        headingBeforeOrbit) > 1, 10000)
    controls.stop.click()
    const headingAfterOrbit = state.viewer.camera.getView().headingDegrees
    check('orbit', Math.abs(headingAfterOrbit - headingBeforeOrbit) > 1,
      `${headingBeforeOrbit} -> ${headingAfterOrbit}`)

    controls.routePlay.click()
    await waitFor('路线播放开始', () =>
      state.motion.mode === 'route-playing', 2000)
    controls.routePause.click()
    await waitFor('路线播放暂停', () =>
      state.motion.mode === 'route-paused', 1000)
    check('route_pause', state.motion.mode === 'route-paused',
      state.motion.mode)
    await delay(200)
    controls.routePlay.click()
    await waitFor('路线播放完成', () =>
      state.motion.reason === 'route-playing_complete', 5000)
    check('route_complete', state.currentIndex === 1, state.currentIndex)

    const settled = await waitFor('terrain coverage ready', () => {
      const current = state.viewer.getState()
      const transition = current.renderer && current.renderer.transition
      return current.frame && current.renderer.quality &&
        current.renderer.quality.ready &&
        current.renderer.textures.state === 'settled' &&
        transition && !transition.displayingPreviousFrame &&
        transition.coverageComplete
        ? current : null
    }, 15000)
    await waitFor('最终纹理收敛', () => {
      const current = state.viewer.getState()
      return current.renderer && current.renderer.quality &&
        current.renderer.quality.ready ? current : null
    }, 45000)
    const terminalFailures = settled.diagnostics.filter((entry) =>
      entry.kind === 'terrain_request_failed')
    const validTerminalLeaves = settled.terrain.failedRequestCount === 0 ||
      (terminalFailures.length > 0 && terminalFailures.every((entry) =>
        /^2:/.test(entry.detail.key) &&
        /HTTP 404/.test(entry.detail.message)))
    check('terrain', settled.error === '' && settled.frame.drawCount > 0 &&
      settled.renderer.transition.coverageComplete &&
      !settled.renderer.transition.displayingPreviousFrame &&
      validTerminalLeaves,
    `${settled.frame.drawCount} draws, ` +
      `${settled.terrain.failedRequestCount} terminal leaves`)

    const framebuffer = framebufferStats()
    check('framebuffer', framebuffer.nonBackgroundPixels > 1000 &&
      framebuffer.sampledColorCount > 8,
    `${framebuffer.nonBackgroundPixels} pixels, ` +
      `${framebuffer.sampledColorCount} colors`)
    if (!state.debugVisible) controls.debugToggle.click()
    await delay(100)
    check('debug_panel', !debugPanel.hidden &&
      /imagery target/.test(debugPanel.textContent), debugPanel.textContent)

    const report = {
      schema: 'terra.globe-tour-web-evidence.v1',
      passed: checks.every((entry) => entry.passed),
      checks,
      framebuffer,
      dragFramebuffer,
      zoomOutFramebuffer,
      zoomInFramebuffer,
      globalFramebuffer,
      globalTransitionFramebuffer,
      qualitySnapshots: {
        drag: afterDragState.renderer.quality,
        zoomOut: zoomOutState.renderer.quality,
        zoomIn: zoomInState.renderer.quality,
        global: globalState.renderer.quality
      },
      textureSnapshots: {
        drag: afterDragState.renderer.textures,
        zoomOut: zoomOutState.renderer.textures,
        zoomIn: zoomInState.renderer.textures,
        global: globalState.renderer.textures
      },
      finalView: state.viewer.camera.getView(),
      viewer: state.viewer.getState()
    }
    automationResult.textContent = JSON.stringify(report)
    document.documentElement.dataset.terraStatus = 'passed'
    window.__terraTourEvidence = report
  }

  async function main() {
    installCanvasAdapter()
    state.fixture = await fetch('data/suzhou-gardens-bicycle.v1.json', {
      cache: 'no-store'
    }).then((response) => {
      if (!response.ok) throw new Error(`路线数据 HTTP ${response.status}`)
      return response.json()
    })
    const terraModule = await instantiateWasm()
    const imagery = sdk.imagery.resolveImageryProfile(imageryProfileName, '',
      imageryProfileName, `${window.location.origin}/imagery`)
    state.imagery = imagery
    state.viewer = await sdk.viewer.TerraViewer.create({
      mode: 'globe',
      canvas,
      serviceOrigin: window.location.origin,
      manifestPath: '/terra/v1/datasets/globe/manifest',
      terraModule,
      request: browserRequest,
      imagery,
      viewport: viewport(),
      interaction: { inertiaEnabled: true },
      initialTarget: {
        longitudeDegrees: 116.4074,
        latitudeDegrees: 39.9042
      }
    })
    buildPoiList()
    buildPoiLabels()
    state.viewer.setPois(state.fixture.pois.map((poi, index) => ({
      id: poi.id,
      coordinate: poi.coordinate,
      altitudeMode: 'surface',
      priority: state.fixture.pois.length - index,
      icon: 'place'
    })))
    state.viewer.setRoute({
      id: state.fixture.route.id,
      coordinates: state.fixture.route.coordinates,
      altitudeMode: 'surface',
      color: '#f3b642',
      widthPixels: 4,
      opacity: 0.95
    })
    attribution.textContent = imagery.attribution
    wireControls()
    wirePointerInteraction()
    wireViewerEvents()
    const observer = new ResizeObserver(() => state.viewer.resize(viewport()))
    observer.observe(canvas)
    window.addEventListener('beforeunload', () => {
      observer.disconnect()
      state.viewer.destroy()
    })
    showOverview()
    runtimeStatus.textContent = '就绪'
    document.documentElement.dataset.terraStatus = 'ready'
    window.__terraTour = { state, viewer: state.viewer, fixture: state.fixture }
    syncControls()
    startDiagnostics()
    if (verifyMode) await runVerification()
  }

  main().catch((error) => {
    const message = sdk && sdk.common
      ? sdk.common.redactSensitiveText(error.message || String(error))
      : String(error)
    errorBanner.hidden = false
    errorBanner.textContent = message
    runtimeStatus.textContent = '失败'
    automationResult.textContent = JSON.stringify({
      passed: false,
      message,
      stage: state.verificationStage,
      viewer: state.viewer ? state.viewer.getState() : null
    })
    document.documentElement.dataset.terraStatus = 'failed'
  })
})()
