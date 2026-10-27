const assert = require('assert')
const {ImageTextureStore, createCanvasTextureStore} = require('../../adapters/webgl/image_texture_store')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {textureByteSize} = require('../../adapters/webgl/texture_store')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const key = tile => [tile.level,tile.matrix,tile.row,tile.column].join('/')
const tiles = Array.from({length:4}, (_,i) => ({level:1,matrix:1,row:i>>1,column:i&1}))
const gpu = textureByteSize(16,16), pixels = 16*16*4

async function main() {
  const stores = [], images = [], pending = [], uploads = []
  let starts = 0, peak = 0
  const make = (budget = 4*gpu+pixels, prefetchAncestors = false) => {
    const renderer = {canvas:{createImage() {
      const image = {width:16,height:16,url:'',clears:0,
        get src() {return this.url},
        set src(url) {
          this.url=url
          if (!url) {++this.clears; return}
          assert(store.inputJobs && store.pipelineBytes() >= pixels, 'Image source started without pixel credit')
          ++starts; pending.push(image)
          peak = Math.max(peak, store.renderer.resourceLedger.bytes)
        }}
      images.push(image); return image
    }}, options:{managedResources:true,textureDescriptor:{kind:'global-geodetic',tile_size:16}},
    gl:{deleteTexture() {}}, presentedTextures:new Map(), resourceLedger:new ResourceLedger(budget),
    requestResources() {}, requestRender() {}, uploadTexture(image,w,h,commit,cancel) {
      assert(image.src && !uploads.some(upload=>upload.image===image))
      uploads.push({image,commit,cancel}); return true
    }}
    const store = createCanvasTextureStore(renderer,{urlForTile:key, maximumBytes:budget, maximumConcurrent:4,
      maximumRetries:0,prefetchAncestors,directTargets:true})
    assert(store instanceof ImageTextureStore)
    stores.push(store); return store
  }
  const finish = async (width=16,fail=false) => {
    const image=pending.shift(); assert(image && image.onload)
    image.width=width
    if (fail) image.onerror(); else image.onload()
    await tick(); return image
  }
  try {
    const store=make(5*gpu+pixels,true)
    assert(store.cache.set('0/0/0/0',{texture:{},width:16,height:16},gpu))
    const competitor=store.renderer.resourceLedger.reserve('competitor',1)
    store.sync(tiles.map(texture=>({texture})),[])
    await tick()
    assert.strictEqual(starts,0,'Incomplete sibling group started I/O')
    competitor.release(); store.admissionBlocked.clear(); store.advance(); await tick()
    assert.strictEqual(pending.length,1,'Serial budget admitted simultaneous decoded images')
    for (let i=0;i<4;++i) {
      const image=await finish()
      store.processUploads(Infinity)
      const upload=uploads.shift(); assert(upload && upload.image===image)
      assert(image.src, 'Pixels released before upload receipt')
      assert.strictEqual(pending.length,0,'Receipt-owned pixels were reused for another request')
      upload.commit({})
      assert.strictEqual(image.src,'')
      await tick(); store.advance(); await tick()
    }
    assert(tiles.every(tile=>store.gpuReady(key(tile))))
    assert.strictEqual(store.cache.bytes,5*gpu)
    assert.strictEqual(store.pipelineBytes(),0)
    assert.strictEqual(peak,5*gpu+pixels)
    assert.strictEqual(starts,4)

    // Recovery follows the actual displayed cut even after its plan changes.
    const tile=tiles[0], id=key(tile)
    store.renderer.presentedTextures.set(id,tile)
    store.sync([],[])
    store.restoreContext(); await tick()
    assert(pending.length,'Recovery ignored a displayed tile absent from the new plan')
    await finish(); store.processUploads(Infinity)
    uploads.shift().commit({})
    assert(store.gpuReady(id))
    assert.strictEqual(store.cache.entries.get(id).value.image,null)
    store.destroy(); await tick()
    assert.strictEqual(store.renderer.resourceLedger.bytes,0)

    // Two inputs can overlap, but a stalled GPU may not decode a whole cut.
    const overlapping=make(200000)
    overlapping.sync(tiles.map(texture=>({texture})),[]); await tick()
    assert.strictEqual(pending.length,2)
    const first=await finish(), second=await finish()
    overlapping.processUploads(Infinity)
    assert.strictEqual(uploads.length,2)
    assert.strictEqual(pending.length,0)
    assert.strictEqual(overlapping.inputBytes,2*pixels)
    const cancelled=uploads.shift(); cancelled.cancel()
    assert.strictEqual(first.src,key(tiles[0]),'Cancelled upload lost its only reload-free retry source')
    overlapping.processUploads(Infinity)
    assert.strictEqual(uploads.length,2)
    overlapping.renderer.options.textureDescriptor.tile_size=32
    overlapping.setSource(()=> 'replacement',[])
    assert(first.src && second.src,'Source switch refunded submitted image inputs')
    assert.strictEqual(overlapping.inputBytes,2*pixels)
    while (uploads.length) uploads.shift().cancel()
    await tick()
    assert.strictEqual(first.src,''); assert.strictEqual(second.src,'')
    assert.strictEqual(overlapping.renderer.resourceLedger.bytes,0)
    overlapping.destroy()

    const loading=make()
    loading.sync([{texture:tile}],[]); await tick()
    const active=pending.shift()
    loading.destroy(); await tick()
    assert.strictEqual(active.src,''); assert.strictEqual(active.onload,null)
    assert.strictEqual(loading.renderer.resourceLedger.bytes,0)

    for (const failure of ['dimension','load']) {
      const bad=make()
      bad.sync([{texture:tile}],[]); await tick()
      const image=await finish(failure==='dimension'?32:16,failure==='load')
      assert.strictEqual(image.src,'')
      assert(bad.failed.has(id))
      assert.strictEqual(bad.renderer.resourceLedger.bytes,0)
      bad.destroy()
    }
  } finally {
    stores.forEach(store=>store.destroy())
    while(uploads.length) uploads.shift().cancel()
    await tick()
  }
  assert(images.every(image=>image.src===''))
  assert(stores.every(store=>store.renderer.resourceLedger.bytes===0))
  console.log('Image production group credit, bounded pixels, receipt lifetime, recovery and cancellation passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})
