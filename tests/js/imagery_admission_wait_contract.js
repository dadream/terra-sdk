const assert=require('assert')
const {PartitionGroups}=require('../../adapters/webgl/partition_groups')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')

module.exports=async function(makeStore,tick) {
  const roots=[0,1].map(column=>({level:0,matrix:1,row:0,column}))
  const store=makeStore({maximumBytes:16*1024*1024,maximumEntries:1024,maximumConcurrent:4,
    prefetchAncestors:true,coverageTiles:roots}),r=store.renderer
  Object.assign(r,{textures:store,current:{},renderDraws:[],partitionGeneration:1,partitionQueue:[],partitionUploads:[],
    partitionBytes:0,partitionReservedBytes:0,partitionCpuBytes:0,partitionCapacityBytes:1024*1024,
    prunePartitions(){},geometryPinnedKeys:new Set(),meshOutputPlan:{accepted:true}})
  const groups=r.partitionGroups=new PartitionGroups(r)
  const tiles=Array.from({length:8},(_,i)=>({level:1,matrix:2,row:i%2,column:Math.floor(i/2)}))
  let probes=0,starts=0
  const reserve=store.reserveRequest.bind(store)
  store.reserveRequest=id=>{++probes;return reserve(id)}
  store.requestAsset=(url,reservation)=>{
    ++starts
    assert(reservation&&store.cache.reservedBytes>0&&store.pipelineBytes()>0,'A queue hint bypassed image/workspace admission')
    let cancel
    return {promise:new Promise((resolve,reject)=>{cancel=()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'}))}),abort(){cancel()}}
  }
  try {
    for(const root of roots)store.cache.set(key(root),
      {texture:{},width:16,height:16},store.requestBytes())
    store.sync(tiles.map(texture=>({texture})),[])
    const protectedKeys=Array.from(store.protectedKeys).sort()
    for(let receipt=0;receipt<16;++receipt){store.dependenciesChanged();store.advance();await tick()}
    assert.strictEqual(probes,0,'A known terrain handoff repeatedly entered complete footprint admission')
    assert.strictEqual(starts,0)
    assert(tiles.every(t=>store.frontierKeys.has(key(t))), 'Parking dropped target demand')
    assert.deepStrictEqual(Array.from(store.protectedKeys).sort(),protectedKeys)
    // A private successor is not the displayed surface's dependency. Keep
    // current, fully owned inputs loading while that successor is prepared.
    r.meshOutputPlan={accepted:false};groups.wakeImagery()
    for(let n=0;n<40&&!starts;++n){groups.advanceSelection();await tick()}
    assert(starts>0,'A private terrain successor starved paid imagery for the current surface')
    assert.strictEqual(r.resourceLedger.stats().overBudgetBytes,0)
  } finally {groups.clear();store.destroy();await tick();await tick()}
  assert.strictEqual(r.resourceLedger.bytes,0,'Queued or active image work survived destruction')
}
