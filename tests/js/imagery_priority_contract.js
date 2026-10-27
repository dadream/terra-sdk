const assert = require('assert')

// Inspect actual request order, not just a comparator. No image request leaves
// the fake canvas; active producers and retry timers must survive re-ranking.
module.exports = async ({Renderer, FakeCanvas, FakeGl, settle}) => {
  const tile = (level, column) => ({level, matrix: level + 1, row: 0, column})
  const key = t => [t.level, t.matrix, t.row, t.column].join('/')
  const roots = [tile(0, 0), tile(0, 1)]
  const near = tile(15, 100), far = tile(4, 20), active = tile(5, 63)
  const demand = tiles => tiles.map(texture => ({texture, imageryPixelError: 1}))
  const create = () => {
    const canvas = new FakeCanvas(new FakeGl())
    const renderer = new Renderer(canvas, {mode: 'height', urlForTile: key,
      directTextureTargets: true, maximumTextureRequests: 1,
      maximumTextureEntries: 64, textureCacheBytes: 64 * 611668})
    const store = renderer.textures
    store.configureSource(key, roots)
    const seed = t => store.cache.set(key(t), {texture: {}, width: 256, height: 256}, 349524)
    roots.forEach(seed)
    return {canvas, renderer, store, seed}
  }
  let f = create()
  try {
    f.store.sync(demand([far, near]))
    assert.strictEqual(f.canvas.images[0].src, key(near),
      'Final target SSE hid the largest current coverage deficit')
    assert.strictEqual(f.canvas.images.length, 1)
    assert(![...f.store.desired.values()].some(t => t.level > 0 && t.level < 15 && t.column === 0),
      'Priority changes introduced intermediate downloads')
    assert.strictEqual(f.store.get(near).resolvedLevel, 0, 'Request priority changed available coverage')
  } finally { f.renderer.destroy() }
  await settle()

  f = create()
  try {
    f.store.sync(demand([active]))
    const running = f.canvas.images[0]
    f.store.sync(demand([active, far]))
    f.store.sync(demand([active, far, near]))
    assert(f.store.scheduler.queued.get(key(near)).priority > f.store.scheduler.queued.get(key(far)).priority)
    // A newly usable predecessor reduces this region's outstanding deficit.
    // Its queued request must move behind the still-blurred other region.
    f.seed(tile(14, 50))
    f.store.sync(demand([active, far, near]))
    assert(f.store.scheduler.queued.get(key(far)).priority > f.store.scheduler.queued.get(key(near)).priority)
    assert.strictEqual(f.canvas.images.length, 1, 'Re-ranking restarted or cancelled an active producer')
    assert.strictEqual(running.src, key(active))
    running.onload()
    await settle(); await settle()
    assert.strictEqual(f.canvas.images[1].src, key(far), 'Network queue retained obsolete priority')
  } finally { f.renderer.destroy() }
  await settle()

  f = create()
  try {
    const siblings = [far, tile(4, 21), {...far, row: 1}]
    f.store.sync(demand([active]))
    const running = f.canvas.images[0]
    f.store.sync(demand([active, ...siblings]))
    assert(siblings.every(t => f.store.scheduler.queued.has(key(t))))
    f.store.sync(demand([active, ...siblings, near]))
    assert(siblings.every(t => !f.store.scheduler.queued.has(key(t))),
      'Unstarted requests retained replacement slots after losing group eligibility')
    assert(f.store.scheduler.active.has(key(active)))
    running.onload()
    await settle(); await settle()
    assert.strictEqual(f.canvas.images[1].src, key(near))
  } finally { f.renderer.destroy() }
  await settle()

  f = create()
  try {
    const sibling = tile(4, 21)
    f.seed(far)
    f.store.sync(demand([near, far, sibling]))
    assert.strictEqual(f.canvas.images[0].src, key(sibling),
      'New urgent detail displaced a partially prepared publication group')
    assert(!f.store.availableKeys.has(key(far)), 'An incomplete sibling group published early')
  } finally { f.renderer.destroy() }
  await settle()

  f = create()
  try {
    f.store.retryDelayMs = 10000
    f.store.sync(demand([near]))
    f.canvas.images[0].onerror(new Error('controlled failure'))
    await settle(); await settle()
    assert(f.store.retryTimers.has(key(near)))
    for (let i = 0; i < 4; ++i) f.store.advance()
    await settle()
    assert.strictEqual(f.canvas.images.length, 1, 'Resource wake-up bypassed retry backoff')
  } finally { f.renderer.destroy() }
  await settle()
}
