const installGeometry = require('./reference/geometry_payload')
const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile: child} = require('../../sdk/js/imagery/terra_texture_tiles')
const costBatch = require('./reference/mesh_cost_batch')

module.exports = async function verifyAdmissionCredit(Renderer, canvas) {
  // Old display (60) + Native/host producer (60) + GPU geometry (60) +
  // four UV destinations (4 * 66 * 2) exactly fill the shared budget.
  const ledger = new ResourceLedger(708), frames = new MeshFrames(ledger)
  let competitor, competed = false, admitted
  const r = new Renderer(canvas, {resourceLedger: ledger, urlForTile: () => '',
    geometryCacheBytes: 10000, partitionCacheBytes: 10000,
    meshPartitionWorkspaceBytes: () => 0,
    createMeshPartitionPlanTask(id, rows, onRows) {
      const task = costBatch(rows, onRows, row => row.cells.map(cell => ({key: cell.key, bytes: 66})))
      return {cancel: () => task.cancel(), promise: task.promise.then(value => {
        // Run after the admission continuation receives the final price, but
        // before its asynchronous caller consumes the result. No timers or
        // network timing are needed to reproduce this resource competition.
        queueMicrotask(() => queueMicrotask(() => {
          competed = true
          competitor = ledger.reserve('imagery-detail', 1)
        }))
        return value
      })}
    }})
  const tile = {level: 0, matrix: 0, row: 0, column: 0}, leaf = child(tile, 1, 0, 0)
  const draw = resourceId => ({resourceId, textureResourceId: 4294967296 + resourceId, texture: tile,
    vertexCount: 3, firstIndex: 0, indexCount: 0}) // This contract isolates UV output admission.
  const packet = {draws: [draw(2)], nativePlan: {
    id: 10, residentBytes: 0, additionalBytes: 30, reclaimableBytes: 0, maximumBytes: 10000}}
  try {
    installGeometry(r, draw(1), {key: 'mesh:1', partitions: new Map()})
    r.geometryPinnedKeys.add('mesh:1')
    r.displaySurface = {current: {draws: [draw(1)]}, renderDraws: []}
    r.presentation.cells.set(key(leaf), {cell: leaf, a: tile, b: leaf})
    frames.prepareOutputs = value => r.prepareMeshOutputs(value)
    admitted = await frames.admitProduction(packet, () => 30,
      (bytes, acquire) => frames.reserveNativeWork('mesh-transfer', bytes, acquire))
    assert(competed, 'Competition did not run before the caller consumed admission')
    assert.strictEqual(competitor, null, 'Completed terrain pricing returned without funded destinations')
    assert(admitted.outputs.valid())
    assert.strictEqual(admitted.credit.bytes, 60)
    assert.strictEqual(ledger.bytes, 708)
    assert.strictEqual(r.partitionCpuBytes, 264)
    assert.strictEqual(r.partitionReservedBytes, 264)
    assert(r.geometry.has('mesh:1'), 'Admission evicted the displayed terrain')
  } finally {
    if (admitted) {admitted.outputs.release(); admitted.credit.release()}
    if (competitor) competitor.release()
    r.destroy()
  }
  assert.strictEqual(ledger.bytes, 0, 'Funded admission leaked after cancellation')
}
