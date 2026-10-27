const assert = require('assert')

module.exports = async function verifyParallelDecode(makeStore, {decodes, uploads, tick}) {
  const tiles = Array.from({length:8}, (_, column) => ({level:2,matrix:3,row:0,column}))
  const load = async store => {
    store.sync(tiles.map(texture => ({texture})), [])
    for (let attempt=0;attempt<40&&store.cache.entries.size<8;++attempt) await tick()
    assert.strictEqual(store.cache.entries.size,8)
  }
  const resolve = async (index=0, size=256) => {
    const task=decodes.splice(index,1)[0]; assert(task); task.resolve(size)
    await tick(); await tick()
  }
  const create = () => makeStore({tileSize:256, maximumBytes:16*1048576,
    sharedMaximumBytes:32*1048576, maximumConcurrent:8})

  // A slow first bitmap cannot serialize independently funded siblings. A
  // later completion frees only its own slot, with no GPU submission required.
  const parallel=create()
  await load(parallel); parallel.prepareUploads(); await tick()
  assert.strictEqual(decodes.length,4,'Funded sibling decodes still await a serial browser callback')
  assert.strictEqual(parallel.stats().preparingImages,4)
  await resolve(3)
  parallel.prepareUploads(); await tick()
  assert.strictEqual(decodes.length,4,'Out-of-order completion did not refill its own decoder slot')
  assert.strictEqual(parallel.stats().readyImages,1)
  assert.strictEqual(uploads.length,0,'Preparing bitmaps bypassed the GPU resource clock')
  decodes.splice(1,1)[0].reject(new Error('One concurrent decoder failed'))
  await tick(); await tick()
  assert.strictEqual(parallel.failed.size,1)
  assert.strictEqual(parallel.stats().preparingImages,3,'One failure retired unrelated decoder slots')
  parallel.prepareUploads(); await tick()
  assert.strictEqual(decodes.length,4,'One failed image stranded independent funded work')
  parallel.setMaximumConcurrent(1)
  assert.strictEqual(parallel.stats().preparingImages,4,'Reducing concurrency refunded active decoders')
  parallel.prepareUploads(); await tick()
  assert.strictEqual(decodes.length,4,'A reduced profile admitted more decoders')
  parallel.destroy()
  assert(parallel.renderer.resourceLedger.bytes>0,'Destroy refunded browser-owned pixels before their callbacks')
  while(decodes.length) await resolve(decodes.length-1)
  assert.strictEqual(parallel.renderer.resourceLedger.bytes,0)
  assert.strictEqual(parallel.preparations.size,0)

  // Task slots do not grant memory. Restrict the real workspace to exactly two
  // pixel destinations; the third task must wait despite a four-task ceiling.
  const bounded=create()
  await load(bounded)
  bounded.workspace.trim(bounded.inputBytes+2*bounded.decodeBytes)
  bounded.prepareUploads(); await tick()
  assert.strictEqual(decodes.length,2,'Decoder concurrency exceeded funded pixel credit')
  assert.strictEqual(bounded.workspace.availableBytes,0)
  bounded.destroy()
  while(decodes.length) await resolve()
  assert.strictEqual(bounded.renderer.resourceLedger.bytes,0)

  // Source replacement keeps old in-flight slots/leases until all callbacks.
  // New dimensions decode only through new-generation credit and validation.
  const switched=create()
  await load(switched); switched.prepareUploads(); await tick()
  assert.strictEqual(decodes.length,4)
  switched.renderer.options.textureDescriptor.tile_size=32
  switched.setSource(() => 'https://replacement.invalid', [])
  switched.setMaximumConcurrent(1)
  await load(switched); switched.prepareUploads(); await tick()
  assert.strictEqual(decodes.length,4)
  while(decodes.length) await resolve(decodes.length-1)
  assert.strictEqual(switched.stats().decodedBytes,0,'Retired-source bitmap entered current cache')
  switched.prepareUploads(); await tick()
  assert.strictEqual(decodes.length,1)
  await resolve(0,32)
  assert.strictEqual(switched.stats().decodedBytes,32*32*4)
  switched.destroy()
  assert.strictEqual(switched.renderer.resourceLedger.bytes,0)
  console.log('Parallel decode: bounded siblings, out-of-order receipts, pixel credit, shrinking, source replacement and teardown passed')
}
