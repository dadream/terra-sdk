const installGeometry = require('./reference/geometry_payload')
const assert = require('assert')
const costBatch = require('./reference/mesh_cost_batch')
const allocationQuote = require('./reference/mesh_allocation_quote')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile: child} = require('../../sdk/js/imagery/terra_texture_tiles')

module.exports = async function verifyMeshOutputs(Renderer, canvas, settle) {
  await require('./terrain_coverage_admission_test')(Renderer, canvas)
  await require('./geometry_handoff_capacity_contract')(Renderer, canvas)
  await require('./mesh_preparation_credit_contract')(Renderer, canvas)
  await require('./mesh_admission_credit_contract')(Renderer, canvas)
  await require('./candidate_image_ownership_contract')(Renderer, canvas)
  await require('./candidate_stage_peak_contract')(Renderer, canvas)
  const ledger = new ResourceLedger(20000 + 32 * 1024 * 1024), prices = []
  const r = new Renderer(canvas, {resourceLedger: ledger, urlForTile: () => '',
    geometryCacheBytes: 10000, partitionCacheBytes: 10000,
    meshPartitionWorkspaceBytes: () => 0,
    createMeshPartitionPlanTask(id, rows, onRows) {
      return costBatch(rows, onRows, ({draw, cells}) => {
        prices.push({id, draw, cells})
        return cells.map(c => ({key: c.key, bytes: 66}))
      })
    },
    createPartitionPlanTask() { assert.fail('Pre-admitted UV was priced again') },
    createPartitionTask(id, cells, geometry, maximumBytes) {
      assert.strictEqual(maximumBytes, 66*cells.length)
      return {promise: Promise.resolve(cells.map(cell => ({cell, positions: new Float32Array(9),
        uv: new Float32Array(6), indices: new Uint16Array(3)}))), cancel() {}}
    }})
  const tile = {level: 0, matrix: 0, row: 0, column: 0}
  const old = {resourceId: 1, textureResourceId: 4294967297, texture: tile, vertexCount: 3}
  const fresh = {resourceId: 2, textureResourceId: 4294967298, texture: tile, vertexCount: 3}
  const packet = {draws: [fresh], nativePlan: {id: 10}}
  const leaf = child(tile, 1, 0, 0)
  let outputs, claimed
  try {
    installGeometry(r, old, {key: 'mesh:1', partitions: new Map()})
    r.geometryPinnedKeys.add('mesh:1')
    r.displaySurface = {current: {draws: [old]}, renderDraws: []}
    r.presentation.cells.set(key(leaf), {cell: leaf, a: tile, b: leaf})
    const plan = r.prepareMeshOutputs(packet)
    ledger.setLimit(707)
    assert(plan)
    assert.strictEqual(await plan.admit(packet, 60), null, 'UV destination omitted from joint admission')
    assert.strictEqual(ledger.bytes, 60)
    const frozen = plan.draws(packet.draws)
    assert.strictEqual(frozen.length, 4)
    r.presentation.cells.clear()
    const finer = child(leaf, 3, 0, 0)
    r.presentation.cells.set(key(finer), {cell: finer, a: leaf, b: finer})
    assert.deepStrictEqual(plan.draws(packet.draws), frozen, 'Live refinement changed a pending handoff')
    const ready = r.textures.gpuReady
    r.textures.targetDesired.set(key(tile), tile)
    r.textures.gpuReady = id => id === key(tile)
    const measure = r.measureTextureDraw
    r.measureTextureDraw = () => 8
    r.cameraVersion = 2; r.plannedCameraVersion = 1
    assert.deepStrictEqual(plan.draws(packet.draws), frozen, 'Stale preview discarded fine handoff imagery')
    r.plannedCameraVersion = 2
    assert.deepStrictEqual(plan.draws(packet.draws), frozen, 'An unqualified ancestor discarded visible detail')
    r.measureTextureDraw = () => 1.2
    const coarse = plan.draws(packet.draws)
    assert.deepStrictEqual(coarse.map(d => d.texture), frozen.map(d => d.texture))
    assert(coarse.every(d => key(d.imageryTarget) === key(tile)), 'Frozen footprints prevented a ready coarsening fade')
    r.textures.targetDesired.clear(); r.textures.gpuReady = ready; r.measureTextureDraw = measure
    ledger.setLimit(708)
    outputs = await plan.admit(packet, 60)
    assert(outputs && outputs.valid())
    assert.strictEqual(ledger.reserve('competitor', 1), null)
    assert.strictEqual(outputs.credit.bytes, 60)
    assert.strictEqual(r.partitionCpuBytes, 264)
    assert.strictEqual(r.partitionReservedBytes, 264)
    const geometry = {key: 'mesh:2', resourceId: 2, partitions: new Map()}
    installGeometry(r, fresh, geometry, outputs)
    r.geometryPinnedKeys.add('mesh:2')
    const cells = frozen.map(d => r.partitionCell(d))
    r.requestPartitionSet(geometry, cells)
    const reserve = ledger.reserve
    ledger.reserve = () => assert.fail('UV production attempted a second admission')
    try {
      for (let i = 0; i < 10 && geometry.partitions.size < 4; ++i) {
        r.pumpPartitionRequests(); await settle(); r.processPartitionUploads(Infinity)
      }
    } finally { ledger.reserve = reserve }
    assert.strictEqual(prices.length, 1)
    r.processPartitionUploads(Infinity)
    assert.strictEqual(geometry.partitions.size, 4)
    assert.strictEqual(r.partitionCpuBytes, 0)
    assert.strictEqual(r.partitionReservedBytes, 0)
    assert.strictEqual(r.partitionBytes, 264)
    r.prunePartitions(10000, 10000)
    assert.strictEqual(geometry.partitions.size, 4, 'Uploaded prerequisites evicted before the terrain receipt')
    r.renderRequested = false
    outputs.release()
    assert(r.renderRequested, 'Releasing the fixed handoff footprint left finer resident imagery asleep')
    r.renderRequested = false
    outputs.release()
    assert(!r.renderRequested, 'A repeated receipt scheduled another presentation')
    outputs.credit.release(); outputs = null
    assert(!r.meshOutputPlan)
    r.presentation.cells.clear()
    r.presentation.cells.set(key(leaf), {cell: leaf, a: tile, b: leaf})
    const reused = r.prepareMeshOutputs(packet)
    ledger.setLimit(384)
    outputs = await reused.admit(packet, 0)
    assert.strictEqual(prices.length, 1, 'Immutable resident partitions were priced again')
    assert(outputs && outputs.valid(), 'Already resident destinations needed duplicate output credit')
    r.prunePartitions(10000, 10000)
    assert.strictEqual(geometry.partitions.size, 4, 'Admission evicted borrowed destinations')
    outputs.release(); outputs.credit.release(); outputs = null
    r.prunePartitions(10000, 10000)
    assert.strictEqual(geometry.partitions.size, 0)

    // A receipt/cancel releases unclaimed outputs only. Work already holding
    // a child lease continues to own its bytes until its own cancellation ack.
    ledger.setLimit(0)
    const again = r.prepareMeshOutputs(packet)
    assert(again)
    outputs = await again.admit(packet, 60)
    assert(outputs)
    const owned = again.draws(packet.draws).map(d => r.partitionCell(d))
    claimed = again.take('mesh:2', owned.slice(0,1))
    assert(claimed)
    const keep = claimed.bytes
    r.setPaused(true)
    assert(!outputs.valid())
    r.renderRequested = false
    outputs.release(); outputs.credit.release(); outputs = null
    assert(!r.renderRequested, 'Paused handoff disposal scheduled drawing')
    assert.strictEqual(r.partitionCpuBytes, keep)
    assert.strictEqual(r.partitionReservedBytes, keep)
    r.releasePartitionInput({output: claimed.output, cpuBytes: keep})
    claimed = null
    assert.strictEqual(r.partitionCpuBytes, 0)
    assert.strictEqual(r.partitionReservedBytes, 0)
    r.setPaused(false)
    for (const flag of ['contextLost', 'destroyed']) {
      const invalid = r.prepareMeshOutputs(packet)
      r[flag] = true
      r.renderRequested = false
      invalid.release()
      assert(!r.renderRequested, flag + ' handoff disposal scheduled drawing')
      r[flag] = false
    }
    // A coarse terrain receipt does not retire unproduced fine UV destinations.
    // They belong to the accepted imagery goal until production or cancellation.
    ledger.setLimit(10000)
    r.presentation.cells.clear()
    const futureMesh = Object.assign({}, fresh, {resourceId:3,textureResourceId:4294967299})
    const futureDraws = [0,1].flatMap(row=>[0,1].map(column=>Object.assign({},futureMesh,{
      sourceTexture:tile,texture:child(tile,1,row,column),imageryClipCell:true,
      imageryCellScale:2,imageryCellOffsetX:-column,imageryCellOffsetY:-row})))
    const futurePacket = {draws:[futureMesh],nativePlan:{id:11},imageryPlan:{draws:futureDraws}}
    const future = r.prepareMeshOutputs(futurePacket)
    outputs = await future.admit(futurePacket,0)
    assert(outputs && outputs.presented)
    const futureGeometry={key:'mesh:3',resourceId:3,partitions:new Map()}
    installGeometry(r,futureMesh,futureGeometry,outputs)
    r.geometryPinnedKeys.add('mesh:3')
    const reserved=r.partitionReservedBytes, cpu=r.partitionCpuBytes
    outputs.presented()
    assert.strictEqual(r.meshOutputPlan,null)
    assert.strictEqual(r.forecastOutputPlan,future)
    assert.strictEqual(r.partitionReservedBytes,reserved,'Terrain receipt refunded future GPU destinations')
    assert.strictEqual(r.partitionCpuBytes,cpu,'Terrain receipt refunded future UV work')
    const futureCells=futureDraws.map(draw=>r.partitionCell(draw))
    r.requestPartitionSet(futureGeometry,futureCells)
    ledger.reserve=()=>assert.fail('Accepted forecast UV was admitted a second time')
    try {
      for(let i=0;i<10 && futureGeometry.partitions.size<4;++i) {
        r.pumpPartitionRequests();await settle();r.processPartitionUploads(Infinity)
      }
    } finally {ledger.reserve=reserve}
    assert.strictEqual(futureGeometry.partitions.size,4)
    outputs.release();outputs=null
  } finally {
    if (outputs) {outputs.release(); outputs.credit.release()}
    if (claimed) r.releasePartitionInput({output: claimed.output, cpuBytes: claimed.bytes})
    r.destroy()
  }
  assert.strictEqual(ledger.bytes, 0, 'Prepared handoff leaked resources')
  await require('./mesh_production_groups_contract')(Renderer, canvas)
  await require('./mesh_partition_source_contract')(Renderer, canvas)
  await verifyEarlyRefusal(Renderer, canvas)
  await require('./mesh_resident_preparation_contract')(Renderer, canvas)
}

