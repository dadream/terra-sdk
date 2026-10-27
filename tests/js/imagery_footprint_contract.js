const assert = require('assert')
const {ImageryFootprintCache} = require('./reference/imagery_footprint_cache')
const {ImageryPresentation} = require('../../sdk/js/imagery/terra_imagery_presentation')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {imageryCandidate} = require('../../adapters/webgl/imagery_candidate')
const {textureKeyString:key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile} = require('../../sdk/js/imagery/terra_texture_tiles')

module.exports = function verifyImageryFootprints() {
  const ledger = new ResourceLedger(8 * 1024 * 1024)
  const cache = new ImageryFootprintCache(ledger)
  const root = {level:0,matrix:1,row:0,column:0}
  const hull = [[0,0],[1,0],[1,1],[0,1]], measured = new Map()
  const models = new Map()
  let hullReads = 0
  const measurement = () => ({visible:true,pixelsPerUv:100,
    regions:[{uv:{minimumU:0,maximumU:1,minimumV:0,maximumV:1}}],
    get hull() { ++hullReads; return hull }})
  const draws = Array.from({length:100}, (_,i) => {
    const source = descendantTextureTile(root,4,i/10>>0,i%10)
    measured.set(String(i),measurement())
    models.set(String(i),{get hull() { ++hullReads; return hull }})
    return {geometryKey:String(i),resourceId:i,sourceTexture:source,
      texture:descendantTextureTile(source,2,0,0)}
  })
  measured.set('world',measurement())
  models.set('world',{get hull() { ++hullReads; return hull }})
  draws.push({geometryKey:'world',resourceId:101,texture:root})
  const resident = new Set([key(root)])
  const store = {
    targetDesired:new Map(draws.map(d=>[key(d.texture),d.texture])),
    currentRoots:new Map([[key(root),root]]), availableKeys:new Set(resident),
    failed:new Set(), admissionBlocked:new Set(), directTargets:true,
    cache:{has:id=>resident.has(id)}, gpuReady:id=>resident.has(id), requiresResident:()=>true,
    resourceGroups:()=>draws.map(d=>[key(root),new Map([[key(d.texture),d.texture]])])
  }
  const r = {textures:store,renderDraws:draws,imageryFootprints:cache,
    presentation:new ImageryPresentation(),presentedTextures:new Map(),presentationBridges:[],
    cameraVersion:1,plannedCameraVersion:1,terrainBoundImagery:false,
    current:{imageryPlan:{quality:{planningComplete:true}}}, options:{imageryPixelError:1.25},
    measureDraw:draw=>measured.get(draw.geometryKey), measureTextureDraw:()=>4,
    geometry:{get:id=>({model:models.get(id)})}}
  const a = new Map([[key(draws[0].texture),draws[0].texture]])
  const b = new Map([[key(draws[99].texture),draws[99].texture]])
  const compare = children => {
    const actual = imageryCandidate(r,children)
    r.imageryFootprints = null
    try { assert.deepStrictEqual(actual,imageryCandidate(r,children),
      'Mesh reuse changed the canonical world cut or its output order') }
    finally { r.imageryFootprints = cache }
    return actual
  }
  try {
    imageryCandidate(r,a)
    const first = hullReads
    const built = cache.stats().builtMeshes
    hullReads = 0
    imageryCandidate(r,b)
    const changed = hullReads
    assert(cache.stats().builtMeshes <= built+2, 'An image group rebuilt unchanged world footprints')
    const unchanged = cache.stats().builtMeshes
    hullReads = 0
    imageryCandidate(r,b)
    assert.strictEqual(cache.stats().builtMeshes,unchanged,'An unchanged candidate rebuilt its footprint')
    r.renderDraws = draws.slice()
    imageryCandidate(r,b)
    assert.strictEqual(cache.stats().builtMeshes,unchanged,'Copying the draw container rebuilt unchanged mesh footprints')
    compare(b)
    resident.add(key(draws[0].texture));store.availableKeys.add(key(draws[0].texture))
    const withPeer = compare(b)
    assert(withPeer.some(d=>d.geometryKey==='world' && key(d.imageryTarget)===key(draws[0].texture)),
      'A reused coarse mesh lost the fine goal supplied by another mesh')
    r.presentedTextures.set(key(draws[0].texture),draws[0].texture)
    compare(b) // A newly retained fine branch changes decisions at its ancestors.
    measured.set('world',measurement());compare(b)
    r.options.imageryPixelError = 8;compare(b)
    r.plannedCameraVersion = -1;compare(b)
    r.capacityHandover = new Map([[key(root),root]])
    r.plannedCameraVersion = 1;compare(b)
    r.presentationBridges = [root];compare(b)
    r.presentationBridges = []
    measured.set('99',{visible:false});compare(b)
    measured.set('99',measurement())
    resident.delete(key(draws[0].texture));compare(b)
    assert(cache.bytes > 0 && ledger.bytes === cache.bytes,'Footprint metadata escaped the resource ledger')

    // Optional reuse cannot evict real payload or prevent another producer.
    const retained = compare(b)
    const producer = ledger.reserve('actual-producer',ledger.maximumBytes)
    assert(producer && cache.bytes === 0 && cache.entries.size === 0,'A real producer could not reclaim optional footprints')
    const before = ledger.bytes
    assert.deepStrictEqual(compare(b),retained)
    assert.strictEqual(ledger.bytes,before,'An unfunded footprint changed resource ownership')
    assert.strictEqual(cache.entries.size,0)
    producer.release()
    compare(b)
    cache.clear()
    const saved = models.get('0')
    models.set('0',{get hull() { throw new Error('source hull failed') }})
    assert.throws(()=>imageryCandidate(r,b),/source hull failed/)
    assert.strictEqual(cache.entries.size,0)
    assert.strictEqual(ledger.bytes,0,'A failed footprint build retained its temporary funding')
    models.set('0',saved)
    const maximum = cache.maximumBytes
    cache.maximumBytes = 4096
    compare(b)
    assert(cache.bytes <= 4096,'Optional metadata exceeded its own capacity')
    cache.maximumBytes = maximum
    const original = r.geometry.get
    r.geometry.get = () => {throw new Error('model unavailable')}
    assert.throws(()=>imageryCandidate(r,b),/model unavailable/)
    r.geometry.get = original
    r.measureDraw = r.measureTextureDraw = () => {throw new Error('World UV pricing read camera measurements')}
    compare(b)
    console.log('Incremental mesh footprints: canonical equality, peer goals, changing dependencies and funded reclaim passed',
      JSON.stringify({meshes:draws.length,firstHullReads:first,changedHullReads:changed}))
  } finally {cache.clear()}
  assert.strictEqual(ledger.bytes,0,'Destroyed footprint plans retained metadata credit')
}
