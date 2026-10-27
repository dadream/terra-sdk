const assert=require('assert')
const {MessageChannel,receiveMessageOnPort}=require('worker_threads')
const {MeasurementDeliveryHost}=require('../../adapters/wasm/measurement_delivery_host')
const {MeasurementDeliveryClient}=require('../../adapters/wasm/measurement_delivery_client')
const {LocalMeasurementDelivery}=require('../../adapters/wasm/measurement_delivery_local')
const {MeasurementSender,MeasurementReceiver}=require('../../adapters/wasm/measurement_transport')
const {TerrainWorkerClient}=require('../../adapters/wasm/terra_worker_client')
const {transferList}=require('../../adapters/wasm/terra_worker_host')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {MeasurementRows,MeasurementLoans,releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')

const uv={minimumU:0,minimumV:0,maximumU:1,maximumV:1}
const measurement=(id,count)=>({resourceId:id,visible:true,pixelsPerUv:64,bounds:uv,
  hull:[[0,0],[1,0],[0,1]],regions:Array.from({length:count},(_,domain)=>({uv,pixelsPerUv:64,domain}))})
const flush=async()=>{for(let i=0;i<4;++i)await Promise.resolve()}
function bridge(maximumBytes=0) {
  const ledger=new ResourceLedger(maximumBytes),controls=[],received=[],quotes=[],events=[]
  const channel=new MessageChannel()
  let host
  const receiver=new MeasurementReceiver(ledger,items=>controls.push({type:'measurement-forget',items}))
  const client=new MeasurementDeliveryClient(receiver,{post:message=>controls.push(message),fatal:error=>{throw error}})
  host=new MeasurementDeliveryHost({
    quote:(message,quote)=>{quotes.push(quote);client.quote(message.id,quote)},
    publish:(message,value,progress,receipt)=>{
      channel.port1.postMessage(value,transferList(value))
      const packet=receiveMessageOnPort(channel.port2).message
      received.push({id:message.id,progress,...client.receive(message.id,receipt,packet.measurements)})
    },
    cancel:message=>events.push(['cancel',message.id]),
    finished:(message,progress)=>events.push(['finished',message.id,progress]),
    fatal:error=>{throw error}
  })
  function control() {
    while(controls.length) {
      const message=controls.shift()
      if(message.type==='measurement-grant')host.grant(message.workId,message.bytes)
      else if(message.type==='measurement-cancel')host.cancel(message.workId)
      else if(message.type==='measurement-resend')host.resend(message.workId,message.missing)
      else if(message.type==='measurement-forget')host.forget(message.items)
      else throw new Error('Unexpected measurement control')
    }
  }
  async function finish() {
    for(let i=0;i<32&&host.queue.length;++i) {
      await flush();control();if(host.hasWork())await host.tick()
    }
    assert.strictEqual(host.queue.length,0,'Funded delivery failed to finish')
    return received[received.length-1]
  }
  function close() {
    host.close();client.stopped();receiver.clear()
    for(const item of received)releaseMeasurements(item.values)
    channel.port1.close();channel.port2.close()
    assert.strictEqual(ledger.bytes,0)
  }
  return {host,client,receiver,ledger,controls,received,quotes,events,control,finish,close}
}

module.exports=async function verifyMeasurementDelivery() {
  await require('./completed_measurement_cache_contract')()
  const source=[measurement(1,600),measurement(2,1)],ids=[1,2],b=bridge()
  try {
    b.host.enqueue({id:10},{measurements:source},true,ids)
    await b.host.tick();await flush()
    assert.strictEqual(b.host.queue[0].work.buffers.length,0,'Quote allocated an unfunded destination')
    assert.strictEqual(b.ledger.bytes,601*176)
    assert(!b.host.hasWork(),'A quote waiting for its grant requested idle pumping')
    b.control();await b.host.tick()
    assert.strictEqual(b.host.queue[0].work.row,256,'A copy turn exceeded its row bound')
    b.host.cancel(b.quotes[0].id)
    assert.strictEqual(b.ledger.bytes,601*176,'Cancellation intent refunded an active buffer')
    await b.host.tick()
    assert.strictEqual(b.ledger.bytes,0)
    assert(b.received[0].cancelled)
    assert.strictEqual(b.host.sender.sequence,0,'Cancellation taught the sender an unobserved reference')
    b.host.enqueue({id:11},{measurements:source},false,ids)
    b.host.enqueue({id:12},{measurements:source},false,ids)
    const complete=await b.finish()
    assert.deepStrictEqual(b.quotes.map(q=>q.bytes),[601*176,601*176,0])
    assert(complete.values[0].regions instanceof MeasurementRows)
    assert.strictEqual(complete.values[0].regions,b.received[1].values[0].regions)
    assert.strictEqual(complete.values[0].regions.domain(599),599)
    assert.deepStrictEqual(b.events.filter(e=>e[0]==='finished').map(e=>e[1]),[10,11,12])
    const loans=new MeasurementLoans();loans.replace(complete.values)
    for(const item of b.received)releaseMeasurements(item.values)
    b.client.retire();assert.strictEqual(b.ledger.bytes,601*176,'Retirement refunded display-borrowed data')
    loans.clear();assert.strictEqual(b.ledger.bytes,0)
  }finally{b.close()}

  // A forget can cross a new quote. The receiver asks for a fresh immutable
  // publication, rather than re-running terrain or accepting a stale reference.
  const r=bridge(4*176),display=new MeasurementLoans(),small=[measurement(1,3),measurement(2,1)]
  let pressure
  try {
    r.host.enqueue({id:1},{measurements:small},false,ids)
    const first=await r.finish();display.replace([first.values[1]]);releaseMeasurements(first.values)
    pressure=r.ledger.reserve('pressure',3*176);assert(pressure)
    assert.strictEqual(r.receiver.stats().ownedBytes,176)
    r.host.enqueue({id:2},{measurements:small},false,ids)
    await r.host.tick();await flush()
    assert(r.controls.some(m=>m.type==='measurement-resend'))
    assert.strictEqual(r.client.records.size,0,'Missing-reference quote received credit')
    pressure.release();pressure=null
    r.control();const next=await r.finish()
    assert(next.values[0].regions instanceof MeasurementRows)
    assert.strictEqual(next.values[1].regions,first.values[1].regions)
    assert.deepStrictEqual(r.quotes.map(q=>q.bytes),[704,0,528])
    assert.strictEqual(r.quotes[1].sequence,r.quotes[2].sequence)
  }finally{if(pressure)pressure.release();display.clear();r.close()}

  // A passive retained mesh is part of the next packet's keep set even when
  // this response has no entry for it. Hold a real cache-reclamation notice
  // behind the already issued grant to reproduce opposite-direction traffic.
  const retained=bridge(3*176),pair=[measurement(1,1),measurement(2,1)]
  let competing
  try {
    retained.host.enqueue({id:1},{measurements:pair},false,ids)
    const first=await retained.finish();releaseMeasurements(first.values)
    retained.host.enqueue({id:2},{measurements:[pair[0]]},false,ids)
    await retained.host.tick();await flush();retained.control()
    competing=retained.ledger.reserve('concurrent-production',2*176)
    // Do not deliver the forget before the older packet. A correct grant pins
    // every claimed reference, so pressure cannot evict the passive row here.
    await retained.host.tick()
    assert(retained.receiver.regions.has(2),'An issued measurement quote lost its retained-only payload')
    assert.strictEqual(competing,null,'A publication left part of its keep set reclaimable')
    assert.deepStrictEqual(retained.quotes[1].references.map(value=>value.id).sort(),[1,2])
    assert.strictEqual(retained.receiver.sequence,2)
  }finally{if(competing)competing.release();retained.close()}

  const refused=bridge(175)
  try {
    refused.host.enqueue({id:1},{measurements:[measurement(1,1)]},false,[1])
    await refused.host.tick();await flush()
    assert.strictEqual(refused.client.records.size,1,'Capacity refusal closed before its source receipt')
    assert.strictEqual(refused.host.queue[0].work.buffers.length,0)
    refused.control();await refused.host.tick()
    assert.strictEqual(refused.received[0].error.status,9)
    assert.strictEqual(refused.received[0].error.capacityShortfallBytes,1)
    assert.strictEqual(refused.received[0].error.capacityRevision,refused.ledger.availabilityRevision)
    assert.strictEqual(refused.client.records.size,0)
  }finally{refused.close()}

  // The same 176-byte publication is one byte short in either executor.
  // Refusal must quote the deficit without allocating or retaining its rows.
  const shortLedger=new ResourceLedger(175),shortLocal=new LocalMeasurementDelivery(shortLedger)
  try {
    await assert.rejects(shortLocal.publish({measurements:[measurement(1,1)]},[1],
      {wait:async()=>{throw new Error('Unfunded rows were copied')}},()=>false),
    error=>error.status===9&&error.capacityShortfallBytes===1&&
      error.capacityRevision===shortLedger.availabilityRevision)
    assert.strictEqual(shortLocal.active,null)
    assert.strictEqual(shortLocal.receiver.stats().ownedBytes,0)
  }finally{shortLocal.close()}
  assert.strictEqual(shortLedger.bytes,0)

  const localLedger=new ResourceLedger(),local=new LocalMeasurementDelivery(localLedger)
  let turns=0,cancelled=false,resume
  try {
    const value=await local.publish({measurements:source},ids,{wait:async()=>{++turns}},()=>cancelled)
    assert.strictEqual(turns,2)
    assert(value.measurements[0].regions instanceof MeasurementRows)
    const again=await local.publish({measurements:source},ids,{wait:async()=>{throw new Error('Delta copied rows')}},()=>false)
    assert.strictEqual(again.measurements[0].regions,value.measurements[0].regions)
    releaseMeasurements(value.measurements);releaseMeasurements(again.measurements)
    const operation=local.publish({measurements:[measurement(3,600)]},[3],
      {wait:()=>new Promise(resolve=>{resume=resolve})},()=>cancelled)
    assert(resume&&local.active.work.buffers.length)
    cancelled=true;local.close();resume()
    assert((await operation).superseded)
  }finally{local.close()}
  assert.strictEqual(localLedger.bytes,0)

  // Destruction drains already transferred events before stopping the Worker.
  // A missing stop receipt retains its unknown wire grant even after terminate.
  for(const receipt of [true,false]) {
    const ledger=new ResourceLedger(),sent=[]
    const source=new MeasurementSender(),work=source.begin([measurement(1,1)],[1])
    let late,channel
    let terminated=0
    const client=new TerrainWorkerClient({postMessage:message=>sent.push(message),terminate(){++terminated}},
      {workerTimeoutMs:15})
    client.setResourceLedger(ledger)
    const response=client.send({type:'imagery'})
    const rejected=assert.rejects(response,/destroyed/)
    const header={memoryBytes:0,nativeRevision:0,nativeBytes:0,recordBytes:0,heightBytes:0,imageryBytes:0,
      imageryOutputBytes:0,indexBytes:0,imageryInputBytes:0,imageryReferenceBytes:0,imageryReferenceRevision:0}
    client.receive({...header,id:1,mirrorWork:work.quote()})
    await flush();assert.strictEqual(ledger.bytes,176)
    if(receipt) {
      const grant=sent[sent.length-1]
      work.grant(grant.bytes);assert(work.step().done)
      channel=new MessageChannel()
      const packet=work.packet()
      channel.port1.postMessage(packet,transferList(packet));work.commit()
      late=receiveMessageOnPort(channel.port2).message
    }
    const termination=client.destroy()
    assert.strictEqual(terminated,0)
    assert.strictEqual(sent[sent.length-1].type,'measurement-stop')
    if(receipt) {
      try {
        client.receive({id:1,mirrorReceipt:{id:work.id,bytes:work.bytes},value:{measurements:late}})
        assert.strictEqual(late.buffers.length,0,'Destroyed client retained its transferred wire aliases')
        assert.strictEqual(client.measurementReceiver.bytes,0,'Destroy adopted late data into a host cache')
        assert.strictEqual(ledger.bytes,0)
        assert.strictEqual(terminated,0,'A late packet bypassed the pending stop barrier')
      }finally{channel.port1.close();channel.port2.close()}
      client.receive({type:'native-ownership',measurementStopped:true})
      await termination
      assert.strictEqual(ledger.bytes,0)
    } else {
      await assert.rejects(termination,/no complete release receipt/)
      assert.strictEqual(ledger.bytes,176,'Unproven transfer was falsely reported released')
      // This fake source allocated nothing. Its eventual zero receipt is the
      // proof; termination intent was deliberately insufficient above.
      work.cancel()
      client.receive({id:1,mirrorReceipt:{id:1,bytes:0,cancelled:true},value:{superseded:true}})
      assert.strictEqual(ledger.bytes,0)
    }
    await rejected;assert.strictEqual(terminated,1)
  }
  console.log('Measurement delivery: pre-funded bounded publication, queued deltas, resend, refusal, Direct parity and FIFO stop receipts passed')
}
