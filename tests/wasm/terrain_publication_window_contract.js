const fs = require('fs'), path = require('path'), assert = require('assert')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {surfaceIds} = require('../../sdk/js/terrain/surface_replacement')
const root = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_root_0_record.bin'))
const detail = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_patch_record.bin'))
const budget = {maximumChangeCount:32,maximumPriorityUpdateCount:256,maximumElapsedMs:0,meshBudgetBytes:16*1024*1024}
async function run(mod, window) {
 const abi = new TerraAbi(mod)
 try {
  abi.loadManifest({formatVersion:1,patchDimension:64,transform:'cylindrical',heightScale:1,
   minimumU:-180,minimumV:-90,maximumU:180,maximumV:90,radius:6378000,
   texture:{kind:'global-geodetic',matrix_level_offset:0,maximum_level:18,minimum_level:0,
   tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]}})
  abi.setViewport(1280,720,Math.PI/4);abi.setGlobeTarget(116.4074,39.9042)
  abi.setCamera({distance:10000,tiltRadians:-0.3,yawRadians:0})
  const receive = () => abi.getRequests().forEach(r=>abi.submitRecord(r.kind,r.key,r.kind===1?root:detail))
  let packet, rounds=0
  for(;rounds<400;++rounds) {
   packet=abi.prepareMeshFrame(0.00125,budget);abi.materializeMeshFrame(packet); abi.commitMeshFrame(packet);abi.presentFrame(packet.frame.sequence);receive()
   if(packet.draws.length>=180)break
  }
  assert(rounds<400,'fixture failed to refine')
  const before=surfaceIds(packet.draws),states=[]
  let changes = 0
  for(let i=0;i<20;++i){
   const allowance = !window ? 32 : window === 'changes' ? 32 - changes : i ? 0 : 32
   const b = Object.assign({},budget,{maximumChangeCount:allowance})
   const state = abi.advanceTerrain(0.00125,b)
   assert(Number.isInteger(state.topologyChangeCount) && state.topologyChangeCount <= allowance)
   changes += state.topologyChangeCount
   states.push(state);receive()
  }
  const target=abi.prepareMeshFrame(0.00125,window?Object.assign({},budget,{maximumChangeCount:0}):budget)
  const additional = target.nativePlan.additionalBytes
  const bytes=abi.replacementWorkBytes(target.nativePlan,before)
  const proof=await abi.createReplacementTask(target.nativePlan,before,bytes).run()
  const groups=proof.groups.map(g=>({before:g.before.length,after:g.after.length,
   new:g.after.filter(id=>!before.includes(id)).length}))
  // Zero-change continuations finish priorities and preserve the candidate;
  // after publication the next window must resume real refinement.
  if (window) {
   const nodes = states[0].topologyNodeCount
   if (window === 'calls') assert(states.every(state => state.topologyNodeCount === nodes), 'Deferred topology kept growing')
   assert(changes <= 32, 'Background work exceeded the cumulative publication allowance')
   assert.strictEqual(states[states.length - 1].pendingPriorityUpdateCount, 0)
   abi.materializeMeshFrame(target); abi.commitMeshFrame(target); abi.presentFrame(target.frame.sequence)
   let changed = false
   for (let i = 0; i < 20; ++i) {
    const resumed = abi.prepareMeshFrame(0.00125,budget)
    abi.materializeMeshFrame(resumed); abi.commitMeshFrame(resumed); abi.presentFrame(resumed.frame.sequence); receive()
    changed = changed || resumed.updateState.modelRevision > target.updateState.modelRevision
   }
   assert(changed, 'Publishing the deferred cut failed to resume refinement')
  }
  return {window,rounds,changes,before:before.length,after:surfaceIds(target.draws).length,
   beforeModel:packet.updateState.modelRevision,afterModel:target.updateState.modelRevision,
   additional,groups,
   states:states.map(s=>({revision:s.modelRevision,nodes:s.topologyNodeCount,pending:s.pendingPriorityUpdateCount}))}
 }finally{abi.destroy()}
}
// The checked-in records are reused as synthetic global heights. This tests
// CBDAM publication cost and continuity, not the accuracy of a real global DEM.
module.exports = async function verifyTerrainPublicationWindow(mod) {
 const before = await run(mod, false), conservative = await run(mod, 'calls'), after = await run(mod, 'changes')
 const largest = value => Math.max(...value.groups.map(g => g.new))
 assert(largest(before) > 128, 'Fixture did not accumulate a large boundary dependency')
 assert(largest(after) < largest(before), 'One pending topology batch did not bound the successor')
 assert(after.additional < before.additional)
 assert.strictEqual(conservative.changes, 0, 'Fixture should begin with height/priority preparation only')
 assert.strictEqual(after.changes, 32, 'Available topology allowance did not survive preparation-only calls')
 assert(after.afterModel > conservative.afterModel, 'Actual credit did not advance the pending model')
 console.log('Wasm actual topology credit, deferred priorities and resumed refinement passed',
   JSON.stringify([before, conservative, after].map(r => ({mode:r.window, changes:r.changes,
    newMeshes:largest(r), additionalNativeBytes:r.additional, before:r.before, after:r.after}))))
}
