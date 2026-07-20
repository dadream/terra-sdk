const runtimeConfig = require('../../config/runtime')
const probe = require('../../utils/terra_planar_load_probe')

Page({
  data: {
    status: 'Loading PS 1k planar dataset',
    statusKind: 'running',
    summary: 'Manifest pending | Root pending | Detail pending',
    reportText: '',
    running: false
  },

  onReady() {
    this.runProbe()
  },

  runProbe() {
    if (this.data.running) {
      return
    }
    const serviceOrigin =
      wx.getStorageSync('terra.planarServiceOrigin') ||
      runtimeConfig.planarServiceOrigin
    if (!serviceOrigin) {
      this.fail(new Error('Planar service origin is not configured'))
      return
    }
    this.setData({
      status: 'Loading PS 1k planar dataset',
      statusKind: 'running',
      summary: 'Manifest pending | Root pending | Detail pending',
      reportText: '',
      running: true
    })
    probe.runPlanarLoadProbe({
      serviceOrigin,
      manifestPath: runtimeConfig.planarManifestPath
    }).then((report) => {
      const reportText = JSON.stringify(report, null, 2)
      getApp().globalData.planarLoadReport = report
      this.setData({
        status: 'Planar data load passed',
        statusKind: 'passed',
        summary: probe.reportSummary(report),
        reportText,
        running: false
      })
    }).catch((error) => this.fail(error))
  },

  fail(error) {
    const report = {
      schema: 'terra.miniprogram.planar-load.v1',
      capturedAt: new Date().toISOString(),
      passed: false,
      error: probe.errorMessage(error)
    }
    const reportText = JSON.stringify(report, null, 2)
    getApp().globalData.planarLoadReport = report
    this.setData({
      status: 'Planar data load failed',
      statusKind: 'failed',
      summary: report.error,
      reportText,
      running: false
    })
  },

  copyReport() {
    if (this.data.reportText) {
      wx.setClipboardData({ data: this.data.reportText })
    }
  }
})
