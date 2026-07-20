const runtimeConfig = require('../../config/runtime')
const { TerraViewer } = require('../../utils/terra_viewer')
const { TerraMiniProgramInteractionAdapter } = require(
  '../../utils/terra_miniprogram_interaction')

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
    status: 'Preparing PS 1k terrain',
    statusKind: 'running',
    metrics: '',
    controlsDisabled: true,
    reportReady: false,
    retryVisible: false,
    renderMode: 'texture'
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
      .select('#planar')
      .fields({ node: true, size: true })
      .exec((result) => {
        const selected = result && result[0]
        if (this.unloaded || token !== this.startToken) {
          return
        }
        if (!selected || !selected.node) {
          this.fail(new Error('WebGL canvas node is unavailable'))
          return
        }
        this.initialize(selected.node, selected.width, selected.height, token)
      })
  },

  async initialize(canvas, width, height, token) {
    try {
      const serviceOrigin =
        wx.getStorageSync('terra.planarServiceOrigin') ||
        runtimeConfig.planarServiceOrigin || runtimeConfig.terrainServiceOrigin
      if (!serviceOrigin) {
        throw new Error('Planar service origin is not configured')
      }
      const viewer = await TerraViewer.create({
        mode: 'planar',
        canvas,
        serviceOrigin,
        manifestPath: runtimeConfig.planarManifestPath,
        textureId: runtimeConfig.planarTextureId,
        planarLevel: runtimeConfig.planarLevel,
        viewport: viewport(width, height),
        onState: (state) => this.updateState(state),
        onDiagnostic: (kind) => {
          if (!this.unloaded && token === this.startToken) {
            this.setData({ status: `Planar ${kind}`, statusKind: 'warning' })
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
        mode: 'move'
        })
      this.setData({ controlsDisabled: false })
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
      if (this.runtime) {
        if (this.interaction) this.interaction.cancel()
        this.runtime.resize(viewport(
          event.size.windowWidth, event.size.windowHeight))
      }
    }
    wx.onWindowResize(this.resizeHandler)
  },

  updateState(state) {
    if (this.unloaded) {
      return
    }
    const frame = state.frame || {}
    const renderer = state.renderer || {}
    const draws = renderer.draws || {}
    const textures = renderer.textures || {}
    const terrainFailures = state.terrain
      ? state.terrain.failedRequestCount || 0
      : 0
    const failures = terrainFailures + (textures.failed || 0)
    const ready = (draws.submitted || 0) > 0 && (textures.entries || 0) > 0
    const status = state.error || (state.contextLost
      ? 'WebGL context paused'
      : failures
        ? `Planar ${failures} resource requests failed`
        : ready
          ? 'PS 1k terrain ready'
          : `Loading ${frame.loadedRecordCount || 0} terrain records`)
    this.latestReport = state
    getApp().globalData.planarReport = state
    this.setData({
      status,
      statusKind: state.error ? 'failed' :
        state.contextLost || failures ? 'warning' : ready ? 'ready' : 'running',
      metrics: [
        `patches ${frame.patchCount || 0}`,
        `records ${frame.loadedRecordCount || 0}`,
        `draws ${draws.submitted || 0}`,
        `vertices ${frame.vertexCount || 0}`,
        `texture ${textures.entries ? 'ready' : 'pending'}`
      ].join(' | '),
      reportReady: true,
      retryVisible: failures > 0,
      renderMode: renderer.mode || 'texture'
    })
  },

  fail(error) {
    this.setData({
      status: error.message || String(error),
      statusKind: 'failed',
      controlsDisabled: true
    })
  },

  onTouchStart(event) {
    if (this.interaction) this.interaction.begin(event)
  },

  onTouchMove(event) {
    if (this.interaction) this.interaction.update(event)
  },

  onTouchEnd(event) {
    if (this.interaction) this.interaction.end(event)
  },

  onTouchCancel() {
    if (this.interaction) this.interaction.cancel()
  },

  birdView() {
    if (this.runtime) this.runtime.birdView()
  },

  tilt45() {
    if (this.runtime) this.runtime.tilt45()
  },

  zoomIn() {
    if (this.runtime) this.runtime.zoom(0.82)
  },

  zoomOut() {
    if (this.runtime) this.runtime.zoom(1.22)
  },

  showTexture() {
    if (this.runtime) this.runtime.setRenderMode('texture')
  },

  showHeight() {
    if (this.runtime) this.runtime.setRenderMode('height')
  },

  resetCamera() {
    if (this.runtime) this.runtime.reset()
  },

  retryFailed() {
    if (this.runtime) this.runtime.retryFailed()
  },

  copyReport() {
    if (this.latestReport) {
      wx.setClipboardData({ data: JSON.stringify(this.latestReport, null, 2) })
    }
  }
})