// The native boundary proof may expose a small complete successor even when
// the whole candidate cannot coexist with the old display. Skip its remaining
// UV work without treating the lower bound as actual production credit.
async function verifyEarlyRefusal(Renderer, canvas) {
  const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
  for (const limit of [430, 530, 600]) {
    const ledger = new ResourceLedger(limit), priced = []
    const r = new Renderer(canvas, {resourceLedger: ledger, urlForTile: () => '',
      geometryCacheBytes: 10000, partitionCacheBytes: 10000,
      meshPartitionWorkspaceBytes: () => 0,
      createMeshPartitionPlanTask(id, rows, onRows) {
        return costBatch(rows, onRows, ({draw, cells}) => {
          priced.push(draw.resourceId)
          return cells.map(c => ({key: c.key, bytes: 6}))
        })
      }})
    const tile = {level: 0, matrix: 0, row: 0, column: 0}, leaf = child(tile, 1, 0, 0)
    const draw = resourceId => ({resourceId, textureResourceId: 4294967296 + resourceId, texture: tile,
      vertexCount: 3, firstIndex: 0, indexCount: 0})
    const before = [draw(1), draw(4)], after = [draw(2), draw(3)]
    const packet = {draws: after, frame: {coverageComplete: true},
      nativePlan: {id: 10, residentBytes: 0, additionalBytes: 120, reclaimableBytes: 0, maximumBytes: 10000},
      replacementPlan: {atomic: true, groups: [{before: [1,4], after: [2,3]}]}}
    const frames = new MeshFrames(ledger)
    frames.presented = {draws: before, frame: {coverageComplete: true}}
    let admitted, native, stop, boundaries = 0, refunded = 0
    try {
      before.forEach(d => {
        const id = 'mesh:' + d.resourceId
        installGeometry(r, d, {key: id, partitions: new Map(), partitionBytes: 0})
        r.geometryPinnedKeys.add(id)
      })
      r.displaySurface = {current: {draws: before}, renderDraws: []}
      r.presentation.cells.set(key(leaf), {cell: leaf, a: leaf, b: leaf})
      const plan = allocationQuote(r.prepareMeshOutputs(packet)), retained = r.geometry.get('mesh:4')
      for (const d of plan.draws([before[1]])) {
        const cell = r.partitionCell(d), allocation = ledger.reserve('partition-gpu', 6)
        allocation.mark('resident')
        retained.partitions.set(cell.key, {byteSize: 6, allocation})
        retained.partitionBytes += 6; r.partitionBytes += 6
      }
      frames.prepareOutputs = () => plan
      if (limit === 600) {
        native = ledger.reserve('mesh-native', 100)
        native.mark('resident')
        stop = ledger.reclamation.register({revision: () => 0, reclaim: async needed => {
          const held = ledger.bytes
          await Promise.resolve()
          assert.strictEqual(ledger.bytes, held, 'Pending native work was refunded speculatively')
          const bytes = Math.min(needed, native.bytes)
          native.resize(native.bytes - bytes); refunded += bytes
          return bytes
        }})
      }
      ledger.setLimit(limit)
      const proof = {groups: [{before: [1], after: [2]}, {before: [4], after: [3]}]}
      admitted = await frames.admitProduction(packet,
        value => value.draws.filter(d => d.resourceId === 2 || d.resourceId === 3).length * 60,
        (bytes, acquire) => frames.reserveNativeWork('mesh-transfer', bytes, acquire),
        async indices => {
          assert.deepStrictEqual(indices, [0])
          assert.strictEqual(boundaries, 1, 'A local candidate bypassed native boundary proof')
          return {draws: [after[0], before[1]], frame: packet.frame,
            nativePlan: Object.assign({}, packet.nativePlan, {additionalBytes: 60})}
        }, async () => { ++boundaries; return proof })
      assert(admitted.outputs.valid())
      if (native) {
        assert.deepStrictEqual(priced, [2,3])
        assert.strictEqual(boundaries, 0, 'A real native refund unnecessarily forced local replacement')
        assert.strictEqual(refunded, 100)
        assert.strictEqual(ledger.bytes, 600)
        assert.strictEqual(r.meshPreparationStats.refusedBeforePricing + r.meshPreparationStats.refusedAfterPricing, 0)
      } else {
        assert.deepStrictEqual(priced, [2], 'An infeasible full candidate priced unrelated successor cells')
        assert.deepStrictEqual(admitted.packet.draws.map(d => d.resourceId), [2,4])
        assert.deepStrictEqual(admitted.packet.replacementPlan.groups, [proof.groups[0], {before: [4], after: [4]}])
        assert.strictEqual(r.meshPreparationStats[limit === 430 ? 'refusedBeforePricing' : 'refusedAfterPricing'], 1)
        assert.strictEqual(r.meshPreparationStats.pricedMeshes, 1)
        assert.strictEqual(ledger.bytes, 372)
      }
      assert.strictEqual(retained.partitions.size, 4, 'The old display lost retained UV cells')
    } finally {
      if (admitted) {admitted.outputs.release(); admitted.credit.release()}
      if (stop) stop()
      if (native) native.release()
      r.destroy()
    }
    assert.strictEqual(ledger.bytes, 0)
  }
}
