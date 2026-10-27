const assert = require('assert')
const { TextureStore } = require('../../adapters/webgl/texture_store')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function testAvailabilityIndependentOfGeometry() {
  const displayed = {level: 1, matrix: 1, row: 0, column: 0}
  const children = [0, 1].map(column => ({level: 2, matrix: 2, row: 0, column}))
  const renderer = {canvas: {}, gl: {deleteTexture() {}}, options: {}, requestRender() {}, requestResources() {},
    presentedTextures: new Map([['1/1/0/0', displayed]]),
    get current() { throw new Error('Image availability read a terrain candidate') },
    imageryGroupReady() { throw new Error('Image availability waited for a mesh partition') }}
  const store = new TextureStore(renderer, {urlForTile: () => 'unused',
    maximumBytes: 1024, maximumEntries: 8, maximumConcurrent: 1})
  const asset = texture => ({image: null, texture, width: 1, height: 1})
  try {
    store.cache.set('0/0/0/0', asset({}), 4)
    store.cache.set('1/1/0/0', asset({}), 4)
    store.buildRequirementTree(children.map(texture => ({texture})))
    store.cache.set('2/2/0/0', asset({}), 4)
    store.cache.set('2/2/0/1', asset(null), 4)
    store.recomputeAvailability()
    assert(!store.availableKeys.has('2/2/0/0'), 'One uploaded sibling escaped atomic resource readiness')
    assert(!store.availableKeys.has('2/2/0/1'), 'A decoded image was treated as GPU ready')
    store.cache.get('2/2/0/1').texture = {}
    store.recomputeAvailability()
    store.refreshProtection()
    assert(children.every(tile => store.availableKeys.has(`2/2/0/${tile.column}`)),
      'Ready images waited for terrain publication or partition buffers')
    assert.strictEqual(store.transitionReserved, 0,
      'Prepared images held the download staging slots while display was blocked')
    assert.deepStrictEqual(Array.from(renderer.presentedTextures.keys()), ['1/1/0/0'],
      'Image availability falsely acknowledged display submission')
    assert(store.protectedKeys.has('1/1/0/0'), 'Resource readiness retired the actual display parent')
  } finally { store.destroy() }
}

