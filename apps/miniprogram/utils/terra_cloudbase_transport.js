const common = require('./terra_globe_common')

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
    common.invariant(typeof wx !== 'undefined' && wx.cloud &&
      typeof wx.cloud.callContainer === 'function',
    'wx.cloud.callContainer is unavailable')
    let settled = false
    let rejectRequest = null
    const promise = new Promise((resolve, reject) => {
      rejectRequest = reject
      wx.cloud.callContainer({
        config: { env: config.envId },
        path: requestPath(requestOptions.url),
        method: requestOptions.method || 'GET',
        header: Object.assign({}, requestOptions.header, {
          'X-WX-SERVICE': config.serviceName
        }),
        responseType: requestOptions.responseType,
        timeout: requestOptions.timeout || 15000
      }).then((response) => {
        if (!settled) {
          settled = true
          resolve({
            statusCode: response.statusCode,
            header: response.header || {},
            data: response.data
          })
        }
      }).catch((error) => {
        if (!settled) {
          settled = true
          reject(new Error(error && error.errMsg
            ? error.errMsg
            : 'CloudBase terrain request failed'))
        }
      })
    })
    return {
      promise,
      abort() {
        if (!settled) {
          settled = true
          rejectRequest(new Error('Terrain request was cancelled'))
        }
      }
    }
  }
}

module.exports = {
  createCloudbaseRequest,
  requestPath
}
