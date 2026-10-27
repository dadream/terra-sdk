const assert = require('assert')
const {TerrainCapacity} = require('../../sdk/js/terrain/terrain_capacity')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')

module.exports = async function verifyIncrementalRecovery() {
  // A complete local producer fits beside the old display even though another
  // full three-owner generation cannot. The real production admission, not the
  // policy's target quota, owns every byte before the producer may allocate.
  for (const asynchronous of [false, true]) {
    const ledger = new ResourceLedger(150), display = ledger.reserve('old-display',80)
    const remote = asynchronous ? ledger.reserve('idle-native',40) : null
    const capacity = new TerrainCapacity(50,10), frames = new MeshFrames(ledger)
    capacity.refuse(30,1,40)
    const before = ledger.bytes
    assert(capacity.beginRestore(1))
    assert.strictEqual(ledger.bytes,before,'Reopening selection allocated or refunded payload')
    assert(ledger.bytes + 3 * capacity.preferred > ledger.maximumBytes)
    let refund
    const unregister = asynchronous ? ledger.reclamation.register({revision:()=>1,
      reclaim:needed=>new Promise(resolve=>{refund=()=>{
        const bytes=Math.min(needed,remote.bytes);remote.resize(remote.bytes-bytes);resolve(bytes)
      }})}) : ()=>{}
    const packet = {draws:[{resourceId:1,textureResourceId:1,vertexCount:1,positionFloatCount:3,textureFloatCount:2,
      firstIndex:0,indexCount:3}],nativePlan:{additionalBytes:20,residentBytes:0,reclaimableBytes:0,maximumBytes:100}}
    let admitted
    try {
      const pending = frames.admitProduction(packet,()=>20,
        (bytes,acquire)=>frames.reserveNativeWork('local-production',bytes,acquire))
      if (asynchronous) {
        await Promise.resolve()
        assert(refund,'Refused local production did not request actual native reclamation')
        assert.strictEqual(ledger.bytes,before,'An unacknowledged native refund funded production')
        refund()
      }
      admitted = await pending
      assert.strictEqual(admitted.credit.bytes,40)
      assert.strictEqual(display.bytes,80,'The old display was released before a replacement receipt')
      assert(ledger.bytes <= ledger.maximumBytes)
      unregister()
      const extra = ledger.reserve('other-funded-work',ledger.maximumBytes-ledger.bytes)
      await assert.rejects(frames.admitProduction(packet,()=>20,
        (bytes,acquire)=>frames.reserveNativeWork('another-production',bytes,acquire)),error=>error.status===9)
      assert.strictEqual(display.bytes,80)
      extra.release()
    } finally {
      unregister();if(admitted)admitted.credit.release();if(remote)remote.release();display.release();frames.clear()
    }
    assert.strictEqual(ledger.bytes,0,'Local recovery left an owned allocation')
  }
}
