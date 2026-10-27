const {invariant}=require('../../sdk/js/core/terra_globe_common')
const {Cleanup}=require('../../sdk/js/runtime/cleanup')

// One synchronous producer scratch owner. The input grant/receipt lane covers
// its exact ArrayBuffer payload as well as native input packing. No buffer is
// transferred, cached after completion, or lent to two measurement iterators.
class ImageryScratch {
  constructor(abi,onDestroy) {
    invariant(abi.context&&!abi.destroyed,'Imagery scratch owner is closed')
    this.abi=abi;this.onDestroy=onDestroy
    this.allocations=0;this.peakBytes=0;this.requiredBytes=0
    abi.imageryScratchOwners.add(this)
  }

  request(bytes) {
    invariant(!this.closed&&!this.abi.destroyed&&this.abi.context&&Number.isSafeInteger(bytes)&&bytes>0&&
      (!this.requiredBytes||this.requiredBytes===bytes),'Invalid imagery scratch request')
    this.requiredBytes=bytes
    if(!this.buffer)return null
    invariant(!this.active&&this.buffer.byteLength===bytes,'Imagery scratch is already borrowed')
    this.active=true
    const buffer=this.buffer
    return {buffer,fresh:true,release:()=>{if(this.buffer===buffer)this.close()}}
  }

  allocate(workspace) {
    invariant(!this.closed&&!this.abi.destroyed&&this.abi.context&&this.requiredBytes>0,'Imagery scratch owner is closed')
    if(this.buffer)return true
    const credit=workspace?workspace.reserve(this.requiredBytes):this.abi.beginImageryInput(this.requiredBytes)
    if(!credit)return false
    try {
      try {this.buffer=new ArrayBuffer(this.requiredBytes)}
      catch(error){if(error instanceof RangeError)error.status=9;throw error}
      this.abi.imageryScratchBytes=(this.abi.imageryScratchBytes||0)+this.buffer.byteLength
      ++this.allocations;this.peakBytes=Math.max(this.peakBytes,this.buffer.byteLength)
      this.abi.observeImageryInput()
      return true
    } finally {credit.release()}
  }

  close() {
    const bytes=this.buffer?this.buffer.byteLength:0
    this.buffer=null;this.active=false;this.requiredBytes=0
    if(bytes){this.abi.imageryScratchBytes-=bytes;this.abi.observeImageryInput()}
  }

  stats(){return {allocations:this.allocations,peakBytes:this.peakBytes,bytes:this.buffer?this.buffer.byteLength:0}}

  destroy() {
    if(this.closed)return
    this.closed=true
    const cleanup=new Cleanup()
    if(this.onDestroy)cleanup.run(()=>this.onDestroy())
    cleanup.run(()=>this.close())
    this.onDestroy=null;this.abi.imageryScratchOwners.delete(this)
    cleanup.finish()
  }
}
module.exports={ImageryScratch}
