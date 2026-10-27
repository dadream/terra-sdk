const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const preparedUv = require('./prepared_uv_contract')
const preparedSurface = require('./prepared_surface_contract')

// An immediate publisher is the oracle for the same snapshot held while the
// other model processes new cameras, records and height refinements.
module.exports = async function verifyPreparedSnapshot(module) {
  const owners = [new TerraAbi(module), new TerraAbi(module)]
  const records = [null, 'globe_root_0_record.bin', 'globe_root_0_detail_record.bin']
    .map(name => name && fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden', name)))
  const budget = {maximumChangeCount: 16, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0}
  const manifest = {formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
    heightScale: 0.001953125, minimumU: -180, minimumV: -90,
    maximumU: 180, maximumV: 90, radius: 6378000,
    texture: {kind: 'global-geodetic', matrix_level_offset: 0, minimum_level: 0, maximum_level: 8,
      tile_size: 256, level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180, -90], [180, 90]]}}
  const camera = {distance: 3000000, tiltRadians: -0.7, yawRadians: 0.3}
  const submit = abi => abi.getRequests().forEach(r => abi.submitRecord(r.kind, r.key, records[r.kind]))
  try {
    for (const abi of owners) {
      abi.loadManifest(manifest); abi.setViewport(640, 360, Math.PI / 6)
      abi.setGlobeTarget(0, 0); abi.setCamera(camera)
      abi.updateStep(0.005, budget)
      for (let i = 0; i < 10; ++i) { submit(abi); abi.advanceTerrain(0.005, budget) }
    }
    const [held, immediate] = owners
    const plans = owners.map(abi => abi.prepareMeshFrame(0.005, budget))
    assert.deepStrictEqual(plans[0].draws, plans[1].draws)
    assert(plans[0].nativePlan.additionalBytes > 0)
    const originalFrame = held.getFrame(), originalBytes = held.meshPayloadBytes()
    const sampled = preparedUv.read(held, plans[0])
    await preparedSurface.taskContract(held, plans[0])
    const sampledSurface = await preparedSurface.read(held, plans[0])
    const priced = preparedSurface.measurements(held, plans[0], sampledSurface, true)
    assert(priced.some(value => value.visible && value.pixelsPerUv > 0), 'Prepared forecast has no visible surface')
    // Candidate pricing owns its planner independently of the display. Closing
    // it must preserve the prepared height snapshot and the later publication.
    const predictor = held.createImageryPlanner()
    let forecast
    try {
      forecast = predictor.plan(plans[0].draws, draw => priced[plans[0].draws.indexOf(draw)],
        {descriptor:manifest.texture, detached:true, resetHistory:true, targetPixelError:1.25})
    } finally { predictor.destroy() }
    assert.strictEqual(held.meshPayloadBytes(), originalBytes, 'Prepared pricing allocated native mesh payload')
    const before = held.getUpdateState().heightBytes
    immediate.materializeMeshFrame(plans[1])
    immediate.commitMeshFrame(plans[1])
    const expected = plans[1].draws.map(draw => immediate.copyMeshResource(draw))
    preparedSurface.verify(immediate, plans[1], sampledSurface)
    const measured = preparedSurface.measurements(immediate, plans[1], null, true)
    assert.deepStrictEqual(priced, measured, 'Prepared surface changed projected imagery measurements')
    const actualPlan = immediate.planImagery(plans[1].draws, draw => measured[plans[1].draws.indexOf(draw)],
      {descriptor:manifest.texture, detached:true, resetHistory:true, targetPixelError:1.25})
    assert.deepStrictEqual(forecast.draws, actualPlan.draws, 'Prepared forecast chose different imagery tiles')
    let progress, built = 0, peakHeights = before
    for (let i = 0; i < 12; ++i) {
      held.setGlobeTarget(i * 5, 20)
      held.setCamera({...camera, distance: 500000, yawRadians: i * 0.1})
      submit(held); progress = held.advanceTerrain(0.005, budget)
      peakHeights = Math.max(peakHeights, held.heightPayloadBytes())
      held.reclaimHeights(32 * 1024 * 1024)
      built += progress.heightBuildCount
      assert.deepStrictEqual(held.getFrame(), originalFrame, 'Background model published the prepared frame')
      assert.strictEqual(held.meshPayloadBytes(), originalBytes, 'Background model materialized uncredited meshes')
      assert(held.getUpdateState().heightBytes <= 32 * 1024 * 1024)
    }
    assert(built > 0 && peakHeights > before, 'Fixture did not add height inputs')
    assert(progress.modelRevision > plans[0].updateState.modelRevision, 'Fixture did not advance the model')
    assert.deepStrictEqual(preparedUv.read(held, plans[0]), sampled)
    const repeatedSurface = await preparedSurface.read(held, plans[0])
    for (const [id, mesh] of repeatedSurface) preparedSurface.same(mesh.positions, sampledSurface.get(id).positions,
      'Background height work changed prepared positions')
    const native = plans[0].nativePlan
    const cost = held.replacementWorkBytes(native, [])
    const proof = await held.createReplacementTask(native, [], cost).run()
    assert(proof.groups.length > 0, 'Snapshot boundary work lost its input')
    const heldHeightBytes = held.getUpdateState().heightBytes
    held.materializeMeshFrame(plans[0])
    held.commitMeshFrame(plans[0])
    preparedSurface.verify(held, plans[0], sampledSurface)
    assert(held.getUpdateState().heightBytes < heldHeightBytes,
      'Fixture did not exercise/release snapshot-only copy-on-write height storage')
    plans[0].draws.forEach((draw, i) => assert.deepStrictEqual(held.copyMeshResource(draw), expected[i],
      'Delayed production used heights from a newer model'))
    assert.strictEqual(held.getUpdateState().modelRevision, plans[1].updateState.modelRevision)
    assert.strictEqual(held.module.call('terra_get_prepared_mesh_uv', held.context, native.id, 0, 0, 0, 0), 2)
    assert.strictEqual(held.module.call('terra_get_prepared_mesh_positions', held.context, native.id, 0, 0, 0, 0), 2)
    const next = held.prepareMeshFrame(0.005, {...budget, maximumChangeCount: 0})
    assert(next.updateState.modelRevision > plans[0].updateState.modelRevision,
      'Publishing the old snapshot rolled back the background model')
    held.discardMeshPlan(next.nativePlan)
    held.loadManifest(manifest)
    assert.strictEqual(held.meshPayloadBytes(), 0, 'Reset retained snapshot meshes')
  } finally { owners.forEach(abi => abi.destroy()) }
  console.log('Prepared XYZ/UV and imagery forecast match production and survive background camera/height work')
}
