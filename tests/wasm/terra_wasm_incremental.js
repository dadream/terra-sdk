const assert = require('assert')
const fs = require('fs')
const path = require('path')
const loader = require('../../adapters/wasm/terra_wasm')
const { TerraAbi, REQUEST_ROOT } = require('../../adapters/wasm/terra_globe_runtime')
const { createReplacementTask } = require('../js/reference/surface_replacement')
const preparedUv = require('./prepared_uv_contract')
const {preparedSurfaceBytes} = require('../../adapters/wasm/prepared_surface')

async function main() {
  const wasmPath = process.argv[2]
  assert(wasmPath, 'A Wasm build path is required')
  const module = await loader.instantiateTerraWasmBytes(fs.readFileSync(wasmPath))
  await require('./abi_teardown_contract')(module,fs.readFileSync(wasmPath))
  await require('./imagery_scratch_contract')(module)
  require('./height_work_contract')(module)
  await require('./mesh_production_contract')(module)
  require('./shared_uv_contract')(module)
  await require('./terrain_wait_contract')(fs.readFileSync(wasmPath))
  await require('./terrain_capacity_recovery_contract')(module)
  await require('./prepared_snapshot_contract')(module)
  await require('./boundary_credit_contract')(module)
  await require('./prepared_navigation_contract')(module)
  const abi = new TerraAbi(module)
  await require('./height_query_contract')(abi)
  const root = fs.readFileSync(path.join(__dirname,
    '../../testdata/miniprogram/golden/globe_root_0_record.bin'))
  try {
    assert(abi.incrementalLayout, 'The build does not expose the incremental extension')
    abi.loadManifest({
      formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
      heightScale: 0.001953125, minimumU: -180, minimumV: -90,
      maximumU: 180, maximumV: 90, radius: 6378000,
      texture: { kind: 'global-geodetic', matrix_level_offset: 0, maximum_level: 8, minimum_level: 0,
        tile_size: 256, level_zero_columns: 2, level_zero_rows: 1,
        bounds: [[-180, -90], [180, 90]] }
    })
    abi.setViewport(1280, 720, Math.PI / 6)
    const budget = { maximumChangeCount: 1, maximumPriorityUpdateCount: 2,
      maximumElapsedMs: 0 }
    const first = abi.updateStep(1, budget)
    const initial = abi.getUpdateState()
    assert.strictEqual(initial.priorityUpdateCount, 2)
    assert.strictEqual(initial.pendingPriorityUpdateCount, 6)
    assert(initial.budgetExhausted && !first.decisionsComplete)
    assert(initial.meshBytes <= initial.maximumMeshBytes)
    let frame = first
    for (let step = 0; step < 12 && !frame.decisionsComplete; step += 1) {
      abi.getRequests().forEach(request => {
        if (request.kind === REQUEST_ROOT) abi.submitRecord(request.kind, request.key, root)
      })
      if (step === 0) {
        const before = abi.getUpdateState()
        const prepared = abi.advanceTerrain(1, budget)
        assert(prepared.modelRevision > before.modelRevision,
          'Root height arrival with unchanged topology did not change model identity')
        assert.strictEqual(abi.getUpdateState().modelRevision, before.modelRevision,
          'Height preparation changed the published candidate version')
        assert.deepStrictEqual(abi.getFrame(), frame)
        const beforeMeshBytes = abi.getUpdateState().meshBytes
        const plan = abi.prepareMeshFrame(1, budget)
        assert(plan.nativePlan.additionalBytes > 0)
        assert.strictEqual(abi.getUpdateState().meshBytes, beforeMeshBytes)
        assert.deepStrictEqual(abi.getFrame(), frame, 'Preparing metadata published a frame')
        plan.draws.forEach(draw => assert.strictEqual(module.call('terra_get_mesh_position_view',
          abi.context, draw.resourceId), 0, 'Preparation generated uncredited native payload'))
        const complete = abi.alloc(4)
        let denied
        try { denied = module.call('terra_step_mesh_frame', abi.context, plan.nativePlan.id,
          plan.nativePlan.additionalBytes - 1, complete) } finally { abi.free(complete) }
        assert.strictEqual(denied, 9)
        assert.strictEqual(abi.getUpdateState().meshBytes, beforeMeshBytes)
        const cancelled = plan.nativePlan
        const interrupted = abi.createPreparedSurfaceTask(cancelled.id, plan.draws[0], preparedSurfaceBytes(plan.draws[0]))
        interrupted.maximumSteps = 1
        assert(!interrupted.step().done)
        abi.discardMeshPlan(cancelled)
        await assert.rejects(interrupted.run(), e => e.status === 2)
        assert.strictEqual(interrupted.value, null, 'Invalidated task returned partial positions')
        const replacement = abi.prepareMeshFrame(1, budget)
        assert.notStrictEqual(replacement.nativePlan.id, cancelled.id)
        assert.strictEqual(replacement.frame.sequence, plan.frame.sequence)
        abi.discardMeshPlan(cancelled)
        assert.strictEqual(module.call('terra_step_mesh_frame', abi.context, cancelled.id, 0, 0), 2)
        const sampled = preparedUv.read(abi, replacement)
        assert.strictEqual(module.call('terra_get_prepared_mesh_uv', abi.context, cancelled.id,
          replacement.draws[0].resourceId, 0, 0, 0), 2)
        const prices = await preparedUv.plan(abi, replacement)
        abi.materializeMeshFrame(replacement); abi.commitMeshFrame(replacement)
        await preparedUv.verify(abi, replacement, sampled, prices)
        assert.strictEqual(replacement.nativePlan, null)
        assert(abi.getUpdateState().meshBytes > beforeMeshBytes)
        frame = abi.getFrame()
      }
      abi.presentFrame(frame.sequence)
      frame = abi.updateStep(1, budget)
      assert(abi.getUpdateState().priorityUpdateCount <= 2)
    }
    assert(frame.decisionsComplete && frame.coverageComplete)
    const meshes = abi.getMeshResources()
    assert.strictEqual(meshes.length, frame.drawCount)
    const copied = new Map()
    meshes.forEach(draw => {
      if (!copied.has(draw.resourceId)) copied.set(draw.resourceId, abi.copyMeshResource(draw))
      assert.strictEqual(copied.get(draw.resourceId).positions.length, draw.vertexCount * 3)
      assert.strictEqual(copied.get(draw.resourceId).textureUv.length, draw.vertexCount * 2)
    })
    assert.strictEqual(copied.size, 16, 'Root coverage and visible draws must share content IDs')
    require('./terrain_winding_contract')(abi, true)
    require('./mesh_borrow_contract')(abi)
    assert(abi.getUpdateState().meshBytes <= abi.getUpdateState().maximumMeshBytes)
    const revision = abi.getUpdateState().modelRevision
    abi.presentFrame(frame.sequence)
    // Coverage and visible descriptors alias the same root arrays. Charge
    // unique resources, not draws or the overlapping display/candidate owners.
    budget.maximumMeshBytes = abi.getUpdateState().meshBytes
    frame = abi.updateStep(1, budget)
    assert(frame.decisionsComplete)
    assert.strictEqual(abi.getUpdateState().priorityUpdateCount, 0)
    assert.strictEqual(abi.getUpdateState().heightBuildCount, 0)
    assert(abi.getUpdateState().heightBytes > 0)
    assert.strictEqual(abi.getUpdateState().modelRevision, revision)
    assert(abi.getMeshResources().every(draw => copied.has(draw.resourceId)),
      'A stable update must not allocate new mesh identities')
    budget.maximumMeshBytes = 0
    abi.presentFrame(frame.sequence)
    // Force the native proof path for an identical cut (the host normally
    // short-circuits it). Shared boundary storage must still emit both owners,
    // survive cancellation and leave the published mesh arrays untouched.
    {
      const before = require('../../sdk/js/terrain/surface_replacement').surfaceIds(abi.getMeshResources())
      const plan = abi.prepareMeshFrame(1, budget), payload = abi.meshPayloadBytes()
      const bytes = abi.replacementWorkBytes(plan.nativePlan, before)
      const cancelled = abi.replacementSteps(plan.nativePlan, before, bytes)
      assert.strictEqual(cancelled.next().done, false)
      cancelled.return()
      const proof = await abi.createReplacementTask(plan.nativePlan, before, bytes).run()
      assert.strictEqual(proof.groups.length, before.length)
      assert.deepStrictEqual(proof.groups.map(g => {
        assert.deepStrictEqual(g.before, g.after)
        assert.strictEqual(g.before.length, 1)
        return g.before[0]
      }).sort((a,b)=>a-b), before)
      assert.strictEqual(abi.meshPayloadBytes(), payload)
      assert.deepStrictEqual(abi.getFrame(), frame)
      abi.discardMeshPlan(plan.nativePlan)
    }
    abi.setCamera({ distance: 15000000 - 6378000, tiltRadians: -0.2, yawRadians: 0.5 })
    // Exercise the real Wasm clock import, not just deterministic work limits.
    frame = abi.updateStep(1, Object.assign({}, budget, { maximumElapsedMs: 10 }))
    assert(abi.getUpdateState().priorityUpdateCount <= 2)
    assert.strictEqual(abi.getUpdateState().modelRevision, revision)
    assert.throws(() => abi.presentFrame(frame.sequence - 1), /Terra status 2/)
    const published = abi.getUpdateState(), held = abi.getMeshResources()
    let advanced = 0
    for (let i = 0; i < 12; ++i) {
      const progress = abi.advanceTerrain(1, budget)
      advanced += progress.priorityUpdateCount
      assert(progress.priorityUpdateCount <= 2)
      assert.strictEqual(progress.sequence, frame.sequence)
    }
    assert(advanced > 0, 'A held candidate prevented native priority progress')
    assert.deepStrictEqual(abi.getFrame(), frame, 'Model work mutated the published frame')
    assert.strictEqual(abi.getUpdateState().pendingPriorityUpdateCount, published.pendingPriorityUpdateCount,
      'Model progress overwrote the published candidate state')
    assert.deepStrictEqual(abi.getMeshResources(), held)
    held.forEach(draw => {
      const mesh = abi.copyMeshResource(draw), original = copied.get(draw.resourceId)
      assert.deepStrictEqual(mesh.positions, original.positions)
      assert.deepStrictEqual(mesh.textureUv, original.textureUv)
    })
    abi.presentFrame(frame.sequence)
  } finally {
    abi.destroy()
  }
  const replay = new TerraAbi(module)
  try {
    replay.loadManifest({formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
      heightScale: 1, minimumU: -180, minimumV: -90, maximumU: 180, maximumV: 90, radius: 6378000,
      texture: {kind: 'global-geodetic', matrix_level_offset: 0, maximum_level: 8, minimum_level: 0,
        tile_size: 256, level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180,-90],[180,90]]}})
    replay.setViewport(640, 360, Math.PI / 4)
    replay.setGlobeTarget(116.4074, 39.9042)
    const detail = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_patch_record.bin'))
    let previousSurface = null, replacementChecks = 0
    const step = receive => {
      const packet = replay.prepareMeshFrame(0.0018597704681097907, {maximumChangeCount: 16,
        maximumPriorityUpdateCount: 256, maximumElapsedMs: 0, maximumNodeCount: 65536, meshBudgetBytes: 8*1024*1024})
      const f = packet.frame, nativeBytes = previousSurface ? replay.getUpdateState().meshBytes : 0
      let nativeProof = null
      if (previousSurface && f.coverageComplete && replacementChecks < 12) {
        const beforeIds = require('../../sdk/js/terrain/surface_replacement').surfaceIds(previousSurface.draws)
        const bytes = replay.replacementWorkBytes(packet.nativePlan, beforeIds)
        const denied = replay.createReplacementTask(packet.nativePlan, beforeIds, bytes - 1)
        assert.throws(() => denied.step(), error => error.status === 9)
        const cancelled = replay.createReplacementTask(packet.nativePlan, beforeIds, bytes)
        cancelled.step(); cancelled.cancel()
        const task = replay.createReplacementTask(packet.nativePlan, beforeIds, bytes)
        let result, count = 0
        do { result = task.step(); assert(++count < 10000) } while (!result.done)
        nativeProof = result.value
        assert.strictEqual(replay.getUpdateState().meshBytes, nativeBytes,
          'Boundary planning generated a full target mesh')
      }
      replay.materializeMeshFrame(packet); replay.commitMeshFrame(packet)
      const requests = replay.getRequests()
      if (receive) requests.forEach(r => replay.submitRecord(r.kind, r.key, r.kind === REQUEST_ROOT ? root : detail))
      if (f.coverageComplete && replacementChecks < 12) {
        const draws = replay.getMeshResources()
        const next = {draws, indices: replay.getIndices(),
          meshResources: new Map(draws.map(draw => [draw.resourceId, replay.copyMeshResource(draw)]))}
        if (previousSurface) {
          const task = createReplacementTask(previousSurface, next, true)
          let result
          for (let i = 0; i < 10000; ++i) {
            result = task.step()
            if (result.done) break
          }
          assert(result.done && result.value, 'Real CBDAM surfaces could not establish replacement dependencies')
          for (const [key, surface] of [['before', previousSurface], ['after', next]]) {
            const expected = surface.draws.filter(draw => !(draw.flags & 1)).map(draw => draw.resourceId).sort((a, b) => a - b)
            const actual = [].concat(...result.value.map(group => group[key])).map(draw => draw.resourceId).sort((a, b) => a - b)
            assert.deepStrictEqual(actual, expected, 'A native fragment was lost or duplicated by replacement grouping')
          }
          const normalize = proof => proof.map(group => [group.before.slice().sort((a,b)=>a-b),
            group.after.slice().sort((a,b)=>a-b)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
          const reference = result.value.map(group => ({before: group.before.map(draw => draw.resourceId),
            after: group.after.map(draw => draw.resourceId)}))
          assert.deepStrictEqual(normalize(nativeProof.groups), normalize(reference),
            'Pre-generation native boundary proof differs from the complete Float32 mesh oracle')
          ++replacementChecks
        }
        previousSurface = next
      }
      replay.presentFrame(f.sequence)
      return f.decisionsComplete && requests.length === 0
    }
    for (let i=0; i<12; ++i) step(true)
    const heldFrame = replay.updateStep(0.0018597704681097907, {maximumChangeCount: 1,
      maximumPriorityUpdateCount: 2, maximumElapsedMs: 0})
    const heldMeshes = replay.getMeshResources()
    require('./terrain_winding_contract')(replay, true)
    const heldContent = new Map(heldMeshes.map(draw => [draw.resourceId, replay.copyMeshResource(draw)]))
    replay.setCamera({distance: 500, tiltRadians: -1, yawRadians: 0.5})
    let builtHeights = 0, newRequests = 0
    for (let i=0; i<32; ++i) {
      const progress = replay.advanceTerrain(0.0018597704681097907, {
        maximumChangeCount: 4, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0,
        maximumNodeCount: 128, meshBudgetBytes: 8*1024*1024})
      builtHeights += progress.heightBuildCount
      replay.getRequests().forEach(r => {
        ++newRequests
        replay.submitRecord(r.kind, r.key, r.kind === REQUEST_ROOT ? root : detail)
      })
    }
    assert(builtHeights > 0 && newRequests > 0,
      'Held display prevented request frontier and height preparation from advancing')
    assert.deepStrictEqual(replay.getFrame(), heldFrame)
    assert.deepStrictEqual(replay.getMeshResources(), heldMeshes)
    heldMeshes.forEach(draw => {
      const actual = replay.copyMeshResource(draw), expected = heldContent.get(draw.resourceId)
      assert.deepStrictEqual(actual.positions, expected.positions)
      assert.deepStrictEqual(actual.textureUv, expected.textureUv)
    })
    replay.presentFrame(heldFrame.sequence)
    for (let i=0; i<8; ++i) {
      replay.setCamera({distance: 6378000*(i%2 ? 2.6 : 0.3), tiltRadians: i%2 ? -Math.PI/4 : 0, yawRadians: i*37*Math.PI/180})
      for (let j=0; j<3; ++j) step(false)
    }
    replay.setCamera({distance: 19509657.618864898, tiltRadians: 0, yawRadians: 0})
    let settled = false
    for (let i=0; i<200 && !settled; ++i) settled = step(true)
    assert(settled, 'Returning to a cached view stalled with no request or pending priority work')
    assert(replacementChecks >= 8, 'Insufficient real CBDAM replacement transitions exercised')
    const state = replay.getUpdateState()
    assert(state.heightBytes <= 32*1024*1024 && state.decodedRecordBytes <= 16*1024*1024)
  } finally { replay.destroy() }
  await require('./terrain_publication_window_contract')(module)
  process.stdout.write('Wasm incremental update and resource lifetime contracts passed.\n')
}

main().catch(error => {
  process.stderr.write(error.stack + '\n')
  process.exitCode = 1
})
