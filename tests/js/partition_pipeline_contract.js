const installGeometry = require('./reference/geometry_payload')
const assert = require('assert')
const {GlSubmission, UploadBudget} = require('../../adapters/webgl/gl_allocation')
const costBatch = require('./reference/mesh_cost_batch')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile: child} = require('../../sdk/js/imagery/terra_texture_tiles')

module.exports = async function verifyPipeline({Renderer, FakeGl, FakeCanvas}) {
  for (const limit of [264, 528]) await verifyWindow(Renderer, FakeGl, FakeCanvas, limit)
}

async function verifyWindow(Renderer, FakeGl, FakeCanvas, limit) {
  const cellBytes = 66, windowJobs = limit / (4 * cellBytes), windowCells = limit / cellBytes
  const gl = new FakeGl(), produced = [], tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const r = new Renderer(new FakeCanvas(gl), {urlForTile: () => '', uploadBudgetObjects: 24, uploadBudgetBytes: limit,
    meshPartitionWorkspaceBytes: () => 0,
    createMeshPartitionPlanTask(id, rows, onRows) {
      return costBatch(rows, onRows, row => row.cells.map(cell => ({key: cell.key, bytes: cellBytes})))
    },
    createPartitionTask(id, cells, geometry, bytes) {
      assert.strictEqual(bytes, cells.length * cellBytes)
      produced.push(id)
      return {promise: Promise.resolve(cells.map(cell => ({cell, indices: new Uint16Array([0,1,2]),
        positions: new Float32Array(9), uv: new Float32Array(6)}))), cancel() {}}
    }})
  let outputs, batch
  try {
    // Nine terrain meshes share an already-admitted immutable imagery cut.
    // Keeping GPU completion pending must allow one further upload batch, but
    // cannot drain the entire cut into an unbounded CPU-ready queue.
    r.sourceUvPartitions = true
    // Exercise explicit partition production beyond the direct-clip precision
    // bound; shallow handoffs can now use the funded base mesh immediately.
    r.sourceUvScale = () => 1
    const tile = {level: 0, matrix: 0, row: 0, column: 0}, leaf = child(tile, 1, 0, 0)
    const draws = Array.from({length: 9}, (_, i) => ({resourceId: i + 1, textureResourceId: 4294967297 + i, texture: tile, vertexCount: 3}))
    for (const draw of draws) {
      const id = 'mesh:' + draw.resourceId
      installGeometry(r, draw, {key: id, resourceId: draw.resourceId, partitions: new Map()})
      r.geometryPinnedKeys.add(id)
    }
    r.displaySurface = {current: {draws: [{...draws[0], resourceId: 1000}]}, renderDraws: []}
    r.presentation.cells.set(key(leaf), {cell: leaf, a: tile, b: leaf})
    const packet = {draws, nativePlan: {id: 20}}, plan = r.prepareMeshOutputs(packet)
    outputs = await plan.admit(packet, 0)
    assert(outputs && outputs.valid())
    for (const draw of draws) r.requestPartitionSet(r.geometry.get('mesh:' + draw.resourceId),
      plan.draws([draw]).map(d => r.partitionCell(d)))
    const fill = async () => { for (let i = 0; i < 15; ++i) {r.pumpPartitionRequests(); await tick()} }
    await fill()
    assert.strictEqual(produced.length, windowJobs, 'Ready output serialized preparation or exceeded one upload window')
    assert.strictEqual(r.partitionUploads.length, windowJobs)
    batch = r.uploadBatch = new GlSubmission(gl, null, new UploadBudget(limit, 24))
    r.processPartitionUploads(Infinity)
    r.uploadBatch = null
    assert.strictEqual(batch.items.length, windowJobs, 'Independent mesh uploads paid separate completion boundaries')
    assert.strictEqual(batch.budget.bytes, limit)
    assert.strictEqual(batch.budget.objects, 3 * windowCells)
    assert(r.geometry.values().every(g => g.partitions.size === 0), 'Unacknowledged uploads were published')
    const charged = r.resourceLedger.bytes
    await fill()
    assert.strictEqual(produced.length, 2 * windowJobs, 'GPU wait did not allow exactly one next preparation window')
    assert.strictEqual(r.partitionUploads.length, windowJobs)
    assert.strictEqual(r.resourceLedger.bytes, charged, 'Lookahead created unfunded output')
    batch.commit(); batch = null
    assert.strictEqual(r.geometry.values().reduce((n,g) => n + g.partitions.size, 0), windowCells)
    assert.strictEqual(r.partitionCpuBytes, (36 - windowCells) * cellBytes)
    batch = r.uploadBatch = new GlSubmission(gl, null, new UploadBudget(limit, 24))
    r.processPartitionUploads(Infinity); r.uploadBatch = null
    assert.strictEqual(batch.items.length, windowJobs)
    batch.cancel(); batch = null
    assert.strictEqual(r.partitionUploads.length, windowJobs, 'Failed batch lost independent retry inputs')
    assert.strictEqual(r.partitionReservedBytes, (36 - windowCells) * cellBytes)
  } finally {
    r.uploadBatch = null
    if (batch) batch.cancel()
    if (outputs) {outputs.release(); outputs.credit.release()}
    r.destroy(); await tick()
  }
  assert.strictEqual(r.resourceLedger.bytes, 0, 'Pipeline teardown refunded early or leaked admitted work')
}
