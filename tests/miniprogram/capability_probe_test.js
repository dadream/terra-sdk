const assert = require('assert')
const probe = require('../../apps/miniprogram/utils/capability_probe')

const hello = new Uint8Array([104, 101, 108, 108, 111])
assert.strictEqual(probe.fnv1aSample(hello, 1), 0x4f9f2cab)

const summary = probe.reportSummary({
  webgl: { passed: true },
  wasm: { passed: true },
  network: { skipped: true }
})
assert.strictEqual(summary, 'WebGL pass | Wasm pass | Network skipped')

assert.strictEqual(probe.errorMessage(new Error('expected')), 'expected')

global.wx = {
  getDeviceInfo() {
    return { platform: 'devtools', model: 'simulator' }
  },
  getAppBaseInfo() {
    return { SDKVersion: 'test' }
  },
  getWindowInfo() {
    return { pixelRatio: 2, windowWidth: 320, windowHeight: 480 }
  }
}
const modernInfo = probe.collectSystemInfo()
assert.strictEqual(modernInfo.platform, 'devtools')
assert.strictEqual(modernInfo.pixelRatio, 2)

global.wx = {}
const defaultInfo = probe.collectSystemInfo()
assert.strictEqual(defaultInfo.platform, '')
assert.strictEqual(defaultInfo.SDKVersion, '')
assert.strictEqual(defaultInfo.pixelRatio, 1)
delete global.wx

console.log('Mini Program capability probe host tests passed.')
