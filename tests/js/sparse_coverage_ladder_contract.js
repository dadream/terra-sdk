const assert=require('assert')
const {ImageryPyramid}=require('../../sdk/js/imagery/terra_imagery_pyramid')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
module.exports=async function(makeStore,tick) {
  const leaf={level:17,matrix:18,row:50000,column:200000}
  const tree=new ImageryPyramid({coverageLevelStep:3}),resident=new Set()
  const demand=()=>{tree.begin();tree.addPath(leaf,1,true,true,id=>resident.has(id),1);tree.finish()}
  demand()
  assert.deepStrictEqual([...tree.desired.values()].map(t=>t.level),[0,3,6,9,12,15,17])
  assert.strictEqual([...tree.desired.values()].pop(),leaf,'Coverage changed final texture precision')
  for(const [id,tile]of tree.desired)if(tile.level===12)resident.add(id)
  demand()
  assert.deepStrictEqual([...tree.desired.values()].map(t=>t.level),[0,12,15,17],
    'Resident coverage unnecessarily downloaded its missing ancestors')
  resident.add(key(leaf));demand()
  assert.deepStrictEqual([...tree.desired.values()].map(t=>t.level),[0,17],
    'An already complete image was forced back through coarse levels')
  const direct=new ImageryPyramid();direct.begin();direct.addPath(leaf,1,true,true,()=>false,1)
  assert.deepStrictEqual([...direct.desired.values()].map(t=>t.level),[0,17])
  if(makeStore) {
    const store=makeStore({maximumBytes:16*1024*1024,prefetchAncestors:true,maximumConcurrent:8})
    store.scheduler.paused=true
    try {
      store.buildRequirementTree([{texture:leaf}]);store.recomputeAvailability()
      for(const tile of store.currentRoots.values())store.cache.set(key(tile),{texture:{},width:16,height:16},store.requestBytes())
      store.recomputeAvailability()
      const groups=()=>store.frontierGroups().flatMap(group=>[...group.children.values()])
      assert.deepStrictEqual(groups().map(tile=>tile.level),[3],
        'A cold leaf bypassed its sparse coarse coverage')
      const first=groups()[0]
      store.cache.set(key(first),{texture:{},width:16,height:16},store.requestBytes())
      store.recomputeAvailability()
      assert.deepStrictEqual(groups().map(tile=>tile.level),[6],
        'Completing one coverage rung did not release the next')
      let deliver
      const url=store.urlForTile(leaf)
      assert(store.sourceCache.start(url,65536,65536,()=>({
        promise:new Promise(resolve=>{deliver=resolve}),abort(){}})))
      await tick()
      assert(!groups().some(tile=>tile.level===leaf.level),'Unfinished encoded input bypassed coverage')
      deliver(new Blob([new Uint8Array(32)]));await tick()
      assert(groups().some(tile=>tile.level===leaf.level),
        'Downloaded fine imagery waited for an unnecessary intermediate image')
      assert.strictEqual(store.cache.reservations.size,0,'Skipping an ancestor bypassed actual GPU/UV admission')
      store.sourceCache.clear()
      assert(!groups().some(tile=>tile.level===leaf.level),'Cancelled encoded input bypassed coverage')
      const second=groups()[0]
      store.failed.set(key(second),new Error('Optional coverage unavailable'))
      assert(groups().some(tile=>tile.level===9),
        'A failed optional coverage image permanently blocked finer data')
    }finally{store.destroy()}
    assert.strictEqual(store.renderer.resourceLedger.bytes,0)
  }
}
if(require.main===module)module.exports()
