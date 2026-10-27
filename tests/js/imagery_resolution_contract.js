const assert = require('assert')
const {TextureStore} = require('../../adapters/webgl/texture_store')
const {ImageryPyramid} = require('../../sdk/js/imagery/terra_imagery_pyramid')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {parentTextureTile, descendantTextureTile} = require('../../sdk/js/imagery/terra_texture_tiles')

module.exports = function verifyImageryResolution() {
  const root = {level:0, matrix:1, row:0, column:0}
  const anchor = descendantTextureTile(root, 7, 63, 49)
  const leaves = Array.from({length:1024}, (_, i) => descendantTextureTile(anchor, 5, i >> 5, i % 32))
  const groups = new Map(), nodes = new Set()
  for (const tile of leaves) {
    const parent = key(parentTextureTile(tile))
    if (!groups.has(parent)) groups.set(parent, new Map())
    groups.get(parent).set(key(tile), tile)
    for (let p = tile; p; p = parentTextureTile(p)) nodes.add(key(p))
  }
  const store = Object.create(TextureStore.prototype)
  let reads = 0
  const resident = new Map([[key(root), {texture:{}}]])
  Object.assign(store, {
    directTargets:true, availableKeys:new Set(resident.keys()), failed:new Set(),
    renderer:{presentedTextures:new Map()}, currentRoots:new Map([[key(root),root]]),
    resourceGroups:() => Array.from(groups), requiresResident:() => true,
    cache:{has:id => resident.has(id), reservations:new Map()},
    scheduler:{active:new Map()}, pyramid:new ImageryPyramid(),
    gpuReady(id) { ++reads; return resident.has(id) }
  })
  leaves.forEach((tile,i) => store.pyramid.priorities.set(key(tile), 1 + i / 1024))
  const frontier = store.frontierGroups()
  assert.strictEqual(frontier.length, groups.size)
  assert(frontier.every(g => g.children.size === 4 && g.staged === 0 && g.inFlight === 0))
  const expected = Array.from(groups, ([parent, children]) => [parent,
    Math.max(...Array.from(children.values(), tile => store.pyramid.refinementPriority(tile, root.level)))])
    .sort((a,b) => b[1] - a[1])
  assert.deepStrictEqual(frontier.map(g => [g.parentKey,g.priority]), expected)
  assert(reads <= nodes.size, `A single frontier traversal repeated ancestor readiness: ${reads} reads for ${nodes.size} nodes`)
  const frontierReads = reads

  // Every traversal observes fresh resource state. GPU completion, retirement
  // and a submitted predecessor must change the next ranking immediately.
  const fine = parentTextureTile(leaves[0])
  resident.set(key(fine), {texture:{}}); store.availableKeys.add(key(fine))
  const rank = () => store.frontierGroups().find(g => g.parentKey === key(fine)).priority
  assert.strictEqual(rank(), Math.max(...Array.from(groups.get(key(fine)).values(),
    tile => store.pyramid.refinementPriority(tile, fine.level))))
  store.availableKeys.delete(key(fine)); store.renderer.presentedTextures.set(key(fine),fine)
  assert.strictEqual(store.presentationTileFor(leaves[0]).level, fine.level)
  resident.delete(key(fine))
  assert.strictEqual(rank(), expected.find(([id]) => id === key(fine))[1])

  // Finished demand contributes coverage/protection, never request ranking.
  // Retiring one image reopens only its complete replacement group, including
  // its resident siblings when calculating that group's priority.
  const priority=store.pyramid.refinementPriority
  let priced=0
  store.pyramid.refinementPriority=function(...args){++priced;return priority.apply(this,args)}
  leaves.forEach(tile=>{resident.set(key(tile),{texture:{}});store.availableKeys.add(key(tile))})
  reads=0
  assert.deepStrictEqual(store.frontierGroups(),[])
  assert.strictEqual(priced,0,'Completed groups still ran screen-space priority calculations')
  assert.strictEqual(reads,0,'Completed groups still queried their usable predecessors')
  const retired=leaves[0],retiredKey=key(retired)
  resident.delete(retiredKey)
  let reopened=store.frontierGroups()
  assert.strictEqual(priced,4,'Retirement priced unrelated completed groups')
  assert.strictEqual(reopened.length,1)
  assert.strictEqual(reopened[0].parentKey,key(parentTextureTile(retired)))
  assert.deepStrictEqual(Array.from(reopened[0].children.keys()),[retiredKey])
  const reopenedPriority=Math.max(...Array.from(reopened[0].allChildren.values(), tile=>
    priority.call(store.pyramid,tile,store.presentationTileFor(tile).level)))
  assert.strictEqual(reopened[0].priority,reopenedPriority)
  priced=0;store.failed.add(retiredKey)
  assert.deepStrictEqual(store.frontierGroups(),[])
  assert.strictEqual(priced,0,'Terminal failure kept a finished group in the request frontier')
  store.failed.delete(retiredKey)
  assert.strictEqual(store.frontierGroups().length,1,'Retry did not reopen an unfinished group')
  resident.set(retiredKey,{texture:{}})
  priced=0;resident.delete(key(root))
  reopened=store.frontierGroups()
  assert.strictEqual(reopened.length,1)
  assert.strictEqual(reopened[0].parentKey,null,'Missing root lost its separate coverage request')
  assert.strictEqual(priced,0)
  resident.set(key(root),{texture:{}})
  store.pyramid.refinementPriority=priority

  const {ImageryResolution} = require('../../sdk/js/imagery/imagery_resolution')
  let probes = 0
  const ready = new Set([key(root),key(fine)])
  const resolution = new ImageryResolution(id => { ++probes; return ready.has(id) })
  const naive = tile => {
    for (let p=tile;p;p=parentTextureTile(p)) if (ready.has(key(p))) return p
    return null
  }
  for (const tile of leaves.concat(leaves.slice().reverse())) {
    assert.deepStrictEqual(resolution.resolve(tile), naive(tile))
    assert.deepStrictEqual(resolution.fallback(tile), naive(tile))
  }
  assert(probes <= nodes.size, 'One resolution pass probed a shared ancestor twice')
  for (let i=0;i<6000;++i) {
    const tile = descendantTextureTile(root, 12, i >> 6, i % 64)
    assert.deepStrictEqual(resolution.resolve(tile), naive(tile), 'Memo saturation changed the ready ancestor')
  }
  assert(resolution.paths.size <= 4096, 'A traversal retained unbounded path metadata')
  for (const origin of [root, {...root,column:3,row:1}, {level:3,matrix:0,row:4,column:7}]) {
    const missing = new ImageryResolution(() => false)
    const tile = descendantTextureTile(origin,4,9,11)
    assert.strictEqual(missing.resolve(tile), null)
    assert.deepStrictEqual(missing.fallback(tile), origin, 'An absent source root lost its own coverage identity')
  }
  const view = new ImageryResolution(id => ready.has(id))
  const sourceTile = {...root,matrix:2}
  assert.strictEqual(view.resolve(sourceTile),null,'Different source matrices shared readiness')
  assert.deepStrictEqual(view.resolve(root),root)
  console.log('Imagery ancestor resolution: shared paths, fresh GPU state, ranking, roots and source identity passed',
    JSON.stringify({leaves:leaves.length, uniqueNodes:nodes.size, frontierReadyProbes:frontierReads}))
}
