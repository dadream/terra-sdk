const assert = require('assert')
const fs = require('fs'), path = require('path')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {createMeshTransferTask} = require('../../adapters/wasm/mesh_transfer_preparation')
const {indexPayloadBytes} = require('../../sdk/js/resources/mesh_indices')

module.exports = async function verifyMeshProduction(module) {
  assert.strictEqual(module.exports.terra_materialize_mesh_frame, undefined, 'Obsolete monolithic export remains')
  const root = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_root_0_record.bin'))
  const manifest = {formatVersion: 1, patchDimension: 64, transform: 'cylindrical', heightScale: 1/64,
    minimumU: -180, minimumV: -90, maximumU: 180, maximumV: 90, radius: 6378000,
    texture: {kind: 'global-geodetic', matrix_level_offset: 0, minimum_level: 0, maximum_level: 8,
      tile_size: 256, level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180,-90],[180,90]]}}
  const budget = {maximumChangeCount: 16, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0}
  const prepare = abi => {
    abi.loadManifest(manifest); abi.setViewport(640, 360, Math.PI / 6)
    abi.setGlobeTarget(116.5623, 40.74863); abi.setCamera({distance: 18000000, tiltRadians: 0, yawRadians: 0})
    abi.updateStep(1, budget)
    for (const r of abi.getRequests()) abi.submitRecord(r.kind, r.key, root)
    return abi.prepareMeshFrame(1, budget)
  }
  let expected
  const reference = new TerraAbi(module)
  try {
    const packet = prepare(reference)
    reference.materializeMeshFrame(packet); reference.commitMeshFrame(packet)
    expected = packet.draws.map(draw => reference.copyMeshResource(draw))
  } finally { reference.destroy() }
  for (const cancelAfter of [1, 7, 'ready', Infinity]) {
    const abi = new TerraAbi(module), ledger = new ResourceLedger(4 * 1024 * 1024)
    let task, native
    try {
      const packet = prepare(abi), plan = packet.nativePlan, frame = abi.getFrame()
      const proof = await abi.createReplacementTask(plan, [], abi.replacementWorkBytes(plan, [])).run()
      assert(proof.groups.length > 0)
      native = abi.setResourceLedger(ledger)
      const credit = ledger.reserve('mesh-native', plan.additionalBytes)
      native.begin(credit)
      const before = new Set(packet.draws.filter(d => module.call('terra_get_mesh_position_view', abi.context, d.resourceId)).map(d => d.resourceId))
      assert.strictEqual(before.size, 0)
      task = abi.createMeshTask(packet); task.maximumSteps = 1
      let result, rounds = 0, lastReady = 0
      do {
        result = task.step(); ++rounds
        const ready = new Set(packet.draws.filter(d => module.call('terra_get_mesh_position_view', abi.context, d.resourceId)).map(d => d.resourceId)).size
        assert(ready >= lastReady && ready <= lastReady + 1, 'A step generated more than one fragment')
        lastReady = ready
        assert.strictEqual(native.credit, credit, 'A partial producer refunded its reservation')
        assert.strictEqual(credit.bytes, plan.additionalBytes)
        assert(abi.meshPayloadBytes() <= credit.bytes)
        if (rounds === 1) {
          assert.throws(() => abi.selectMeshGroups(plan, [0]), error => error.status === 1,
            'Production permitted its selected resource set to change')
          assert.throws(() => abi.reuseReplacementPlan(plan, []), error => error.status === 1,
            'Production permitted its boundary proof to change')
        }
        if (!result.done) {
          assert.deepStrictEqual(abi.getFrame(), frame, 'An unfinished candidate changed the published frame')
          // Memory views and immutable height inputs must survive unrelated
          // model/camera work while this producer holds the candidate snapshot.
          module.exports.memory.grow(1)
          abi.setGlobeTarget(rounds, 0)
          await abi.advanceTerrain(1, {...budget, maximumChangeCount: 0})
        }
        if (rounds === cancelAfter) {
          assert(!result.done, 'Cancellation fixture completed too early')
          task.cancel(); task.cancel()
          assert.strictEqual(packet.nativePlan, null)
          assert.deepStrictEqual(abi.getFrame(), frame)
          assert.strictEqual(module.call('terra_step_mesh_frame', abi.context, plan.id, plan.additionalBytes, 0), 2)
          native.finish()
          assert.strictEqual(ledger.bytes, abi.meshPayloadBytes() + abi.recordBudget.actual + abi.heightBudget.actual, 'Cancellation refunded retained cache bytes')
          assert(ledger.bytes > 0, 'Fixture did not retain completed cache allocations')
          const successor = await abi.prepareMeshFrame(1, budget)
          assert(successor.nativePlan.additionalBytes < plan.additionalBytes,
            'Cancellation poisoned completed resources instead of reusing them')
          abi.discardMeshPlan(successor.nativePlan)
          abi.trimMeshCache(0)
          assert.strictEqual(ledger.bytes, abi.recordBudget.actual + abi.heightBudget.actual, 'Unowned cancelled output could not be reclaimed')
          break
        }
        assert(rounds < 128, 'Production did not finish')
      } while (!result.done)
      if (result.done) {
        assert(rounds > 1 && result.value === packet && packet.nativePlan === plan && plan.produced)
        assert.deepStrictEqual(abi.getFrame(), frame, 'Completed generation published before acceptance')
        packet.draws.forEach((draw, i) => assert.deepStrictEqual(abi.copyMeshResource(draw), expected[i],
          'Interleaved work or memory growth changed the immutable output'))
        if (cancelAfter === 'ready') {
          const borrowed = abi.borrowMeshResource(packet.draws[0])
          const positions = borrowed.positions.slice()
          abi.discardMeshPlan(plan)
          native.finish()
          abi.trimMeshCache(0)
          assert.deepStrictEqual(abi.getFrame(), frame, 'Rejecting a complete candidate changed the old publication')
          assert.deepStrictEqual(borrowed.positions, positions, 'Candidate retirement invalidated its analysis loan')
          assert(abi.meshPayloadBytes() > 0, 'Borrowed unpublished payload was refunded early')
          assert.throws(() => abi.commitMeshFrame(packet), error => error.status === 2)
          borrowed.ownership.retire()
          abi.trimMeshCache(0)
          assert.strictEqual(abi.meshPayloadBytes(), 0, 'Released candidate payload could not retire')
        } else {
          abi.commitMeshFrame(packet)
          assert.strictEqual(packet.nativePlan, null)
          assert.strictEqual(abi.getFrame().sequence, packet.frame.sequence)
          assert.throws(() => abi.commitMeshFrame(packet), /not prepared/)
        }
        native.finish()
        assert.strictEqual(ledger.bytes, abi.meshPayloadBytes() + abi.recordBudget.actual + abi.heightBudget.actual)
      }
    } finally {
      if (task) task.cancel()
      if (native) native.finish()
      abi.destroy()
    }
    assert.strictEqual(ledger.bytes, 0, 'Destroyed production leaked native credit')
  }
  // A host-copy failure occurs after native generation. It must leave both
  // the previously published frame and the host's accepted surface intact.
  const failed = new TerraAbi(module), ledger = new ResourceLedger(4 * 1024 * 1024)
  const frames = new MeshFrames(ledger)
  try {
    const unused = prepare(failed), previous = failed.getFrame()
    failed.discardMeshPlan(unused.nativePlan)
    failed.copyMeshPositions = () => { throw new Error('injected host copy failure') }
    await assert.rejects(frames.read(failed, 1, budget), /injected host copy failure/)
    assert.deepStrictEqual(failed.getFrame(), previous, 'Host copy failure published native terrain')
    assert.strictEqual(frames.candidate, null)
    failed.trimMeshCache(0)
    assert.strictEqual(failed.meshPayloadBytes(), 0, 'Failed copy retained candidate mesh ownership')
  } finally {frames.clear(); failed.destroy()}
  assert.strictEqual(ledger.bytes, 0)

  // The real Worker producer can also be cancelled during derived-model work,
  // after CPU generation. Native publication must not precede this boundary.
  const workerAbi = new TerraAbi(module), workerFrames = new MeshFrames()
  let transfer
  try {
    const packet = prepare(workerAbi), previous = workerAbi.getFrame()
    workerAbi.materializeMeshFrame(packet)
    transfer = createMeshTransferTask(workerAbi, workerFrames, packet,
      {residentIds:[], generation:1, needsIndices:true, maximumIndexBytes:indexPayloadBytes(packet.draws)}, [])
    transfer.maximumSteps = 1
    assert(!transfer.step().done, 'Worker cancellation did not exercise derived-model preparation')
    assert.strictEqual(workerFrames.ledger.bytes, indexPayloadBytes(packet.draws),
      'Private Worker model preparation omitted its resident CPU strip')
    assert.deepStrictEqual(workerAbi.getFrame(), previous)
    transfer.cancel()
    workerAbi.discardMeshPlan(packet.nativePlan)
    assert.deepStrictEqual(workerAbi.getFrame(), previous, 'Worker preparation cancellation published terrain')
    assert.strictEqual(workerFrames.candidate, null)
    workerAbi.trimMeshCache(0)
    assert.strictEqual(workerAbi.meshPayloadBytes(), 0, 'Cancelled Worker preparation leaked a native loan')
    assert.strictEqual(workerFrames.ledger.bytes, 0, 'Cancelled Worker preparation retained its CPU strip')
  } finally {if (transfer) transfer.cancel(); workerFrames.clear(); workerAbi.destroy()}
  console.log('Bounded production, explicit publication, staged rejection/loans and host/Worker failure receipts passed')
}
