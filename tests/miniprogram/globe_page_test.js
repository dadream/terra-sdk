const assert = require('assert')
const fs = require('fs')
const path = require('path')

let pageDefinition = null
let copiedReport = null
const app = { globalData: {} }

global.Page = (definition) => {
  pageDefinition = definition
}
global.getApp = () => app
global.wx = {
  getWindowInfo() {
    return { windowWidth: 390, windowHeight: 844, pixelRatio: 3, statusBarHeight: 44 }
  },
  setClipboardData(options) {
    copiedReport = options.data
  }
}

require('../../apps/miniprogram/pages/globe/index')

function createPage() {
  const page = Object.assign({}, pageDefinition)
  page.data = Object.assign({}, pageDefinition.data)
  page.setDataCalls = 0
  page.setData = (values) => {
    page.setDataCalls += 1
    Object.assign(page.data, values)
  }
  return page
}

function state() {
  return {
    schema: 'terra.miniprogram.globe-runtime.v1',
    frame: {
      patchCount: 2,
      requestCount: 1,
      loadedRecordCount: 1
    },
    terrain: { failedRequestCount: 0 },
    renderer: {
      draws: { submitted: 1, queued: 0 },
      textures: {
        failed: 0,
        state: 'settled',
        cachedRoots: 2,
        rootDesired: 2,
        cachedTarget: 8,
        targetDesired: 8
      }
    },
    budget: { devicePixelRatio: 1.5 },
    camera: {
      longitudeDegrees: 116.4074,
      latitudeDegrees: 39.9042,
      tiltRadians: -Math.PI / 4,
      yawRadians: Math.PI / 6
    },
    imageryId: 'tianditu-img-c',
    contextLost: false,
    error: ''
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function verifySeparatedControlsMarkup() {
  const markup = fs.readFileSync(path.join(__dirname,
    '../../apps/miniprogram/pages/globe/index.wxml'), 'utf8')
  const canvasStart = markup.indexOf('<canvas ')
  const status = markup.indexOf('<view class="globe__status ')
  const toolbar = markup.indexOf('<view class="globe__toolbar">')
  const attribution = markup.indexOf('class="globe__attribution"')
  const canvasEnd = markup.indexOf('</canvas>')
  assert(status >= 0 && status < canvasStart && canvasEnd > canvasStart)
  assert(toolbar > canvasEnd && attribution > canvasEnd)
  assert(!markup.includes('<cover-view'))
  ;['selectMove', 'selectLook', 'focusBeijing', 'topDown', 'zoomOut',
    'zoomIn', 'tilt45', 'northUp', 'resetCamera', 'copyReport']
    .forEach((handler) => {
      assert(markup.includes(`bindtap="${handler}"`))
    })
}

async function main() {
  assert(pageDefinition)
  verifySeparatedControlsMarkup()
  const page = createPage()
  page.onLoad()
  assert.strictEqual(page.data.statusHeight, 132)
  page.setDataCalls = 0
  assert.strictEqual(page.data.statusPaddingTop, 52)
  const initial = state()
  page.updateState(initial)
  assert.strictEqual(page.setDataCalls, 1)
  assert.strictEqual(page.data.status, 'Globe 1 records 1 draws')
  assert.strictEqual(page.data.statusKind, 'ready')
  assert.strictEqual(page.data.reportReady, true)
  assert.strictEqual(app.globalData.globeReport, initial)

  const progress = state()
  progress.frame.patchCount = 3
  page.updateState(progress)
  assert.strictEqual(page.setDataCalls, 1)
  await wait(270)
  assert.strictEqual(page.setDataCalls, 2)
  assert.strictEqual(page.data.metrics.indexOf('patches 3') >= 0, true)
  assert.strictEqual(page.data.metrics.indexOf(
    'imagery tianditu-img-c settled') >= 0, true)
  assert.strictEqual(page.data.metrics.indexOf('roots 2/2') >= 0, true)
  assert.strictEqual(page.data.metrics.indexOf('tiles 8/8') >= 0, true)
  assert.strictEqual(page.data.metrics.indexOf(
    'target 116.41, 39.90') >= 0, true)
  assert.strictEqual(page.data.metrics.indexOf('pitch -45') >= 0, true)

  const failed = state()
  failed.terrain.failedRequestCount = 1
  page.updateState(failed)
  assert.strictEqual(page.data.retryVisible, true)
  assert.strictEqual(page.data.statusKind, 'warning')
  assert.strictEqual(page.data.status, 'Globe 1 resource requests failed')

  page.copyReport()
  assert.strictEqual(JSON.parse(copiedReport).schema,
    'terra.miniprogram.globe-runtime.v1')

  page.updateState(progress)
  page.fail(new Error('fatal'))
  const callsAfterFailure = page.setDataCalls
  await wait(270)
  assert.strictEqual(page.setDataCalls, callsAfterFailure)
  assert.strictEqual(page.data.status, 'fatal')

  const forwarded = []
  const commands = []
  let destroyed = false
  let interactionDestroyed = false
  page.unloaded = false
  page.runtime = {
    zoom(scale) {
      commands.push(['zoom', scale])
    },
    tilt45() {
      commands.push(['tilt45'])
    },
    focusInitialTarget() {
      commands.push(['focus'])
    },
    topDown() {
      commands.push(['top'])
    },
    northUp() {
      commands.push(['north'])
    },
    reset() {
      commands.push(['reset'])
    },
    retryFailed() {
      commands.push(['retry'])
    },
    destroy() {
      destroyed = true
    }
  }
  page.interaction = {
    begin(event) { forwarded.push(['begin', event]) },
    update(event) { forwarded.push(['update', event]) },
    end(event) { forwarded.push(['end', event]) },
    cancel() { forwarded.push(['cancel']) },
    setOptions(options) { forwarded.push(['options', options]) },
    destroy() { interactionDestroyed = true }
  }
  page.zoomIn()
  page.zoomOut()
  page.tilt45()
  page.focusBeijing()
  page.topDown()
  page.northUp()
  page.resetCamera()
  page.retryFailed()
  assert.deepStrictEqual(commands, [
    ['zoom', 0.82], ['zoom', 1.22], ['tilt45'], ['focus'], ['top'],
    ['north'], ['reset'], ['retry']
  ])
  const startEvent = { touches: [{ identifier: 1, clientX: 10, clientY: 10 }] }
  const moveEvent = { touches: [{ identifier: 1, clientX: 30, clientY: 5 }] }
  page.onTouchStart(startEvent)
  page.onTouchMove(moveEvent)
  page.onTouchEnd({ touches: [] })
  page.onTouchCancel()
  assert.strictEqual(forwarded[0][0], 'begin')
  assert.strictEqual(forwarded[1][0], 'update')
  assert.strictEqual(forwarded[2][0], 'end')
  assert.strictEqual(forwarded[3][0], 'cancel')

  page.selectLook()
  assert.strictEqual(page.data.gestureMode, 'look')
  assert.deepStrictEqual(forwarded[4], ['options', { mode: 'look' }])

  const callsBeforeUnload = page.setDataCalls
  page.onUnload()
  assert.strictEqual(page.runtime, null)
  assert.strictEqual(destroyed, true)
  assert.strictEqual(interactionDestroyed, true)
  page.updateState(state())
  assert.strictEqual(page.setDataCalls, callsBeforeUnload)
  console.log('Mini Program globe page tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
