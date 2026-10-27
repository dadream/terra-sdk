const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {MeshReceipts} = require('../../sdk/js/terrain/mesh_receipts')

// The same real mesh lifetime contract runs directly in Wasm and over a Worker.
module.exports = async function verifyRetention(abi, worker, ledger) {
  const frames = new MeshFrames(ledger), errors = []
  const receipts = new MeshReceipts(frames, () => abi, e => errors.push(e))
  const manifest = {formatVersion: 1, patchDimension: 64, transform: 'planar',
    heightScale: 0.0000976563, minimumU: 0, minimumV: 0, maximumU: 1025, maximumV: 1025,
    radius: 0, texture: {kind: 'planar-tms', matrix_level_offset: 0, maximum_level: 0,
      minimum_level: 0, tile_size: 256, level_zero_columns: 1, level_zero_rows: 1,
      bounds: [[0, 0], [1025, 1025]]}}
  await abi.loadManifest(manifest)
  await abi.setPlanarLevel(1)
  abi.setPlanarTarget(600, 400); abi.setViewport(640, 360, Math.PI / 6)
  abi.setCamera({distance: 3000, tiltRadians: -0.3, yawRadians: 0})
  const budget = {maximumChangeCount: 32, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0}
  const read = async () => {
    const before = frames.presented
    const packet = worker ? await abi.step(0.005, budget, frames) : await frames.read(abi, 0.005, budget)
    if (before && before.draws.some(draw => !(draw.flags & 1))) {
      const surface = value => Object.assign({}, value, {meshResources: value.resources})
      const task = require('../js/reference/surface_replacement').createReplacementTask(surface(before), surface(packet), false)
      const reference = await task.run()
      const normalize = groups => groups.map(g => [g.before.slice().sort((a,b)=>a-b),
        g.after.slice().sort((a,b)=>a-b)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
      assert(packet.replacementPlan && reference, 'Planar mesh publication lost its boundary proof')
      const oracle = reference.map(g => ({before:g.before.map(d=>d.resourceId), after:g.after.map(d=>d.resourceId)}))
      const expected = packet.replacementPlan.atomic ? [{before:oracle.flatMap(g=>g.before), after:oracle.flatMap(g=>g.after)}] : oracle
      assert.deepStrictEqual(normalize(packet.replacementPlan.groups), normalize(expected),
      'Planar or mixed native cut differs from full-mesh boundary reference')
    }
    assert(!frames.ledger.stats().owners['terrain-boundary-work'], 'Mesh publication retained planning credit')
    return packet
  }
  for (let i = 0; i < 4; ++i) {
    const cut = await read()
    const requests = worker ? cut.requests : abi.getRequests()
    for (const request of requests) {
      const file = request.kind === 1 ? 'planar_root_record.bin' : 'planar_root_detail_record.bin'
      await abi.submitRecord(request.kind, request.key,
        fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden', file)))
    }
    await receipts.present(cut.frame.sequence)
    if (cut.draws.length === 4 && !requests.length) break
  }
  assert.strictEqual(frames.presented.draws.length, 4)
  const previous = Array.from(frames.presented.resources.keys())
  await abi.setPlanarLevel(0)
  const publishedRevision = frames.presented.updateState.modelRevision
  const advance = async () => {
    const value = await abi.advanceTerrain(0.005, budget)
    return worker ? value.progress : value
  }
  const model = await advance()
  assert(model.modelRevision > publishedRevision, 'Background topology did not advance its own model version')
  assert.strictEqual((await advance()).modelRevision, model.modelRevision, 'Stable background work changed model identity')
  if (!worker) assert.strictEqual(abi.getUpdateState().modelRevision, publishedRevision,
    'Model advancement rewrote the immutable candidate version')
  budget.maximumMeshBytes = 1
  await assert.rejects(read, error => error.status === 9 && Array.isArray(error.requests),
    'Allocation refusal lost its typed capacity status or request frontier')
  assert.strictEqual(frames.candidate, null)
  assert.deepStrictEqual(Array.from(frames.resources.keys()), previous)
  if (!worker) {
    assert.strictEqual(abi.getFrame().sequence, frames.presented.frame.sequence)
    assert.strictEqual(abi.getUpdateState().modelRevision, publishedRevision)
    frames.presented.draws.forEach(draw => assert.deepStrictEqual(
      abi.copyMeshResource(draw).positions, frames.resources.get(draw.resourceId).positions))
  }
  budget.maximumMeshBytes = 0
  const cut = await read(), sequence = cut.frame.sequence
  assert.strictEqual(cut.updateState.modelRevision, model.modelRevision)
  assert.strictEqual(cut.draws.length, 2)
  assert(previous.every(id => !cut.resources.has(id)), 'Fixture did not replace the old topology')
  const displayed = frames.presented.draws.slice(1).concat(cut.draws.slice(0,1))
  await assert.rejects(async () => abi.retainMeshes(sequence, [{resourceId:0xffffffff}]))
  await assert.rejects(async () => abi.retainMeshes(sequence - 1, displayed))
  assert(await receipts.retain(sequence, displayed))
  assert.strictEqual(errors.length, 0)
  assert(!frames.resources.has(previous[0]) && frames.resources.has(previous[1]))
  assert(frames.candidate === cut && frames.presented.partial)
  await assert.rejects(async () => abi.retainMeshes(sequence, [{resourceId:previous[0]}]),
    worker ? /presentation owner/ : /Terra status 2/)
  if (worker) await abi.discardFrame(sequence)
  frames.discard(sequence)
  const mixed = Array.from(frames.resources.keys()).sort((a,b)=>a-b)
  assert.deepStrictEqual(mixed, displayed.map(d=>d.resourceId).sort((a,b)=>a-b))

  if (!worker) {
    const plan = await abi.prepareMeshFrame(0.005,budget)
    const before = require('../../sdk/js/terrain/surface_replacement').surfaceIds(displayed)
    assert.strictEqual(abi.reuseReplacementPlan(plan.nativePlan,before),null,
      'An arbitrary mixed retention bypassed the whole-group boundary invariant')
    abi.discardMeshPlan(plan.nativePlan)
  }
  await abi.setPlanarLevel(1)
  const returned = await read()
  assert.strictEqual(returned.draws.length, 4)
  assert.strictEqual(returned.additions.length, 1, 'Mixed presentation lost its retained CPU resources')
  assert(await receipts.retain(returned.frame.sequence, displayed),
    'A candidate replacement lost the previously submitted new mesh')
  const newId = cut.draws[0].resourceId
  assert(!returned.resources.has(newId) && frames.presented.resources.has(newId))
  if (worker) {
    const cells = [{key:'whole',bounds:{minimumU:0,maximumU:1,minimumV:0,maximumV:1}}]
    assert((await abi.createPartitionTask(newId,cells,8*1024*1024).promise).length>0,
      'Worker released a displayed mesh with its discarded candidate')
  } else {
    assert(abi.copyMeshResource(cut.draws[0]).positions.length>0,
      'Native owner released a displayed mesh with its discarded candidate')
  }
  assert(await receipts.present(returned.frame.sequence))
  assert.strictEqual(frames.resources.size, 4)
  await assert.rejects(async()=>abi.retainMeshes(returned.frame.sequence,displayed),
    worker ? /Stale mesh retention/ : /Terra status 2/)
  // Idle coarse meshes must yield to an exact working-set budget, without
  // treating duplicated candidate/display ownership as duplicate arrays.
  budget.maximumMeshBytes = Array.from(frames.resources.values()).reduce((n, r) =>
    n + r.positions.byteLength + r.textureUv.byteLength, 0)
  assert(abi.nativeBudget.actual > budget.maximumMeshBytes, 'Fixture lacks idle native cache')
  const memory = frames.ledger, previousLimit = memory.maximumBytes
  const idleBytes = abi.nativeBudget.actual - budget.maximumMeshBytes, beforeReclaim = memory.bytes
  memory.setLimit(beforeReclaim)
  assert.strictEqual(memory.reserve('imagery-pressure-fixture', idleBytes), null)
  assert.strictEqual(memory.bytes, beforeReclaim, 'Pressure refunded native memory before its receipt')
  await memory.reclamation.pending
  assert.strictEqual(abi.nativeBudget.actual, budget.maximumMeshBytes,
    'Cross-owner pressure did not reclaim idle native payload')
  const imageCredit = memory.reserve('imagery-pressure-fixture', idleBytes)
  assert(imageCredit, 'The acknowledged native refund did not fund another owner')
  imageCredit.release(); memory.setLimit(previousLimit)
  const compact = await read()
  assert.strictEqual(compact.updateState.meshBytes, budget.maximumMeshBytes)
  assert.strictEqual(compact.additions.length, 0)
  assert(await receipts.present(compact.frame.sequence))
  assert.strictEqual(frames.ledger.stats().owners['mesh-native'].resident, budget.maximumMeshBytes)
  memory.setLimit(memory.bytes)
  assert.strictEqual(memory.reserve('blocked-imagery-fixture', 1), null)
  await memory.reclamation.pending
  const attempts = memory.reclamation.attempts
  for (let i = 0; i < 8; ++i) {
    assert.strictEqual(memory.reserve('blocked-imagery-fixture', 1), null)
    await memory.reclamation.pending
  }
  assert.strictEqual(memory.reclamation.attempts, attempts, 'Stable held native data was repeatedly scanned')
  assert.strictEqual(abi.nativeBudget.actual, budget.maximumMeshBytes,
    'Cache trim released presented native resources')
  memory.setLimit(previousLimit)
  frames.clear()
}
