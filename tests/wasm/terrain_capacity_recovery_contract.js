const fs=require('fs'),assert=require('assert')
const {TerraAbi}=require('../../adapters/wasm/terra_abi')
module.exports = async function verifyTerrainCapacityRecovery(module) {
 const abi=new TerraAbi(module)
 const root=fs.readFileSync(require('path').join(__dirname,'../../testdata/miniprogram/golden/globe_root_0_record.bin')),detail=fs.readFileSync(require('path').join(__dirname,'../../testdata/miniprogram/golden/globe_patch_record.bin'))
 const budget={maximumChangeCount:32,maximumPriorityUpdateCount:256,maximumElapsedMs:0,meshBudgetBytes:16*1024*1024}
 const payloadBytes=draws=>{
  const positions=new Map(),uv=new Map()
  for(const draw of draws){positions.set(draw.resourceId,draw.positionFloatCount*4);uv.set(draw.textureResourceId,draw.textureFloatCount*4)}
  return [...positions.values(),...uv.values()].reduce((sum,bytes)=>sum+bytes,0)
 }
 const receive=()=>abi.getRequests().forEach(r=>abi.submitRecord(r.kind,r.key,r.kind===1?root:detail))
 try{
 abi.loadManifest({formatVersion:1,patchDimension:64,transform:'cylindrical',heightScale:1/512,minimumU:-180,minimumV:-90,maximumU:180,maximumV:90,radius:6378000,texture:{kind:'global-geodetic',matrix_level_offset:0,maximum_level:18,minimum_level:0,tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]}})
 abi.setViewport(1280,879,Math.PI/4);abi.setGlobeTarget(116.5623,40.74863);abi.setCamera({distance:510240,tiltRadians:-Math.PI/6,yawRadians:14.5*Math.PI/180})
 let packet
 for(let round=0;round<400;round++){
  packet=abi.prepareMeshFrame(.0007616807124577463,budget);abi.materializeMeshFrame(packet); abi.commitMeshFrame(packet);abi.presentFrame(packet.frame.sequence);receive()
  if(round>80&&packet.frame.decisionsComplete)break
 }
 assert(payloadBytes(packet.draws) <= budget.meshBudgetBytes, 'Initial cut exceeded its physical mesh budget')
 assert(new Set(packet.draws.map(draw=>draw.resourceId)).size*42900 > budget.meshBudgetBytes,
  'Terrain stopped at the obsolete per-fragment UV estimate despite shared coordinates')
 const presented=abi.getFrame(),old=new Set(packet.draws.map(d=>d.resourceId))
 abi.setCamera({distance:6378000*3,tiltRadians:0,yawRadians:0})
 const frozen=[]
 for(let round=0;round<30;round++){
  const p=abi.prepareMeshFrame(.0007616807124577463,{...budget,maximumChangeCount:0});
  frozen.push({draws:p.draws.length,bytes:payloadBytes(p.draws),new:p.draws.filter(d=>!old.has(d.resourceId)).length,nodes:p.updateState.topologyNodeCount,pending:p.updateState.pendingPriorityUpdateCount,additional:p.nativePlan.additionalBytes});abi.discardMeshPlan(p.nativePlan);receive()
 }
 assert(frozen[frozen.length-1].bytes > budget.meshBudgetBytes, 'Frustum expansion did not expose excess resident leaves')
 const rows=[]
 for(let round=0;round<100;round++){
  const state=abi.advanceTerrain(.0007616807124577463,{...budget,coarseningOnly:true});receive()
  assert.deepStrictEqual(abi.getFrame(),presented, 'Recovery published an uncredited candidate')
  assert(state.topologyChangeCount <= 32 && state.priorityUpdateCount <= 256)
  assert(state.topologyNodeCount <= (rows.length ? rows[rows.length-1].nodes : frozen[frozen.length-1].nodes), 'Coarsening recovery added refinement nodes')
  rows.push({nodes:state.topologyNodeCount,changes:state.topologyChangeCount,pending:state.pendingPriorityUpdateCount,exhausted:state.budgetExhausted})
  if(!state.pendingPriorityUpdateCount&&!state.budgetExhausted)break
 }
 const p=abi.prepareMeshFrame(.0007616807124577463,{...budget,maximumChangeCount:0});const before=Array.from(old).sort((a,b)=>a-b)
 const proof=await abi.createReplacementTask(p.nativePlan,before,abi.replacementWorkBytes(p.nativePlan,before)).run()
 const result={frozen:frozen[frozen.length-1],rows,after:{draws:p.draws.length,new:p.draws.filter(d=>!old.has(d.resourceId)).length,nodes:p.updateState.topologyNodeCount,additional:p.nativePlan.additionalBytes,groups:proof.groups.map(g=>({before:g.before.length,after:g.after.length}))}}
 assert(rows.length > 1 && rows.length < 100 && !rows[rows.length-1].exhausted)
 assert(payloadBytes(p.draws) <= budget.meshBudgetBytes && result.after.additional < result.frozen.additional)
 abi.materializeMeshFrame(p); abi.commitMeshFrame(p);abi.presentFrame(p.frame.sequence)
 let resumed = false
 for(let turn=0;turn<30;turn++) {
  const state=abi.advanceTerrain(.0007616807124577463,budget);receive()
  resumed = resumed || state.topologyNodeCount > result.after.nodes
 }
 assert(resumed, 'Recovery discarded pending refinement or cached a falsely converged cut')
 console.log('Wasm frustum expansion, bounded coarsening-only recovery, immutable display and resumed refinement passed', JSON.stringify({before:result.frozen.draws,after:result.after.draws,turns:rows.length}))
 return result
 }finally{abi.destroy()}
}
