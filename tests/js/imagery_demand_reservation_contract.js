const assert = require('assert')
const {textureByteSize} = require('../../adapters/webgl/texture_store')
const {TerrainDemand} = require('../../sdk/js/terrain/terrain_demand')

// Both final groups fit, but the full future viewport cannot coexist with
// both old parents. The next group must wait for an actual display receipt.
function verifyRollingReplacement(makeStore) {
  const image = textureByteSize(256, 256), workspace = 1024 * 1024
  const store = makeStore({tileSize:256, maximumBytes:9 * image + workspace,
    sharedMaximumBytes:9 * image + workspace, maximumEntries:100})
  const ledger = store.cache.ledger, gate = new TerrainDemand(), receipts = []
  const asset = () => ({texture:{}, width:256, height:256})
  const groups = [0, 1].map(parent => new Map(Array.from({length:4}, (_, index) => {
    const row = Math.floor(index / 2), column = 2 * parent + index % 2
    return [`2/2/${row}/${column}`, {level:2, matrix:2, row, column}]
  })))
  const quote = () => ({sequence:1, ...store.resourceDemand()})
  const admit = demand => store.reserveDemand(demand)
  try {
    for (let parent = 0; parent < 2; ++parent) {
      const key = `1/1/0/${parent}`
      store.cache.set(key, asset(), image)
      store.protectedKeys.add(key)
      receipts.push(store.cache.retain(key))
      groups[parent].forEach((tile, key) => store.targetDesired.set(key, tile))
    }
    gate.expect('view', 1)
    assert.strictEqual(ledger.canReserve(quote().bytes, [], quote().keep), false,
      'Fixture must exceed the full-view overlap while allowing a local replacement')
    assert.strictEqual(gate.update('view', quote(), admit), false,
      'Whole-view pricing blocked a funded group whose final working set fits')
    assert.strictEqual(store.resourceDemand().bytes, 4 * image,
      'Local admission erased the rest of the final target')
    assert(store.admitGroup(groups[0]))
    for (const [key] of groups[0]) assert(store.groupAdmission.take(key).commit(asset()))
    store.cache.delete('1/1/0/0')
    assert.strictEqual(gate.update('view', quote(), admit), true,
      'Retiring an old image refunded bytes before its display receipt')
    assert.strictEqual(gate.reason, 'capacity')
    assert.strictEqual(ledger.bytes, 6 * image + workspace)
    receipts[0]()
    assert.strictEqual(gate.update('view', quote(), admit), false,
      'An actual retirement failed to fund the next complete group')
    assert(store.admitGroup(groups[1]), JSON.stringify(store.groupAdmission.refusal))
    for (const [key] of groups[1]) assert(store.groupAdmission.take(key).commit(asset()))
    assert.strictEqual(ledger.bytes, ledger.maximumBytes)
    store.cache.delete('1/1/0/1'); receipts[1]()
    assert.strictEqual(gate.update('view', quote(), admit), false)
    assert.strictEqual(store.resourceDemand().targetBytes, 0)
    assert.strictEqual(store.cache.entries.size, 8)
    assert.strictEqual(ledger.bytes, 8 * image + workspace)
    assert(ledger.highWaterBytes <= ledger.maximumBytes, 'Rolling replacement exceeded the shared limit')
  } finally {
    receipts.forEach(release => release())
    store.destroy()
    assert.strictEqual(ledger.bytes, 0)
  }
}

