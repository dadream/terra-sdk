const assert = require('assert')
const runtime = require('../../apps/miniprogram/config/runtime')
const probe = require('../../apps/miniprogram/utils/terra_planar_load_probe')

let pageDefinition = null
let copied = ''
const app = { globalData: {} }

global.Page = (definition) => {
  pageDefinition = definition
}
global.getApp = () => app
global.wx = {
  getStorageSync(key) {
    return key === 'terra.planarServiceOrigin'
      ? 'http://127.0.0.1:18081'
      : ''
  },
  setClipboardData(options) {
    copied = options.data
  }
}

const originalRun = probe.runPlanarLoadProbe
require('../../apps/miniprogram/pages/planar-load/index')

function page() {
  const result = Object.assign({}, pageDefinition)
  result.data = Object.assign({}, pageDefinition.data)
  result.setData = (values) => Object.assign(result.data, values)
  return result
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function testSuccess() {
  probe.runPlanarLoadProbe = () => Promise.resolve({
    schema: 'terra.miniprogram.planar-load.v1',
    passed: true,
    manifest: { statusCode: 200 },
    root: { byteLength: 10967 },
    detail: { byteLength: 9225 }
  })
  const current = page()
  current.runProbe()
  await settle()
  assert.strictEqual(current.data.status, 'Planar data load passed')
  assert.strictEqual(current.data.statusKind, 'passed')
  assert.strictEqual(current.data.running, false)
  assert.strictEqual(app.globalData.planarLoadReport.passed, true)
  current.copyReport()
  assert.strictEqual(JSON.parse(copied).passed, true)
}

async function testFailure() {
  probe.runPlanarLoadProbe = () => Promise.reject(new Error('offline'))
  const current = page()
  current.runProbe()
  await settle()
  assert.strictEqual(current.data.status, 'Planar data load failed')
  assert.strictEqual(current.data.summary, 'offline')
  assert.strictEqual(app.globalData.planarLoadReport.passed, false)
}

async function testMissingOrigin() {
  const configuredOrigin = runtime.planarServiceOrigin
  global.wx.getStorageSync = () => ''
  runtime.planarServiceOrigin = ''
  try {
    const current = page()
    current.runProbe()
    assert.strictEqual(current.data.status, 'Planar data load failed')
    assert.strictEqual(current.data.summary,
      'Planar service origin is not configured')
  } finally {
    runtime.planarServiceOrigin = configuredOrigin
  }
}

async function main() {
  assert(pageDefinition)
  await testSuccess()
  await testFailure()
  await testMissingOrigin()
  probe.runPlanarLoadProbe = originalRun
  delete global.Page
  delete global.getApp
  delete global.wx
  console.log('Mini Program planar load page tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
