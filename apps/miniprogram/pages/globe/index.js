const runtimeConfig = require('../../config/runtime')
const { TerraGlobeRuntime } = require('../../utils/terra_globe_runtime')
const imageryProfiles = require('../../utils/terra_imagery_profiles')

function touchDistance(touches) {
  if (!touches || touches.length < 2) {
    return 0
  }
  const dx = touches[0].clientX - touches[1].clientX
  const dy = touches[0].clientY - touches[1].clientY
  return Math.sqrt(dx * dx + dy * dy)
}

function viewport(width, height) {
  const info = typeof wx.getWindowInfo === 'function'
    ? wx.getWindowInfo()
    : wx.getSystemInfoSync()
  return {
    width: Math.max(1, Math.round(width || info.windowWidth || 1)),
    height: Math.max(1, Math.round(height || info.windowHeight || 1)),
    devicePixelRatio: info.pixelRatio || 1
  }
}

Page({
  data: {
    status: 'Preparing globe',
    statusKind: 'running',
    metrics: '',
    reportReady: false,
    controlsDisabled: true,
    retryVisible: false,
    imageryAttribution: ''
  },

  onReady() {
    this.unloaded = false
    this.start()
  },

  onUnload() {
    this.unloaded = true
    this.startToken = (this.startToken || 0) + 1
    if (this.gestureTimer) {
      clearTimeout(this.gestureTimer)
      this.gestureTimer = null
    }
    this.clearStateTimer()
    if (this.resizeHandler && typeof wx.offWindowResize === 'function') {
      wx.offWindowResize(this.resizeHandler)
    }
    if (this.runtime) {
      this.runtime.destroy()
      this.runtime = null
    }
  },

  start() {
    const token = (this.startToken || 0) + 1
    this.startToken = token
    wx.createSelectorQuery()
      .select('#globe')
      .fields({ node: true, size: true })
      .exec((result) => {
        if (this.unloaded || token !== this.startToken) {
          return
        }
        const selected = result && result[0]
        if (!selected || !selected.node) {
          this.fail(new Error('WebGL canvas node is unavailable'))
          return
        }
        this.initialize(selected.node, selected.width, selected.height, token)
      })
  },

  async initialize(canvas, width, height, token) {
    if (this.unloaded || token !== this.startToken) {
      return
    }
    try {
      const serviceOrigin = wx.getStorageSync('terra.terrainServiceOrigin') ||
        runtimeConfig.terrainServiceOrigin
      if (!serviceOrigin) {
        throw new Error('Terrain service origin is not configured')
      }
      const imagery = imageryProfiles.resolveImageryProfile(
        wx.getStorageSync(imageryProfiles.TIANDITU_PROFILE_STORAGE_KEY) ||
          runtimeConfig.imageryProfile,
        wx.getStorageSync(imageryProfiles.TIANDITU_TOKEN_STORAGE_KEY),
        runtimeConfig.textureId)
      const runtime = await TerraGlobeRuntime.create({
        canvas,
        serviceOrigin,
        manifestPath: runtimeConfig.terrainManifestPath,
        textureId: runtimeConfig.textureId,
        imagery,
        viewport: viewport(width, height),
        onState: (state) => this.updateState(state),
        onDiagnostic: (kind) => {
          if (!this.unloaded && token === this.startToken) {
            this.setData({
              status: `Globe ${kind}`,
              statusKind: 'warning'
            })
          }
        }
      })
      if (this.unloaded || token !== this.startToken) {
        runtime.destroy()
        return
      }
      this.runtime = runtime
      this.setData({
        controlsDisabled: false,
        imageryAttribution: imagery.attribution
      })
      this.installResizeHandler()
    } catch (error) {
      if (!this.unloaded && token === this.startToken) {
        this.fail(error)
      }
    }
  },

  installResizeHandler() {
    if (typeof wx.onWindowResize !== 'function') {
      return
    }
    this.resizeHandler = (event) => {
      if (!this.runtime) {
        return
      }
      try {
        this.runtime.resize(viewport(event.size.windowWidth, event.size.windowHeight))
      } catch (error) {
        this.fail(error)
      }
    }
    wx.onWindowResize(this.resizeHandler)
  },

  updateState(state) {
    if (this.unloaded) {
      return
    }
    const frame = state.frame || {}
    const draws = state.renderer && state.renderer.draws
    const terrainFailures = state.terrain
      ? state.terrain.failedRequestCount || 0
      : 0
    const textureFailures = state.renderer && state.renderer.textures
      ? state.renderer.textures.failed || 0
      : 0
    const resourceFailures = terrainFailures + textureFailures
    const status = state.error
      ? state.error
      : state.contextLost
        ? 'WebGL context paused'
        : resourceFailures
          ? `Globe ${resourceFailures} resource requests failed`
          : `Globe ${frame.loadedRecordCount || 0} records ${draws ? draws.submitted : 0} draws`
    const metrics = [
      `patches ${frame.patchCount || 0}`,
      `requests ${frame.requestCount || 0}`,
      `draws ${draws ? draws.submitted : 0}`,
      `DPR ${state.budget ? state.budget.devicePixelRatio.toFixed(2) : '0'}`
    ].concat(resourceFailures ? [`failed ${resourceFailures}`] : []).join(' | ')
    const nextData = {
      status,
      statusKind: state.error ? 'failed' :
        state.contextLost || resourceFailures ? 'warning' : 'ready',
      metrics,
      reportReady: true,
      retryVisible: resourceFailures > 0
    }
    this.latestReport = state
    getApp().globalData.globeReport = state
    this.queueState(nextData)
  },

  queueState(nextData) {
    const previous = this.lastUiData
    const immediate = !previous ||
      previous.status !== nextData.status ||
      previous.statusKind !== nextData.statusKind ||
      previous.retryVisible !== nextData.retryVisible
    const now = Date.now()
    if (immediate || now - (this.lastUiUpdateAt || 0) >= 250) {
      this.clearStateTimer()
      this.applyState(nextData)
      return
    }
    this.pendingUiData = nextData
    if (!this.uiStateTimer) {
      const delay = Math.max(1, 250 - (now - this.lastUiUpdateAt))
      this.uiStateTimer = setTimeout(() => {
        this.uiStateTimer = null
        const pending = this.pendingUiData
        this.pendingUiData = null
        if (pending) {
          this.applyState(pending)
        }
      }, delay)
    }
  },

  applyState(nextData) {
    this.lastUiData = nextData
    this.lastUiUpdateAt = Date.now()
    this.setData(nextData)
  },

  clearStateTimer() {
    if (this.uiStateTimer) {
      clearTimeout(this.uiStateTimer)
      this.uiStateTimer = null
    }
    this.pendingUiData = null
  },

  fail(error) {
    if (this.unloaded) {
      return
    }
    this.clearStateTimer()
    this.setData({
      status: error.message || String(error),
      statusKind: 'failed',
      controlsDisabled: true
    })
  },

  onTouchStart(event) {
    this.lastTouches = event.touches || []
  },

  onTouchMove(event) {
    if (!this.runtime) {
      return
    }
    const touches = event.touches || []
    if (!this.lastTouches || !touches.length) {
      this.lastTouches = touches
      return
    }
    let change = null
    if (touches.length >= 2 && this.lastTouches.length >= 2) {
      const previous = touchDistance(this.lastTouches)
      const current = touchDistance(touches)
      if (previous > 0 && current > 0) {
        change = { zoomScale: Math.max(0.86, Math.min(1.16, previous / current)) }
      }
    } else if (touches.length === 1 && this.lastTouches.length === 1) {
      const dx = touches[0].clientX - this.lastTouches[0].clientX
      const dy = touches[0].clientY - this.lastTouches[0].clientY
      change = { yawDelta: -dx * 0.006, tiltDelta: -dy * 0.004 }
    }
    this.lastTouches = touches
    if (change) {
      this.queueGesture(change)
    }
  },

  onTouchEnd() {
    this.lastTouches = null
  },

  queueGesture(change) {
    this.pendingGesture = this.pendingGesture || {
      zoomScale: 1,
      yawDelta: 0,
      tiltDelta: 0
    }
    this.pendingGesture.zoomScale *= change.zoomScale || 1
    this.pendingGesture.yawDelta += change.yawDelta || 0
    this.pendingGesture.tiltDelta += change.tiltDelta || 0
    if (this.gestureTimer) {
      return
    }
    this.gestureTimer = setTimeout(() => {
      this.gestureTimer = null
      const pending = this.pendingGesture
      this.pendingGesture = null
      if (this.runtime) {
        try {
          this.runtime.applyCamera(pending)
        } catch (error) {
          this.fail(error)
        }
      }
    }, 16)
  },

  zoomIn() {
    if (this.runtime) {
      this.runtime.zoom(0.82)
    }
  },

  zoomOut() {
    if (this.runtime) {
      this.runtime.zoom(1.22)
    }
  },

  tilt45() {
    if (this.runtime) {
      this.runtime.tilt45()
    }
  },

  resetCamera() {
    if (this.runtime) {
      this.runtime.reset()
    }
  },

  retryFailed() {
    if (this.runtime) {
      this.runtime.retryFailed()
    }
  },

  copyReport() {
    if (this.latestReport) {
      wx.setClipboardData({ data: JSON.stringify(this.latestReport, null, 2) })
    }
  }
})
