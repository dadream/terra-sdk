const host=require('../../../adapters/wasm/terra_worker_host')
const {measurementFactory}=require('./measurement_production')
function TerrainWorkerHost(options={}){return new host.TerrainWorkerHost({...options,measurementFactory})}
// Existing control fixtures temporarily replace handle() to isolate FIFO
// scheduling. install() and direct fixtures must observe that same prototype.
TerrainWorkerHost.prototype=host.TerrainWorkerHost.prototype
module.exports={...host,TerrainWorkerHost,
  install:(scope,options={})=>host.install(scope,{...options,measurementFactory})}
