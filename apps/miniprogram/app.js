const runtimeConfig = require('./config/runtime')

App({
  onLaunch() {
    if (runtimeConfig.cloudbaseEnvId &&
      typeof wx !== 'undefined' && wx.cloud &&
      typeof wx.cloud.init === 'function') {
      wx.cloud.init({
        env: runtimeConfig.cloudbaseEnvId,
        traceUser: true
      })
    }
  },

  globalData: {
    capabilityReport: null,
    globeReport: null,
    planarReport: null,
    planarLoadReport: null
  }
})