async function main() {
  testUploadSelection()
  testAvailabilityIndependentOfGeometry()
  testCoverageCapacityAccounting()
  testStableProductionProtection()
  testIndependentCoarseningGroups()
  testPrivateCandidateDemand()
  const decoder = global.createImageBitmap
  const abortController = global.AbortController
  // The repository's Wasm build image uses Node without browser globals.
  if (!abortController) global.AbortController = class {
    constructor() { this.signal = {aborted: false} }
    abort() { this.signal.aborted = true }
  }
  let finishDecode, closed = 0, requests = 0
  const renderer = {canvas: {ownerDocument: {}}, presentedTextures: new Map(),
    options: {managedResources: true, fetchTextures: async () => {
      ++requests
      return {ok: true, blob: async () => ({})}
    }}, requestRender() {}, requestResources() {}}
  const store = new TextureStore(renderer, {urlForTile: () => 'https://tiles.example/image',
    maximumBytes: 611668, maximumEntries: 1, maximumConcurrent: 3,
    maximumRetries: 0, prefetchAncestors: false})
  global.createImageBitmap = () => new Promise(resolve => {
    finishDecode = () => resolve({width: 256, height: 256, close() { ++closed }})
  })
  const tile = {level: 0, matrix: 0, row: 0, column: 0}, key = '0/0/0/0'
  try {
    store.desired.set(key, tile)
    store.schedule(key, tile, 1)
    await tick()
    assert.strictEqual(requests, 1)
    assert.strictEqual(store.cache.stats().reservedBytes, 611668)
    assert.strictEqual(store.cache.stats().bytes, 0)
    assert(finishDecode)
    // Switching sources cancels I/O but cannot synchronously cancel a browser
    // decoder. Its lease must survive the source generation change.
    store.setSource(() => 'https://replacement.example/image', [])
    store.desired.set(key, tile)
    store.schedule(key, tile, 1)
    await tick()
    assert.strictEqual(requests, 1, 'A source switch reused memory still owned by a decoder')
    assert.strictEqual(store.cache.stats().reservedBytes, 611668)
    finishDecode()
    await tick(); await tick()
    assert.strictEqual(closed, 1, 'An obsolete decoded image was not closed')
    assert.strictEqual(store.cache.stats().reservedBytes, 0)
    assert.strictEqual(store.cache.stats().bytes, 0)
    store.advance()
    store.schedule(key, tile, 1)
    await tick()
    assert.strictEqual(requests, 2, 'Released capacity did not unblock the new source')
    finishDecode()
    await tick(); await tick()
    assert(store.cache.has(key))
    assert.strictEqual(store.cache.stats().reservedBytes, 0)
    assert.strictEqual(store.cache.stats().bytes, 611668)
    renderer.presentedTextures.set(key, tile)
    store.refreshProtection()
    const second = {level: 0, matrix: 0, row: 0, column: 1}
    store.desired.set('0/0/0/1', second)
    store.schedule('0/0/0/1', second, 1)
    await tick()
    assert.strictEqual(requests, 2, 'Pinned display capacity caused a doomed download/decode')
    assert(store.blockedByCapacity)
    assert.strictEqual(store.cache.stats().highWaterBytes, 611668)
  } finally {
    store.destroy()
    if (finishDecode) finishDecode()
    await tick(); await tick()
    if (decoder === undefined) delete global.createImageBitmap
    else global.createImageBitmap = decoder
    if (abortController === undefined) delete global.AbortController
    else global.AbortController = abortController
  }
  assert.strictEqual(closed, 2)
  assert.strictEqual(store.cache.stats().reservedBytes, 0)
  assert.strictEqual(store.scheduler.stats().active, 0)
  assert.strictEqual(store.advanceTimer, null)
  console.log('Texture pre-decode admission, source cancellation and pinned-capacity backpressure passed')
}

