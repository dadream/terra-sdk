const assert = require('assert')
const {textureKeyString:key} = require('../../sdk/js/core/terra_globe_common')

// Exercise the real encoded producer/frontier, with network dispatch paused.
// A dependency wait may suppress request ranking, never coverage/protection.
module.exports = function verifySelection(makeStore) {
  const store = makeStore({maximumBytes:16*1024*1024, maximumEntries:1024, maximumConcurrent:8,
    prefetchAncestors:true})
  store.scheduler.paused = true
  // Isolate ranking of final sibling requests; sparse cold coverage is
  // exercised separately by sparse_coverage_ladder_contract.
  store.pyramid.coverageLevelStep=Infinity
  const root = {level:0, matrix:1, row:0, column:0}
  const leaves = Array.from({length:384}, (_, i) => ({level:8, matrix:9,
    row:Math.floor((i%4)/2), column:2*Math.floor(i/4)+(i%2)}))
  const ids = leaves.map(key)
  try {
    // Both physical roots are ready; all future image groups wait for UV data.
    for (const column of [0,1]) store.cache.set(key({...root,column}),
      {texture:{},width:16,height:16}, store.requestBytes())
    store.buildRequirementTree(leaves.map((texture,i) => ({texture,imageryPixelError:i+1})))
    store.recomputeAvailability(); store.refreshProtection()
    assert(store.resourceGroups().every(([,children]) => children.size === 4), 'Expected real sibling groups')
    for (const id of ids) store.preparationWaiting.add(id)
    const protectedKeys = Array.from(store.protectedKeys).sort()
    const priority = store.refinementPriority, reads = []
    store.refinementPriority = function(tile) {reads.push(key(tile)); return priority.call(this,tile)}
    for (let receipt=0; receipt<16; ++receipt) store.scheduleFrontier()
    assert.strictEqual(reads.length,0,'Dependency waits repeated request-priority ancestor walks')
    assert.strictEqual(store.scheduler.queued.size,0)
    assert(ids.every(id => store.frontierKeys.has(id)), 'Waiting targets left the frontier')
    assert.deepStrictEqual(Array.from(store.protectedKeys).sort(),protectedKeys)

    // Three runnable siblings compete; the fourth still needs input capacity.
    const siblings = ids.slice(0,4)
    siblings.forEach(id => store.preparationWaiting.delete(id))
    store.inputBlocked.add(siblings[3])
    store.scheduleFrontier()
    assert.deepStrictEqual(reads.slice().sort(),siblings.slice(0,3).sort(),
      'A sort remeasured candidates or ranked an ineligible sibling')
    assert.deepStrictEqual(Array.from(store.scheduler.queued.keys()),siblings.slice(0,3).reverse(),
      'Runnable siblings lost their original error-priority order')
    store.inputBlocked.clear(); reads.length=0
    store.scheduleFrontier()
    assert.strictEqual(reads.length,0,'A single remaining request required a sort')
    assert(store.scheduler.queued.has(siblings[3]),'An input receipt did not reopen its request')
    store.preparationWaiting.delete(ids[4]); store.admissionBlocked.add(ids[4])
    store.scheduleFrontier()
    assert(!store.scheduler.queued.has(ids[4]),'Selection bypassed a capacity refusal')
    store.admissionBlocked.delete(ids[4]); store.scheduleFrontier()
    assert(store.scheduler.queued.has(ids[4]),'Capacity recovery left an eligible request parked')
  } finally {store.destroy()}
  assert.strictEqual(store.renderer.resourceLedger.bytes,0)
}
