const assert=require('assert')
const path=require('path')
const {Worker}=require('worker_threads')
const {TerraAbi}=require('../../adapters/wasm/terra_abi')
const {TerrainWorkerClient}=require('../../adapters/wasm/terra_worker_client')
const {WORKER_PROTOCOL}=require('../../adapters/wasm/worker_protocol')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')

const manifest={formatVersion:1,patchDimension:8,transform:'cylindrical',heightScale:1,
  minimumU:-180,minimumV:-90,maximumU:180,maximumV:90,radius:6378000,
  texture:{kind:'global-geodetic',matrix_level_offset:0,minimum_level:0,maximum_level:8,
    tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]}}

async function bounded(promise,label) {
  let timer
  try{return await Promise.race([promise,new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+' timed out')),10000)
  })])}finally{clearTimeout(timer)}
}

module.exports=async function verifyAbiTeardown(module,wasmBytes) {
  // Observe real malloc/free calls independently of the ABI's registry. A late
  // iterator finally must not free a pointer the owner already disposed.
  const allocate=module.alloc.bind(module),free=module.free.bind(module),call=module.call.bind(module)
  const live=new Set(),counts=new Map()
  module.alloc=bytes=>{const pointer=allocate(bytes);assert(!live.has(pointer));live.add(pointer);return pointer}
  module.free=pointer=>{assert(live.delete(pointer),'Real Wasm allocation was freed twice');counts.set(pointer,(counts.get(pointer)||0)+1);return free(pointer)}
  try {
    for(const trapped of [false,true]) {
      const abi=new TerraAbi(module),ledger=new ResourceLedger(4*1024*1024)
      abi.setResourceLedger(ledger);abi.loadManifest(manifest)
      const credit=abi.beginImageryInput(128),pointer=abi.alloc(128,'imagery-input');credit.release()
      const failure=new Error(trapped?'fault after native delete':'cancel callback failed')
      const owner=abi.createImageryScratch(()=>{if(!trapped)throw failure})
      owner.request(64);owner.allocate()
      const held=ledger.bytes
      let deleted=0
      module.call=(name,...args)=>{
        const value=call(name,...args)
        if(name==='terra_destroy'){
          ++deleted;assert.strictEqual(live.size,0,'Raw buffers survived context deletion')
          assert(ledger.bytes>0,'Native producer credit was refunded before receipt')
          if(trapped)throw failure
        }
        return value
      }
      try {
        module.exports.memory.grow(1)
        assert.throws(()=>abi.destroy(),error=>error===failure)
        assert.strictEqual(deleted,1);assert.strictEqual(abi.context,0)
        assert.strictEqual(abi.nativeAllocations.size,0);assert.strictEqual(live.size,0)
        const freed=counts.get(pointer)
        abi.free(pointer);assert.strictEqual(counts.get(pointer),freed)
        if(trapped) {
          assert.strictEqual(ledger.bytes,held,'A thrown native receipt falsely refunded the producer')
          assert.throws(()=>abi.destroy(),error=>error===failure)
          assert.strictEqual(deleted,1,'Uncertain native delete was repeated')
        }else{assert.strictEqual(ledger.bytes,0);abi.destroy()}
      }finally{
        module.call=call
        // The test boundary injected its exception after the real void delete
        // returned and all observed mallocs were freed. This fixture alone has
        // that independent confirmation; production correctly does not infer it.
        if(trapped)for(const name of ['nativeBudget','recordBudget','heightBudget','imageryInputBudget','imageryReferenceBudget','imageryOutputBudget'])abi[name].close()
      }
      assert.strictEqual(ledger.bytes,0)
    }
  }finally{module.alloc=allocate;module.free=free;module.call=call}

  // A real Worker sends a fatal control packet after a failed native teardown.
  // Delay exposing its actual exit receipt: credits must remain until receipt.
  const worker=new Worker(`
    const {parentPort,workerData,MessageChannel}=require('worker_threads')
    const loader=require(workerData.loader)
    ;(async()=>{
      const module=await loader.instantiateTerraWasmBytes(workerData.bytes)
      const {TerraAbi}=require(workerData.abi),abi=new TerraAbi(module)
      abi.loadManifest(workerData.manifest)
      const owner=abi.createImageryScratch();owner.request(64);owner.allocate()
      const call=module.call.bind(module)
      module.call=(name,...args)=>{const value=call(name,...args);if(name==='terra_destroy')throw new Error('fault after native delete');return value}
      const scope={MessageChannel,postMessage:(value,transfer)=>parentPort.postMessage(value,transfer)}
      require(workerData.host).install(scope,{abi})
      parentPort.on('message',data=>scope.onmessage({data}))
      parentPort.postMessage({readyForInitialize:true})
    })().catch(error=>{throw error})
  `,{eval:true,workerData:{bytes:wasmBytes,manifest,
    loader:path.resolve(__dirname,'../../adapters/wasm/terra_wasm.js'),
    abi:path.resolve(__dirname,'../../adapters/wasm/terra_abi.js'),
    host:path.resolve(__dirname,'../../adapters/wasm/terra_worker_host.js')}})
  let releaseReceipt,actualExit,client
  const ready=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)})
  try {
    assert((await bounded(ready,'Worker setup')).readyForInitialize)
    let fatal
    const crashed=new Promise(resolve=>{fatal=resolve})
    const transport={postMessage:(message,transfer)=>worker.postMessage(message,transfer),
      terminate(){actualExit=worker.terminate();return actualExit.then(code=>new Promise(resolve=>{releaseReceipt=()=>resolve(code)}))}}
    Object.defineProperty(transport,'onmessage',{set(handler){worker.on('message',data=>handler({data}))}})
    Object.defineProperty(transport,'onerror',{set(handler){worker.on('error',error=>handler({message:error.message}))}})
    client=new TerrainWorkerClient(transport,{onFatal:fatal,workerTimeoutMs:10000})
    await bounded(client.send({type:'initialize',protocol:WORKER_PROTOCOL}),'Worker initialization')
    const ledger=new ResourceLedger(4*1024*1024)
    client.setResourceLedger(ledger)
    const held=ledger.bytes;assert(held>0)
    const request=client.send({type:'destroy'}).then(()=>{throw new Error('Faulted teardown was accepted')},error=>error)
    const error=await bounded(crashed,'fatal control')
    assert(/fault after native delete/.test(error.message))
    await bounded(actualExit,'actual Worker exit')
    assert.strictEqual(ledger.bytes,held,'Fatal packet or unexposed exit refunded the producer')
    releaseReceipt()
    await bounded(client.termination,'termination receipt')
    assert(/fault after native delete/.test((await request).message))
    assert.strictEqual(ledger.bytes,0);assert.strictEqual(client.pending.size,0)
  }finally{
    await worker.terminate()
    if(actualExit)await actualExit.catch(()=>{})
    if(releaseReceipt)releaseReceipt()
    if(client&&client.termination)await client.termination.catch(()=>{})
  }
  console.log('Real Wasm teardown: raw buffers, callback failures, uncertain native receipts and actual Worker termination passed')
}

if(require.main===module) {
  const fs=require('fs'),loader=require('../../adapters/wasm/terra_wasm'),bytes=fs.readFileSync(process.argv[2])
  loader.instantiateTerraWasmBytes(bytes).then(value=>module.exports(value,bytes))
    .catch(error=>{console.error(error);process.exitCode=1})
}
