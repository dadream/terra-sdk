const assert=require('assert')
const {MessageChannel}=require('worker_threads')
const {MeasurementSender,MeasurementReceiver}=require('../../adapters/wasm/measurement_transport')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {MeasurementRows,MeasurementLoans,releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')
const {transferList}=require('../../adapters/wasm/terra_worker_host')

function plain(values) {
  return values.map(value=>{
    const output={...value}
    if(value.regions)output.regions=Array.from({length:value.regions.length},(_,i)=>{
      const rows=value.regions,n=j=>rows.number(i,j),flags=rows.flags(i)
      const row={uv:{minimumU:n(0),minimumV:n(1),maximumU:n(2),maximumV:n(3)},pixelsPerUv:n(4)}
      if(flags&1)row.projection=Array.from({length:9},(_,j)=>n(5+j))
      if(flags&2)row.triangle=Array.from({length:3},(_,j)=>[n(14+j*2),n(15+j*2)])
      if(flags&4)row.numeratorBound=n(20)
      if(rows.domain(i)!==0xffffffff)row.domain=rows.domain(i)
      return row
    })
    return output
  })
}
function fill(sender,values,keep,ledger) {
  const work=sender.begin(values,keep),quote=work.quote()
  assert.throws(()=>work.step(),/funded/)
  assert.strictEqual(work.buffers.length,0)
  assert.throws(()=>work.grant(quote.bytes-1),/grant/)
  const credit=ledger.reserve('measurement-wire',quote.bytes)
  assert(credit)
  work.grant(quote.bytes)
  let step
  do{step=work.step(7);assert(step.rows<=7)}while(!step.done)
  return {work,packet:work.packet(),credit,quote}
}
module.exports=async function verifyMeasurementTransport() {
  const ledger=new ResourceLedger(),sender=new MeasurementSender(),forgotten=[]
  const receiver=new MeasurementReceiver(ledger,items=>{forgotten.push(...items);sender.forget(items)})
  const uv={minimumU:0,minimumV:-0,maximumU:1,maximumV:1}
  const projected={uv,pixelsPerUv:Infinity,projection:[0,8,0,0,0,4,1,0.5,0.25],triangle:[[0,0],[1,0],[0,1]],domain:335}
  const source=[{resourceId:17,pixelsPerUv:Infinity,visible:true,centerDistance:0,bounds:uv,
    hull:[[0,0],[1,0],[0,1]],regions:[projected,{uv,pixelsPerUv:100,projection:[0,8,0,0,0,4,1,0.5,0.25],numeratorBound:9},
      {uv,pixelsPerUv:-0,domain:0}]},
  {resourceId:23,pixelsPerUv:0,visible:false,centerDistance:Infinity,regions:[]},
  {resourceId:42,pixelsPerUv:100,visible:true,regions:undefined},
  {resourceId:77,pixelsPerUv:64,visible:true,regions:[{uv,pixelsPerUv:64}]}]
  const keep=source.map(m=>m.resourceId),snapshots=[]
  const deliver=values=>{
    const sent=fill(sender,values,keep,ledger)
    sent.work.commit()
    const result=receiver.receive(sent.packet,sent.credit);snapshots.push(result)
    return {sent,result}
  }
  try {
    const sent=fill(sender,source,keep,ledger)
    assert.deepStrictEqual(sent.packet.buffers.map(v=>v.byteLength),[3*176,176])
    const row=new DataView(sent.packet.buffers[0].buffer)
    assert.strictEqual(row.getUint32(168,true),3);assert.strictEqual(row.getUint32(172,true),335)
    assert(Object.is(row.getFloat64(8,true),-0));assert.strictEqual(row.getUint32(176+172,true),0xffffffff)
    const channel=new MessageChannel()
    let decoded
    try {
      const received=new Promise((resolve,reject)=>{channel.port2.once('message',resolve);channel.port2.once('messageerror',reject)})
      const transfers=transferList({measurements:sent.packet})
      assert.strictEqual(transfers.length,2)
      channel.port1.postMessage(sent.packet,transfers)
      assert(sent.packet.buffers.every(v=>v.byteLength===0),'Numeric backing allocations were cloned')
      sent.work.commit();decoded=receiver.receive(await received,sent.credit);snapshots.push(decoded)
      assert(decoded[0].regions instanceof MeasurementRows)
      assert.deepStrictEqual(plain(decoded),source)
    }finally{channel.port1.close();channel.port2.close()}
    const old=decoded[0].regions
    const repeat=deliver(source)
    assert.strictEqual(repeat.sent.quote.bytes,0)
    assert.strictEqual(repeat.result[0].regions,old,'Immutable regions were rebuilt')
    const metadata=source.map(v=>({...v,centerDistance:9}))
    assert.strictEqual(deliver(metadata).sent.quote.bytes,0)
    assert.deepStrictEqual(plain(snapshots[snapshots.length-1]),metadata)
    const changed=metadata.map(v=>v.resourceId===17?{...v,regions:v.regions.map(r=>({...r,pixelsPerUv:12}))}:v)
    const update=deliver(changed)
    assert.strictEqual(update.sent.quote.bytes,3*176)
    assert.notStrictEqual(update.result[0].regions,old)
    assert.strictEqual(old.number(0,4),Infinity,'New revision mutated borrowed old evidence')
    assert.deepStrictEqual(plain(update.result),changed)
    // Reject corrupt references atomically. The untouched original packet can
    // still prove that the previous cache and sequence were not partly changed.
    const transaction=fill(sender,changed,keep,ledger),before=receiver.regions,sequence=receiver.sequence
    const corrupt={...transaction.packet,entries:transaction.packet.entries.map((e,i)=>i?e:{...e,regionRevision:1})}
    assert.throws(()=>receiver.receive(corrupt),/Unknown measurement reference/)
    assert.strictEqual(receiver.sequence,sequence);assert.strictEqual(receiver.regions,before)
    transaction.work.commit()
    const accepted=receiver.receive(transaction.packet,transaction.credit);snapshots.push(accepted)
    assert.deepStrictEqual(plain(accepted),changed)
    // Cancellation before and after partial copying does not establish an
    // unsent reference. No payload survives the abandoned work.
    sender.clear();receiver.clear()
    const cancelled=sender.begin(source,keep),quote=cancelled.quote()
    cancelled.cancel();assert.strictEqual(sender.active,null)
    const partial=sender.begin(source,keep),lease=ledger.reserve('partial-wire',quote.bytes)
    partial.grant(quote.bytes);assert(!partial.step(1).done);partial.cancel();lease.release()
    assert.strictEqual(sender.regions.size,0)
  }finally {
    for(const values of snapshots)releaseMeasurements(values)
    sender.clear();receiver.clear()
  }
  assert.strictEqual(ledger.bytes,0)
  // A small retained mesh does not pin the backing of an unrelated dense mesh.
  const bounded=new ResourceLedger(4*176),outgoing=new MeasurementSender(),incoming=new MeasurementReceiver(bounded,
    items=>outgoing.forget(items)),display=new MeasurementLoans()
  const first=fill(outgoing,[source[0],source[3]],[17,77],bounded)
  first.work.commit();const values=incoming.receive(first.packet,first.credit)
  display.replace([values[1]]);releaseMeasurements(values)
  const onlyDense=bounded.reserve('next-mirror',3*176)
  assert(onlyDense);assert.strictEqual(incoming.stats().ownedBytes,176)
  assert.throws(()=>values[0].regions.number(0,0),/retired/)
  assert.strictEqual(values[1].regions.number(0,4),64)
  const next=outgoing.begin([source[0],source[3]],[17,77]),pins=incoming.pin(next.quote().references)
  assert.strictEqual(next.bytes,3*176);assert.deepStrictEqual(pins.missing,[])
  next.grant(onlyDense.bytes);while(!next.step().done){};const packet=next.packet();next.commit()
  const replacement=incoming.receive(packet,onlyDense);releaseMeasurements(replacement);pins.release()
  incoming.clear();assert.strictEqual(bounded.bytes,176,'Cache clear refunded active display evidence')
  display.clear();assert.strictEqual(bounded.bytes,0)
  console.log('Measurement transport: funded per-mesh buffers, exact transfer, immutable deltas, atomic rejection, cancellation and independent display loans passed')
}
