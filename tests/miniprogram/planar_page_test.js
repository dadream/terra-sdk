const assert = require('assert')
const fs = require('fs')
const path = require('path')

let pageDefinition = null
let copiedReport = null
const app = { globalData: {} }

global.Page = (definition) => { pageDefinition = definition }
global.getApp = () => app
global.wx = {
  setClipboardData(options) { copiedReport = options.data }
}

require('../../apps/miniprogram/pages/planar/index')

function createPage() {
  const page = Object.assign({}, pageDefinition)
  page.data = Object.assign({}, pageDefinition.data)
  page.setData = (values) => Object.assign(page.data, values)
  return page
}

function state() {
  return {
    schema: 'terra.miniprogram.planar-runtime.v1',
    frame: {
      patchCount: 4,
      requestCount: 0,
      loadedRecordCount: 1,
      vertexCount: 8580
    },
    terrain: { failedRequestCount: 0 },
    renderer: {
      draws: { submitted: 4, queued: 0 },
      textures: { entries: 1, failed: 0 },
      mode: 'texture'
    },
    contextLost: false,
    error: ''
  }
}

function verifyMarkup() {
  const markup = fs.readFileSync(path.join(__dirname,
    '../../apps/miniprogram/pages/planar/index.wxml'), 'utf8')
  const handlers = ['birdView', 'zoomOut', 'zoomIn', 'tilt45',
    'showTexture', 'showHeight', 'resetCamera', 'copyReport']
  handlers.forEach((handler) => {
    assert(markup.includes(`bindtap="${handler}"`))
  })
  ;['onTouchStart', 'onTouchMove', 'onTouchEnd', 'onTouchCancel']
    .forEach((handler) => assert(markup.includes(handler)))
  assert(markup.indexOf('planar__status') < markup.indexOf('<canvas'))
  assert(markup.indexOf('planar__toolbar') > markup.indexOf('</canvas>'))
}

async function main() {
  assert(pageDefinition)
  verifyMarkup()
  const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname,
    '../../apps/miniprogram/app.json'), 'utf8'))
  assert.strictEqual(appConfig.pages[0], 'pages/planar/index')

  const page = createPage()
  const ready = state()
  page.updateState(ready)
  assert.strictEqual(page.data.status, 'PS 1k terrain ready')
  assert.strictEqual(page.data.statusKind, 'ready')
  assert(page.data.metrics.includes('vertices 8580'))
  assert(page.data.metrics.includes('texture ready'))
  assert.strictEqual(page.data.renderMode, 'texture')
  assert.strictEqual(app.globalData.planarReport, ready)

  const height = state()
  height.renderer.mode = 'height'
  page.updateState(height)
  assert.strictEqual(page.data.renderMode, 'height')

  const commands = []
  const forwarded = []
  let destroyed = false
  let interactionDestroyed = false
  page.unloaded = false
  page.runtime = {
    birdView() { commands.push(['bird']) },
    zoom(value) { commands.push(['zoom', value]) },
    tilt45() { commands.push(['tilt45']) },
    setRenderMode(value) { commands.push(['mode', value]) },
    reset() { commands.push(['reset']) },
    retryFailed() { commands.push(['retry']) },
    destroy() { destroyed = true }
  }
  page.interaction = {
    begin(event) { forwarded.push(['begin', event]) },
    update(event) { forwarded.push(['update', event]) },
    end(event) { forwarded.push(['end', event]) },
    cancel() { forwarded.push(['cancel']) },
    destroy() { interactionDestroyed = true }
  }
  page.birdView()
  page.zoomOut()
  page.zoomIn()
  page.tilt45()
  page.showTexture()
  page.showHeight()
  page.resetCamera()
  page.retryFailed()
  assert.deepStrictEqual(commands, [
    ['bird'], ['zoom', 1.22], ['zoom', 0.82], ['tilt45'],
    ['mode', 'texture'], ['mode', 'height'], ['reset'], ['retry']
  ])
  page.onTouchStart({ touches: [{ identifier: 1, clientX: 1, clientY: 2 }] })
  page.onTouchMove({ touches: [{ identifier: 1, clientX: 3, clientY: 4 }] })
  page.onTouchEnd({ touches: [] })
  page.onTouchCancel()
  assert.deepStrictEqual(forwarded.map((entry) => entry[0]),
    ['begin', 'update', 'end', 'cancel'])

  page.copyReport()
  assert.strictEqual(JSON.parse(copiedReport).schema,
    'terra.miniprogram.planar-runtime.v1')
  const failed = state()
  failed.terrain.failedRequestCount = 1
  page.updateState(failed)
  assert.strictEqual(page.data.statusKind, 'warning')
  assert.strictEqual(page.data.retryVisible, true)

  page.onUnload()
  assert.strictEqual(page.runtime, null)
  assert.strictEqual(destroyed, true)
  assert.strictEqual(interactionDestroyed, true)
  console.log('Mini Program planar page tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
