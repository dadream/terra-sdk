const { ProducedTextureStore } = require('../webgl/produced_texture_store')
const { ResourceWaitQueue } = require('../../sdk/js/resources/resource_wait_queue')
const {requestEncodedImage}=require('./encoded_image_request')
const {EncodedSourceCache}=require('./encoded_source_cache')

// Bounded asynchronous decoders feed the shared uploader through the funded
// cache. Completed pixels retain credit until their actual upload receipt.
class EncodedTextureStore extends ProducedTextureStore {
  constructor(renderer, options) {
    super(renderer, options)
    // An eightfold linear resolution step skips two source levels, providing
    // useful cold coverage and reusable overviews for a rapid reverse zoom.
    this.pyramid.coverageLevelStep=3
    this.inputQueue = new ResourceWaitQueue()
    this.sourceCache = new EncodedSourceCache(renderer.resourceLedger,()=>{
      if(!this.disposed){this.updatePipelineLimit();this.scheduleAdvance()}
    },bytes=>this.reserveSourceInput(bytes))
    this.releaseInputListener = renderer.resourceLedger.subscribe(() => this.inputQueue.wake())
  }

  // Fetch headers occupy a bounded scheduler slot and a funded destination,
  // while bodies borrow the shared serial continuation only before reading.
  initialInputBytes() { return 0 }
  inputCapacityChanged() { if (this.inputQueue) this.inputQueue.wake() }

  pipelineBytes() {return super.pipelineBytes()+(this.sourceCache?this.sourceCache.bytes:0)}

  configureDimensions() {
    const descriptor = this.renderer.options.textureDescriptor
    this.tileSize = Number(descriptor && descriptor.tile_size) || 256
    this.decodeBytes = this.tileSize * this.tileSize * 4
    this.decodeOverlapBytes = this.decodeBytes
    this.encodedLimit = Math.max(65536, this.decodeBytes * 2)
    // Match body capacity to the admitted network concurrency. A fixed pair
    // silently serializes larger request pools even with ample shared credit.
    this.inputEnvelopeBytes = this.encodedLimit * 2
    this.configurePipeline()
    this.estimatedTileBytes = this.resourceBytes(this.tileSize, this.tileSize)
  }

  configurePipeline() {
    // One four-child replacement can prepare together instead of serializing
    // browser callback latency. Smaller request profiles remain equally bounded.
    // This count grants no memory: every task still takes its pixel credit.
    this.maximumPreparationTasks = Math.min(4, this.scheduler.maximumConcurrent)
    this.maximumInputBytes = this.inputEnvelopeBytes * Math.max(2, this.scheduler.maximumConcurrent)
    this.maximumPipelineBytes = this.maximumInputBytes + 2 * this.decodeBytes
  }

  setMaximumConcurrent(value) {
    super.setMaximumConcurrent(value)
    // These are ceilings, not reservations. A reduction never refunds inputs
    // still owned by readers/decoders; new input waits for their receipts.
    this.configurePipeline()
    this.inputCapacityChanged()
  }

  validateImage(image, tileSize) {
    if (image.width === tileSize && image.height === tileSize) return image
    image.close()
    throw new Error('Texture dimensions differ from the imagery descriptor')
  }

  requestAsset(url, reservation) {
    const {tileSize,encodedLimit}=this
    const source=this.sourceCache.take(url)
    let waiting
    const acquire=()=>waiting=this.inputQueue.wait(()=>this.startInput(reservation.input))
    const request=typeof this.renderer.options.fetchTextures==='function'?this.renderer.options.fetchTextures:fetch
    const task=source||requestEncodedImage(request,url,encodedLimit,acquire)
    const promise=task.promise.then(async blob=>{
      if(source){await acquire().promise;waiting=null}
      const input=reservation.input
      input.resize(blob.size);input.transferred=true
      return {blob,input,image:null,texture:null,width:tileSize,height:tileSize,url}
    }).finally(()=>{if(source)source.release()})
    return {promise,abort:()=>{task.abort();if(waiting)waiting.cancel()}}
  }

  requestEligible(key) {
    if(!super.requestEligible(key))return false
    const source=this.sourceCache
    if(!source||!source.active)return true
    const tile=this.desired.get(key)
    return source.active+this.scheduler.active.size<this.scheduler.maximumConcurrent||
      Boolean(tile&&source.has(this.urlForTile(tile)))
  }

