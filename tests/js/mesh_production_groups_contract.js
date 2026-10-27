const installGeometry = require('./reference/geometry_payload')
const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile: child} = require('../../sdk/js/imagery/terra_texture_tiles')
const costBatch = require('./reference/mesh_cost_batch')
const allocationQuote = require('./reference/mesh_allocation_quote')

module.exports = async function verifyProductionGroups(Renderer, canvas) {
  // Every complete target fits memory. A smaller GPU byte/object window must
  // not turn that target into several independently prepared terrain frames.
  for (const [bytes, objects] of [[180,100], [10000,6]]) {
    // Keep the former fixture total explicit; the renderer no longer owns it.
    const ledger = new ResourceLedger(20000 + 32 * 1024 * 1024), priced = [], selected = []
    const r = new Renderer(canvas, {resourceLedger:ledger, urlForTile:()=>'',
      geometryCacheBytes:10000, partitionCacheBytes:10000,
      uploadBudgetBytes:bytes, uploadBudgetObjects:objects,
      meshPartitionWorkspaceBytes: () => 0,
      createMeshPartitionPlanTask(id, rows, onRows) {
        return costBatch(rows,onRows,({draw,cells})=>{
          priced.push(draw.resourceId); return cells.map(c=>({key:c.key,bytes:6}))
        })
      }})
    const tile={level:0,matrix:0,row:0,column:0}, leaf=child(tile,1,0,0)
    const draw=resourceId=>({resourceId, textureResourceId: 4294967296 + resourceId,texture:tile,vertexCount:3,firstIndex:0,indexCount:0})
    const before=[1,2,3,4].map(draw), after=[11,12,13,14,15].map(draw)
    const proof={groups:[{before:[3],after:[12,13]}, {before:[1,2],after:[11]}, {before:[4],after:[14,15]}]}
    const packet={draws:after, frame:{coverageComplete:true}, nativePlan:{id:10,
      residentBytes:0,additionalBytes:300,reclaimableBytes:0,maximumBytes:10000},
      replacementPlan:{atomic:true,groups:[{before:[1,2,3,4],after:[11,12,13,14,15]}]}}
    const frames=new MeshFrames(ledger)
    frames.presented={draws:before,frame:{coverageComplete:true}}
    let result, scans=0
    try {
      before.forEach(d=>{
        const id='mesh:'+d.resourceId
        installGeometry(r,d,{key:id,partitions:new Map(),partitionBytes:0})
        r.geometryPinnedKeys.add(id)
      })
      r.displaySurface={current:{draws:before},renderDraws:[]}
      r.presentation.cells.set(key(leaf),{cell:leaf,a:leaf,b:leaf})
      frames.prepareOutputs=packet=>allocationQuote(r.prepareMeshOutputs(packet))
      result=await frames.admitProduction(packet,
        value=>value.draws.filter(d=>d.resourceId>10).length*60,
        (n,acquire)=>frames.reserveNativeWork('mesh-transfer',n,acquire),
        async indices=>{
          assert.strictEqual(scans,1,'Local selection preceded native boundary proof')
          selected.push(indices)
          const ids=proof.groups.flatMap((g,i)=>indices.includes(i)?g.after:g.before)
          return {...packet,draws:ids.map(draw),nativePlan:{...packet.nativePlan,
            additionalBytes:ids.filter(id=>id>10).length*60}}
        },async()=>{++scans;return proof})
      assert.deepStrictEqual(selected,[],'GPU work window split a memory-funded terrain target')
      assert.strictEqual(scans,0,'Upload window forced an unnecessary native boundary selection')
      assert(after.every(d=>priced.includes(d.resourceId)),'Full target omitted a destination price')
      assert.deepStrictEqual(result.packet.draws.map(d=>d.resourceId),[11,12,13,14,15])
      assert(result.outputs.valid())
      assert(ledger.bytes < ledger.maximumBytes,'Fixture did not leave room for full production')
      assert(before.every(d=>r.geometry.has('mesh:'+d.resourceId)),'Preparation released old display')
    } finally {
      if(result){result.outputs.release();result.credit.release()}
      r.destroy()
    }
    assert.strictEqual(ledger.bytes,0)
  }
  await verifyCapacityFallback()
}

async function verifyCapacityFallback() {
  for (const mode of ['full-fitting','full-refused','first-group-refused','all-refused']) {
    const ledger=new ResourceLedger(1000), frames=new MeshFrames(ledger), selected=[]
    const draw=resourceId=>({resourceId, textureResourceId: 4294967296 + resourceId,vertexCount:3,firstIndex:0,indexCount:0})
    const packet={draws:[3,4].map(draw),frame:{coverageComplete:true},
      nativePlan:{additionalBytes:120,residentBytes:0,reclaimableBytes:0,maximumBytes:1000},
      replacementPlan:{atomic:true,groups:[{before:[1,2],after:[3,4]}]}}
    frames.presented={draws:[1,2].map(draw),frame:{coverageComplete:true}}
    let nativeIds=[3,4], admitted, releases=0,scans=0
    const pressure=mode==='full-fitting'?null:ledger.reserve('unrelated-owner',900)
    frames.prepareOutputs=()=>({
      admit:async (value,bytes)=>{
        assert.deepStrictEqual(value.draws.map(d=>d.resourceId),nativeIds,'Pricing stale native selection')
        if(mode==='all-refused'||mode==='first-group-refused'&&nativeIds.includes(3)&&nativeIds.includes(2))return null
        const credit=ledger.reserve('mesh-transfer',bytes)
        return credit?{credit,valid:()=>true,release(){++releases}}:null
      },release(){++releases}})
    try {
      const operation=frames.admitProduction(packet,()=>0,(n,acquire)=>acquire(),async indices=>{
        selected.push(indices)
        nativeIds=[indices.includes(0)?3:1,indices.includes(1)?4:2]
        return {...packet,draws:nativeIds.map(draw),nativePlan:{...packet.nativePlan,
          additionalBytes:nativeIds.filter(id=>id>2).length*60}}
      },async()=>{
        ++scans
        assert.notStrictEqual(mode,'full-fitting','An admitted full cut demanded a boundary workspace')
        return {groups:[{before:[1],after:[3]},{before:[2],after:[4]}]}
      })
      if(mode==='all-refused')await assert.rejects(operation,error=>error.status===9)
      else {
        admitted=await operation
        assert.deepStrictEqual(admitted.packet.draws.map(d=>d.resourceId),
          mode==='full-fitting'?[3,4]:mode==='first-group-refused'?[1,4]:[3,2])
        assert.strictEqual(releases,0,'Successful output ownership was released during selection')
      }
      assert.strictEqual(scans,mode==='full-fitting'?0:1)
      assert.deepStrictEqual(selected,mode==='full-fitting'?[]:mode==='full-refused'?[[0]]:[[0],[1]])
      assert.deepStrictEqual(frames.presented.draws.map(d=>d.resourceId),[1,2],'Admission changed the displayed cut')
    } finally {
      if(admitted){admitted.outputs.release();admitted.credit.release()}
      if(pressure)pressure.release()
    }
    assert.strictEqual(ledger.bytes,0)
    assert.strictEqual(releases,1)
  }
}
