const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const installGeometry = require('./reference/geometry_payload')
const costBatch = require('./reference/mesh_cost_batch')
const allocationQuote = require('./reference/mesh_allocation_quote')
const {textureKeyString:key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile:child} = require('../../sdk/js/imagery/terra_texture_tiles')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {atomicReplacementPlan} = require('../../sdk/js/terrain/surface_replacement')

module.exports = async function verifyStagePeak(Renderer, canvas) {
  for (const cancel of [false,true]) {
    const ledger = new ResourceLedger(316)
    const r = new Renderer(canvas,{resourceLedger:ledger,urlForTile:()=>'',
      geometryCacheBytes:10000,partitionCacheBytes:10000,meshPartitionWorkspaceBytes:()=>0,
      createMeshPartitionPlanTask(id,rows,onRows) {
        return costBatch(rows,onRows,({cells})=>cells.map(cell=>({key:cell.key,bytes:6})))
      }})
    const tile={level:0,matrix:0,row:0,column:0},leaf=child(tile,1,0,0)
    const old={resourceId:1,textureResourceId:4294967297,texture:tile,vertexCount:3,firstIndex:0,indexCount:0}
    const next={resourceId:2,textureResourceId:4294967298,texture:tile,vertexCount:3,firstIndex:0,indexCount:0}
    const packet={draws:[next],nativePlan:{id:1}}
    let outputs,finish,called=0
    try {
      installGeometry(r,old,{key:'mesh:1',partitions:new Map()})
      r.geometryPinnedKeys.add('mesh:1')
      r.displaySurface={current:{draws:[old]},renderDraws:[]}
      r.presentation.cells.set(key(leaf),{cell:leaf,a:tile,b:leaf})
      const plan=r.prepareMeshOutputs(packet)
      const pending=plan.admit(packet,60,{bytes:256,run(credit) {
        ++called
        assert.strictEqual(credit.bytes,256)
        assert.strictEqual(ledger.bytes,316,'Boundary work overlaps or double-charges GPU destinations')
        assert.strictEqual(r.geometry.reservations.size,0,'New GPU destinations were allocated before boundary completion')
        assert.strictEqual(ledger.reserve('competitor',1),null)
        return new Promise(resolve=>{finish=resolve})
      }})
      assert.strictEqual(called,1,'The funded stage was skipped')
      if(cancel) {
        plan.release()
        assert.strictEqual(ledger.bytes,316,'Cancellation refunded the active boundary stage')
      }
      finish();outputs=await pending
      if(cancel) {
        assert.strictEqual(outputs,null)
        assert.strictEqual(ledger.bytes,60)
      } else {
        assert(outputs && outputs.valid())
        assert.strictEqual(outputs.credit.bytes,60)
        assert.strictEqual(ledger.bytes,228,'Boundary scratch remained reserved during production')
        assert.strictEqual(ledger.highWaterBytes,316)
      }
    } finally {
      if(outputs){outputs.release();outputs.credit.release()}
      r.destroy()
    }
    assert.strictEqual(ledger.bytes,0)
  }
  // Actual geometry/UV admission fits while the optional seam workspace does
  // not. The full atomic cut must retain old GPU ownership and price every new
  // destination; skipping that workspace cannot authorize a partial cut.
  const ledger = new ResourceLedger(316)
  const r = new Renderer(canvas,{resourceLedger:ledger,urlForTile:()=>'',
    geometryCacheBytes:10000,partitionCacheBytes:10000,meshPartitionWorkspaceBytes:()=>0,
    createMeshPartitionPlanTask(id,rows,onRows) {
      return costBatch(rows,onRows,({cells})=>cells.map(cell=>({key:cell.key,bytes:6})))
    }})
  const tile={level:0,matrix:0,row:0,column:0},leaf=child(tile,1,0,0)
  const old={resourceId:1,textureResourceId:4294967297,texture:tile,vertexCount:3,firstIndex:0,indexCount:0}
  const next={resourceId:2,textureResourceId:4294967298,texture:tile,vertexCount:3,firstIndex:0,indexCount:0}
  const frames=new MeshFrames(ledger)
  frames.presented={frame:{coverageComplete:true},draws:[old]}
  frames.prepareOutputs=packet=>allocationQuote(r.prepareMeshOutputs(packet))
  const packet={frame:{coverageComplete:true},draws:[next],
    nativePlan:{id:1,additionalBytes:0,residentBytes:0,reclaimableBytes:0,maximumBytes:10000},
    replacementPlan:atomicReplacementPlan([old],[next])}
  let admitted
  try {
    installGeometry(r,old,{key:'mesh:1',partitions:new Map()})
    r.geometryPinnedKeys.add('mesh:1')
    r.displaySurface={current:{draws:[old]},renderDraws:[]}
    r.presentation.cells.set(key(leaf),{cell:leaf,a:tile,b:leaf})
    const unexpected=()=>assert.fail('An unfunded seam proof or partial selection ran')
    admitted=await frames.admitProduction(packet,()=>60,unexpected,unexpected,unexpected,
      {bytes:512,run:unexpected})
    assert.strictEqual(admitted.packet.replacementPlan.atomic,true)
    assert.strictEqual(admitted.credit.bytes,60)
    assert.strictEqual(ledger.bytes,228,'Atomic fallback omitted geometry, UV or producer destinations')
    assert(r.geometry.has('mesh:1'),'Atomic fallback spent the old display')
    assert.strictEqual(ledger.reserve('competitor',89),null)
    assert(ledger.highWaterBytes<=ledger.maximumBytes)
  } finally {
    if(admitted){admitted.outputs.release();admitted.credit.release()}
    r.destroy()
  }
  assert.strictEqual(ledger.bytes,0,'Atomic fallback leaked owned destinations')
  console.log('Boundary/CPU/GPU transaction peak, ordered destinations and cancellation ownership passed')
}