  coverageInputReady(key) {
    const tile=this.desired.get(key)
    return Boolean(tile&&this.sourceCache&&this.sourceCache.ready(this.urlForTile(tile)))
  }

  reserveSourceInput(bytes) {
    const cache=this.cache,ledger=cache.ledger
    const maximumBytes=this.requestedMaximumBytes-super.pipelineBytes()-this.sourceCache.bytes-bytes
    if(maximumBytes<=0)return null
    // Idle cached history can fund current input, just as it funds ordinary
    // image production. Use the cache's actual pin/eviction rules atomically;
    // optional prefetch cannot reclaim unrelated producers or displayed data.
    const victims=cache.makeRoom(null,cache.bytes+cache.reservedBytes,
      cache.entries.size+cache.retained.size+cache.reservations.size,new Set(),{maximumBytes})
    if(!victims)return null
    const released=victims.reduce((sum,lease)=>sum+lease.bytes,0)
    if(ledger.maximumBytes&&ledger.bytes-released+bytes>ledger.maximumBytes)return null
    return ledger.reserve('imagery-encoded-source',bytes,victims)
  }

  scheduleFrontier() {
    super.scheduleFrontier()
    const source=this.sourceCache,r=this.renderer
    if(!source||!r.options.scheduledImagery||!r.current||this.disposed||this.scheduler.paused)return
    const wanted=new Map(),retained=new Set()
    for(const [key,tile]of this.targetDesired) {
      if(this.currentRoots.has(key)||this.cache.has(key)||this.failed.has(key))continue
      const url=this.urlForTile(tile);retained.add(url)
      if(!this.scheduler.active.has(key)&&!this.cache.reservations.has(key))wanted.set(url,tile)
    }
    source.retain(retained)
    const maximumBytes=Math.min(this.maximumInputBytes,Math.max(0,this.requestedMaximumBytes-super.pipelineBytes()))
    const request=typeof r.options.fetchTextures==='function'?r.options.fetchTextures:fetch
    for(const url of wanted.keys()) {
      if(source.active+this.scheduler.active.size>=this.scheduler.maximumConcurrent)break
      source.start(url,this.inputEnvelopeBytes,maximumBytes,()=>
        requestEncodedImage(request,url,this.encodedLimit,()=>({promise:Promise.resolve()})))
    }
    this.updatePipelineLimit()
  }

  setSource(urlForTile,coverageTiles) {
    super.setSource(urlForTile,coverageTiles)
    if(this.sourceCache)this.sourceCache.clear()
  }

  setPaused(paused) {
    super.setPaused(paused)
    if(paused&&this.sourceCache)this.sourceCache.clear()
  }

  prepareAsset(key, entry) {
    const asset = entry.value
    if (asset.image) return true
    if (this.preparations.has(entry) || this.preparations.size >= this.maximumPreparationTasks || !asset.blob) return false
    const workspace = asset.input.workspace
    asset.decodeCredit = workspace.take(asset.width * asset.height * 4)
    if (!asset.decodeCredit) return false
    const release = this.cache.retain(key), generation = this.generation
    const task = {key, entry, release, cancelled: false, ready: false}
    this.preparations.set(entry, task)
    const current = () => !task.cancelled && generation === this.generation && this.cache.entries.get(key) === entry
    task.promise = Promise.resolve().then(() => createImageBitmap(asset.blob)).then(image => {
      if (!current()) { image.close(); return }
      asset.image = this.validateImage(image, asset.width)
      asset.decodeCredit.mark('resident')
      task.ready = true
    }).catch(error => {
      if (!current()) return
      const tile = this.desired.get(key) || this.renderer.presentedTextures.get(key)
      this.cache.delete(key)
      if (tile) this.requestFailed(key, tile, error, generation)
    }).finally(() => {
      // The cache owns completed pixels and their exact decode credit until
      // upload/eviction. Free only this decoder's slot; out-of-order completion
      // must not release a different decoder or an accepted GPU upload.
      this.finishPreparation(task)
      if (!this.disposed) {
        this.scheduleAdvance()
        this.renderer.requestResources()
      }
    })
    return false
  }

  destroy() {
    super.destroy()
    this.sourceCache.destroy()
    this.releaseInputListener()
  }

  stats() {
    return Object.assign(super.stats(), {waitingBodies: this.inputQueue.pending.length,
      encodedSource:this.sourceCache.stats()})
  }
}

module.exports = { EncodedTextureStore }
