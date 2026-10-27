const {responseLimit, binaryResponseBytes} = require('../../sdk/js/transport/response_limits')

// WX owns its receive buffer. Reject oversized binary results before SDK copies;
// the promise remains pending through abort until the native callback confirms
// producer exit. TerrainTransport independently cancels individual consumers.
function requestWithWx(options) {
  responseLimit(options.maximumResponseBytes)
  if (typeof wx === 'undefined' || typeof wx.request !== 'function') throw new Error('wx.request is unavailable')
  let request = null, cancelled = false, settled = false
  const cancellation = () => Object.assign(new Error('Terrain request was cancelled'), {name: 'AbortError'})
  const promise = new Promise((resolve, reject) => {
    request = wx.request({url: options.url, method: options.method || 'GET',
      responseType: options.responseType, timeout: options.timeout || 15000,
      success(response) {
        settled = true
        if (cancelled) { reject(cancellation()); return }
        try {
          if (options.responseType === 'arraybuffer') binaryResponseBytes(response.data, options.maximumResponseBytes)
          resolve(response)
        } catch (error) { reject(error) }
      },
      fail(error) {
        settled = true
        reject(cancelled ? cancellation() : new Error(error && error.errMsg ? error.errMsg : 'wx.request failed'))
      }
    })
  })
  return {promise, abort() {
    if (!settled && !cancelled) {
      cancelled = true
      if (request && typeof request.abort === 'function') request.abort()
    }
  }}
}

module.exports = {requestWithWx}
