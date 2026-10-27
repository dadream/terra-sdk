const assert=require('assert')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')

module.exports=async function(makeStore,tick) {
  const roots=[0,1].map(column=>({level:0,matrix:1,row:0,column}))
  const tiles=Array.from({length:8},(_,i)=>({level:1,matrix:2,row:i%2,column:Math.floor(i/2)}))
  for(const [cancel,alias] of [[false,false],[true,false],[false,true],[true,true]]) {
    const store=makeStore({maximumBytes:4*1024*1024,maximumEntries:64,maximumConcurrent:4,
      prefetchAncestors:true,coverageTiles:roots}),r=store.renderer
    let open=false,requests=0,active=0,peak=0,prices=0
    store.urlForTile=tile=>'https://imagery.invalid/'+(alias?'shared.png':key(tile))
    r.options.scheduledImagery=true;r.current={}
    r.partitionGroups={refresh(){},imageryRunnable:()=>open,prepareImagery(group,reserve){++prices;return reserve()?'ready':'waiting'}}
    r.options.fetchTextures=(url,{signal})=>{
      ++requests;++active;peak=Math.max(peak,active)
      assert(open||r.resourceLedger.stats().owners['imagery-encoded-source'].reserved>0,
        'Early network work had no bounded encoded-byte credit')
      if(cancel)return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{
        --active;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}))},{once:true}))
      let read=false
      return Promise.resolve({ok:true,headers:{get:()=>''},body:{cancel:async()=>{},getReader:()=>({
        read:async()=>read?{done:true}:(read=true,--active,{done:false,value:new Uint8Array(32)}),
        cancel:async()=>{},releaseLock(){}})}})
    }
    try {
      for(const tile of roots)store.cache.set(key(tile),{texture:{},width:16,height:16},store.requestBytes())
      store.sync(tiles.map(texture=>({texture})),[])
      for(let i=0;i<20;++i){store.advance();await tick()}
      assert(requests>0&&peak<=4,'Source transport did not progress independently within its concurrency')
      assert.strictEqual(prices,0,'Early transport bypassed the UV admission dependency')
      assert.strictEqual(store.cache.reservations.size,0,'Early bytes allocated a GPU destination')
      if(!cancel) {
        assert.strictEqual(requests,alias?1:8)
        assert.strictEqual(store.sourceCache.bytes,(alias?1:8)*32)
        open=true
        for(let i=0;i<30;++i){store.advance();await tick()}
        assert(tiles.every(tile=>store.cache.has(key(tile))),'Funded display did not adopt prefetched bytes')
        assert.strictEqual(requests,8,'Adoption fetched the same source twice')
        assert.strictEqual(store.sourceCache.bytes,0,'Adoption retained duplicate source ownership')
        assert.strictEqual(store.sourceCache.stats().hits,alias?1:8)
      }
    } finally {store.destroy();await tick();await tick()}
    assert.strictEqual(active,0,'Cancelled early transport remained active')
    assert.strictEqual(r.resourceLedger.bytes,0,'Early transport or adoption retained resource credit')
  }
  for(const pinned of [false,true]) {
    const store=makeStore({maximumBytes:150000,maximumEntries:256,maximumConcurrent:1,
      prefetchAncestors:true,coverageTiles:roots}),r=store.renderer,releases=[]
    let requests=0,active=0
    r.options.scheduledImagery=true;r.current={}
    r.partitionGroups={refresh(){},imageryRunnable:()=>false,prepareImagery(){throw Error('Unfunded UV work')}}
    r.options.fetchTextures=(url,{signal})=>{
      ++requests;++active
      return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{
        --active;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}))},{once:true}))
    }
    try {
      for(const tile of roots) {
        store.cache.set(key(tile),{texture:{},width:16,height:16},store.requestBytes())
        releases.push(store.cache.retain(key(tile)))
      }
      for(let i=0;i<100;++i) {
        const id=key({level:8,matrix:9,row:200,column:300+i})
        store.cache.set(id,{texture:{},width:16,height:16},store.requestBytes())
        if(pinned)releases.push(store.cache.retain(id))
      }
      const before=store.cache.bytes
      store.sync([{texture:{level:3,matrix:4,row:0,column:0}}],[])
      for(let i=0;i<6;++i){store.advance();await tick()}
      assert.strictEqual(requests,pinned?0:1,
        'Encoded input must reclaim idle imagery, but must not evict submitted/borrowed images')
      assert(roots.every(tile=>store.gpuReady(key(tile))),'Early input evicted retained coverage')
      assert(pinned||store.cache.bytes<before,'Early input exceeded its share instead of funding real eviction')
      assert(store.cache.bytes+store.cache.reservedBytes+store.pipelineBytes()<=store.requestedMaximumBytes)
      assert.strictEqual(store.cache.reservations.size,0,'Early input produced a GPU destination')
    }finally {
      for(const release of releases)release()
      store.destroy();await tick();await tick()
    }
    assert.strictEqual(active,0)
    assert.strictEqual(r.resourceLedger.bytes,0)
  }
  console.log('Encoded sources overlap blocked UV work; bounded transport, exact adoption, no duplicate fetch and cancelled-reader cleanup passed')
}
