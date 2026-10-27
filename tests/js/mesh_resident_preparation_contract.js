const installGeometry = require('./reference/geometry_payload')
const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {createPreparedPartitionBatch, preparedPartitionBytes} = require('../../adapters/wasm/prepared_partitions')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile: child} = require('../../sdk/js/imagery/terra_texture_tiles')

function fixture(Renderer, canvas, options) {
  const ledger = new ResourceLedger(20000 + 32 * 1024 * 1024), r = new Renderer(canvas, Object.assign({
    resourceLedger: ledger, urlForTile: () => '', geometryCacheBytes: 10000, partitionCacheBytes: 10000,
    meshPartitionWorkspaceBytes: () => 0
  }, options))
  const tile = {level: 0, matrix: 0, row: 0, column: 0}, leaf = child(tile, 1, 0, 0)
  const draw = resourceId => ({resourceId, textureResourceId: 4294967296 + resourceId, texture: tile, vertexCount: 3, firstIndex: 0, indexCount: 3})
  const model = surface.prepareSurface(new Float32Array([0,0,0,1,0,0,0,1,0]),
    new Float32Array([0,0,1,0,0,1]), new Uint16Array([0,1,2]), 0, 3)
  const geometry = {key: 'mesh:1', resourceId: 1, model, partitions: new Map()}
  installGeometry(r, draw(1), geometry)
  r.geometryPinnedKeys.add('mesh:1')
  r.displaySurface = {current: {draws: [draw(1)]}, renderDraws: []}
  r.presentation.cells.set(key(leaf), {cell: leaf, a: tile, b: leaf})
  const packet = {draws: [draw(1), draw(2)], nativePlan: {id: 20}}
  return {r, ledger, geometry, model, packet}
}

module.exports = async function verifyResidentPreparation(Renderer, canvas) {
  // Resident pricing must match independent scratch-only UV pricing. New
  // meshes still use Native; both kinds complete through one batch request.
  {
    const sampled = [], resident = []
    let f, outputs
    f = fixture(Renderer, canvas, {
      createMeshPartitionPlanTask(id, rows, onRows) {
        const abi = {module: {call: () => 0}, createPreparedPartitionTask(id, draw, cells) {
          sampled.push(draw.resourceId)
          return surface.createUvPartitionPlanTask(f.model.uv, f.model.faces, cells)
        }}
        const task = createPreparedPartitionBatch(abi, id, rows, new Uint16Array([0,1,2]),
          Math.max(...rows.map(row => preparedPartitionBytes(row.draw))), row => {
            const entry = f.r.geometry.entries.get(row.geometryKey)
            if (!entry) return null
            resident.push(row.draw.resourceId)
            return {model: entry.value.model, release: f.r.geometry.retain(row.geometryKey)}
          })
        return {promise: task.run(onRows), cancel: () => task.cancel()}
      }
    })
    const {r, ledger, packet, geometry} = f
    try {
      const plan = r.prepareMeshOutputs(packet)
      const cells = plan.draws([packet.draws[0]]).map(d => r.partitionCell(d))
      const expected = new Map((await surface.createUvPartitionPlanTask(f.model.uv, f.model.faces, cells).run())
        .map(item => [item.key, item.bytes]))
      outputs = await plan.admit(packet, 120)
      assert(outputs && outputs.valid())
      assert.deepStrictEqual(sampled, [2], 'A resident mesh was sampled from Native again')
      assert.deepStrictEqual(resident, [1])
      assert.strictEqual(r.meshPreparationStats.last.batches, 1)
      assert.deepStrictEqual(plan.rows.get('mesh:1').prices, expected)
      const newCells = plan.draws([packet.draws[1]]).map(d => r.partitionCell(d))
      const expectedNew = new Map((await surface.createUvPartitionPlanTask(f.model.uv, f.model.faces, newCells).run())
        .map(item => [item.key, item.bytes]))
      assert.deepStrictEqual(plan.rows.get('mesh:2').prices, expectedNew)
      assert(Array.from(expectedNew).every(([key, bytes]) => expected.has(key) || bytes === 0),
        'Whole-hull culling removed a nonempty cell')
      assert.strictEqual(r.geometry.entries.get('mesh:1').holds, 1,
        'Funded admission did not retain its resident geometry destination')
      assert.strictEqual(r.meshPreparationStats.last.residentMeshes, 1)
      assert.strictEqual(r.meshPreparationStats.last.sampledMeshes, 1)
      const before = surface.partitionCacheStats()
      assert.deepStrictEqual(await surface.createPartitionPlanTask(geometry.model, cells).run(),
        Array.from(expected, ([key, bytes]) => ({key, bytes})))
      assert(surface.partitionCacheStats().hits >= before.hits + cells.length,
        'Resident preparation did not share the immutable UV cost cache')
      assert.strictEqual(outputs.credit.bytes, 120)
    } finally {
      if (outputs) {outputs.release(); outputs.credit.release()}
      r.destroy()
    }
    assert.strictEqual(ledger.bytes, 0)
  }

  // An evicted/paused input stays charged until a delayed cancellation receipt.
  let entered, complete, cancelled = false
  const started = new Promise(resolve => {entered = resolve})
  const f = fixture(Renderer, canvas, {
    createMeshPartitionPlanTask() {
      const release = f.r.geometry.retain('mesh:1')
      entered()
      return {promise: new Promise(resolve => {complete = resolve}).finally(release), cancel() {cancelled = true}}
    }
  })
  const {r, ledger, packet} = f
  const pending = r.prepareMeshOutputs(packet).admit(packet, 120)
  try {
    await started
    r.geometry.delete('mesh:1')
    assert.strictEqual(r.geometry.stats().retainedEntries, 1)
    assert.strictEqual(ledger.bytes, 240, 'Known successor costs were not protected while pricing')
    r.setPaused(true)
    assert(cancelled)
    assert.strictEqual(ledger.bytes, 60, 'Pause refunded an input before its cancellation receipt')
    complete(null)
    assert.strictEqual(await pending, null)
    assert.strictEqual(ledger.bytes, 0)
    assert.strictEqual(r.geometry.stats().retainedEntries, 0)
  } finally {
    if (complete) complete(null)
    await pending
    r.destroy()
  }
}
