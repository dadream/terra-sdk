// Projection results may outlive their terrain frame. Retain numeric metadata,
// never a model (which owns vertex arrays and derived acceleration structures).
// The byte limit counts the numeric payload, not JavaScript object overhead.
const {Cleanup,cleanupAfterError}=require('../runtime/cleanup')
const {REGION_BYTES}=require('./measurement_rows')

class SurfaceMeasurementCache {
  constructor(maximumBytes = 32768 * 168, maximumViews = 3) {
    if (![maximumBytes, maximumViews].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('Invalid projection history capacity')
    }
    this.maximumBytes = maximumBytes
    this.maximumViews = maximumViews
    this.views = new Map()
    this.bytes = 0
    this.highWaterBytes = 0
  }

  acquire(signature) {
    const view = this.views.get(signature)
    if (!view) return null
    const releases=[]
    try {for(const value of view.values.values())releases.push(value.regions.borrow())}
    catch(error){cleanupAfterError(error,()=>{const cleanup=new Cleanup();for(const release of releases)cleanup.run(release);cleanup.finish()})}
    this.views.delete(signature); this.views.set(signature, view)
    let active=true
    return {values:new Map(view.values),release() {
      if(!active)return
      active=false
      const cleanup=new Cleanup();for(const release of releases.splice(0))cleanup.run(release);cleanup.finish()
    }}
  }

  delete(signature) {
    const view = this.views.get(signature)
    if (!view)return
    this.bytes -= view.bytes
    this.views.delete(signature)
    const releases=Array.from(view.releases.values());view.values.clear();view.costs.clear();view.releases.clear()
    const cleanup=new Cleanup();for(const release of releases)cleanup.run(release);cleanup.finish()
  }

  remember(signature, measured, resources) {
    for (const value of measured.values()) {
      if ('model' in value) throw new Error('Projection history cannot own a terrain model')
    }
    const view = {values: new Map(), costs: new Map(), releases:new Map(), bytes: 0, regions: 0}
    try {
      for(const [id,value] of measured) {
        if(value.conservative||!resources.has(id))continue
        const rows=value.regions
        if(!rows||typeof rows.borrow!=='function')throw new Error('Projection history requires owned numeric rows')
        const bytes=64+(value.hull||[]).length*16+rows.length*REGION_BYTES
        if(view.bytes+bytes>this.maximumBytes)continue
        view.releases.set(id,rows.borrow())
        view.values.set(id,{pixelsPerUv:value.pixelsPerUv,visible:value.visible,centerDistance:value.centerDistance,
          bounds:value.bounds,hull:value.hull,regions:rows,refinable:value.refinable,
          viewRevision:value.viewRevision,sourceRevision:value.sourceRevision})
        view.costs.set(id,bytes);view.bytes+=bytes;view.regions+=rows.length
      }
    }catch(error) {cleanupAfterError(error,()=>this.releaseView(view))}
    let transferred=false
    const cleanup=new Cleanup()
    cleanup.run(()=>{
    // Acquire incoming owners before releasing an older cache entry whose
    // numbers may be in the active map. A cache read owns a separate loan.
    this.delete(signature)
    // A bounded history can reuse still-live immutable content IDs across views.
    // Prune dead IDs without mutating maps already borrowed by active work.
    for (const [key, view] of this.views) {
      for (const [id, entry] of view.costs) {
        if (resources.has(id)) continue
        view.regions -= (view.values.get(id).regions || []).length
        view.values.delete(id); view.costs.delete(id)
        view.bytes -= entry; this.bytes -= entry
        const release=view.releases.get(id);view.releases.delete(id);release()
      }
      if (!view.values.size) this.delete(key)
    }
    while (this.views.size && (this.views.size >= this.maximumViews ||
        this.bytes + view.bytes > this.maximumBytes)) this.delete(this.views.keys().next().value)
    if (view.values.size && this.maximumViews > 0) {
      this.views.set(signature, view); this.bytes += view.bytes
      transferred=true
      this.highWaterBytes = Math.max(this.highWaterBytes, this.bytes)
    }
    })
    if(!transferred)cleanup.run(()=>this.releaseView(view))
    cleanup.finish()
  }

  releaseView(view) {
    const releases=Array.from(view.releases.values());view.releases.clear()
    const cleanup=new Cleanup();for(const release of releases)cleanup.run(release);cleanup.finish()
  }

  clear() {
    const cleanup=new Cleanup();for(const key of Array.from(this.views.keys()))cleanup.run(()=>this.delete(key));cleanup.finish()
  }

  stats() {
    let entries = 0, regions = 0
    this.views.forEach(view => {
      entries += view.values.size
      regions += view.regions
    })
    return {views: this.views.size, entries, regions, numericPayloadBytes: this.bytes,
      maximumNumericPayloadBytes: this.maximumBytes, highWaterNumericPayloadBytes: this.highWaterBytes}
  }
}

module.exports = {SurfaceMeasurementCache}
