(function () {
  'use strict'

  const sdk = window.TerraWebSdk
  const i18n = window.TerraSiteI18n
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
    scenarioControls: document.getElementById('scenario-controls'),
    scenarioName: document.getElementById('scenario-name'),
    scenarioRun: document.getElementById('scenario-run'),
    scenarioStop: document.getElementById('scenario-stop'),
    scenarioReport: document.getElementById('scenario-report'),
    scenarioStatus: document.getElementById('scenario-status'),
    error: document.getElementById('error-banner'),
    imagery: document.getElementById('imagery-profile'),
    reset: document.getElementById('reset-view'),
    debugToggle: document.getElementById('debug-toggle'),
    environmentToggle: document.getElementById('environment-toggle'),
    environmentPanel: document.getElementById('environment-panel'),
    environmentClose: document.getElementById('environment-close'),
    atmosphereEnabled: document.getElementById('atmosphere-enabled'),
    sunEnabled: document.getElementById('sun-enabled'),
    fogEnabled: document.getElementById('fog-enabled'),
    observeSun: document.getElementById('observe-sun'),
    sunAzimuth: document.getElementById('sun-azimuth'),
    sunAzimuthValue: document.getElementById('sun-azimuth-value'),
    sunZenith: document.getElementById('sun-zenith'),
    sunZenithValue: document.getElementById('sun-zenith-value'),
    turbidity: document.getElementById('atmosphere-turbidity'),
    turbidityValue: document.getElementById('atmosphere-turbidity-value'),
    exposure: document.getElementById('atmosphere-exposure'),
    exposureValue: document.getElementById('atmosphere-exposure-value'),
    fogDensity: document.getElementById('fog-density'),
    fogDensityValue: document.getElementById('fog-density-value'),
    move: document.getElementById('mode-move'),
    look: document.getElementById('mode-look')
  }
  const state = {
    viewer: null,
    interactionMode: 'move',
    gestureMode: 'move',
    debugVisible: false,
    diagnosticsTimer: null,
    environmentFrame: null,
    resizeObserver: null,
    destroyed: false
  }

  function text(key) {
    return i18n ? i18n.t(key) : key
  }

  function updateStaticLabels() {
    if (state.scenarioPhase) elements.scenarioStatus.textContent = text('demo.scenario.' + state.scenarioPhase)
    elements.mode.textContent = isGlobe
      ? text('demo.globe') : text('demo.planar')
    const resetLabel = text(isGlobe ? 'demo.globe' : 'demo.reset')
    elements.reset.textContent = resetLabel
    elements.reset.title = resetLabel
    elements.reset.setAttribute('aria-label', resetLabel)
    if (!state.viewer) {
      elements.runtime.textContent = document.documentElement.dataset.terraStatus === 'failed'
        ? text('demo.status.failed') : text('demo.status.initializing')
      elements.frame.textContent = `${text('demo.frame')} -`
    }
  }

  document.body.dataset.embed = embedded ? 'true' : 'false'
  updateStaticLabels()
  window.addEventListener('terra-language-change', () => {
    updateStaticLabels()
    diagnostics()
  })

  function installCanvasAdapter() {
    canvas.requestAnimationFrame = (callback) =>
      window.requestAnimationFrame(callback)
    canvas.cancelAnimationFrame = (handle) =>
      window.cancelAnimationFrame(handle)
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
    return sdk.transport.browserRequest(Object.assign({}, options,
      {url: rewriteLoopbackUrl(options.url)}))
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
        Promise.resolve(callback(state.viewer)).catch(error => {
          if (!['camera_walk_cancelled', 'terrain_query_cancelled'].includes(error.code)) showError(error)
        })
      } catch (error) {
        showError(error)
      }
    })
  }

  function environmentOptions() {
    return {
      enabled: elements.atmosphereEnabled.checked,
      sunEnabled: elements.sunEnabled.checked,
      fogEnabled: elements.fogEnabled.checked,
      sunAzimuthDegrees: Number(elements.sunAzimuth.value),
      sunZenithDegrees: Number(elements.sunZenith.value),
      turbidity: Number(elements.turbidity.value),
      exposure: Number(elements.exposure.value),
      fogDensityMultiplier: Number(elements.fogDensity.value)
    }
  }

  function updateEnvironmentControls() {
    const atmosphereEnabled = elements.atmosphereEnabled.checked
    elements.sunEnabled.disabled = !atmosphereEnabled
    elements.fogEnabled.disabled = !atmosphereEnabled
    elements.sunAzimuth.disabled = !atmosphereEnabled ||
      !elements.sunEnabled.checked
    elements.sunZenith.disabled = !atmosphereEnabled ||
      !elements.sunEnabled.checked
    elements.turbidity.disabled = !atmosphereEnabled
    elements.exposure.disabled = !atmosphereEnabled
    elements.fogDensity.disabled = !atmosphereEnabled ||
      !elements.fogEnabled.checked
    elements.sunAzimuthValue.value = `${elements.sunAzimuth.value}°`
    elements.sunZenithValue.value = `${elements.sunZenith.value}°`
    elements.turbidityValue.value =
      Number(elements.turbidity.value).toFixed(1)
    elements.exposureValue.value =
      Number(elements.exposure.value).toFixed(1)
    elements.fogDensityValue.value =
      `${Number(elements.fogDensity.value).toFixed(1)}×`
  }

  function scheduleEnvironmentUpdate() {
    updateEnvironmentControls()
    if (!state.viewer || !isGlobe || state.environmentFrame !== null) return
    state.environmentFrame = window.requestAnimationFrame(() => {
      state.environmentFrame = null
      if (!state.viewer) return
      try {
        state.viewer.environment.setAtmosphere(environmentOptions())
      } catch (error) {
        showError(error)
      }
    })
  }

  function setEnvironmentPanelVisible(visible) {
    const next = Boolean(visible) && isGlobe
    elements.environmentPanel.hidden = !next
    elements.environmentToggle.setAttribute('aria-expanded',
      next ? 'true' : 'false')
    if (next && state.debugVisible) {
      state.debugVisible = false
      elements.debug.hidden = true
      elements.scenarioControls.hidden = true
      elements.debugToggle.setAttribute('aria-pressed', 'false')
      if (state.viewer) {
        state.viewer.debug.setRendering({ textureState: false })
      }
    }
  }

  function wireEnvironmentControls() {
    elements.environmentToggle.addEventListener('click', () =>
      setEnvironmentPanelVisible(elements.environmentPanel.hidden))
    elements.environmentClose.addEventListener('click', () =>
      setEnvironmentPanelVisible(false))
    const controls = [elements.atmosphereEnabled, elements.sunEnabled,
      elements.fogEnabled, elements.sunAzimuth, elements.sunZenith,
      elements.turbidity, elements.exposure, elements.fogDensity]
    controls.forEach((control) =>
      control.addEventListener('input', scheduleEnvironmentUpdate))
    elements.observeSun.addEventListener('click', () => {
      if (!state.viewer || !isGlobe) return
      try {
        const runtimeState = state.viewer.getState()
        const view = state.viewer.camera.getView()
        const radius = Number(runtimeState.radiusMeters)
        if (!Number.isFinite(radius) || radius <= 0) {
          throw new Error('Globe radius is unavailable')
        }
        elements.atmosphereEnabled.checked = true
        elements.sunEnabled.checked = true
        elements.sunAzimuth.value = '25'
        elements.sunZenith.value = '89'
        updateEnvironmentControls()
        state.viewer.environment.setAtmosphere(environmentOptions())
        state.viewer.camera.setView(Object.assign({}, view, {
          rangeMeters: 30000,
          headingDegrees: 0,
          tiltDegrees: 80
        }), { animate: true, durationMs: 1200 })
        setEnvironmentPanelVisible(false)
      } catch (error) {
        showError(error)
      }
    })
    updateEnvironmentControls()
  }

  function wireControls() {
    let orbitView = null, enterController = null
    const leaveGround = () => {
      if (enterController) enterController.abort()
      enterController = null
      if (!state.viewer) return
      state.viewer.camera.stopWalking()
      if (orbitView) state.viewer.camera.setView(orbitView)
      orbitView = null
    }
    command('walk-enter', async viewer => {
      if (!isGlobe || viewer.camera.getView().schema === 'terra.eye-view.v1') return
      if (enterController) enterController.abort()
      const controller = enterController = new AbortController(), view = viewer.camera.getView()
      try {
        const point = view.target
        const terrain = await viewer.queryTerrain([point.longitudeDegrees, point.latitudeDegrees], {signal: controller.signal})
        if (controller.signal.aborted || viewer !== state.viewer) return
        if (!terrain.available) throw new Error('Terrain unavailable at the requested ground position')
        orbitView = view
        viewer.camera.setView({schema: 'terra.eye-view.v1', mode: 'globe', position: {
          longitudeDegrees: point.longitudeDegrees, latitudeDegrees: point.latitudeDegrees, heightMeters: terrain.heightMeters + 2},
          headingDegrees: view.headingDegrees, pitchDegrees: -5})
      } finally { if (enterController === controller) enterController = null }
    })
    command('walk-forward', viewer => viewer.camera.walkBy({forwardMeters: 5}))
    command('walk-stop', viewer => viewer.camera.stopWalking())
    command('walk-exit', leaveGround)
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
      leaveGround()
      if (isGlobe) viewer.camera.showGlobe()
      else viewer.camera.reset()
    })
    elements.debugToggle.addEventListener('click', () => {
      if (!state.viewer) return
      const next = !state.debugVisible
      if (next) setEnvironmentPanelVisible(false)
      state.debugVisible = next
      elements.debug.hidden = !state.debugVisible
      elements.scenarioControls.hidden = !state.debugVisible || !isGlobe
      elements.debugToggle.setAttribute('aria-pressed',
        state.debugVisible ? 'true' : 'false')
      state.viewer.debug.setRendering({ textureState: state.debugVisible })
    })
    elements.imagery.addEventListener('change', () => {
      if (!state.viewer || !isGlobe) return
      try {
        const name = elements.imagery.value
        const imagery = imageryProfile(name)
        elements.error.hidden = true
        elements.runtime.textContent = text('demo.status.loading')
        state.viewer.imagery.setSource(imagery)
        elements.attribution.textContent = imagery.attribution
        const url = new URL(window.location.href)
        url.searchParams.set('imagery', name)
        window.history.replaceState(null, '', url)
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
      if (state.viewer.camera.getView().schema === 'terra.eye-view.v1') return
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
    const handoff = transition.handoff || {}
    const runtimePerformance = current.performance || {}
    const coordinator = runtimePerformance.frameCoordinator || {}
    const rendererPerformance = renderer.performance || {}
    const lodPerformance = runtimePerformance.lodUpdate || {}
    const readPerformance = runtimePerformance.frameRead || {}
    const framePerformance = runtimePerformance.rendererSetFrame || {}
    const geometryPerformance = rendererPerformance.geometryPrepare || {}
    const imageryPerformance = rendererPerformance.imageryRebuild || {}
    const completion = value => value && value.count
      ? `${number(value.p95Ms, 1)}ms×${value.count}` : '—'
    const atmosphere = current.atmosphere || {}
    const view = current.view || {}
    const eyeMode = view.schema === 'terra.eye-view.v1'
    document.getElementById('walk-enter').disabled = eyeMode
    document.getElementById('walk-forward').disabled = !eyeMode || Boolean(current.walk && current.walk.pending)
    document.getElementById('walk-stop').disabled = !current.walk || !current.walk.pending
    document.getElementById('walk-exit').disabled = !eyeMode
    for (const id of ['zoom-in', 'zoom-out', 'top-down', 'tilt-45', 'observe-sun'])
      document.getElementById(id).disabled = eyeMode
    const target = view.target || view.position || {}
    const presentationFrame = rendererPerformance.render &&
      rendererPerformance.render.count
    elements.frame.textContent = `${text('demo.frame')} ${presentationFrame || 0} · ` +
      `${text('demo.patches')} ${frame.loadedRecordCount || 0} · ` +
      `${text('demo.draws')} ${frame.drawCount || 0} · ` +
      `${text('demo.textures')} ${textures.entries || 0}`
    const coverageReady = Boolean(textures.coverageReady) &&
      transition.coverageComplete !== false && quality.terrainSelectionCurrent !== false
    const pending = (current.terrain && current.terrain.active || 0) +
      (current.terrain && current.terrain.queued || 0) +
      (textures.active || 0) + (textures.queued || 0)
    const qualityState = quality.state || 'loading'
    elements.runtime.textContent = current.error
      ? text('demo.status.failed')
      : (quality.ready
          ? text('demo.status.ready')
          : (qualityState === 'limited' ||
              qualityState === 'blocked-capacity' ||
              qualityState === 'degraded'
            ? text('demo.status.limited')
            : (qualityState === 'interacting' || qualityState === 'refining' ||
                (coverageReady && pending > 0)
              ? text('demo.status.refining')
              : text('demo.status.loading'))))
    if (quality.ready && frame.drawCount > 0) {
      document.documentElement.dataset.terraStatus = 'ready'
    } else {
      document.documentElement.dataset.terraStatus = current.error ? 'failed'
        : (qualityState === 'ready' ? 'refining' : qualityState)
    }
    const targetText = isGlobe
      ? `${number(target.longitudeDegrees, 5)}, ${number(target.latitudeDegrees, 5)}`
      : `${number(target.x, 2)}, ${number(target.y, 2)}`
    elements.debug.textContent = [
      `${text('demo.debug.modeLabel')} ${mode} ${text('demo.debug.transport')} ` +
        `${publicHttp ? text('demo.debug.ipAdapter') : text('demo.debug.direct')}`,
      `${text('demo.debug.target')} ${targetText}`,
      `${view.schema === 'terra.eye-view.v1' ? 'eye' : text('demo.debug.range')} ${number(view.rangeMeters || 0, 1)}m ` +
        `${text('demo.debug.tilt')} ${number(view.tiltDegrees === undefined ? 90 + view.pitchDegrees : view.tiltDegrees, 1)} ` +
        `${text('demo.debug.heading')} ${number(view.headingDegrees, 1)}`,
      `${text('demo.debug.terrain')} ${frame.loadedRecordCount || 0} ` +
        `${text('demo.debug.records')} ${frame.failedRecordCount || 0} ` +
        `${text('demo.debug.failed')} ${text('demo.debug.requests')} ` +
        `${current.terrain ? current.terrain.active : 0}/` +
        `${current.terrain ? current.terrain.queued : 0}`,
      `${text('demo.debug.geometry')} ${text('demo.debug.expected')} ` +
        `${transition.expectedGeometry || 0} ${text('demo.debug.missing')} ` +
        `${transition.pendingGeometry || 0} ${text('demo.debug.omitted')} ` +
        `${transition.omittedGeometry || 0} ${text('demo.debug.coverage')} ` +
        `${transition.coverageComplete ? text('demo.status.ready') : text('demo.debug.loading')}`,
      `${text('demo.debug.terrainLod')} ${current.resources ? number(current.resources.requestedLodThreshold, 6) : '-'} ` +
        `${text('demo.debug.resolved')} ${current.resources ? number(current.resources.achievedLodError, 6) : '-'} ` +
        `${text('demo.patches')} ${quality.terrainNodeCount || 0} ` +
        `${quality.terrainLimitedByCapacity ? text('demo.status.limited') :
          (quality.terrainSelectionCurrent === false ? text('demo.status.refining') : text('demo.status.ready'))}`,
      `${text('demo.debug.noData')} ${current.resources && current.resources.noDataRecordCount || 0} ` +
        `${text('demo.debug.eyeHeight')} ${current.cameraGround ? number(current.cameraGround.eyeHeightMeters, 1) : '-'}m ` +
        `${text('demo.debug.terrainHeight')} ${current.cameraGround && current.cameraGround.terrainHeightMeters !== null
          ? number(current.cameraGround.terrainHeightMeters, 1) : '-'}m`,
      ...(!current.cameraGround || !current.cameraGround.demand || !current.cameraGround.demand.active ? [] :
        ['eye', 'front'].map(role => {
          const point = current.cameraGround.demand[role]
          return `${text('demo.debug.' + role)} ${point ? point.status : '-'} ` +
            `${point && point.sampleSpacingMeters !== null ? number(point.sampleSpacingMeters, 1) + 'm' : '-'} ` +
            `${point ? point.reasons.join(', ') : ''}`
        })),
      `${text('demo.imagery')} ${textures.state || '-'} ` +
        `${text('demo.debug.roots')} ${textures.cachedRoots || 0}/` +
        `${textures.rootDesired || 0} ${text('demo.debug.requests')} ` +
        `${textures.active || 0}/${textures.queued || 0} ` +
        `${text('demo.debug.failed')} ${textures.failed || 0}`,
      `${text('demo.debug.imageryTarget')} ` +
        `${number(quality.targetPixelError, 2)}px ` +
        `${text('demo.debug.resolved')} ` +
        `${number(quality.resolvedMaxPixelError, 2)}px ` +
        `${text('demo.debug.exact')} ` +
        `${number((quality.targetCoverage || 0) * 100, 1)}%`,
      `${text('demo.debug.imageryLevels')} ` +
        `${number(quality.selectedLevelMinimum, 0)}..` +
        `${number(quality.selectedLevelMaximum, 0)} ` +
        `${text('demo.debug.resolved')} ` +
        `${number(quality.resolvedLevelMinimum, 0)}..` +
        `${number(quality.resolvedLevelMaximum, 0)} ` +
        `${text('demo.debug.transitionCoverage')} ` +
        `${quality.coverageSubmitted || 0}`,
      `${text('demo.debug.cache')} ${textures.entries || 0}/` +
        `${textures.capacity || 0} ${text('demo.debug.presentation')} ` +
        `${textures.presentationTiles || 0} ${text('demo.debug.fallback')} ` +
        `${quality.fallbackCount || 0} ${text('demo.debug.missing')} ` +
        `${quality.missingCount || 0}`,
      `${text('demo.debug.handoff')} ${handoff.phase || '-'} ` +
        `${number(handoff.waitMs, 0)}ms · ${text('demo.debug.reserved')} ` +
        `${number((textures.reservedBytes || 0) / (1024 * 1024), 2)}MiB`,
      `${text('demo.debug.environment')} ` +
        `${atmosphere.enabled ? text('demo.atmosphere') : text('demo.debug.off')} ` +
        `${text('demo.sun')} ${atmosphere.sunEnabled ? text('demo.debug.on') : text('demo.debug.off')} ` +
        `${text('demo.fog')} ${atmosphere.fogEnabled ? text('demo.debug.on') : text('demo.debug.off')}`,
      `${text('demo.debug.frameClock')} ` +
        `${number(coordinator.frame && coordinator.frame.p95Ms, 1)}/${number(coordinator.frame && coordinator.frame.p99Ms, 1)}ms · ` +
        `${text('demo.debug.cameraSubmit')} ${number(coordinator.cameraToSubmit && coordinator.cameraToSubmit.p95Ms, 1)}ms`,
      `${text('demo.debug.performance')} ` +
        `${text('demo.debug.full')} ${number(runtimePerformance.fullUpdate && runtimePerformance.fullUpdate.lastMs, 2)}ms×` +
        `${runtimePerformance.fullUpdate ? runtimePerformance.fullUpdate.count : 0} ` +
        `${text('demo.debug.preview')} ${number(runtimePerformance.cameraPreview && runtimePerformance.cameraPreview.lastMs, 2)}ms×` +
        `${runtimePerformance.cameraPreview ? runtimePerformance.cameraPreview.count : 0} ` +
        `${text('demo.debug.render')} ${number(rendererPerformance.render && rendererPerformance.render.lastMs, 2)}ms ` +
        `${number(rendererPerformance.framesPerSecond, 1)}fps ` +
        `${text('demo.debug.wasmMemory')} ` +
        `${number((runtimePerformance.wasmMemoryBytes || 0) / (1024 * 1024), 1)}MiB`,
      `${text('demo.debug.phases')} ${text('demo.debug.lod')} ${number(lodPerformance.lastMs, 2)}ms ` +
        `${text('demo.debug.read')} ${number(readPerformance.lastMs, 2)}ms ` +
        `${text('demo.debug.frameBuild')} ${number(framePerformance.lastMs, 2)}ms`,
      `${text('demo.debug.rendererPhases')} ` +
        `${text('demo.debug.geometryPrepare')} ${number(geometryPerformance.lastMs, 2)}ms ` +
        `${text('demo.debug.imageryRebuild')} ${number(imageryPerformance.lastMs, 2)}ms`,
      `${text('demo.debug.submissionWait')} p95 ` +
        `${text('demo.debug.drawSubmission')} ${completion(rendererPerformance.drawSubmissionWait)} · ` +
        `${text('demo.debug.resourceSubmission')} ${completion(rendererPerformance.resourceSubmissionWait)}`
    ].concat(current.error ? [
      `${text('demo.debug.error')} ` +
        sdk.common.redactSensitiveText(current.error)
    ] : []).join('\n')
  }

  function showError(error) {
    const message = sdk && sdk.common
      ? sdk.common.redactSensitiveText(error.message || String(error))
      : String(error)
    elements.error.hidden = false
    elements.error.textContent = message
    elements.runtime.textContent = text('demo.status.failed')
    document.documentElement.dataset.terraStatus = 'failed'
  }

  async function runScenario(name) {
    if (!state.viewer || state.scenarioController) return null
    const controller = new AbortController()
    state.scenarioController = controller
    elements.scenarioRun.disabled = true
    elements.scenarioStop.disabled = false
    elements.scenarioReport.disabled = true
    state.scenarioResult = null
    try {
      const report = await window.TerraNavigationScenarios.run(state.viewer, name, {
        signal: controller.signal,
        onPhase(phase) {
          state.scenarioPhase = phase
          elements.scenarioStatus.textContent = text('demo.scenario.' + phase)
        }
      })
      state.scenarioResult = report
      elements.scenarioReport.disabled = false
      return report
    } catch (error) {
      state.scenarioResult = error.report || null
      elements.scenarioReport.disabled = !state.scenarioResult
      throw error
    } finally {
      state.scenarioController = null
      elements.scenarioRun.disabled = false
      elements.scenarioStop.disabled = true
    }
  }

  function wireScenarios() {
    elements.scenarioRun.addEventListener('click', () => {
      runScenario(elements.scenarioName.value).catch(error => {
        if (error.message !== 'Navigation scenario cancelled') showError(error)
      })
    })
    elements.scenarioStop.addEventListener('click', () => {
      if (state.scenarioController) state.scenarioController.abort()
    })
    elements.scenarioReport.addEventListener('click', () => {
      if (!state.scenarioResult) return
      const blob = new Blob([JSON.stringify(state.scenarioResult, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = 'terra-' + state.scenarioResult.scenario + '.json'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }

  function destroy() {
    if (state.destroyed) return
    state.destroyed = true
    if (state.scenarioController) state.scenarioController.abort()
    if (state.diagnosticsTimer) window.clearInterval(state.diagnosticsTimer)
    if (state.environmentFrame !== null) {
      window.cancelAnimationFrame(state.environmentFrame)
      state.environmentFrame = null
    }
    if (state.resizeObserver) state.resizeObserver.disconnect()
    if (state.viewer) state.viewer.destroy()
    state.viewer = null
  }

  async function main() {
    installCanvasAdapter()
    wireControls()
    wireEnvironmentControls()
    wireScenarios()
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
      wasmUrl: '/assets/terra_sdk.wasm',
      fetchTextures: (url, options) => fetch(rewriteLoopbackUrl(url), options),
      workerUrl: '/assets/terra_worker.js' +
        new URL(document.currentScript && document.currentScript.src ||
          document.querySelector('script[src*="app.js"]').src, window.location.href).search,
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
      options.atmosphere = environmentOptions()
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
      if (document.hidden) {
        if (state.scenarioController) state.scenarioController.abort()
        state.viewer.pause()
      }
      else state.viewer.resume()
    })
    window.addEventListener('pagehide', destroy, { once: true })
    window.addEventListener('beforeunload', destroy, { once: true })
    window.__terraProductDemo = {
      mode,
      viewer: state.viewer,
      publicHttpAdapter: publicHttp,
      runScenario,
      destroy
    }
  }

  main().catch(showError)
})()
