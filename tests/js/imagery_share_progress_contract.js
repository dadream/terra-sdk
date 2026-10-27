const assert = require('assert')

// Target planning must progress without a network or display receipt. Those
// producers already own their continuation credit; a new grant is additional
// ownership, never permission to release or publish their unfinished output.
module.exports = async function verifyShareProgress(makeStore, tile, gpu, tick) {
  const preferred = 2 * 65536 + 8 * gpu
  const store = makeStore({maximumBytes: preferred, maximumShareBytes: preferred + 4 * gpu,
    sharedMaximumBytes: preferred + 10 * gpu, maximumEntries: 100, coverageTiles: [tile]})
  const r = store.renderer, ledger = r.resourceLedger
  const query = ledger.reserve('query-continuation', 100)
  const displayed = '0/0/0/0', first = {level: 1, matrix: 1, row: 0, column: 0}
  const second = {level: 1, matrix: 1, row: 0, column: 1}
  const submission = r.pendingSubmission = {drawn: true}
  let receive, replans = 0
  r.options.fetchTextures = () => new Promise(resolve => { receive = resolve })
  r.options.onImageryPlanningChange = () => ++replans
  r.cameraVersion = r.plannedCameraVersion = 1
  const acknowledgePlan = () => {
    r.current = {imageryPlan: {quality: {planningComplete: true, cameraCurrent: true,
      limitedByTextureBudget: true, maximumTextureCount: store.targetCapacity()}}}
  }
  try {
    assert(store.cache.set(displayed, {texture: {}, width: 16, height: 16}, gpu))
    store.availableKeys.add(displayed)
    store.protectedKeys.add(displayed)
    r.presentedTextures.set(displayed, tile)
    for (const [id, image] of [['1/1/0/0', first], ['1/1/0/1', second]]) {
      store.targetDesired.set(id, image)
      store.schedule(id, image, 1)
    }
    await tick()
    assert(receive, 'The first real producer never entered fetch')
    assert.strictEqual(store.scheduler.active.size, 1)
    assert.strictEqual(store.scheduler.queued.size, 1)
    assert.strictEqual(store.inputBytes, 0, 'A pending header owns no body bytes')
    assert(store.pipelineBytes() >= store.minimumWorkspaceBytes(), 'Headers started without a funded continuation')
    const owned = ledger.bytes
    const capacity = store.targetCapacity()
    acknowledgePlan()
    for (let count = 1; count <= 4; ++count) {
      assert(store.growShare(), 'Complete current-view planning waited for old image/display completion')
      assert.strictEqual(store.targetCapacity(), capacity + count)
      assert.strictEqual(ledger.bytes, owned + count * gpu)
      assert.strictEqual(store.growShare(), false, 'One capacity plan obtained duplicate grants')
      assert.strictEqual(store.inputBytes, 0)
      assert.strictEqual(store.scheduler.active.size, 1)
      assert.strictEqual(query.bytes, 100)
      assert.strictEqual(r.pendingSubmission, submission)
      assert(store.gpuReady(displayed), 'Planning growth lost the submitted coverage')
      assert(!store.gpuReady('1/1/0/0'), 'Unfinished target became presentable')
      acknowledgePlan()
    }
    assert.strictEqual(replans, 4)
    assert.strictEqual(store.stats().resourceShare.grantsBeforeImagesReady, 4)
    assert.strictEqual(store.growShare(), false, 'Growth bypassed the application ceiling')
    store.setPaused(true)
    assert.strictEqual(store.resourceShare.stats().unusedBytes, 0)
    assert.strictEqual(ledger.bytes, owned, 'Pause refunded an unacknowledged network producer')
    assert.strictEqual(store.scheduler.queued.size, 0)
  } finally {
    store.destroy()
    if (receive) receive({ok: true, headers: {get: () => 'image/png'},
      body: {cancel: async () => {}, getReader: () => ({read: async () => ({done: true}), cancel: async () => {}, releaseLock() {}})}})
    await tick(); await tick()
    query.release()
    assert.strictEqual(ledger.bytes, 0, 'Delayed source completion left live resource ownership')
  }
}
