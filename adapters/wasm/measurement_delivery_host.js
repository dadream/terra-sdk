const {invariant}=require('../../sdk/js/core/terra_globe_common')
const {MeasurementSender}=require('./measurement_transport')
const {NativeMeasurementLoans,releaseNativeMeasurements}=require('./native_surface_measurement')
const {Cleanup}=require('../../sdk/js/runtime/cleanup')

// The native/JS producer may finish before the host can fund its mirror. Keep
// that immutable response, not a second running RPC, until grant or cancellation.
// Measurement sequence publication is serialized, independent of RPC order.
class MeasurementDeliveryHost {
  constructor(callbacks){this.callbacks=callbacks;this.sender=new MeasurementSender();this.queue=[]}
  enqueue(message,value,progress,retainedIds) {
    if(this.stopped){releaseNativeMeasurements(value.measurements);this.callbacks.publish(message,{superseded:true},false,null);this.callbacks.finished(message,false);return}
    const inputs=new NativeMeasurementLoans()
    try {
      inputs.replace(value.measurements.map(value=>value.regions))
      this.queue.push({message,value,progress,retainedIds:Array.from(retainedIds),work:null,quoted:false,inputs})
    }catch(error){inputs.clear();throw error}
    finally{releaseNativeMeasurements(value.measurements)}
  }
  hasWork() {
    const head=this.queue[0]
    return Boolean(head&&(!head.work||!head.quoted||head.message.cancelled||head.work.granted))
  }
  grant(id,bytes) {
    const head=this.queue[0]
    if(!head||!head.work||head.work.id!==id||head.message.cancelled)return false
    head.work.grant(bytes);return true
  }
  resend(id,missing) {
    const head=this.queue[0]
    if(!head||!head.work||head.work.id!==id||head.message.cancelled)return false
    invariant(!head.work.granted&&Array.isArray(missing)&&missing.length,'Invalid measurement resend')
    invariant(missing.every(ref=>head.work.references.some(old=>old.id===ref.id&&old.revision===ref.revision)),
      'Measurement resend does not match its quote')
    head.work.cancel();this.sender.forget(missing);head.work=null;head.quoted=false
    return true
  }
  forget(items){this.sender.forget(items)}
  cancel(id) {
    const record=this.queue.find(value=>value.work&&value.work.id===id)
    if(record)record.message.cancelled=true
    return Boolean(record)
  }
  async tick() {
    const record=this.queue[0]
    if(!record)return
    try {
      if(record.message.cancelled) {
        if(record.work)record.work.cancel()
        await this.callbacks.cancel(record.message)
        record.inputs.clear()
        this.callbacks.publish(record.message,{superseded:true},false,
          record.quoted?{id:record.work.id,bytes:0,cancelled:true}:null)
        this.finish(record,false);return
      }
      if(!record.work)record.work=this.sender.begin(record.value.measurements,record.retainedIds)
      if(!record.quoted) {
        record.quoted=true;this.callbacks.quote(record.message,record.work.quote());return
      }
      if(!record.work.granted)return
      if(!record.work.step(256).done)return
      const packet=record.work.packet()
      record.inputs.clear() // The active Sender owns the rows through transfer/commit.
      this.callbacks.publish(record.message,Object.assign({},record.value,{measurements:packet}),record.progress,
        {id:record.work.id,bytes:record.work.bytes})
      // Test transports and in-process bridges can synchronously close during
      // publication. The already-delivered owner then belongs to the receiver.
      if(record.work.finished)return
      record.work.commit();this.finish(record,record.progress)
    }catch(error) {
      // An uncertain postMessage is not a zero-byte receipt. A FIFO stop
      // barrier must drain transferred host events before grants can refund.
      const records=this.queue;this.queue=[]
      const cleanup=new Cleanup();cleanup.capture(error)
      for(const value of records) {
        if(value.work)cleanup.run(()=>value.work.cancel())
        cleanup.run(()=>value.inputs.clear())
      }
      cleanup.run(()=>this.sender.clear());this.callbacks.fatal(cleanup.error)
    }
  }
  finish(record,progress) {
    invariant(this.queue[0]===record,'Measurement response order changed')
    this.queue.shift();record.inputs.clear();this.callbacks.finished(record.message,progress)
  }
  reset() {
    const records=this.queue;this.queue=[]
    const cleanup=new Cleanup();cleanup.run(()=>this.sender.clear())
    for(const record of records) {
      if(record.work)cleanup.run(()=>record.work.cancel())
      cleanup.run(()=>record.inputs.clear())
      cleanup.run(()=>this.callbacks.publish(record.message,{superseded:true},false,
        record.quoted?{id:record.work.id,bytes:0,cancelled:true}:null))
      cleanup.run(()=>this.callbacks.finished(record.message,false))
    }
    cleanup.finish()
  }
  close() {
    this.stopped=true
    const released=[]
    for(const record of this.queue)if(record.work&&record.quoted)released.push(record.work.id)
    const records=this.queue;this.queue=[]
    const cleanup=new Cleanup();for(const record of records) {
      if(record.work)cleanup.run(()=>record.work.cancel())
      cleanup.run(()=>record.inputs.clear())
    }
    cleanup.run(()=>this.sender.clear());cleanup.finish()
    return released
  }
}

module.exports={MeasurementDeliveryHost}
