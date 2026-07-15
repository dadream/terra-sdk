const assert = require('assert')

let pageDefinition = null
let copiedReport = null
const app = { globalData: {} }

global.Page = (definition) => {
  pageDefinition = definition
}
global.getApp = () => app
global.wx = {
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
      textures: { failed: 0 }
    },
    budget: { devicePixelRatio: 1.5 },
    contextLost: false,
    error: ''
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function main() {
  assert(pageDefinition)
  const page = createPage()
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

  const gestures = []
  let destroyed = false
  page.unloaded = false
  page.runtime = {
    applyCamera(change) {
      gestures.push(change)
    },
    destroy() {
      destroyed = true
    }
  }
  page.onTouchStart({ touches: [{ clientX: 10, clientY: 10 }] })
  page.onTouchMove({ touches: [{ clientX: 30, clientY: 5 }] })
  await wait(20)
  assert.strictEqual(gestures.length, 1)
  assert(gestures[0].yawDelta < 0)
  assert(gestures[0].tiltDelta > 0)

  const callsBeforeUnload = page.setDataCalls
  page.onUnload()
  assert.strictEqual(page.runtime, null)
  assert.strictEqual(destroyed, true)
  page.updateState(state())
  assert.strictEqual(page.setDataCalls, callsBeforeUnload)
  console.log('Mini Program globe page tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
