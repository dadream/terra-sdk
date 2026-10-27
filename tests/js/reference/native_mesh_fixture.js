const {NativeMeshBudget} = require('../../../sdk/js/resources/native_mesh_budget')
const {ownMesh} = require('../../../sdk/js/resources/mesh_ownership')

// JS fixtures own no actual native arrays. Real-Wasm and dedicated
// production-credit tests exercise nonzero native residency and failures.
module.exports = {
  ...require('./imagery_task_fixture'),
  createMeshTask(packet, bytes) {
    const abi = this
    return new (require('../../../sdk/js/runtime/cooperative_task').CooperativeTask)((function* () {
      abi.materializeMeshFrame(packet, bytes)
      return packet
    })())
  },
  commitMeshFrame(packet) { packet.nativePlan = null },
  recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, nativeRevision: 0,
  meshDraw(draw) { return Object.assign({textureResourceId: 4294967296 + draw.resourceId, firstIndex: 0, indexCount: 3}, draw) },
  copyMeshPositions(draw) { return this.copyMeshResource(draw).positions },
  copyMeshUv(draw) { return this.copyMeshResource(draw).textureUv },
  borrowMeshResource(draw) {
    const resource = this.copyMeshResource(draw)
    resource.textureResourceId = draw.textureResourceId
    return ownMesh(resource, {bytes: resource.positions.byteLength,
      mark() {}, release() {}})
  },
  reuseReplacementPlan() { return null },
  setResourceLedger(ledger) {
    if (!this.nativeBudget) this.nativeBudget = new NativeMeshBudget(ledger)
    if (this.nativeBudget.ledger !== ledger) throw new Error('Fixture changed native ledger')
    return this.nativeBudget
  },
  memoryBytes() { return 0 },
  meshPayloadBytes() { return 0 },
  recordPayloadBytes() { return 0 },
  heightPayloadBytes() { return 0 },
  imageryPayloadBytes() { return 0 },
  imageryOutputPayloadBytes() { return 0 },
  imageryReferencePayloadBytes() { return 0 },
  imageryInputPayloadBytes() { return 0 },
  reclaimHeights() { return 0 },
  discardTerrainWork() {},
  heightSlice(bytes, produce) { return produce() },
  reclaimRecords() { return 0 },
  trimMeshCache() {}
}