// A terrain feasibility check must not leave the image group's continuation
// space available to another producer before that group starts its request.
module.exports = function verifyDemandReservation(makeStore) {
  verifyRollingReplacement(makeStore)
  const image = textureByteSize(256, 256), workspace = 1024 * 1024
  const required = 4 * image + workspace, room = 100
  const store = makeStore({tileSize: 256, maximumBytes: required,
    maximumShareBytes: required + 2 * image, sharedMaximumBytes: required + room,
    maximumEntries: 100, prefetchAncestors: false})
  const ledger = store.cache.ledger
  const children = new Map(Array.from({length: 4}, (_, index) => {
    const column = index % 2, row = Math.floor(index / 2)
    const tile = {level: 2, matrix: 2, row, column}
    return [`2/2/${row}/${column}`, tile]
  }))
  let competing, active
  try {
    children.forEach((tile, id) => store.targetDesired.set(id, tile))
    assert(store.resourceShare.grow(image)); store.applyShareLimit()
    const quote = store.resourceDemand()
    assert.strictEqual(quote.requiredBytes, required)
    competing = ledger.reserve('competing-terrain', room + 1)
    assert(competing)
    assert.strictEqual(store.reserveDemand(quote), false, 'One-byte-short demand was partially admitted')
    assert.strictEqual(store.demandCredit.bytes, 0)
    assert.strictEqual(store.resourceShare.workspace.availableBytes, image, 'Refusal spent its share offer')
    competing.release(); competing = null
    assert(store.reserveDemand(store.resourceDemand()))
    assert.strictEqual(ledger.bytes, required, 'The share was counted twice during demand funding')
    assert.strictEqual(store.resourceShare.workspace.availableBytes, 0)
    assert.strictEqual(store.resourceDemand().bytes, 0)
    const grants = store.demandGrants
    assert(store.reserveDemand(store.resourceDemand()))
    assert.strictEqual(store.demandGrants, grants, 'Unchanged pricing reserved the same destinations again')
    store.withdrawShare(true)
    assert.strictEqual(ledger.bytes, required, 'Revoking optional share spent the admitted plan')
    competing = ledger.reserve('competing-terrain', room)
    assert(competing)
    assert.strictEqual(ledger.reserve('unfunded-terrain', 1), null,
      'Terrain consumed space promised to the current image plan')
    assert(store.admitGroup(children), 'The promised group could not consume its own credit')
    assert.strictEqual(ledger.bytes, required + room, 'Production allocated the same forecast twice')
    assert.strictEqual(store.demandCredit.bytes, 0)
    assert.strictEqual(store.pipelineBytes(), workspace)
    assert.strictEqual(store.cache.reservations.size, 4)
    active = store.groupAdmission.take(children.keys().next().value)
    store.releaseDemand()
    store.clear()
    assert.strictEqual(ledger.bytes, image + room,
      'Source replacement refunded an active producer before its receipt')
    active.cancel(); active = null
    assert.strictEqual(ledger.bytes, room)
    competing.release(); competing = null

    // An unstarted old-view forecast is reversible; source failure removes
    // only that destination, and remaining targets can still be funded.
    children.forEach((tile, id) => store.targetDesired.set(id, tile))
    assert(store.reserveDemand(store.resourceDemand()))
    store.failed.set(children.keys().next().value, {})
    assert(store.reserveDemand(store.resourceDemand()))
    assert.strictEqual(store.demandCredit.bytes, required - image)
    store.setPaused(true)
    assert.strictEqual(ledger.bytes, 0, 'Pause retained unstarted forecast credit')
  } finally {
    if (active) active.cancel()
    if (competing) competing.release()
    store.destroy()
    assert.strictEqual(ledger.bytes, 0)
  }

  // Root coverage is allowed to use the same production lane before the
  // final leaves. Keep that root until all four replacement outputs fit.
  const coverage = makeStore({tileSize: 256, maximumBytes: required + image,
    sharedMaximumBytes: required + image, maximumEntries: 100, prefetchAncestors: false})
  try {
    children.forEach((tile, id) => coverage.targetDesired.set(id, tile))
    assert(coverage.reserveDemand(coverage.resourceDemand()))
    const root = new Map([['0/0/0/0', {level: 0, matrix: 0, row: 0, column: 0}]])
    assert(coverage.admitGroup(root), 'Final-target credit prevented coarse coverage from starting')
    const pending = coverage.groupAdmission.take('0/0/0/0')
    assert(pending.commit({texture: {}, width: 256, height: 256}))
    coverage.protectedKeys.add('0/0/0/0')
    assert(coverage.admitGroup(children), 'Coarse coverage stranded its complete finer replacement')
    assert(coverage.cache.entries.has('0/0/0/0'), 'Replacement evicted displayed root before its receipt')
    assert.strictEqual(coverage.cache.ledger.bytes, required + image)
    const child = coverage.groupAdmission.take(children.keys().next().value)
    assert(child.commit({texture: {}, width: 256, height: 256}))
    assert.strictEqual(coverage.cache.ledger.reserve('terrain-after-upload', 1), null,
      'Completing an image refunded its promised residency to unrelated terrain')
    coverage.releaseDemand()
    const reclaimed = coverage.cache.ledger.reserve('new-view', 1)
    assert(reclaimed, 'An obsolete demand kept the previous target cache pinned')
    reclaimed.release()
  } finally {
    coverage.destroy()
    assert.strictEqual(coverage.cache.ledger.bytes, 0)
  }
}
