const runtime = require('../../config/runtime')
const probe = require('../../utils/capability_probe')

Page({
  data: {
    status: 'Initializing capability probe',
    statusKind: 'running',
    summary: 'WebGL pending | Wasm pending | Network pending',
    reportText: ''
  },

  onReady() {
    this.startProbe()
  },

  startProbe() {
    wx.createSelectorQuery()
      .select('#webgl')
      .fields({ node: true, size: true })
      .exec((result) => {
        const selected = result && result[0]
        if (!selected || !selected.node) {
          this.failProbe(new Error('WebGL canvas node is unavailable'))
          return
        }

        this.runProbe(selected.node, selected.width, selected.height)
      })
  },

  runProbe(canvas, width, height) {
    let webgl
    try {
      webgl = probe.runWebGlProbe(canvas, width, height)
    } catch (error) {
      this.failProbe(error)
      return
    }

    const wasmPromise = probe.runWasmProbe().catch((error) => ({
      passed: false,
      error: probe.errorMessage(error)
    }))
    const networkUrl =
      wx.getStorageSync('terra.arrayBufferProbeUrl') ||
      runtime.arrayBufferProbeUrl
    const networkPromise = probe
      .runArrayBufferProbe(networkUrl)
      .catch((error) => ({
        passed: false,
        error: probe.errorMessage(error)
      }))

    Promise.all([wasmPromise, networkPromise]).then((results) => {
      const report = {
        schema: 'terra.miniprogram.capabilities.v1',
        capturedAt: new Date().toISOString(),
        system: probe.collectSystemInfo(),
        webgl,
        wasm: results[0],
        network: results[1]
      }
      const passed = webgl.passed && results[0].passed
      const reportText = JSON.stringify(report, null, 2)

      getApp().globalData.capabilityReport = report
      this.setData({
        status: passed ? 'WebGL and Wasm passed' : 'Capability probe failed',
        statusKind: passed ? 'passed' : 'failed',
        summary: probe.reportSummary(report),
        reportText
      })
    })
  },

  failProbe(error) {
    const report = {
      schema: 'terra.miniprogram.capabilities.v1',
      capturedAt: new Date().toISOString(),
      system: probe.collectSystemInfo(),
      fatalError: probe.errorMessage(error)
    }

    this.setData({
      status: 'Capability probe failed',
      statusKind: 'failed',
      summary: report.fatalError,
      reportText: JSON.stringify(report, null, 2)
    })
  },

  copyReport() {
    if (!this.data.reportText) {
      return
    }
    wx.setClipboardData({ data: this.data.reportText })
  }
})
