const assert = require('assert')

const transport = require(
  '../../apps/miniprogram/utils/terra_cloudbase_transport')
const runtimeConfig = require('../../apps/miniprogram/config/runtime')

async function main() {
  assert.strictEqual(runtimeConfig.cloudbasePlanarTerrainService,
    'terra-terrain-1k')
  assert.strictEqual(runtimeConfig.cloudbaseGlobeTerrainService,
    'terra-terrain-globe')
  assert.strictEqual(runtimeConfig.imageryProfile, 'tianditu-img-c')
  assert.match(runtimeConfig.tiandituProxyOrigin,
    /^https:\/\/[^/?#]+$/)
  assert.ok(!/tianditu\.gov\.cn/.test(runtimeConfig.tiandituProxyOrigin))
  assert.ok(!Object.prototype.hasOwnProperty.call(
    runtimeConfig, 'tiandituToken'))

  assert.strictEqual(transport.requestPath(
    'https://cloudbase.invalid/terra/v1/test?level=1'),
  '/terra/v1/test?level=1')
  assert.strictEqual(transport.requestPath('/healthz'), '/healthz')

  let captured = null
  global.wx = {
    cloud: {
      callContainer(options) {
        captured = options
        return Promise.resolve({
          statusCode: 200,
          header: { 'content-type': 'application/octet-stream' },
          data: new ArrayBuffer(4)
        })
      }
    }
  }
  const request = transport.createCloudbaseRequest({
    envId: 'test-env',
    serviceName: 'terra-terrain-globe'
  })
  const task = request({
    url: 'https://cloudbase.invalid/terra/v1/datasets/globe/manifest',
    responseType: 'arraybuffer'
  })
  const response = await task.promise
  assert.strictEqual(response.statusCode, 200)
  assert.strictEqual(response.data.byteLength, 4)
  assert.strictEqual(captured.config.env, 'test-env')
  assert.strictEqual(captured.header['X-WX-SERVICE'],
    'terra-terrain-globe')
  assert.strictEqual(captured.path,
    '/terra/v1/datasets/globe/manifest')
  assert.strictEqual(captured.responseType, 'arraybuffer')

  let rejectCall = null
  global.wx.cloud.callContainer = () => new Promise((resolve, reject) => {
    rejectCall = reject
  })
  const cancelled = request({ url: '/terra/v1/cancel' })
  cancelled.abort()
  await assert.rejects(cancelled.promise, /cancelled/)
  rejectCall(new Error('late failure'))

  delete global.wx
  console.log('Mini Program CloudBase transport tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
