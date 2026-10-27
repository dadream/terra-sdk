const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {TerrainDemand} = require('../../sdk/js/terrain/terrain_demand')
const {TextureStore} = require('../../adapters/webgl/texture_store')
const {TerraWebGlRenderer} = require('../../adapters/webgl/terra_webgl_renderer')
const {mergeImageryDemand} = require('../../sdk/js/imagery/imagery_demand')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')

module.exports = function verifyContinuationDemand() {
  const root = {level:0,matrix:0,row:0,column:0}, leaf = {level:1,matrix:1,row:0,column:0}
  const draw = {resourceId:7,geometryKey:'mesh:7',texture:root}
  const measured = [{resourceId:7,visible:true,pixelsPerUv:100}]
  const plan = {draws:[{...draw,texture:leaf,sourceTexture:root}], quality:{
    spatialCut:true, coverageGuaranteed:true, demandReady:true, planningComplete:false,
    targetPixelError:1.25, meetsTarget:false}}
  const options = {sameView:true,measurementsCurrent:true,scheduledImagery:true,tileSize:256,
    hidden:()=>false,rootDraw:draw=>draw}
  const merge = (next=plan, targets=[draw]) => mergeImageryDemand(targets, null, next,
    new Map(), measured, options).plan
  assert(merge().quality.demandReady, 'A complete fitted cut lost its continuation price')
  assert.strictEqual(merge().quality.planningComplete,false,'Continuation forged final precision')
  for (const invalid of [{spatialCut:false},{coverageGuaranteed:false},{measurementPending:true},
    {rebuilding:true},{cameraCurrent:false}]) {
    assert.strictEqual(merge({...plan,quality:{...plan.quality,...invalid}}).quality.demandReady,false,
      'An incomplete or stale cut authorized continuation: '+JSON.stringify(invalid))
  }
  assert.strictEqual(merge(plan,[draw,{...draw,resourceId:8,geometryKey:'mesh:8'}]).quality.demandReady,false,
    'A partial mesh footprint authorized whole-cut continuation')

  const ledger = new ResourceLedger(400), gate = new TerrainDemand()
  const renderer = {resourceLedger:ledger,canvas:{},options:{},requestResources(){},requestRender(){},
    mode:'texture',cameraVersion:2,plannedCameraVersion:2,current:{frame:{sequence:1},imageryPlan:merge()}}
  const store = renderer.textures = new TextureStore(renderer,{urlForTile:()=>'',maximumBytes:400})
  store.estimatedTileBytes=100;store.minimumWorkspaceBytes=()=>40
  store.currentRoots.set(key(root),root);store.targetDesired.set(key(leaf),leaf)
  store.cache.set(key(root),{},100)
  const held = ledger.reserve('other-producer',260)
  const quote = () => TerraWebGlRenderer.prototype.terrainRefinementDemand.call(renderer)
  const reserve = value => TerraWebGlRenderer.prototype.reserveImageryDemand.call(renderer,value)
  try {
    gate.expect('view',1)
    const unavailable=quote()
    assert(unavailable && unavailable.requiredBytes===140,
      'An already fitted current cut waited for final precision before quoting its continuation')
    assert(gate.update('view',unavailable,reserve),'Unfunded continuation authorized topology')
    assert.strictEqual(store.demandCredit.bytes,0,'Rejected continuation created credit')
    held.release()
    const admitted=quote()
    assert.strictEqual(gate.update('view',admitted,reserve),false,
      'A funded complete cut waited for final precision or image downloads')
    assert.strictEqual(store.demandCredit.bytes,140,'Topology resumed without owned continuation credit')
    assert.strictEqual(store.cache.has(key(leaf)),false,'Demand admission produced an image')
    assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete,false)
    assert.strictEqual(reserve({...admitted,sequence:0}),false)
    assert.strictEqual(reserve({...admitted,sourceGeneration:-1}),false)
    ++renderer.cameraVersion
    assert.strictEqual(quote(),null,'An old-camera fitted cut authorized current topology')
    assert.strictEqual(reserve(admitted),false)
  } finally {held.release();store.destroy()}
  assert.strictEqual(ledger.bytes,0,'Continuation retained ownership after destruction')
}

if (require.main === module) module.exports()
