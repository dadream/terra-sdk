const assert = require('assert')
const fs = require('fs'), path = require('path')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')

// Compare the actual published arrays with a batch producer. Smaller grants,
// pauses and camera arrivals must change scheduling, never the selected result.
module.exports = function verifyHeightWork(module) {
  const owners = [new TerraAbi(module), new TerraAbi(module), new TerraAbi(module)]
  const [batch, sliced, grouped] = owners
  const manifest = {formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
    heightScale: 0.001953125, minimumU: -180, minimumV: -90,
    maximumU: 180, maximumV: 90, radius: 6378000,
    texture: {kind: 'global-geodetic', matrix_level_offset: 0, minimum_level: 0, maximum_level: 8,
      tile_size: 256, level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180, -90], [180, 90]]}}
  const camera = {distance: 3000000, tiltRadians: -0.7, yawRadians: 0.3}
  const budget = {maximumChangeCount: 8, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0}
  const rootBytes = 65 * 66 * 4
  const refineBytes = 4 * rootBytes / 2 + (2 * 65 * 65 + 64 * 64 + 129 * 129) * 4
  const records = [null, 'globe_root_0_record.bin', 'globe_root_0_detail_record.bin']
    .map(name => name && fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden', name)))
  const native = (name, ...args) => module.call(name, sliced.context, ...args)
  const payload = () => native('terra_height_payload_bytes')
  const grant = bytes => assert.strictEqual(native('terra_set_height_work_limit', bytes, 1), 0)
  let roots = 0, refinements = 0, continuations = 0, groupedTurns = 0
  try {
    owners.forEach(abi => {
      abi.loadManifest(manifest); abi.setViewport(640, 360, Math.PI / 6)
      abi.setGlobeTarget(0, 0); abi.setCamera(camera)
      abi.updateStep(0.005, budget)
    })
    for (let round = 0; round < 6; ++round) {
      owners.forEach(abi => {
        abi.setGlobeTarget(0, 0); abi.setCamera(camera)
        abi.getRequests().forEach(r => abi.submitRecord(r.kind, r.key, records[r.kind]))
      })
      const expected = batch.prepareMeshFrame(0.005, budget)
      let group = grouped.heightSlice(0, () => grouped.prepareMeshFrame(0.005, budget))
      for (let turn = 0; group.heightPending; ++turn) {
        assert(turn < 512, 'Funded height batches did not converge')
        const before = grouped.heightPayloadBytes(), credit = Math.max(group.heightWorkBytes, 256 * 1024)
        group = grouped.heightSlice(credit, () => grouped.prepareMeshFrame(0.005, budget))
        assert(grouped.heightPayloadBytes() <= before + credit, 'Height batch spent another RPC grant')
        ++groupedTurns
      }
      assert.deepStrictEqual(group.frame, expected.frame, 'Height batches changed the frozen selection')
      assert.deepStrictEqual(group.updateState, expected.updateState, 'Height batches changed model progress')
      assert.deepStrictEqual(group.draws, expected.draws)
      grouped.materializeMeshFrame(group); grouped.commitMeshFrame(group)
      const oldFrame = sliced.getFrame()
      grant(0)
      let actual
      for (let turn = 0; !actual; ++turn) {
        assert(turn < 512, 'Height work did not converge')
        try { actual = sliced.prepareMeshFrame(0.005, budget) }
        catch (error) {
          assert.strictEqual(error.status, 10, error.message)
          ++continuations
          const quote = native('terra_height_work_bytes'), before = payload()
          assert.deepStrictEqual(sliced.getFrame(), oldFrame, 'Height continuation published a frame')
          if (quote) {
            assert(quote === rootBytes || quote === refineBytes || quote === refineBytes - rootBytes, 'Unexpected height production quote')
            if (quote === rootBytes) ++roots; else ++refinements
            grant(quote - 1)
            assert.throws(() => sliced.prepareMeshFrame(0.005, budget), e => e.status === 10)
            assert.strictEqual(payload(), before, 'Short height grant allocated payload')
          }
          assert.throws(() => sliced.advanceTerrain(0.005, budget), e => e.status === 2)
          sliced.setGlobeTarget(70, -20)
          sliced.setCamera({...camera, distance: 10000000, yawRadians: 1.5})
          assert.strictEqual(native('terra_height_work_bytes'), quote, 'Camera arrival invalidated pending work')
          grant(quote)
        }
      }
      assert.deepStrictEqual(actual.frame, expected.frame, 'Height slices changed the selected snapshot')
      assert.deepStrictEqual(actual.updateState, expected.updateState, 'Height slices spent additional topology work')
      assert.deepStrictEqual(actual.draws, expected.draws)
      batch.materializeMeshFrame(expected); batch.commitMeshFrame(expected); sliced.materializeMeshFrame(actual); sliced.commitMeshFrame(actual)
      actual.draws.forEach((draw, i) => assert.deepStrictEqual(sliced.copyMeshResource(draw),
        batch.copyMeshResource(expected.draws[i]), 'Height slicing changed output arrays'))
      group.draws.forEach((draw, i) => assert.deepStrictEqual(grouped.copyMeshResource(draw),
        batch.copyMeshResource(expected.draws[i]), 'Funded height batches changed output arrays'))
      batch.presentFrame(expected.frame.sequence); sliced.presentFrame(actual.frame.sequence)
      grouped.presentFrame(group.frame.sequence)
    }
    assert(roots > 1 && refinements > 1 && continuations > 2, 'Fixture did not exercise root and refinement slices')
    // New records grow the native cache vector while the old selected epoch is
    // suspended. Its immutable inputs must survive without capturing raw cache
    // pointers or accidentally refining from a later data generation.
    const arriving = new TerraAbi(module), arrivalOracle = new TerraAbi(module)
    owners.push(arriving, arrivalOracle)
    for (const abi of [arriving, arrivalOracle]) {
      abi.loadManifest(manifest); abi.setViewport(640, 360, Math.PI / 6)
      abi.setGlobeTarget(0, 0); abi.setCamera(camera)
      abi.updateStep(0.005, budget)
      const first = abi.getRequests().find(r => r.kind === 1)
      abi.submitRecord(first.kind, first.key, records[first.kind])
    }
    const arrivalExpected = arrivalOracle.prepareMeshFrame(0.005, budget)
    arrivalOracle.materializeMeshFrame(arrivalExpected); arrivalOracle.commitMeshFrame(arrivalExpected)
    const firstOutput = arrivalExpected.draws.map(draw => arrivalOracle.copyMeshResource(draw))
    assert.strictEqual(module.call('terra_set_height_work_limit', arriving.context, 0, 1), 0)
    assert.throws(() => arriving.prepareMeshFrame(0.005, budget), e => e.status === 10)
    const late = arriving.getRequests().filter(r => r.kind === 1)
    assert(late.length > 1, 'Arrival fixture lacks concurrent record growth')
    late.forEach(r => arriving.submitRecord(r.kind, r.key, records[r.kind]))
    let arrivalPlan
    for (let turn = 0; !arrivalPlan; ++turn) {
      assert(turn < 512)
      const quote = module.call('terra_height_work_bytes', arriving.context)
      assert.strictEqual(module.call('terra_set_height_work_limit', arriving.context, quote, 1), 0)
      try { arrivalPlan = arriving.prepareMeshFrame(0.005, budget) }
      catch (error) { assert.strictEqual(error.status, 10, error.message) }
    }
    arriving.materializeMeshFrame(arrivalPlan); arriving.commitMeshFrame(arrivalPlan)
    assert.strictEqual(arrivalPlan.draws.length, firstOutput.length)
    arrivalPlan.draws.forEach((draw, i) => assert.deepStrictEqual(arriving.copyMeshResource(draw), firstOutput[i],
      'Late records changed a frozen height input or output'))
    arriving.presentFrame(arrivalPlan.frame.sequence)
    assert.strictEqual(module.call('terra_set_height_work_limit', arriving.context, 0, 1), 0)
    assert.throws(() => arriving.prepareMeshFrame(0.005, budget), e => e.status === 10)
    assert.strictEqual(module.call('terra_height_work_bytes', arriving.context), rootBytes,
      'The next epoch ignored records received during its predecessor')
    assert.strictEqual(module.call('terra_discard_terrain_work', arriving.context), 0)
    sliced.getRequests().forEach(r => sliced.submitRecord(r.kind, r.key, records[r.kind]))
    grant(0)
    assert.throws(() => sliced.prepareMeshFrame(0.0001, budget), e => e.status === 10)
    const beforeDiscard = payload(), beforeFrame = sliced.getFrame()
    assert.strictEqual(native('terra_discard_terrain_work'), 0)
    assert.strictEqual(native('terra_height_work_bytes'), 0)
    assert.strictEqual(payload(), beforeDiscard, 'Discard refunded cached height ownership')
    assert.deepStrictEqual(sliced.getFrame(), beforeFrame)
    sliced.loadManifest(manifest)
    assert.strictEqual(payload(), 0, 'Manifest reset retained height payload')
    assert.strictEqual(native('terra_height_work_bytes'), 0)
    console.log('Native height credit, bounded continuation, frozen selection, array parity and discard passed',
      JSON.stringify({singleBuildContinuations:continuations, groupedTurns}))
  } finally { owners.forEach(abi => abi.destroy()) }
}
