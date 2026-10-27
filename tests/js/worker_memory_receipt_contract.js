const assert=require('assert')
const {TerrainWorkerClient}=require('../../adapters/wasm/terra_worker_client')
const {WORKER_PROTOCOL}=require('../../adapters/wasm/worker_protocol')
const {MeshFrames}=require('../../sdk/js/terrain/terra_mesh_frames')

const header=memory=>({memoryBytes:memory.buffer.byteLength,nativeBytes:0,nativeRevision:0,
  recordBytes:0,heightBytes:0,imageryBytes:0,imageryInputBytes:0,imageryOutputBytes:0,indexBytes:0,
  imageryReferenceRevision:0,imageryReferenceBytes:0})

async function clientReceipts(Client) {
  const memory=new WebAssembly.Memory({initial:1,maximum:8}),sent=[]
  let terminated=false,finishTermination
  const client=new Client({postMessage:message=>sent.push(message),terminate(){
    terminated=true;return new Promise(resolve=>{finishTermination=resolve})}})
  try {
    client.receive({...header(memory),type:'native-ownership'})
    assert.strictEqual(client.memoryBytes(),memory.buffer.byteLength,
      'Worker ownership did not report actual Wasm capacity')
    const result=client.send({type:'imagery'})
    memory.grow(1)
    client.receive({...header(memory),id:sent[0].id,progress:true,value:{pending:true}})
    assert.strictEqual(client.memoryBytes(),memory.buffer.byteLength,'Imagery progress hid Wasm growth')
    memory.grow(1)
    client.receive({...header(memory),id:sent[0].id,value:{}})
    await result
    assert.strictEqual(client.memoryBytes(),memory.buffer.byteLength,'Image completion lost Wasm growth')
    memory.grow(1)
    client.receive({...header(memory),id:999,value:{superseded:true}})
    assert.strictEqual(client.memoryBytes(),memory.buffer.byteLength,'Cancelled RPC lost its memory receipt')
    const failure=client.send({type:'imagery'}),rejected=assert.rejects(failure,/image failed/)
    memory.grow(1)
    client.receive({...header(memory),id:sent[sent.length-1].id,error:'image failed'})
    await rejected
    assert.strictEqual(client.memoryBytes(),memory.buffer.byteLength,'Error reply hid allocated memory')
    // A newer ownership receipt may arrive before a resumed caller consumes
    // its older result. The result payload is never the memory authority.
    client.requestTerrain=async()=>{
      const old=client.memoryBytes();memory.grow(1)
      client.receive({...header(memory),type:'native-ownership'})
      return {memoryBytes:old}
    }
    await client.advanceTerrain(1,{})
    assert.strictEqual(client.memoryBytes(),memory.buffer.byteLength,'Old terrain result overwrote fresh memory')
    const latest=client.memoryBytes(),done=client.destroy()
    assert(terminated)
    assert.strictEqual(client.memoryBytes(),latest,'Destroy intent refunded an unterminated Wasm owner')
    finishTermination();await done
    assert.strictEqual(client.memoryBytes(),0,'Completed Worker termination retained memory')
  } finally {
    const done=client.destroy();if(finishTermination)finishTermination();await done
  }
  for(const bytes of [undefined,-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1,65535]) {
    let stopped=false
    const invalid=new Client({postMessage(){},terminate(){stopped=true}})
    invalid.receive({...header(memory),type:'native-ownership'})
    invalid.receive({...header(memory),memoryBytes:bytes,type:'native-ownership'})
    assert(stopped&&invalid.destroyed,'Invalid or decreasing Worker memory was accepted')
    await invalid.destroy()
  }
}

async function meshReceipt(Client) {
  const memory=new WebAssembly.Memory({initial:1,maximum:2}),frames=new MeshFrames()
  let client
  const worker={terminate(){},postMessage(message){
    queueMicrotask(()=>{
      let value
      if(message.type==='step')value={sequence:1,draws:[],missing:[],nativePlan:{id:1,
        residentBytes:0,additionalBytes:0,reclaimableBytes:0,maximumBytes:67108864}}
      else if(message.type==='materialize')value={frame:{sequence:1},draws:[],additions:[],
        textureAdditions:[],indices:new Uint16Array(0),memoryBytes:memory.buffer.byteLength}
      else if(message.type==='commit-mesh'){memory.grow(1);value={updateState:{}}}
      else value=true
      client.receive({...header(memory),id:message.id,value})
    })
  }}
  client=new Client(worker)
  try {
    await client.step(1,{},frames)
    assert.strictEqual(client.memoryBytes(),memory.buffer.byteLength,
      'Old mesh transfer overwrote the newer commit memory receipt')
  } finally {frames.clear();await client.destroy()}
}

async function hostReceipts(install) {
  const memory=new WebAssembly.Memory({initial:1,maximum:4}),responses=new Map(),idle=[]
  let next=1
  const fixture=require('./reference/native_mesh_fixture')
  const abi={...fixture,incrementalLayout:true,memoryBytes:()=>memory.buffer.byteLength,
    computeAtmosphere(fail){memory.grow(1);if(fail)throw new Error('allocation survived error');return true},
    destroy(){}}
  const scope={postMessage(message){
    const resolve=responses.get(message.id)
    if(resolve){responses.delete(message.id);resolve(message)}else idle.push(message)
  }}
  install(scope,{abi})
  const send=message=>new Promise(resolve=>{
    const id=next++;responses.set(id,resolve);scope.onmessage({data:{id,...message}})
  })
  try {
    let reply=await send({type:'initialize',protocol:WORKER_PROTOCOL})
    assert(!reply.error,reply.error)
    assert.strictEqual(reply.memoryBytes,memory.buffer.byteLength,'Worker initialization omitted memory ownership')
    reply=await send({type:'call',method:'computeAtmosphere',args:[false]})
    assert.strictEqual(reply.value,true)
    assert.strictEqual(reply.memoryBytes,memory.buffer.byteLength,'Non-terrain allocation omitted memory ownership')
    reply=await send({type:'call',method:'computeAtmosphere',args:[true]})
    assert.match(reply.error,/allocation survived error/)
    assert.strictEqual(reply.memoryBytes,memory.buffer.byteLength,'Worker error omitted actual heap growth')
    memory.grow(1)
    scope.onmessage({data:{type:'cancel-imagery',all:true}})
    for(let n=0;n<100&&!idle.length;++n)await new Promise(resolve=>setTimeout(resolve,0))
    assert.strictEqual(idle.length,1)
    assert.strictEqual(idle[0].memoryBytes,memory.buffer.byteLength,'Idle cancellation omitted memory ownership')
  } finally {await send({type:'destroy'})}
}

module.exports=async function(options={}) {
  const Client=options.Client||TerrainWorkerClient
  if(options.part!=='host'){await clientReceipts(Client);await meshReceipt(Client)}
  if(options.part!=='client')await hostReceipts(options.install||require('./reference/measurement_host_fixture').install)
  console.log('Worker memory receipts: real growth, progress/error/cancellation, stale continuations and actual termination passed')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
