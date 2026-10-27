const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {textureKeyString:key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile:child} = require('../../sdk/js/imagery/terra_texture_tiles')
const installGeometry = require('./reference/geometry_payload')
const costBatch = require('./reference/mesh_cost_batch')

module.exports = async function verifyTerrainCoverage(Renderer, canvas) {
  for (const unavailable of [null, 'empty', 'matrix', 'image', 'upload', 'source', 'coverage', 'unsubmitted', 'pause']) {
    const ledger = new ResourceLedger(16384)
    const r = new Renderer(canvas, {resourceLedger:ledger, urlForTile:()=>'',
      textureDescriptor:{matrix_level_offset:unavailable==='matrix'?1:0},
      geometryCacheBytes:2048, partitionCacheBytes:2048,
      meshPartitionWorkspaceBytes:()=>0,
      createMeshPartitionPlanTask(id, rows, onRows) {
        return costBatch(rows,onRows,({cells})=>cells.map((cell,index)=>
          ({key:cell.key,bytes:unavailable==='empty'&&index===0?0:6})))
      }})
    const root={level:0,matrix:unavailable==='matrix'?1:0,row:0,column:0}, leaf=child(root,1,0,0)
    const old={resourceId:1,textureResourceId:4294967297,texture:{...root,matrix:0},vertexCount:3,
      firstVertex:0,firstIndex:0,indexCount:3,origin:[0,0,0]}
    const fresh={...old,resourceId:2,textureResourceId:4294967298}
    const packet={draws:[fresh],frame:{coverageComplete:unavailable!=='coverage'},nativePlan:{id:2}}
    let outputs
    try {
      installGeometry(r,old,{key:'mesh:1',partitions:new Map()})
      r.geometryPinnedKeys.add('mesh:1')
      r.displaySurface={current:{draws:[old]},renderDraws:[]}
      if(unavailable!=='unsubmitted')r.lastSubmittedSurface=r.displaySurface.current
      r.textures.cache.set(key(root),{texture:{},width:1,height:1},4)
      if(unavailable!=='image')r.textures.cache.set(key(leaf),
        {texture:unavailable==='upload'?null:{},width:1,height:1},4)
      r.presentation.cells.set(key(leaf),{cell:leaf,a:root,b:leaf})
      const plan=r.prepareMeshOutputs(packet)
      let repeatedQuotes=0
      const planBatch=r.geometry.planBatch.bind(r.geometry)
      r.geometry.planBatch=(...args)=>{if(plan.worldTask)++repeatedQuotes;return planBatch(...args)}
      outputs=await plan.admit(packet,60)
      assert(outputs && outputs.valid())
      assert(repeatedQuotes<=1,'Funded world rows repeatedly repriced the complete geometry cut')
      assert(plan.preparedWorld&&plan.preparedWorld.result.cuts.size===1,
        'Actual terrain publication omitted its paid display successor')
      assert.strictEqual(ledger.stats().owners['display-cut'].resident,plan.attempt.worldCutBytes)
      if(unavailable==='empty') {
        const cut=plan.preparedWorld.result.cuts.get('mesh:2')
        assert.strictEqual(plan.attempt.emptyCoverageCells,1)
        assert.strictEqual(cut.rows.length,3,'A proven empty UV cell retained a display payload')
        assert(cut.rows.every(draw=>plan.rows.get('mesh:2').prices.get(r.partitionCell(draw).key)>0),
          'Pruning discarded a nonempty UV cell')
        assert.strictEqual(plan.attempt.worldCutBytes,512+3*768+256)
        assert(outputs.hasResidentCoverage(),'Pruning empty cells lost the complete coverage proof')
      }
      if(unavailable==='source')++r.textures.generation
      if(unavailable==='pause')r.setPaused(true)
      const bytes=ledger.bytes
      assert.strictEqual(outputs.hasResidentCoverage(),unavailable===null||unavailable==='matrix'||unavailable==='empty',
        'Resident coverage requires complete geometry, submitted display and live uploaded images: '+unavailable)
      assert.strictEqual(ledger.bytes,bytes,'Coverage proof allocated unpriced image payload')
      if(unavailable==='image') {
        r.releaseMemoryListener()
        let wakes=0;r.requestResourcesCallback=()=>{++wakes};r.resourcesRequested=false
        outputs.release()
        assert.strictEqual(wakes,0,'An unaccepted candidate release restarted preparation without a capacity event')
        assert.strictEqual(r.resourcesRequested,false)
      }
      if(unavailable==='coverage') {
        outputs.acceptSurface()
        r.releaseMemoryListener()
        let wakes=0;r.requestResourcesCallback=()=>{++wakes};r.resourcesRequested=false
        outputs.release()
        assert.strictEqual(wakes,0,'An accepted but unpresented candidate release restarted preparation')
      }
      if(unavailable==='matrix') {
        outputs.acceptSurface()
        // A receipt must wake preparation even when capacity notifications do
        // not provide an incidental wake (all target images can be resident).
        r.releaseMemoryListener()
        let wakes=0;r.requestResourcesCallback=()=>{++wakes};r.resourcesRequested=false
        const reserved=r.partitionReservedBytes
        plan.finishHandoff()
        assert.strictEqual(r.meshOutputPlan,null)
        assert.strictEqual(r.forecastOutputPlan,plan)
        assert.strictEqual(r.partitionReservedBytes,reserved,'Presentation refunded still-owned UV output')
        assert(r.resourcesRequested&&wakes===1,'Forecast handoff receipt did not wake its refinement clock')
      }
      if(!unavailable) {
        // Live camera/presentation changes cannot retire the frozen handoff's
        // fine blend endpoints or its already priced new-mesh UV destinations.
        r.cameraVersion+=1;r.presentation.cells.clear()
        r.textures.cache.maximumBytes=1;r.textures.cache.evict()
        assert(r.textures.cache.has(key(leaf)) && r.textures.cache.has(key(root)))
        assert(outputs.hasResidentCoverage())
        assert.strictEqual(r.partitionReservedBytes,24)
        outputs.acceptSurface()
        r.releaseMemoryListener()
        let wakes=0;r.requestResourcesCallback=()=>{++wakes};r.resourcesRequested=false
        outputs.presented()
        assert(r.resourcesRequested&&wakes===1,'Coverage handoff receipt did not wake its refinement clock')
        assert(!outputs.hasResidentCoverage(),'Retired handoff retained a coverage admission')
        r.textures.cache.evict()
        assert(!r.textures.cache.has(key(leaf)),'Receipt retained the old image hold')
      }
    } finally {
      if(outputs){outputs.release();outputs.credit.release()}
      r.destroy()
    }
    assert.strictEqual(ledger.bytes,0,'Coverage admission leaked image/geometry ownership')
  }
}
