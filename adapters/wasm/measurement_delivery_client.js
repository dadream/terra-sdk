const {invariant}=require('../../sdk/js/core/terra_globe_common')

// A grant follows its physical allocation across realms: source work -> wire
// transfer -> host mirror. Cancellation alone never refunds an issued grant.
class MeasurementDeliveryClient {
  constructor(receiver,callbacks) {
    this.receiver=receiver;this.callbacks=callbacks;this.records=new Map();this.retiring=false
  }
  quote(messageId,quote) {
    invariant(quote&&Number.isSafeInteger(quote.id)&&quote.id>0&&Number.isSafeInteger(quote.sequence)&&quote.sequence>0&&
      Number.isSafeInteger(quote.bytes)&&quote.bytes>=0&&quote.bytes<=1048576*176&&Array.isArray(quote.references),
    'Invalid measurement work quote')
    invariant(quote.sequence===this.receiver.sequence+1,'Invalid measurement quote sequence')
    if(this.retiring){this.callbacks.post({type:'measurement-cancel',workId:quote.id});return}
    invariant(!this.records.has(quote.id),'Repeated measurement grant')
    const pins=this.receiver.pin(quote.references)
    if(pins.missing.length) {
      pins.release();this.callbacks.post({type:'measurement-resend',workId:quote.id,missing:pins.missing});return
    }
    const record={messageId,quote,pins,credit:null,issued:false,active:true}
    this.records.set(quote.id,record)
    Promise.resolve().then(()=>record.active&&!this.retiring?this.fund(record):undefined)
      .catch(error=>this.callbacks.fatal(error))
  }
  async fund(record) {
    const ledger=this.receiver.ledger,bytes=record.quote.bytes
    invariant(!bytes||ledger,'Measurement production requires a shared ledger')
    if(bytes) {
      const refusal={}
      const reserve=()=>ledger.reserve('imagery-measurement-wire',bytes,[],[],[],refusal)
      record.credit=reserve()
      if(!record.credit) {
        await ledger.reclamation.pending
        if(!record.active||this.retiring)return
        record.credit=reserve()
      }
      if(!record.credit) {
        record.failure=Object.assign(new Error('Measurement mirror capacity is occupied'),
          {status:9,capacityShortfallBytes:refusal.shortfallBytes,capacityRevision:ledger.availabilityRevision})
        this.callbacks.post({type:'measurement-cancel',workId:record.quote.id});return
      }
    }
    if(!record.active||this.retiring){if(record.credit)record.credit.release();record.credit=null;return}
    // Set before post: a synchronous transport may deliver the full receipt.
    record.issued=true
    this.callbacks.post({type:'measurement-grant',workId:record.quote.id,bytes})
  }
  receive(messageId,receipt,packet,discard=false) {
    const record=receipt&&this.records.get(receipt.id)
    // A reset may repeat a cancellation already acknowledged by a data packet.
    if(!record&&receipt&&receipt.cancelled&&!packet&&Number.isSafeInteger(receipt.id)&&receipt.id>0&&receipt.bytes===0)
      return {cancelled:true}
    invariant(record&&record.messageId===messageId&&Number.isSafeInteger(receipt.bytes)&&receipt.bytes>=0,
      'Unknown measurement ownership receipt')
    let values,completed=false
    try {
      if(receipt.cancelled) {
        invariant(receipt.bytes===0&&!packet,'Cancelled measurement still owns wire payload')
        completed=true
      }else {
        invariant(record.issued&&packet&&receipt.bytes===record.quote.bytes&&packet.sequence===record.quote.sequence,
          'Measurement receipt does not match its grant')
        invariant(Array.isArray(packet.buffers)&&packet.buffers.every(data=>
          ArrayBuffer.isView(data)&&data.buffer instanceof ArrayBuffer&&data.byteOffset===0&&
          data.byteLength===data.buffer.byteLength)&&
          packet.buffers.reduce((n,data)=>n+data.byteLength,0)===record.quote.bytes,
        'Transferred measurement bytes do not match their issued grant')
        completed=true
        if(!discard){values=this.receiver.receive(packet,record.credit);record.credit=null}
      }
      return {values,error:record.failure,cancelled:Boolean(receipt.cancelled)}
    }finally {
      if(packet&&Array.isArray(packet.buffers))packet.buffers.length=0
      record.pins.release()
      if(completed) {
        record.active=false
        if(record.credit)record.credit.release()
        record.credit=null;this.records.delete(receipt.id)
      }
    }
  }
  released(ids) {
    invariant(Array.isArray(ids)&&ids.every(id=>Number.isSafeInteger(id)&&id>0),'Invalid measurement release receipt')
    for(const id of ids) {
      const record=this.records.get(id)
      if(!record)continue
      record.active=false;record.pins.release()
      if(record.credit)record.credit.release()
      record.credit=null;this.records.delete(id)
    }
  }
  stopped(){this.released(Array.from(this.records.keys()))}
  retire() {
    this.retiring=true
    for(const [id,record] of this.records) {
      if(!record.issued||!record.quote.bytes) {
        record.active=false;record.pins.release()
        if(record.credit)record.credit.release()
        this.records.delete(id)
      }else if(record.credit)record.credit.mark('retired')
    }
    this.receiver.clear()
  }
  // Transferred-but-unobserved buffers may already be in the receiver's event
  // queue. Worker termination alone cannot prove these grants empty. A normal
  // stop drains the FIFO before its receipt; an uncertain crash retains them.
  pendingBytes(){let bytes=0;for(const record of this.records.values())if(record.credit)bytes+=record.credit.bytes;return bytes}
}

module.exports={MeasurementDeliveryClient}
