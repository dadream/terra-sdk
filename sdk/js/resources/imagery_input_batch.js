const {invariant}=require('../core/terra_globe_common')

// Several synchronous allocations may share one bounded production grant.
// Spend quoted bytes conservatively; frees never replenish its permission.
// Closing ends permission, while the RPC receipt retires the actual credit.
class ImageryInputBatch {
  // Native projection commonly quotes about 100KiB for one phase, followed
  // by smaller metadata phases. The fixed oblique path consumes about550MiB
  // of cumulative permission while retaining only tens of MiB: a1MiB grant
  // added over500 host round trips. This window funds multiple bounded CPU
  // turns; it changes neither their time limits nor cancellation checkpoints.
  // Optional room never evicts extra cache: minimum admission still applies,
  // and the stream's terminal receipt refunds unused permission.
  constructor(create,preferredBytes=8*1024*1024) {
    invariant(typeof create==='function'&&Number.isSafeInteger(preferredBytes)&&preferredBytes>0,
      'Invalid imagery input batch')
    this.create=create;this.preferredBytes=preferredBytes;this.active=0;this.used=0
    this.counts={quotes:0,grants:0,allocations:0,grantedBytes:0,quotedBytes:0,unusedBytes:0}
  }
  open(bytes) {
    this.close()
    const pool=this.create(),quote=pool.quote.bind(pool),grant=pool.grant.bind(pool)
    pool.reserve(bytes)
    pool.quote=()=>{const value=quote();return value?{...value,preferredBytes:Math.max(bytes,this.preferredBytes)}:null}
    pool.grant=value=>{
      const accepted=grant(value)
      if(accepted){++this.counts.grants;this.counts.grantedBytes+=value.bytes}
      return accepted
    }
    this.pool=pool;this.used=0;++this.counts.quotes;return pool
  }
  stage() {
    const batch=this
    let closed=false,active=false,waiting=null
    return {
      reserve(bytes) {
        invariant(!closed&&!active&&Number.isSafeInteger(bytes)&&bytes>0,'Invalid batched imagery allocation')
        let pool=batch.pool
        if(!pool||pool.finished||pool.granted&&pool.granted-batch.used<bytes||
            !pool.granted&&pool.bytes!==bytes)pool=batch.open(bytes)
        if(!pool.granted){waiting=pool;return null}
        batch.used+=bytes;++batch.active;++batch.counts.allocations;batch.counts.quotedBytes+=bytes
        active=true
        return {release() {
          if(!active)return
          active=false;closed=true;--batch.active
        }}
      },
      get finished(){return closed},
      set finished(value) {
        if(!value||closed)return
        invariant(!active,'Cannot cancel an active imagery allocation')
        closed=true
        if(waiting&&batch.pool===waiting)batch.close()
      }
    }
  }
  finishGranted() {if(this.pool&&this.pool.granted)this.close()}
  close() {
    invariant(!this.active,'Cannot finish a live imagery allocation')
    const pool=this.pool;this.pool=null
    if(pool&&!pool.finished) {
      if(pool.granted)this.counts.unusedBytes+=pool.granted-this.used
      pool.finished=true
    }
    this.used=0
  }
  stats(){return {...this.counts,activeAllocations:this.active,
    heldGrantBytes:this.pool&&this.pool.granted||0,spentGrantBytes:this.used}}
}
module.exports={ImageryInputBatch}
