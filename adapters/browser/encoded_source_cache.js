const {invariant}=require('../../sdk/js/core/terra_globe_common')

// Optional encoded bytes are independent of display/UV admission. Every fetch
// owns its complete body/assembly envelope; no decoded pixels or GPU objects
// are produced here. Claimed bytes stay owned until the display input adopts
// them, or its cancelled reader finishes.
class EncodedSourceCache {
  constructor(ledger,wake,reserve) {
    this.ledger=ledger;this.wake=wake;this.rows=new Map();this.failed=new Set();this.bytes=0;this.active=0
    this.reserve=reserve||(bytes=>ledger.maximumBytes&&ledger.bytes+bytes>ledger.maximumBytes?null:
      ledger.reserve('imagery-encoded-source',bytes))
    this.revision=0
    this.counts={requests:0,hits:0,failed:0,cancelled:0,highWaterBytes:0}
  }
  register() {
    if(this.unregister)return
    this.unregister=this.ledger.reclamation.register({owner:'imagery-encoded-source',revision:()=>this.revision,
      reclaim:async needed=>{
        const before=this.bytes,waiting=[];let retiring=0
        for(const row of this.rows.values()) {
          if(row.claimed)continue
          retiring+=row.credit.bytes;row.close();waiting.push(row.promise)
          if(retiring>=needed)break
        }
        await Promise.allSettled(waiting);return Math.max(0,before-this.bytes)
      }})
  }
  has(url){const row=this.rows.get(url);return Boolean(row&&!row.cancelled&&!row.claimed)}
  ready(url){const row=this.rows.get(url);return Boolean(row&&row.done&&!row.cancelled&&!row.claimed)}
  start(url,envelope,maximumBytes,request) {
    if(this.rows.has(url)||this.failed.has(url)||this.ledger.reclamation.pending||this.bytes+envelope>maximumBytes)return false
    const credit=this.reserve(envelope)
    if(!credit)return false
    const row={credit,claimed:false,done:false,released:false,cancelled:false}
    const release=()=>{
      if(row.released)return
      row.released=true;this.bytes-=credit.bytes;credit.release()
      ++this.revision
      if(!this.bytes&&this.unregister){this.unregister();this.unregister=null}
      if(this.rows.get(url)===row)this.rows.delete(url)
    }
    row.close=()=>{
      if(!row.cancelled){row.cancelled=true;++this.counts.cancelled}
      if(row.request)row.request.abort()
      if(row.done&&!row.claimed)release()
    }
    row.release=()=>{row.claimed=false;if(row.done)release();else row.close()}
    this.rows.set(url,row);this.bytes+=envelope;++this.active;++this.counts.requests
    this.register()
    ++this.revision
    this.counts.highWaterBytes=Math.max(this.counts.highWaterBytes,this.bytes)
    row.promise=Promise.resolve().then(()=>{
      if(row.cancelled)throw Object.assign(new Error('Encoded source retired'),{name:'AbortError'})
      row.request=request();return row.request.promise
    }).then(blob=>{
      invariant(blob.size<=envelope,'Encoded source exceeded its credit')
      this.bytes+=blob.size-credit.bytes;credit.resize(blob.size);credit.mark('resident');return blob
    }).catch(error=>{if(!row.cancelled){++this.counts.failed;this.failed.add(url)}row.cancelled=true;throw error}).finally(()=>{
      row.done=true;--this.active
      ++this.revision
      if(row.cancelled&&!row.claimed)release()
      this.wake()
    })
    row.promise.catch(()=>{}) // Optional failure is retried by ordinary demand.
    return true
  }
  take(url) {
    const row=this.rows.get(url)
    // Different logical tiles may resolve to one URL. This optional credit
    // has one adopter; peers use their own ordinary funded request instead
    // of borrowing an already-issued input or bypassing network concurrency.
    if(!row||row.cancelled||row.claimed)return null
    row.claimed=true;++this.counts.hits;++this.revision
    return {promise:row.promise,abort:row.close,release:row.release}
  }
  retain(urls) {
    for(const [url,row]of this.rows)if(!urls.has(url)&&!row.claimed)row.close()
    for(const url of this.failed)if(!urls.has(url))this.failed.delete(url)
  }
  clear(){for(const row of this.rows.values())row.close();this.failed.clear()}
  destroy(){this.clear();if(this.unregister)this.unregister();this.unregister=null}
  stats(){return {...this.counts,bytes:this.bytes,active:this.active,entries:this.rows.size}}
}
module.exports={EncodedSourceCache}
