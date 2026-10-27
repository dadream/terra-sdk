const installGeometry = require('./reference/geometry_payload')
const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile: child} = require('../../sdk/js/imagery/terra_texture_tiles')
const {visibilityCoverage} = require('../../sdk/js/terrain/visibility_coverage')
const {prepareSurface} = require('../../sdk/js/terrain/terra_surface_plan')
const {meshPartitionSource} = require('../../adapters/webgl/mesh_partition_source')
const costBatch = require('./reference/mesh_cost_batch')

module.exports = async function verifyPartitionSources(Renderer, canvas) {
  for (const direct of [true, false]) {
    const ledger = new ResourceLedger(20000 + 32 * 1024 * 1024), priced = []
    const r = new Renderer(canvas, {resourceLedger: ledger, urlForTile: () => '',
      geometryCacheBytes: 10000, partitionCacheBytes: 10000,
      meshPartitionWorkspaceBytes: () => 0,
      createMeshPartitionPlanTask(id, rows, onRows) {
        return costBatch(rows, onRows, ({draw, cells}) => {
          priced.push(draw.resourceId); return cells.map(cell => ({key: cell.key, bytes: 6}))
        })
      }})
    r.sourceUvPartitions = direct
    const source = {level: 0, matrix: 0, row: 0, column: 0}, parent = child(source, 1, 0, 0), leaf = child(parent, 1, 0, 0)
    const draw = resourceId => ({resourceId, textureResourceId: 4294967296 + resourceId, geometryKey: 'mesh:' + resourceId, texture: source,
      vertexCount: 4, firstIndex: 0, indexCount: 4, origin: [0,0,0]})
    const positions = new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]), uv = new Float32Array([0,0, 1,0, 0,1, 1,1])
    const model = prepareSurface(positions, uv, new Uint16Array([0,2,1,3]), 0, 4)
    const allocation = ledger.reserve('partition-gpu', 6); allocation.mark('resident')
    const part = {sourceUv: true, indexCount: 3, vertexCount: 0, indexBuffer: canvas.gl.createBuffer(), byteSize: 6, allocation}
    const geometry = {key: 'mesh:1', resourceId: 1, model, partitions: new Map([[key(parent), part]]), partitionBytes: 6}
    let outputs
    try {
      installGeometry(r, draw(1), geometry); r.geometryPinnedKeys.add('mesh:1')
      r.partitionBytes = 6
      const old = draw(1)
      r.displaySurface = {current: {draws: [old]}, renderDraws: [old]}
      // The previous camera had no prepared cells for three quarters of this
      // mesh. That region still needs a complete new-camera coverage proof.
      geometry.partitionDraws = [{...old, geometryKey: 'mesh:1', sourceTexture: source, texture: parent,
        imageryClipCell: true, imageryCellScale: 2, imageryCellOffsetX: 0, imageryCellOffsetY: 0}]
      r.presentation.cells.set(key(leaf), {cell: leaf, a: leaf, b: leaf})
      r.measureDraw = () => ({visible: false, regions: []})
      const packet = {draws: [old, draw(2)], nativePlan: {id: 10}}
      const plan = r.prepareMeshOutputs(packet)
      outputs = await plan.admit(packet, 80)
      assert(outputs && outputs.valid())
      assert.deepStrictEqual(priced, direct ? [] : [1,2],
        'A funded source-UV mesh waited for redundant handoff partitions, or WebGL1 skipped clipping')
      const footprint = plan.draws([old])
      const incoming = plan.draws([draw(2)])
      assert.strictEqual(incoming.length, 7)
      assert.strictEqual(incoming.filter(d => d.imageryDirectClip).length, direct ? 7 : 0)
      assert(incoming.every(d => !d.imageryIndexCell), 'New geometry borrowed an unrelated mesh partition')
      assert.strictEqual(outputs.credit.bytes, 80, 'Direct clipping bypassed mesh production credit')
      assert.strictEqual(footprint.length, 7)
      assert.strictEqual(visibilityCoverage(footprint.map(d => [d, d.imageryClipCell]), r.geometry, new Set()).get('mesh:1'), 1,
        'A camera-cropped old footprint was treated as complete new coverage')
      assert.strictEqual(footprint.filter(d => d.imageryDirectClip).length, direct ? 7 : 0)
      if (direct) {
        assert.strictEqual(footprint.filter(d => d.imageryIndexCell === key(parent)).length, 4,
          'Fine cells did not borrow their smallest resident source-UV superset')
        assert.strictEqual(footprint.filter(d => !d.imageryIndexCell).length, 3,
          'Newly exposed cells did not retain original mesh coverage')
        assert.strictEqual(meshPartitionSource(r, geometry, {...footprint[0], imageryCellScale: 4096}), null,
          'Deep cell bypassed the source-UV precision bound')
        assert.strictEqual(meshPartitionSource(r, null, {...incoming[0], imageryCellScale: 4096}), null,
          'New geometry bypassed the same source-UV precision bound')
      }
      r.prunePartitions(10000, 10000)
      if (direct) assert.strictEqual(geometry.partitions.get(key(parent)), part, 'Borrowed parent was evicted before handoff')
      // After the plan receipt, a submitted descendant still owns its ancestor
      // buffer through the normal displayed-partition protection rule.
      geometry.partitionDraws = footprint
      outputs.release(); outputs.credit.release(); outputs = null
      r.prunePartitions(10000, 10000)
      if (direct) assert.strictEqual(geometry.partitions.get(key(parent)), part, 'Displayed borrowed parent lost ownership')
    } finally {
      if (outputs) { outputs.release(); outputs.credit.release() }
      r.destroy()
    }
    assert.strictEqual(ledger.bytes, 0)
  }
}
