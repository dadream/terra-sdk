const assert = require('assert')

module.exports = function verifyCapacityBeforeMapping(makeStore, gpu) {
  const envelope = makeStore().minimumWorkspaceBytes()
  const store = makeStore({maximumBytes: envelope + gpu, maximumEntries: 128, sharedMaximumBytes: 400000})
  const ledger = store.renderer.resourceLedger
  const tile = {level: 1, matrix: 1, row: 0, column: 0}, id = '1/1/0/0'
  const children = new Map([[id, tile]])
  let prices = 0
  store.renderer.partitionGroups = {refresh() {},imageryRunnable:()=>true,
    prepareImagery() { ++prices; return 'waiting' }}
  try {
    store.desired.set(id, tile); store.requestGroups.set(id, children)
    const count = Math.floor((store.requestedMaximumBytes + store.replacementHeadroomBytes() - envelope) / gpu)
    assert(count > 0)
    for (let i = 0; i < count; ++i) {
      const key = 'display:' + i
      store.protectedKeys.add(key)
      store.cache.set(key, {texture: {}, width: 16, height: 16}, gpu)
    }
    const before = ledger.stats(), cache = store.cache.stats(), limit = store.cache.maximumBytes
    for (let i = 0; i < 3; ++i) assert.strictEqual(store.reserveRequest(id), null)
    assert.strictEqual(prices, 0, 'An image group that cannot fit rebuilt its terrain mapping')
    assert.deepStrictEqual(ledger.stats(), before, 'A capacity check changed owned credit')
    assert.deepStrictEqual(store.cache.stats(), cache, 'A capacity check evicted or reserved images')
    assert.strictEqual(store.cache.maximumBytes, limit, 'A temporary replacement peak changed the cache policy')
    assert.strictEqual(store.workspace, null, 'A rejected image group created production state')

    store.cache.delete('display:0')
    assert.strictEqual(store.reserveRequest(id), null)
    assert.strictEqual(prices, 1, 'Real image capacity did not resume complete mapping preparation')
    assert.strictEqual(store.cache.reservations.size, 0, 'A lower-bound fit bypassed complete output admission')
    assert(store.admitGroup(children), 'The image-only fit disagreed with real image/workspace admission')
    assert.strictEqual(store.cache.reservations.size, 1)
  } finally { store.destroy() }
  assert.strictEqual(ledger.bytes, 0)
}
