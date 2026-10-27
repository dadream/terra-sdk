const assert = require('assert')
const {EncodedTextureStore} = require('../../adapters/browser/encoded_texture_store')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {textureByteSize} = require('../../adapters/webgl/texture_store')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function verifyCase(maximumBytes, expectedBodies) {
  const headers = [], readers = [], cancelled = new Set()
  const nativeSetTimeout = global.setTimeout, nativeClearTimeout = global.clearTimeout, timers = new Set()
  global.setTimeout = (callback, milliseconds, ...args) => {
    let handle
    handle = nativeSetTimeout(() => { timers.delete(handle); callback(...args) }, milliseconds)
    if (milliseconds > 10000 && milliseconds <= 15000) timers.add(handle)
    return handle
  }
  global.clearTimeout = handle => { timers.delete(handle); nativeClearTimeout(handle) }
  const renderer = {canvas: {ownerDocument: {}}, gl: {deleteTexture() {}}, presentedTextures: new Map(),
    resourceLedger: new ResourceLedger(maximumBytes), requestResources() {}, requestRender() {},
    options: {managedResources: true, textureDescriptor: {tile_size: 16},
      fetchTextures: (url, {signal}) => new Promise(resolve => {
        const id = headers.length
        headers.push(() => resolve({ok: true, headers: {get: () => 'image/png'}, body: {
          cancel: async () => {cancelled.add(id)},
          getReader: () => ({read: () => signal.aborted ? Promise.resolve({done: true}) :
            new Promise(done => {readers.push(() => done({done: true}))}),
          cancel: async () => {cancelled.add(id)}, releaseLock() {}})
        }}))
      })}}
  const store = new EncodedTextureStore(renderer, {urlForTile: () => 'https://test.invalid/image',
    maximumBytes, maximumEntries: 32, maximumConcurrent: 3,
    maximumRetries: 0, prefetchAncestors: false, directTargets: true})
  try {
    store.sync(Array.from({length: 3}, (_, column) => ({texture: {level: 3, matrix: 3, row: 0, column}})), [])
    await tick(); await tick()
    assert.strictEqual(headers.length, 3, 'Header latency monopolized body credit and blocked the third network slot')
    assert.strictEqual(timers.size, 3)
    assert.strictEqual(store.inputBytes, 0)
    assert.strictEqual(store.pipelineBytes(), store.minimumWorkspaceBytes(), 'Headers have no funded serial continuation')
    assert.strictEqual(store.cache.reservedBytes, 3 * textureByteSize(16,16))
    if (expectedBodies === 3) store.setMaximumConcurrent(1)
    headers.forEach(resolve => resolve())
    await tick(); await tick()
    if (expectedBodies === 3) {
      assert.strictEqual(readers.length, 2)
      store.setMaximumConcurrent(3)
      await tick(); await tick()
      // No read has finished and no capacity was refunded. The new local
      // window itself must wake an affordable body waiting in the queue.
    }
    assert.strictEqual(readers.length, expectedBodies, 'Body concurrency did not follow actual available credit')
    assert.strictEqual(store.inputBytes, expectedBodies * store.inputEnvelopeBytes)
    assert.strictEqual(store.stats().waitingBodies, 3 - expectedBodies)
    assert.strictEqual(timers.size, expectedBodies, 'Local body backpressure was still charged to a network timeout')
    const ownedInputs = store.inputBytes
    const ownedTotal = renderer.resourceLedger.bytes
    store.setMaximumConcurrent(1)
    assert.strictEqual(store.inputBytes, ownedInputs, 'Concurrency reduction refunded live readers')
    assert.strictEqual(renderer.resourceLedger.bytes, ownedTotal)
    store.setSource(() => 'https://replacement.invalid/image', [])
    await tick(); await tick()
    assert.strictEqual(store.stats().waitingBodies, 0)
    assert.strictEqual(timers.size, 0)
    assert.strictEqual(cancelled.size, 3 - expectedBodies, 'A waiting response body was left open')
    assert.strictEqual(store.inputBytes, ownedInputs, 'Source change refunded a reader before its acknowledgement')
    assert.strictEqual(renderer.resourceLedger.bytes, ownedInputs + expectedBodies * textureByteSize(16,16))
    readers.forEach(resolve => resolve())
    await tick(); await tick()
    assert.strictEqual(store.inputBytes, 0)
    assert.strictEqual(renderer.resourceLedger.bytes, 0)
    assert.strictEqual(cancelled.size, 3)
  } finally {
    try {
      store.destroy()
      headers.forEach(resolve => resolve())
      readers.forEach(resolve => resolve())
      await tick(); await tick()
      assert.strictEqual(renderer.resourceLedger.bytes, 0)
      assert.strictEqual(timers.size, 0)
    } finally { global.setTimeout = nativeSetTimeout; global.clearTimeout = nativeClearTimeout }
  }
}
async function verify() {
  await verifyCase(300000, 2) // Global credit, rather than an arbitrary input pair, limits reading.
  await verifyCase(500000, 3)
  console.log('Configured body concurrency, shared-credit backpressure and cancellation receipts passed')
}
module.exports = verify
if (require.main === module) verify().catch(error => {console.error(error); process.exitCode = 1})
