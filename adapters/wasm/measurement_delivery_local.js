const {MeasurementSender,MeasurementReceiver}=require('./measurement_transport')
const {releaseNativeMeasurements}=require('./native_surface_measurement')
const {Cleanup}=require('../../sdk/js/runtime/cleanup')

// The Direct client uses the same packed host evidence and byte ownership.
// Only the grant and receipt stay in this executor rather than crossing IPC.
class LocalMeasurementDelivery {
  constructor(ledger) {
    this.ledger=ledger;this.sender=new MeasurementSender()
    this.receiver=new MeasurementReceiver(ledger,items=>this.sender.forget(items))
  }
  async publish(value,retainedIds,turn,cancelled) {
    if(!value.measurements)return value
    let credit,pins,work
    const cleanup=new Cleanup()
    try {
      work=this.sender.begin(value.measurements,retainedIds)
      pins=this.receiver.pin(work.quote().references)
      if(pins.missing.length) {
        work.cancel();this.sender.forget(pins.missing);pins.release()
        work=this.sender.begin(value.measurements,retainedIds);pins=this.receiver.pin(work.quote().references)
      }
      if(work.bytes) {
        const refusal={}
        const reserve=()=>this.ledger.reserve('imagery-measurement-wire',work.bytes,[],[],[],refusal)
        credit=reserve()
        if(!credit){await this.ledger.reclamation.pending;if(!cancelled())credit=reserve()}
        if(!credit)throw Object.assign(new Error('Measurement mirror capacity is occupied'),
          {status:9,capacityShortfallBytes:refusal.shortfallBytes,capacityRevision:this.ledger.availabilityRevision})
      }
      if(cancelled())return {superseded:true}
      work.grant(work.bytes)
      this.active={work,credit}
      while(!work.step(256).done) {
        await turn.wait()
        if(cancelled())return {superseded:true}
      }
      const packet=work.packet();work.commit()
      const measurements=this.receiver.receive(packet,credit);credit=null
      return Object.assign({},value,{measurements})
    }catch(error){cleanup.capture(error)}finally {
      if(work&&!work.finished)cleanup.run(()=>work.cancel())
      if(credit)cleanup.run(()=>credit.release())
      if(pins)cleanup.run(()=>pins.release())
      cleanup.run(()=>releaseNativeMeasurements(value.measurements))
      this.active=null
      cleanup.finish()
    }
  }
  close() {
    const active=this.active,cleanup=new Cleanup();this.active=null
    if(active){cleanup.run(()=>active.work.cancel());if(active.credit)cleanup.run(()=>active.credit.release())}
    cleanup.run(()=>this.sender.clear());cleanup.run(()=>this.receiver.clear());cleanup.finish()
  }
}

module.exports={LocalMeasurementDelivery}
