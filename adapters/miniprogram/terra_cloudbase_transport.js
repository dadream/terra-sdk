const common = require('../../sdk/js/core/terra_globe_common')
const {responseLimit, binaryResponseBytes} = require('../../sdk/js/transport/response_limits')

function requestPath(url) {
  common.invariant(typeof url === 'string' && url.length > 0,
    'CloudBase request URL is required')
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(url)
  const value = match ? (match[1] || '/') : url
  common.invariant(value[0] === '/', 'CloudBase request path must be absolute')
  return value
}

function createCloudbaseRequest(options) {
  const config = options || {}
  common.invariant(typeof config.envId === 'string' && config.envId.length > 0,
    'CloudBase environment ID is required')
  common.invariant(typeof config.serviceName === 'string' &&
    /^[a-z][a-z0-9-]{0,62}$/.test(config.serviceName),
  'CloudBase service name is invalid')

  return function cloudbaseRequest(requestOptions) {
    responseLimit(requestOptions.maximumResponseBytes)
    common.invariant(typeof wx !== 'undefined' && wx.cloud &&
      typeof wx.cloud.callContainer === 'function',
    'wx.cloud.callContainer is unavailable')
    let settled = false
    let cancelled = false
    const promise = Promise.resolve().then(() => {
      if (cancelled) throw new Error('Terrain request was cancelled')
      return wx.cloud.callContainer({
        config: { env: config.envId },
        path: requestPath(requestOptions.url),
        method: requestOptions.method || 'GET',
        header: Object.assign({}, requestOptions.header, {
          'X-WX-SERVICE': config.serviceName
        }),
        responseType: requestOptions.responseType,
        timeout: requestOptions.timeout || 15000
      })
    }).then((response) => {
      if (cancelled) throw new Error('Terrain request was cancelled')
      if (requestOptions.responseType === 'arraybuffer') binaryResponseBytes(response.data, requestOptions.maximumResponseBytes)
      return {statusCode: response.statusCode, header: response.header || {}, data: response.data}
    }).catch((error) => {
      if (cancelled) throw new Error('Terrain request was cancelled')
      if (error && error.code) throw error
      throw new Error(error && (error.errMsg || error.message) || 'CloudBase terrain request failed')
    }).finally(() => { settled = true })
    return {
      promise,
      abort() {
        if (!settled) {
          // callContainer exposes no abort handle here. Keep its producer and
          // concurrency ownership until the actual native promise completes.
          cancelled = true
        }
      }
    }
  }
}

module.exports = {
  createCloudbaseRequest,
  requestPath
}
