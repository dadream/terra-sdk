const path = require('path')
const {Worker} = require('worker_threads')
const {TerraAbi} = require('../../../adapters/wasm/terra_abi')
const {TerrainWorkerClient} = require('../../../adapters/wasm/terra_worker_client')
const loader = require('../../../adapters/wasm/terra_wasm')

// Each contract owns its actual Wasm instance or protocol Worker and awaits
// termination in finally. No shared controller or synthetic native owner.
module.exports = async function createOwner(bytes, worker) {
  if (!worker) return new TerraAbi(await loader.instantiateTerraWasmBytes(bytes))
  const host=path.resolve(__dirname,'../../../adapters/wasm/terra_worker_host')
  const thread=new Worker(`
    const {parentPort, MessageChannel}=require('worker_threads')
    const scope={MessageChannel,postMessage:(value,transfer)=>parentPort.postMessage(value,transfer)}
    require(${JSON.stringify(host)}).install(scope)
    parentPort.on('message',value=>scope.onmessage({data:value}))
  `,{eval:true})
  const adapter={postMessage:(value,transfer)=>thread.postMessage(value,transfer),terminate:()=>thread.terminate()}
  thread.on('message',value=>adapter.onmessage({data:value}))
  thread.on('error',error=>adapter.onerror(error))
  try {
    return await TerrainWorkerClient.create({workerFactory:()=>adapter,wasmBytes:Uint8Array.from(bytes).buffer})
  } catch(error){await thread.terminate();throw error}
}
