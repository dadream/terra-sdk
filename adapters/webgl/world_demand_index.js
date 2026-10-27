const {CooperativeTask}=require('../../sdk/js/runtime/cooperative_task')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {parentTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')

// Reconcile changed goals once on the resource clock. Request admission then
// queries only the image's ancestor chain, never scans the whole terrain cut.
// The record cancels this producer before replacing/releasing its paid cuts.
class WorldDemandIndex {
  constructor(record,ledger,inputKey,now) {
    this.revision=record.goalRevision;this.credit=ledger.reserve('world-demand-index',1024)
    this.used=1024;this.badMeshes=new Set();this.sources=new Set();this.branches=new Set()
    this.task=this.credit?new CooperativeTask(this.build(record,inputKey,ledger),Infinity,now):null
  }
  reserve(bytes,ledger) {
    this.used+=bytes
    if(this.used<=this.credit.bytes)return
    const free=ledger.maximumBytes?Math.max(0,ledger.maximumBytes-ledger.bytes):65536
    if(!this.credit.resize(this.credit.bytes+Math.max(this.used-this.credit.bytes,Math.min(65536,free))))
      throw Object.assign(new Error('World demand index is not funded'),{status:9})
  }
  *build(record,inputKey,ledger) {
    const draws=record.draws,checked=new Map()
    for(const draw of draws) {
      yield
      const id=draw.geometryKey,cut=record.cuts.get(id),index=checked.get(id)||0
      if(!checked.has(id))this.reserve(192+String(id).length*2,ledger)
      checked.set(id,index+1)
      if(!cut||!cut.goals||cut.goals[index]!==inputKey(draw))this.badMeshes.add(id)
    }
    for(const [id,count]of checked) {
      yield
      const cut=record.cuts.get(id)
      if(!cut||!cut.goals||cut.goals.length!==count)this.badMeshes.add(id)
    }
    for(const draw of draws) {
      yield
      if(!this.badMeshes.has(draw.geometryKey))continue
      let tile=draw.sourceTexture||draw.texture,id=key(tile)
      if(this.sources.has(id))continue
      this.reserve(96+id.length*2,ledger);this.sources.add(id)
      while((tile=parentTextureTile(tile))) {
        yield
        id=key(tile)
        if(this.branches.has(id))break
        this.reserve(96+id.length*2,ledger);this.branches.add(id)
      }
    }
    let bytes=1024
    for(const values of [this.badMeshes,this.sources,this.branches])for(const value of values) {
      yield
      bytes+=96+String(value).length*2
    }
    if(!this.credit.resize(bytes))throw Object.assign(new Error('World demand index output is not funded'),{status:9})
    this.credit.mark('resident')
    this.complete=true
  }
  allows(children) {
    if(!this.complete)return false
    for(const tile of children.values()) {
      if(this.branches.has(key(tile)))return false
      for(let current=tile;current;current=parentTextureTile(current))if(this.sources.has(key(current)))return false
    }
    return true
  }
  close() {
    if(this.task)this.task.cancel()
    if(this.credit)this.credit.release()
    this.task=null;this.credit=null;this.complete=false
    this.badMeshes.clear();this.sources.clear();this.branches.clear()
  }
}
module.exports={WorldDemandIndex}
