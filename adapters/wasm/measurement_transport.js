const {invariant}=require('../../sdk/js/core/terra_globe_common')
const {NativeMeasurementRows,NativeMeasurementLoans}=require('./native_surface_measurement')
const {Cleanup,cleanupAfterError}=require('../../sdk/js/runtime/cleanup')
const {REGION_BYTES,EMPTY_ROWS,MeasurementLoans,adoptMeasurementRows,borrowMeasurementRows,
  ownMeasurements,releaseMeasurements,writeMeasurementRow}=require('../../sdk/js/terrain/measurement_rows')

// Quote immutable metadata first. Numeric buffers require a matching grant;
// one publication at a time establishes the sender's reference history.
class MeasurementSender {
  constructor(){this.sequence=0;this.nextId=1;this.regions=new Map();this.active=null;this.nativeLoans=new NativeMeasurementLoans()}
  syncNativeLoans() {
    const sender=this
    function* values() {
      for(const entry of sender.regions.values())yield entry.value
      if(sender.active)for(const entry of sender.active.next.values())yield entry.value
    }
    this.nativeLoans.replace(values())
  }
  begin(measurements,retainedIds) {
    invariant(!this.active&&this.nextId<Number.MAX_SAFE_INTEGER,'Measurement publication is already active')
    const keep=new Set(retainedIds),next=new Map(),ids=new Set(),sources=[]
    this.regions.forEach((entry,id)=>{if(keep.has(id))next.set(id,entry)})
    const sequence=this.sequence+1
    let bytes=0
    const entries=measurements.map(value=>{
      const id=value.resourceId,entry=Object.assign({},value),previous=this.regions.get(id)
      invariant(Number.isSafeInteger(id)&&id>0&&!ids.has(id),'Invalid measurement resource identity');ids.add(id)
      delete entry.regionRevision
      if(!value.regions){next.delete(id);return entry}
      delete entry.regions
      invariant((Array.isArray(value.regions)||value.regions instanceof NativeMeasurementRows)&&value.regions.length<=1048576,'Invalid producer measurement rows')
      if(previous&&previous.value===value.regions) {
        entry.regionRevision=previous.revision;next.set(id,previous)
      }else {
        const count=value.regions.length,slot=count?sources.length:-1
        entry.regionRevision=sequence;entry.regions=[slot,count]
        if(count){sources.push(value.regions);bytes+=count*REGION_BYTES}
        next.set(id,{revision:sequence,value:value.regions})
      }
      return entry
    })
    // keep also contains passive history omitted from this response's entries.
    // Those rows are just as necessary to receive the packet as explicit
    // deltas. Pin the complete quoted reference set until the transfer receipt;
    // a forget travelling the other way must not invalidate an issued grant.
    const references=Array.from(next,([id,entry])=>({id,revision:entry.revision}))
      .filter(entry=>entry.revision<sequence)
    invariant(measurements.length<=65536&&bytes<=1048576*REGION_BYTES,'Measurement publication exceeds supported shape')
    const work=new MeasurementPublication(this,this.nextId++,sequence,next,entries,sources,references,bytes)
    this.active=work
    try{this.syncNativeLoans()}catch(error){cleanupAfterError(error,()=>work.cancel())}
    return work
  }
  forget(items) {
    for(const {id,revision} of items) {
      const old=this.regions.get(id)
      if(old&&old.revision===revision)this.regions.delete(id)
      if(this.active) {
        const pending=this.active.next.get(id)
        if(pending&&pending.revision===revision)this.active.next.delete(id)
      }
    }
    this.syncNativeLoans()
  }
  clear(){
    const cleanup=new Cleanup()
    if(this.active)cleanup.run(()=>this.active.cancel())
    this.regions.clear();cleanup.run(()=>this.nativeLoans.clear());cleanup.finish()
  }
}
class MeasurementPublication {
  constructor(sender,id,sequence,next,entries,sources,references,bytes) {
    Object.assign(this,{sender,id,sequence,next,entries,sources,references,bytes})
    this.buffers=[];this.source=0;this.row=0;this.granted=false;this.finished=false
  }
  quote(){return {id:this.id,sequence:this.sequence,bytes:this.bytes,references:this.references}}
  grant(bytes) {
    invariant(!this.finished&&!this.granted&&Number.isSafeInteger(bytes)&&bytes===this.bytes,'Invalid measurement grant')
    this.granted=true
  }
  step(maximumRows=256) {
    invariant(!this.finished&&this.granted&&Number.isSafeInteger(maximumRows)&&maximumRows>0&&maximumRows<=256,
      'Measurement publication requires bounded funded work')
    let copied=0
    while(this.source<this.sources.length&&copied<maximumRows) {
      const rows=this.sources[this.source]
      if(!this.view) {
        const data=new Uint8Array(rows.length*REGION_BYTES)
        this.buffers.push(data);this.view=new DataView(data.buffer)
      }
      while(this.row<rows.length&&copied<maximumRows) {
        if(rows instanceof NativeMeasurementRows) {
          const count=Math.min(rows.length-this.row,maximumRows-copied)
          rows.copyTo(this.buffers[this.buffers.length-1],this.row*REGION_BYTES,this.row,count);this.row+=count;copied+=count
        }else {writeMeasurementRow(rows[this.row],this.view,this.row*REGION_BYTES);++this.row;++copied}
      }
      if(this.row===rows.length){++this.source;this.row=0;this.view=null}
    }
    return {done:this.source===this.sources.length,rows:copied}
  }
  packet() {
    invariant(!this.finished&&this.granted&&this.source===this.sources.length,'Incomplete measurement publication')
    if(!this.exported)this.exported={entries:this.entries,buffers:this.buffers.slice(),sequence:this.sequence,keep:Array.from(this.next.keys())}
    return this.exported
  }
  commit() {
    invariant(!this.finished&&this.sender.active===this&&this.sequence===this.sender.sequence+1,'Stale measurement publication')
    this.packet();this.sender.sequence=this.sequence;this.sender.regions=this.next;this.sender.active=null
    this.finished=true;this.view=null;this.sources=[];this.buffers=[];this.exported=null
    this.sender.syncNativeLoans()
  }
  cancel() {
    if(this.finished)return
    this.finished=true;this.view=null;this.sources=[];this.buffers=[]
    if(this.exported)this.exported.buffers.length=0
    this.exported=null
    if(this.sender.active===this)this.sender.active=null
    this.sender.syncNativeLoans()
  }
}