function testUploadSelection() {
  const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
  const {descendantTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')
  const root={level:0,matrix:1,row:0,column:0}
  const anchor=descendantTextureTile(root,7,63,49)
  const leaves=Array.from({length:1024},(_,i)=>descendantTextureTile(anchor,5,i>>5,i%32))
  const displayed=descendantTextureTile(root,3,0,0)
  const renderer={canvas:{},gl:{deleteTexture(){}},options:{},requestRender(){},requestResources(){},
    presentedTextures:new Map([[key(displayed),displayed]])}
  const store=new TextureStore(renderer,{urlForTile:()=> 'unused',maximumBytes:16384,
    maximumEntries:2048,estimatedTileBytes:4,transitionReserveEntries:8})
  const asset=()=>({texture:{},width:1,height:1})
  try {
    store.cache.set(key(root),asset(),4);store.cache.set(key(displayed),asset(),4)
    store.buildRequirementTree(leaves.map((texture,i)=>({texture,imageryPixelError:1.25*(i+1)})))
    store.recomputeAvailability();store.refreshProtection()
    const selected=Array.from(store.uploadKeys())
    assert.strictEqual(selected.length,10,'Selection did not retain roots, actual display and two complete groups')
    assert(selected.includes(key(root))&&selected.includes(key(displayed)))
    const priority=store.pyramid.refinementPriority
    let reads=0
    store.pyramid.refinementPriority=function(...args){++reads;return priority.apply(this,args)}
    for(let turn=0;turn<20;++turn)assert.deepStrictEqual(Array.from(store.uploadKeys()),selected)
    assert.strictEqual(reads,0,'Upload polling reranked the network request frontier')

    // Ready resources and a new view must replace the selection; it is not
    // a memoized readiness answer or a second owner of cached payload.
    for(const tile of leaves)if(selected.includes(key(tile)))store.cache.set(key(tile),asset(),4)
    store.recomputeAvailability();store.refreshProtection()
    const next=store.uploadKeys()
    assert(selected.slice(2).every(id=>!next.has(id)),'Completed groups remained upload work')
    assert.strictEqual(next.size,10)
    store.buildRequirementTree([{texture:root}])
    store.recomputeAvailability();store.refreshProtection()
    assert.deepStrictEqual(Array.from(store.uploadKeys()),[key(root),key(displayed)])
    store.setSource(()=> 'new-source',[{...root,column:1}])
    assert(!store.uploadKeys().has(key(leaves[0])),'Source replacement kept old upload demand')
  }finally{store.destroy()}
  assert.strictEqual(store.cache.ledger.bytes,0)
}

function testCoverageCapacityAccounting() {
  const {textureByteSize} = require('../../adapters/webgl/texture_store')
  const key = tile => `${tile.level}/${tile.matrix}/${tile.row}/${tile.column}`
  const roots = [0,1].map(column => ({level:0,matrix:0,row:0,column}))
  const details = Array.from({length:9}, (_,column) => ({level:3,matrix:3,row:0,column}))
  const renderer = {canvas:{},gl:{deleteTexture(){}},options:{},presentedTextures:new Map(),
    requestRender(){},requestResources(){}}
  const imageBytes = textureByteSize(256,256)
  const store = new TextureStore(renderer,{urlForTile:()=>'',coverageTiles:roots,
    maximumEntries:10,maximumBytes:10*imageBytes,prefetchAncestors:false,transitionReserveEntries:4})
  try {
    assert.strictEqual(store.targetCapacity(),4)
    for (const tile of roots.concat(details.slice(0,4)))
      store.cache.set(key(tile),{texture:{},width:256,height:256},imageBytes)
    // Coverage can also appear as an ordinary draw for a hidden or coarse
    // mesh. The physical images and their reserved capacity do not multiply.
    for (let overlap=0;overlap<=2;++overlap) {
      store.buildRequirementTree(details.slice(0,4).concat(roots.slice(0,overlap)).map(texture=>({texture})))
      store.recomputeAvailability()
      const stats=store.stats()
      assert.strictEqual(stats.targetMissing,0)
      assert.strictEqual(stats.state,'settled')
      assert.strictEqual(stats.limitedByCapacity,false,
        'Already reserved coverage was charged again against detail target capacity')
      assert.strictEqual(stats.limitedByPhysicalCapacity,false)
      assert.strictEqual(store.cache.bytes,6*imageBytes)
    }
    store.buildRequirementTree(details.slice(0,5).map(texture=>({texture})))
    assert(store.stats().limitedByCapacity,'A real detail-capacity deficit was hidden by coverage deduplication')
    assert(!store.stats().limitedByPhysicalCapacity)
    store.buildRequirementTree(details.map(texture=>({texture})))
    assert(store.stats().limitedByPhysicalCapacity,
      'Physical capacity omitted the required coverage images outside the detail target')
    store.setPreferredBytes(imageBytes)
    store.buildRequirementTree([])
    assert(store.stats().limitedByCapacity && store.stats().limitedByPhysicalCapacity,
      'Insufficient root coverage capacity was hidden when no detail was requested')
  } finally {store.destroy()}
  assert.strictEqual(store.cache.ledger.bytes,0)
}

function testStableProductionProtection() {
  const {EncodedTextureStore} = require('../../adapters/browser/encoded_texture_store')
  const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
  const {PartitionGroups} = require('../../adapters/webgl/partition_groups')
  const key = tile => `${tile.level}/${tile.matrix}/${tile.row}/${tile.column}`
  const root = {level:0,matrix:0,row:0,column:0}
  const children = [0,1].flatMap(row => [0,1].map(column => ({level:1,matrix:1,row,column})))
  const renderer = {canvas:{},gl:{deleteTexture(){}},options:{},presentedTextures:new Map([[key(root),root]]),
    resourceLedger:new ResourceLedger(8*1024*1024),requestRender(){},requestResources(){}}
  const store = renderer.textures = new EncodedTextureStore(renderer,
    {urlForTile:()=> 'unused',maximumBytes:4*1024*1024,maximumEntries:32})
  try {
    store.cache.set(key(root),{texture:{},width:256,height:256},store.requestBytes())
    store.buildRequirementTree(children.map(texture=>({texture})))
    store.recomputeAvailability();store.refreshProtection()
    assert(children.every(tile=>store.protectedKeys.has(key(tile))), 'Future group lost pre-insertion protection')
    const groups = new PartitionGroups(renderer), stamp = groups.admissionKey()
    const protection = [...store.protectedKeys].sort()
    for (let frame=0;frame<12;++frame) {
      store.refreshProtection()
      assert.deepStrictEqual([...store.protectedKeys].sort(),protection)
      assert.strictEqual(groups.admissionKey(),stamp,
        'An unchanged production frontier invalidated its capacity refusal on every refresh')
    }
    store.buildRequirementTree([{texture:root}])
    store.recomputeAvailability();store.refreshProtection()
    assert.notStrictEqual(groups.admissionKey(),stamp, 'Changed protection did not permit a fresh admission')
  } finally {store.destroy()}
  assert.strictEqual(renderer.resourceLedger.bytes,0)
}

function testIndependentCoarseningGroups() {
  const key = tile => `${tile.level}/${tile.matrix}/${tile.row}/${tile.column}`
  const root={level:0,matrix:0,row:0,column:0}
  const targets=[0,1].map(column=>({level:2,matrix:2,row:0,column}))
  const leaves=targets.flatMap(tile=>[0,1].flatMap(row=>[0,1].map(column=>
    ({level:3,matrix:3,row,column:2*tile.column+column}))))
  const renderer={canvas:{},gl:{deleteTexture(){}},options:{},requestRender(){},requestResources(){},
    presentedTextures:new Map(leaves.map(tile=>[key(tile),tile]))}
  const store=new TextureStore(renderer,{urlForTile:()=> 'unused',maximumBytes:40,maximumEntries:10})
  const asset=()=>({texture:{},width:1,height:1})
  try {
    for(const tile of [root,...leaves]) assert(store.cache.set(key(tile),asset(),4))
    store.buildRequirementTree(targets.map(texture=>({texture})))
    store.recomputeAvailability();store.refreshProtection()
    const groups=store.resourceGroups()
    assert.strictEqual(groups.length,2,'Independent coarsening parents were coupled as refinement siblings')
    assert(groups.every(([,children])=>children.size===1))
    // Only one output fits alongside the old submitted cut. A parent can
    // replace its own descendants without waiting for its neighbour's image.
    assert(store.cache.set(key(targets[0]),asset(),4))
    store.recomputeAvailability()
    assert(store.availableKeys.has(key(targets[0])))
    assert(!store.availableKeys.has(key(targets[1])))
    assert(leaves.every(tile=>store.cache.has(key(tile))),'Readiness evicted unacknowledged descendants')
    renderer.presentedTextures=new Map([targets[0],...leaves.filter(tile=>tile.column>=2)].map(tile=>[key(tile),tile]))
    store.refreshProtection()
    assert(store.cache.set(key(targets[1]),asset(),4),'A completed local coarsening could not fund its neighbour')
    assert(leaves.filter(tile=>tile.column>=2).every(tile=>store.cache.has(key(tile))),
      'One local receipt retired its still-visible neighbour')
    store.recomputeAvailability()
    assert(targets.every(tile=>store.availableKeys.has(key(tile))))
    assert(store.cache.bytes<=40)
  } finally {store.destroy()}
}

function testPrivateCandidateDemand() {
  const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
  const ledger = new ResourceLedger(256)
  const renderer = {resourceLedger:ledger,canvas:{},gl:{deleteTexture(){}},options:{},requestRender(){},requestResources(){},presentedTextures:new Map()}
  const store = new TextureStore(renderer,{urlForTile:()=> 'unused',maximumBytes:256,maximumEntries:16,maximumConcurrent:1})
  store.estimatedTileBytes=4
  store.minimumWorkspaceBytes=()=>8
  const root={level:0,matrix:0,row:0,column:0}, tile={level:2,matrix:2,row:0,column:0}
  try {
    store.cache.set('0/0/0/0',{image:null,texture:{},width:1,height:1},4)
    const old=ledger.bytes, candidate=store.reserveCandidateDemand([{texture:tile}])
    assert(candidate.valid())
    assert.strictEqual(ledger.bytes-old,12,'Candidate charged intermediate levels or forgot its serial lane')
    assert(candidate.targets.has('0/0/0/0') && candidate.targets.has('2/2/0/0'))
    store.buildRequirementTree([{texture:root}])
    store.advance()
    assert.strictEqual(ledger.bytes-old,12,'Old-view maintenance spent or trimmed candidate credit')
    assert.strictEqual(store.demandCredit.bytes,0,'Private demand became runnable before acceptance')
    candidate.release()
    assert.strictEqual(ledger.bytes,old)
    const accepted=store.reserveCandidateDemand([{texture:tile}])
    accepted.accept();accepted.accept();accepted.release()
    store.advance()
    assert.strictEqual(store.demandCredit.bytes,12,'Acceptance failed to transfer continuation ownership')
    assert(store.demandKeys.has('2/2/0/0'))
    store.buildRequirementTree([{texture:tile}])
    assert.strictEqual(store.forecastTargets,null,'Actual demand did not take over the forecast')
    const sibling=Object.assign({},tile,{column:1})
    store.buildRequirementTree([{texture:tile},{texture:sibling}])
    assert(store.reserveDemand(store.resourceDemand()),'Accepted demand could not grow for the next plan')
    assert.strictEqual(store.demandCredit.bytes,16)
    assert.strictEqual(ledger.bytes,old+16,'Appending demand leaked an unowned reservation')
    store.releaseDemand()
    ledger.setLimit(old+11)
    const denied=store.reserveCandidateDemand([{texture:tile}])
    assert(!denied.valid && denied.shortfallBytes>0,'Unfunded candidate was accepted')
    assert.strictEqual(ledger.bytes,old,'Refusal retained partial image credit')
    const leaves=Array.from({length:8},(_,column)=>({texture:{level:3,matrix:3,row:0,column}}))
    ledger.setLimit(old+16)
    const rolling=store.reserveCandidateDemand(leaves)
    assert(rolling.valid(),'A full viewport replacement demanded every final image simultaneously')
    assert.strictEqual(rolling.targetBytes,40)
    assert.strictEqual(rolling.continuationBytes,16,'Bootstrap must fund a complete visible sibling group and input lane')
    assert.strictEqual(rolling.targets.size,9,'Rolling admission lost the complete final target')
    assert(store.cache.has('0/0/0/0'),'Admitting a successor evicted displayed coarse coverage')
    rolling.accept()
    store.buildRequirementTree(leaves)
    assert.strictEqual(store.resourceDemand().requiredBytes,16,
      'Published demand reverted to charging every final image at once')
    assert(store.reserveDemand(store.resourceDemand()),
      'The accepted sibling-group continuation became unaffordable after publication')
    assert.strictEqual(store.resourceDemand().bytes,24,
      'Rolling production credit hid the outstanding final target')
    const gate = new (require('../../sdk/js/terrain/terrain_demand').TerrainDemand)()
    gate.expect('view',1)
    assert.strictEqual(gate.update('view',{sequence:1,...store.resourceDemand()},quote=>store.reserveDemand(quote)),false,
      'A funded local image continuation was rejected by the whole-view forecast')
    assert.strictEqual(gate.reason,null)
    assert.strictEqual(store.resourceDemand().bytes,24,'Local admission hid the outstanding final target')
    assert.strictEqual(store.demandCredit.bytes,16,'Resuming terrain revoked image continuation credit')
    rolling.release()
    store.releaseDemand()
    assert.strictEqual(ledger.bytes,old)
  } finally {store.destroy()}
  assert.strictEqual(ledger.bytes,0)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
