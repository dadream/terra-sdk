const installGeometry = require('./reference/geometry_payload')
const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile: child} = require('../../sdk/js/imagery/terra_texture_tiles')

module.exports = async function verifyPreparationCredit(Renderer, canvas) {
  for (const mode of ['complete', 'cancel', 'stopped', 'failed', 'short', 'imagery-grant']) {
    const ledger = new ResourceLedger(mode === 'short' ? 707 : 708)
    let entered, finish, fail, progress, cancelled = false, starts = 0, outputs, pending, replans = 0
    const started = new Promise(resolve => {entered = resolve})
    const r = new Renderer(canvas, {resourceLedger: ledger, urlForTile: () => '',
      geometryCacheBytes: 10000, partitionCacheBytes: 10000,
      textureCacheBytes: 100, imageryShareMaximumBytes: 200,
      onImageryPlanningChange() { ++replans },
      meshPartitionWorkspaceBytes: () => 648,
      createMeshPartitionPlanTask(id, rows, onRows, credit) {
        ++starts
        // Pricing and production both fit 648 bytes, but cannot coexist as
        // independent allocations. A real funded loan must cover this stage.
        assert.strictEqual(ledger.bytes, 708, 'Pricing began without protected terrain credit')
        assert(credit && credit.bytes === 648, 'Pricing received no owned scratch loan')
        assert.strictEqual(ledger.reserve('imagery-detail', 1), null)
        progress = () => onRows(rows.map(row => ({resourceId: row.draw.resourceId, source: 'sampled',
          prices: row.cells.map((cell, i) => ({key: cell.key, bytes: mode === 'stopped' && !i ? 67 : 66}))})))
        entered()
        return {promise: new Promise((resolve, reject) => {finish = resolve; fail = reject}),
          cancel() {cancelled = true}}
      }})
    const tile = {level: 0, matrix: 0, row: 0, column: 0}, leaf = child(tile, 1, 0, 0)
    const draw = resourceId => ({resourceId, textureResourceId: 4294967296 + resourceId, texture: tile, vertexCount: 3, firstIndex: 0, indexCount: 0})
    const packet = {draws: [draw(2)], nativePlan: {id: 10}}
    try {
      installGeometry(r, draw(1), {key: 'mesh:1', partitions: new Map()})
      r.geometryPinnedKeys.add('mesh:1')
      if (mode === 'imagery-grant') {
        assert(r.textures.resourceShare.grow(100))
        assert.strictEqual(ledger.bytes, 160)
      }
      r.displaySurface = {current: {draws: [draw(1)]}, renderDraws: []}
      r.presentation.cells.set(key(leaf), {cell: leaf, a: tile, b: leaf})
      pending = r.prepareMeshOutputs(packet).admit(packet, 60)
      if (mode === 'short') {
        assert.strictEqual(await pending, null)
        assert.strictEqual(starts, 0, 'An unfunded scratch producer was started')
      } else {
        // Propagate synchronous producer failures instead of waiting forever
        // for a start acknowledgement that could never arrive.
        await Promise.race([started, pending.then(() => assert.fail('Pricing did not wait for its receipt'))])
        if (mode === 'cancel') {
          r.setPaused(true)
          assert(cancelled)
          assert.strictEqual(ledger.bytes, 708, 'Cancelled scratch was refunded before acknowledgement')
          assert.strictEqual(ledger.stats().owners['mesh-preparation'].retired, 648)
        } else if (mode !== 'failed') assert.strictEqual(progress(), mode !== 'stopped')
        assert.strictEqual(ledger.bytes, 708)
        if (mode === 'failed') {
          fail(new Error('Pricing producer failed'))
          await assert.rejects(pending, /Pricing producer failed/)
        } else {
          finish(mode === 'complete' || mode === 'imagery-grant')
          outputs = await pending
          if (mode === 'complete' || mode === 'imagery-grant') {
            assert(outputs && outputs.valid())
            assert.strictEqual(outputs.credit.bytes, 60)
            assert.strictEqual(ledger.bytes, 708, 'Scratch and successor were charged twice')
            assert.strictEqual(ledger.highWaterBytes, 708)
            assert.strictEqual(r.partitionCpuBytes, 264)
            assert.strictEqual(r.partitionReservedBytes, 264)
            if (mode === 'imagery-grant') {
              assert.strictEqual(replans, 1)
              assert.strictEqual(r.textures.resourceShare.stats().unusedBytes, 0)
              assert.strictEqual(r.textures.resourceShare.bytes, 100)
              assert.strictEqual(r.textures.resourceShare.pressured, false)
            }
          } else assert.strictEqual(outputs, null)
        }
      }
      if (mode !== 'complete' && mode !== 'imagery-grant') assert.strictEqual(ledger.bytes, 60)
    } finally {
      if (finish) finish(false)
      if (pending) await pending.catch(() => {})
      if (outputs) {outputs.release(); outputs.credit.release()}
      r.destroy()
    }
    assert.strictEqual(ledger.bytes, 0, mode + ' leaked owned preparation work')
  }
}