class MeasurementReceiver {
  constructor(ledger,onForget) {
    this.ledger=ledger;this.onForget=onForget||(()=>{});this.sequence=0;this.regions=new Map();this.bytes=0
    this.snapshots=0;this.numericBytes=0;this.reusedRegions=0
  }
  setLedger(ledger) {
    invariant(!this.ledger||this.ledger===ledger||!this.bytes,'Measurement ledger cannot change while occupied')
    this.ledger=ledger
  }
  clear(){
    const entries=Array.from(this.regions.values()),cleanup=new Cleanup();this.regions.clear()
    for(const entry of entries)cleanup.run(()=>entry.release());cleanup.finish()
  }
  forget(id,revision) {
    const entry=this.regions.get(id)
    if(!entry||entry.revision!==revision)return
    this.regions.delete(id);entry.release();this.onForget([{id,revision}])
  }
  pin(references) {
    const missing=[],values=[],ids=new Set(),loans=new MeasurementLoans()
    for(const ref of references) {
      invariant(Number.isSafeInteger(ref.id)&&ref.id>0&&Number.isSafeInteger(ref.revision)&&ref.revision>0&&!ids.has(ref.id),
        'Invalid measurement reference quote');ids.add(ref.id)
      const entry=this.regions.get(ref.id)
      if(!entry||entry.revision!==ref.revision)missing.push(ref)
      else values.push({regions:entry.value})
    }
    loans.replace(values);return {missing,release:()=>loans.clear()}
  }
  receive(packet,credit) {
    const initial=[],created=[],next=new Map(),ids=new Set(),used=new Set()
    let measurements,committed=false,bytes=0,reused=0
    try {
      invariant(packet&&packet.sequence===this.sequence+1&&Array.isArray(packet.entries)&&
        Array.isArray(packet.keep)&&Array.isArray(packet.buffers),'Invalid measurement sequence')
      const keep=new Set(packet.keep)
      invariant(keep.size===packet.keep.length&&packet.keep.every(id=>Number.isSafeInteger(id)&&id>0),
        'Invalid retained measurement identities')
      for(const data of packet.buffers) {
        invariant(data instanceof Uint8Array&&data.buffer instanceof ArrayBuffer&&data.byteOffset===0&&
          data.byteLength===data.buffer.byteLength&&data.byteLength>0&&data.byteLength%REGION_BYTES===0,
        'Invalid measurement transport');bytes+=data.byteLength
      }
      invariant(bytes<=1048576*REGION_BYTES&&(!bytes||this.ledger&&credit&&credit.active&&credit.bytes===bytes),
        'Measurement reception requires its issued credit')
      this.regions.forEach((entry,id)=>{if(keep.has(id))next.set(id,entry)})
      measurements=packet.entries.map(entry=>{
        const value=Object.assign({},entry),id=value.resourceId,revision=value.regionRevision
        invariant(Number.isSafeInteger(id)&&id>0&&!ids.has(id),'Invalid measurement resource identity');ids.add(id)
        if(revision===undefined) {
          invariant(!value.regions&&!keep.has(id),'Unversioned measurement regions');next.delete(id)
        }else {
          invariant(Number.isSafeInteger(revision)&&revision>0&&revision<=packet.sequence&&keep.has(id),'Invalid measurement revision')
          if(revision===packet.sequence) {
            invariant(Array.isArray(value.regions)&&value.regions.length===2,'Missing new measurement regions')
            const [slot,count]=value.regions
            invariant(Number.isSafeInteger(count)&&count>=0&&count<=1048576&&
              (count?Number.isSafeInteger(slot)&&slot>=0&&slot<packet.buffers.length&&!used.has(slot):slot===-1),
            'Invalid measurement transport span')
            let rows=EMPTY_ROWS
            if(count) {
              let data=packet.buffers[slot]
              invariant(data&&data.byteLength===count*REGION_BYTES,'Invalid measurement transport span')
              const lease=credit.split(data.byteLength,'reserved','imagery-measurement-host')
              let owned
              try {owned=adoptMeasurementRows(data,lease,()=>{this.bytes-=count*REGION_BYTES})}
              catch(error){packet.buffers[slot]=null;data=null;lease.release();throw error}
              this.bytes+=count*REGION_BYTES;initial.push(owned)
              rows=owned.rows;packet.buffers[slot]=null;data=null;used.add(slot)
            }
            value.regions=rows
            const cached={revision,value:rows,release:borrowMeasurementRows(rows,()=>this.forget(id,revision))}
            next.set(id,cached);created.push(cached)
          }else {
            const previous=this.regions.get(id)
            invariant(!value.regions&&previous&&previous.revision===revision,'Unknown measurement reference')
            value.regions=previous.value;reused+=previous.value.length
          }
          delete value.regionRevision
        }
        return value
      })
      invariant(used.size===packet.buffers.length&&next.size===keep.size,'Unclaimed measurement transport regions')
      ownMeasurements(measurements)
      const old=this.regions;this.regions=next;this.sequence=packet.sequence;committed=true
      for(const [id,entry] of old)if(next.get(id)!==entry)entry.release()
      ++this.snapshots;this.numericBytes+=bytes;this.reusedRegions+=reused
      return measurements
    }catch(error) {
      if(packet&&Array.isArray(packet.buffers))packet.buffers.length=0
      if(!committed){releaseMeasurements(measurements);for(const entry of created)entry.release()}
      throw error
    }finally {
      if(packet&&Array.isArray(packet.buffers))packet.buffers.length=0
      for(const owned of initial)owned.release()
      if(credit)credit.release()
    }
  }
  stats() {
    let count=0
    for(const entry of this.regions.values())count+=entry.value.length
    return {snapshots:this.snapshots,numericBytes:this.numericBytes,reusedRegions:this.reusedRegions,
      cachedMeshes:this.regions.size,cachedRegions:count,ownedBytes:this.bytes}
  }
}

module.exports={MeasurementSender,MeasurementReceiver}
