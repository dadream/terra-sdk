const assert = require('assert')
const installGeometry = require('./reference/geometry_payload')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {textureResourceKey} = require('../../sdk/js/resources/mesh_coordinates')

// The old complete display and a smaller successor each fit the steady cache,
// but their overlap does not. Only the shared ledger can fund that overlap.
module.exports = async function verifyGeometryHandoff(Renderer, canvas) {
  for (const action of ['present', 'cancel', 'shared-limit', 'oversized-target', 'unrelated-owner']) {
    const ledger = new ResourceLedger(1000)
    const r = new Renderer(canvas, {resourceLedger:ledger, urlForTile:()=>'',
      geometryCacheBytes:200, partitionCacheBytes:1000,
      meshPartitionWorkspaceBytes:()=>0,
      createMeshPartitionPlanTask(){ assert.fail('Unpartitioned handoff needs no UV pricing') }})
    const tile = {level:0,matrix:0,row:0,column:0}
    const old = {resourceId:1,textureResourceId:512,texture:tile,vertexCount:action === 'unrelated-owner' ? 6 : 9}
    const fresh = {resourceId:2,textureResourceId:513,texture:tile,
      vertexCount:action === 'oversized-target' ? 12 : action === 'unrelated-owner' ? 9 : 6}
    const packet = {draws:[fresh],nativePlan:{id:10},imageryPlan:{draws:[]}}
    let outputs
    try {
      installGeometry(r,old,{key:'mesh:1',partitions:new Map()})
      r.geometryPinnedKeys.add('mesh:1')
      r.geometryPinnedKeys.add(textureResourceKey(old))
      if (action === 'unrelated-owner') {
        const other = {resourceId:3,textureResourceId:514,texture:tile,vertexCount:3}
        installGeometry(r,other,{key:'mesh:3',partitions:new Map()})
        r.geometryPinnedKeys.add('mesh:3'); r.geometryPinnedKeys.add(textureResourceKey(other))
      }
      r.displaySurface = {current:{draws:[old]},renderDraws:[]}
      ledger.setLimit(action === 'shared-limit' ? 539 : 1000)
      const plan = r.prepareMeshOutputs(packet)
      outputs = await plan.admit(packet,240)
      if (['shared-limit', 'oversized-target', 'unrelated-owner'].includes(action)) {
        assert.strictEqual(outputs,null,action + ' admitted an unfunded successor')
        assert(plan.capacityShortfallBytes > 0,'Capacity refusal lost its physical deficit')
        assert.strictEqual(ledger.bytes,180,'Refusal changed old display ownership')
        assert(r.geometry.has('mesh:1'))
        plan.release(); r.destroy()
        assert.strictEqual(ledger.bytes,0,'Refused handoff ownership leaked')
        continue
      }
      assert(outputs && outputs.valid(),'A globally funded smaller replacement cannot pass the local cache ceiling')
      assert.strictEqual(ledger.bytes,540,'Old geometry was refunded before its replacement existed')
      assert.strictEqual(r.geometry.maximumBytes,200,'Handoff permanently raised the cache budget')
      assert.strictEqual(r.geometry.reserve('unrelated',1),null,'Handoff allowance escaped to unrelated producers')
      if (action === 'present') {
        r.geometryPinnedKeys.add('mesh:2')
        r.geometryPinnedKeys.add(textureResourceKey(fresh))
        installGeometry(r,fresh,{key:'mesh:2',partitions:new Map()},outputs)
        assert.strictEqual(r.geometry.bytes,300)
        assert(r.geometry.has('mesh:1'),'Uploading the successor evicted the displayed predecessor')
        outputs.presented()
        outputs.credit.release()
        r.geometryPinnedKeys.delete('mesh:1'); r.geometryPinnedKeys.delete(textureResourceKey(old))
        r.geometry.evict()
        assert.strictEqual(r.geometry.bytes,120,'Receipt failed to restore the steady cache footprint')
        assert(!r.geometry.has('mesh:1') && r.geometry.has('mesh:2'))
      } else {
        outputs.release(); outputs.credit.release()
        assert.strictEqual(ledger.bytes,180,'Cancelled handoff leaked destinations or retired the old display')
        assert(r.geometry.has('mesh:1'))
      }
    } finally {
      if (outputs) {outputs.release(); outputs.credit.release()}
      r.destroy()
    }
    assert.strictEqual(ledger.bytes,0,'Handoff ownership leaked')
  }
}
