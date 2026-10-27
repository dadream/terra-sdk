const assert = require('assert')
const {textureByteSize} = require('../../adapters/webgl/texture_store')

// A plan can outlive the free capacity which originally funded its growth.
// Reproduce the idle complete-group refusal without a browser or network.
module.exports = function verifySharePressure(makeStore) {
  const image = textureByteSize(256, 256), workspace = 1024 * 1024
  const preferred = workspace + 8 * image, maximum = preferred + 4 * image
  const store = makeStore({tileSize: 256, maximumBytes: preferred, maximumShareBytes: maximum,
    sharedMaximumBytes: maximum + 4 * image, maximumEntries: 100, prefetchAncestors: true})
  const r = store.renderer, ledger = r.resourceLedger, share = store.resourceShare
  let competing, replans = 0
  r.cameraVersion = r.plannedCameraVersion = 1
  r.options.onImageryPlanningChange = () => ++replans
  try {
    assert.strictEqual(store.minimumWorkspaceBytes(), workspace)
    assert(share.grow(4 * image)); store.applyShareLimit()
    const resident = Array.from({length: 12}, (_, column) => ({level: 4, matrix: 4, row: 0, column}))
    for (const tile of resident) {
      const id = `4/4/0/${tile.column}`
      const pending = store.fundShare(funding => store.cache.reserve(id, image, funding))
      assert(pending && pending.commit({texture: {}, width: 256, height: 256}))
      store.protectedKeys.add(id); store.availableKeys.add(id); r.presentedTextures.set(id, tile)
    }
    assert.strictEqual(share.stats().unusedBytes, 0)
    const group = new Map(Array.from({length: 4}, (_, column) => {
      const tile = {level: 5, matrix: 5, row: 0, column}
      return [`5/5/0/${column}`, tile]
    }))
    group.forEach((tile, id) => { store.desired.set(id, tile); store.targetDesired.set(id, tile) })
    const capacity = store.targetCapacity()
    r.current = {imageryPlan: {quality: {planningComplete: true, cameraCurrent: true,
      maximumTextureCount: capacity, limitedByTextureBudget: false}}}
    competing = ledger.reserve('competing-display', ledger.maximumBytes - ledger.bytes - 4 * image - workspace + 1)
    assert(competing)
    const owned = ledger.bytes
    const refuse = () => {
      assert.strictEqual(store.admitGroup(group), false)
      group.forEach((_, id) => store.requestBlocked(id))
    }
    refuse()
    assert.strictEqual(store.groupAdmission.refusal.shortfallBytes, 1,
      'The complete image/workspace shortage was not priced after victim selection')
    r.pendingSubmission = {}
    assert.strictEqual(store.resolveCapacityPressure(), false, 'Unacknowledged display caused capacity regression')
    r.pendingSubmission = null
    ledger.reclamation.pending = Promise.resolve()
    assert.strictEqual(store.resolveCapacityPressure(), false, 'Unacknowledged reclaim caused capacity regression')
    ledger.reclamation.pending = null
    r.cameraVersion = 2
    assert.strictEqual(store.resolveCapacityPressure(), false, 'An obsolete view constrained current planning')
    r.cameraVersion = 1
    r.refineImageryCamera = 1
    r.current.imageryPlan.quality.refinableMeasurementCount = 2
    assert.strictEqual(store.resolveCapacityPressure(), false,
      'A pending cost verification retracted imagery precision before its measurement completed')
    assert.strictEqual(share.bytes, maximum)
    r.current.imageryPlan.quality.refinableMeasurementCount = 0
    assert(store.resolveCapacityPressure(), 'Idle shared-capacity refusal left the expanded plan permanently stranded')
    assert.strictEqual(store.targetCapacity(), capacity - 1, 'A one-byte shortage revoked all growth')
    assert.strictEqual(replans, 1)
    assert.strictEqual(ledger.bytes, owned, 'Planning retraction refunded live displayed assets')
    assert.strictEqual(store.cache.entries.size, resident.length)
    assert.strictEqual(store.cache.reservations.size, 0)
    assert.strictEqual(store.inputJobs, 0)
    assert.strictEqual(share.grow(image), false, 'The constrained plan immediately regrew its refused allowance')
    for (let i = 0; i < 20; ++i) assert.strictEqual(store.resolveCapacityPressure(), false)
    assert.strictEqual(replans, 1, 'Unchanged pressure repeatedly replanned the same cut')

    // A receipt, not elapsed time, permits the retained group to make progress.
    competing.release(); competing = null
    r.presentedTextures.delete('4/4/0/0'); store.protectedKeys.delete('4/4/0/0')
    assert(store.admitGroup(group))
    assert.strictEqual(store.cache.reservations.size, 4)
  } finally {
    store.destroy()
    if (competing) competing.release()
    assert.strictEqual(ledger.bytes, 0)
    assert.strictEqual(ledger.leases.size, 0)
  }
}
