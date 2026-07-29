const runtimeConfig = require('../../config/runtime')
const { TerraViewer } = require('../../utils/terra_viewer')
const imageryProfiles = require('../../utils/terra_imagery_profiles')
const { createCloudbaseRequest } = require(
  '../../utils/terra_cloudbase_transport')
const { TerraMiniProgramInteractionAdapter } = require(
  '../../utils/terra_miniprogram_interaction')

function windowInfo() {
  if (typeof wx.getWindowInfo === 'function') {
    return wx.getWindowInfo()
  }
  return {
    windowWidth: 1,
    windowHeight: 1,
    pixelRatio: 1,
    statusBarHeight: 0
  }
}

function viewport(width, height) {
  const info = windowInfo()
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
    imageryAttribution: '',
    gestureMode: 'move',
    statusHeight: 88,
    statusPaddingTop: 8
  },

  onLoad() {
    const info = windowInfo()
    const statusBarHeight = Math.max(0, Number(info.statusBarHeight) || 0)
    this.setData({
      statusHeight: 88 + statusBarHeight,
      statusPaddingTop: 8 + statusBarHeight
    })
  },

  onReady() {
    this.unloaded = false
    this.start()
  },

  onHide() {
    if (this.interaction) this.interaction.cancel()
    if (this.viewer) this.viewer.pause()
  },

  onShow() {
    if (this.viewer) this.viewer.resume()
  },

  onUnload() {
    this.unloaded = true
    this.startToken = (this.startToken || 0) + 1
    if (this.interaction) {
      this.interaction.destroy()
      this.interaction = null
    }
    this.clearStateTimer()
    if (this.resizeHandler && typeof wx.offWindowResize === 'function') {
      wx.offWindowResize(this.resizeHandler)
    }
    if (this.viewer) {
      this.viewer.destroy()
      this.viewer = null
      this.runtime = null
    } else if (this.runtime) {
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
      let serviceOrigin =
        wx.getStorageSync('terra.terrainServiceOrigin') ||
        runtimeConfig.terrainServiceOrigin
      let request = null
      if (!serviceOrigin && runtimeConfig.cloudbaseEnvId &&
        runtimeConfig.cloudbaseGlobeTerrainService) {
        serviceOrigin = 'https://cloudbase.invalid'
        request = createCloudbaseRequest({
          envId: runtimeConfig.cloudbaseEnvId,
          serviceName: runtimeConfig.cloudbaseGlobeTerrainService
        })
      }
      if (!serviceOrigin) {
        throw new Error('Terrain service origin is not configured')
      }
      const imagery = imageryProfiles.resolveImageryProfile(
        wx.getStorageSync(imageryProfiles.TIANDITU_PROFILE_STORAGE_KEY) ||
          runtimeConfig.imageryProfile,
        wx.getStorageSync(imageryProfiles.TIANDITU_TOKEN_STORAGE_KEY),
        runtimeConfig.textureId,
        runtimeConfig.tiandituProxyOrigin)
      const viewer = await TerraViewer.create({
        mode: 'globe',
        canvas,
        serviceOrigin,
        request,
        manifestPath: runtimeConfig.terrainManifestPath,
        textureId: runtimeConfig.textureId,
        initialTarget: runtimeConfig.initialTarget,
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
        viewer.destroy()
        return
      }
      const runtime = viewer.runtime
      this.viewer = viewer
      this.runtime = runtime
      this.interaction = new TerraMiniProgramInteractionAdapter(
        viewer.interaction, {
        canvas,
        mode: this.data.gestureMode,
        onEvent: (type) => {
          if (type === 'camerachange' && !this.unloaded) {
            this.latestView = runtime.getView()
          }
        }
        })
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
        if (this.interaction) {
          this.interaction.cancel()
        }
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
    const camera = state.camera || {}
    const longitude = Number.isFinite(camera.longitudeDegrees)
      ? camera.longitudeDegrees.toFixed(2) : '0.00'
    const latitude = Number.isFinite(camera.latitudeDegrees)
      ? camera.latitudeDegrees.toFixed(2) : '0.00'
    const tiltDegrees = Number.isFinite(camera.tiltRadians)
      ? (camera.tiltRadians * 180 / Math.PI).toFixed(0) : '0'
    const yawDegrees = Number.isFinite(camera.yawRadians)
      ? (camera.yawRadians * 180 / Math.PI).toFixed(0) : '0'
    const metrics = [
      `patches ${frame.patchCount || 0} | requests ${frame.requestCount || 0} | draws ${draws ? draws.submitted : 0}`,
      `target ${longitude}, ${latitude} | pitch ${tiltDegrees} | heading ${yawDegrees}`,
      `imagery ${state.imageryId || 'pending'} | DPR ${state.budget ? state.budget.devicePixelRatio.toFixed(2) : '0'}`
    ].concat(resourceFailures ? [`failed ${resourceFailures}`] : []).join('\n')
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
    if (this.interaction) {
      this.interaction.begin(event)
    }
  },

  onTouchMove(event) {
    if (this.interaction) {
      this.interaction.update(event)
    }
  },

  onTouchEnd(event) {
    if (this.interaction) {
      this.interaction.end(event)
    }
  },

  onTouchCancel() {
    if (this.interaction) {
      this.interaction.cancel()
    }
  },

  selectMove() {
    this.setData({ gestureMode: 'move' })
    if (this.interaction) this.interaction.setOptions({ mode: 'move' })
  },

  selectLook() {
    this.setData({ gestureMode: 'look' })
    if (this.interaction) this.interaction.setOptions({ mode: 'look' })
  },

  focusBeijing() {
    if (this.runtime) {
      this.runtime.focusInitialTarget()
    }
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

  topDown() {
    if (this.runtime) {
      this.runtime.topDown()
    }
  },

  northUp() {
    if (this.runtime) {
      this.runtime.northUp()
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
