const assert = require('assert')
const {releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')
const fs = require('fs')
const path = require('path')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {MeshReceipts} = require('../../sdk/js/terrain/mesh_receipts')
const {surfaceIds} = require('../../sdk/js/terrain/surface_replacement')
const reference = require('../js/reference/surface_replacement')
const {ResourceCache} = require('../../sdk/js/resources/resource_cache')
const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const preparedUv = require('./prepared_uv_contract')
const preparedSurface = require('./prepared_surface_contract')
const {preparedPartitionBytes} = require('../../adapters/wasm/prepared_partitions')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

// Flat and mountainous versions of the same real CBDAM records exercise both
// independent groups and a boundary dependency which cannot be split safely.
module.exports = async function verifyMeshGroups(abi, worker, ledger, gpuOutputs = false) {
  let boundaryRuns = 0
  const operation = worker ? 'send' : 'createReplacementTask', original = abi[operation]
  abi[operation] = function(...args) {
    if (!worker || args[0].type === 'replacement') ++boundaryRuns
    return original.apply(this,args)
  }
  const frames = new MeshFrames(ledger)
  let shown = new Set(), preparedOutput, refusedGroup
  const gpu = new ResourceCache({ledger: frames.ledger, owner: 'geometry-gpu',
    canEvict: key => !shown.has(key), dispose: value => value.release()})
  if (gpuOutputs) frames.reserveOutputs = (packet, bytes) => {
    // A destination held by an earlier upload stays unavailable after native
    // trim. Try a later group, then continue the same target after its receipt.
    if (refusedGroup && packet.draws.length === 3) {
      const ids = surfaceIds(packet.draws).join(',')
      if (!refusedGroup.ids) refusedGroup.ids = ids
      if (ids === refusedGroup.ids) { ++refusedGroup.count; return null }
    }
    preparedOutput = gpu.reserveBatch(new Map(packet.draws.map(d => [d.resourceId, d.vertexCount*20])), bytes, 'mesh-transfer')
    return preparedOutput
  }
  const productionMethod = worker ? 'send' : 'createMeshTask', produce = abi[productionMethod]
  abi[productionMethod] = function(...args) {
    if (gpuOutputs && (!worker || args[0].type === 'materialize'))
      assert(preparedOutput && preparedOutput.valid(), 'Native materialization preceded its GPU destinations')
    return produce.apply(this,args)
  }
  const receipts = new MeshReceipts(frames, () => abi, error => {throw error})
  const budget = {maximumChangeCount: 32, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0}
  let candidateImagery
  const snapshots=new Set()
  const imageryResidency=()=>Array.from(frames.ledger.leases)
    .filter(lease=>lease.owner.startsWith('imagery-')&&!frames.ledger.canReclaim(lease))
    .reduce((sum,lease)=>sum+lease.bytes,0)
  const read = async () => {
    const result=await (worker?abi.step(0.005,budget,frames,candidateImagery):frames.read(abi,0.005,budget))
    if(result.measurements)snapshots.add(result.measurements)
    return result
  }
  const present = async packet => {
    if (gpuOutputs) {
      for (const draw of packet.draws) {
        const destination = packet.outputs.take(draw.resourceId)
        if (!destination) continue
        const release = holdMeshes([packet.resources.get(draw.resourceId)])
        release.ownedBy(destination.lease)
        assert(destination.commit({release}))
      }
      shown = new Set(packet.draws.map(d => d.resourceId))
      packet.outputs.release()
    }
    await receipts.present(packet.frame.sequence)
    releaseMeasurements(packet.measurements);snapshots.delete(packet.measurements)
    if (gpuOutputs) for (const key of gpu.entries.keys()) if (!shown.has(key)) gpu.delete(key)
  }
  const normalize = groups => groups.map(g => [g.before.slice().sort((a,b)=>a-b),
    g.after.slice().sort((a,b)=>a-b)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const verifyProof = async packet => {
    const surface = value => Object.assign({}, value, {meshResources: value.resources})
    const proof = await reference.createReplacementTask(surface(frames.presented), surface(packet), false).run()
    assert(proof, 'Mixed meshes do not establish complete safe boundaries')
    const oracle = proof.map(g => ({before:g.before.map(d=>d.resourceId), after:g.after.map(d=>d.resourceId)}))
    const expected = packet.replacementPlan.atomic ? [{before:oracle.flatMap(g=>g.before), after:oracle.flatMap(g=>g.after)}] : oracle
    assert.deepStrictEqual(normalize(packet.replacementPlan.groups), normalize(expected))
  }
  const verifyImagery = async packet => {
    if (!worker) return
    // The one-byte-short allowance below prices geometry groups only. Native
    // models, row owners and mirror transfers have their own measured cost;
    // exercise membership without borrowing from that geometry allowance.
    // Fixed joint runtime limits are covered by candidate/browser contracts.
    const limit=frames.ledger.maximumBytes,geometryAllowance=limit-imageryResidency()
    if(limit)frames.ledger.setLimit(0)
    try {
    const options = {descriptor: {kind: 'planar-tms', matrix_level_offset: 0,
      minimum_level: 0, maximum_level: 0, tile_size: 256, level_zero_columns: 1,
      level_zero_rows: 1, bounds: [[0,0],[1025,1025]]}, targetPixelError: 1.25,
      maximumTextures: 16, maximumDraws: 32, devicePixelRatio: 1, terrainBound: false}
    const measured = new Set()
    for(let i=0;i<256;++i) {
      const value=await abi.planImagery(packet.frame.sequence,options)
      releaseMeasurements(value.measurements)
      assert.strictEqual(value.meshIdentity,packet.meshIdentity)
      for(const item of value.measurements || []) measured.add(item.resourceId)
      if (!value.pending && !value.continuation) {
        assert(value.imageryPlan.draws.every(d=>packet.resources.has(d.resourceId)),
          'A same-model partial publication reused retired imagery geometry')
        assert(surfaceIds(packet.draws).every(id=>measured.has(id)),
          'Same-model group progress skipped new resource measurements')
        return
      }
    }
    throw new Error('Group imagery planning did not finish')
    }finally{if(limit)frames.ledger.setLimit(geometryAllowance+imageryResidency())}
  }
  try {
    for (const shared of [false, true]) for (const flat of [true, false]) {
      frames.clear()
      gpu.clear(); shown.clear(); gpu.maximumBytes = 0
      frames.ledger.setLimit(0)
      budget.maximumMeshBytes = 0
      await abi.loadManifest({formatVersion: 1, patchDimension: 64, transform: 'planar',
        heightScale: flat ? 1e-14 : 0.0000976563,
        minimumU: 0, minimumV: 0, maximumU: 1025, maximumV: 1025, radius: 0,
        texture: {kind: 'planar-tms', matrix_level_offset: 0, minimum_level: 0, maximum_level: 0,
          tile_size: 256, level_zero_columns: 1, level_zero_rows: 1, bounds: [[0,0],[1025,1025]]}})
      await abi.setPlanarLevel(1)
      abi.setPlanarTarget(600,400); abi.setViewport(640,360,Math.PI/6)
      abi.setCamera({distance:3000,tiltRadians:-0.3,yawRadians:0})
      for (let i=0;i<4;++i) {
        const packet = await read()
        const requests = worker ? packet.requests : abi.getRequests()
        for (const r of requests) await abi.submitRecord(r.kind,r.key,fs.readFileSync(path.join(__dirname,
          '../../testdata/miniprogram/golden', r.kind===1 ? 'planar_root_record.bin' : 'planar_root_detail_record.bin')))
        await present(packet)
        if (packet.draws.length===4 && !requests.length) break
      }
      // The complete old/new destinations fit. Prove the atomic membership
      // against full mesh boundaries without invoking native edge work, for
      // both flat and mountainous records, direct Wasm and the real Worker.
      const scansBeforeAtomic = boundaryRuns
      await abi.setPlanarLevel(0)
      const atomic = await read()
      assert.strictEqual(boundaryRuns, scansBeforeAtomic, 'An admitted complete cut sampled boundaries')
      assert(atomic.replacementPlan.atomic)
      assert.strictEqual(atomic.draws.length, 2)
      await verifyProof(atomic); await present(atomic)
      await abi.setPlanarLevel(1)
      const restored = await read()
      assert.strictEqual(restored.draws.length, 4)
      assert.strictEqual(boundaryRuns, scansBeforeAtomic, 'An admitted refinement sampled boundaries')
      await verifyProof(restored); await present(restored)
      if (worker && !gpuOutputs) {
        // Refuse after materialization AND real core imagery evaluation. Flat
        // terrain has two independent seam groups; mountain edges form one.
        // The former can publish one group from the same transferred arrays,
        // while the latter must retain its complete old surface.
        candidateImagery = {descriptor:{kind:'planar-tms',matrix_level_offset:0,
          minimum_level:0,maximum_level:0,tile_size:256,level_zero_columns:1,level_zero_rows:1,
          bounds:[[0,0],[1025,1025]]},targetPixelError:1.25,maximumTextures:16,
        maximumDraws:32,devicePixelRatio:1,terrainBound:false}
        const copies = new Map()
        let evaluations = 0
        frames.evaluateCandidate = async (packet, forecast) => {
          ++evaluations
          assert.strictEqual(frames.presented,restored)
          assert.strictEqual(frames.candidate,null)
          assert(forecast.candidateReady && forecast.imageryPlan.quality.coverageGuaranteed)
          assert(forecast.imageryPlan.draws.every(draw=>packet.draws.some(mesh=>mesh.resourceId===draw.resourceId)))
          if (evaluations===1) {
            packet.additions.forEach(resource=>copies.set(resource.resourceId,resource.positions))
            return null
          }
          assert(flat && packet.draws.length===3,'Late selection split an indivisible native seam group')
          packet.additions.forEach(resource=>assert.strictEqual(resource.positions,copies.get(resource.resourceId),
            'Late native selection retransferred an existing mesh array'))
          const credit=frames.ledger.reserve('fixture-joint-output',0)
          return {credit,valid:()=>true,release:()=>credit.release()}
        }
        await abi.setPlanarLevel(0)
        if (flat) {
          const mixed = await read()
          assert.strictEqual(mixed.updateState.pendingMeshGroups,1)
          assert.strictEqual(mixed.frame.decisionsComplete,false)
          await verifyProof(mixed); await present(mixed)
        } else {
          await assert.rejects(read,error=>error.status===9)
          assert.strictEqual(frames.presented,restored)
          assert.strictEqual(frames.candidate,null)
        }
        assert.strictEqual(evaluations,flat?2:1)
        frames.evaluateCandidate=null;candidateImagery=undefined
        await present(await read())
        await abi.setPlanarLevel(1)
        await present(await read())
      }
      // A renderer can fund its complete successor independently of GPU work
      // slicing. Real capacity pressure below still requires seam groups;
      // an affordable target must not sample boundaries merely for uploads.
      frames.prepareOutputs = () => ({
        admit: async (packet, bytes) => {
          if (gpuOutputs) return frames.reserveOutputs(packet, bytes)
          const credit = frames.ledger.reserve('mesh-transfer', bytes)
          return credit && {credit, valid: () => true, release() {}}
        }, release() {}
      })
      await abi.setPlanarLevel(0)
      const beforeFunded = boundaryRuns
      const local = await read()
      assert(local.replacementPlan.atomic, 'Funded complete production was split for an upload window')
      assert.strictEqual(boundaryRuns,beforeFunded,'Funded output sampled unnecessary native boundaries')
      assert.strictEqual(local.draws.length,2,'Funded production left an unnecessary intermediate cut')
      await verifyProof(local); await present(local)
      const scanned = boundaryRuns
      const remaining = await read()
      assert.strictEqual(remaining.draws.length, 2)
      assert.strictEqual(boundaryRuns, scanned, 'A fixed remaining target rescanned boundary samples')
      await verifyProof(remaining); await present(remaining)
      frames.prepareOutputs = null
      await abi.setPlanarLevel(1)
      await present(await read())
      const old = frames.presented
      assert.strictEqual(old.draws.length,4)
      const size = old.draws[0].vertexCount*20
      await abi.setPlanarLevel(0)
      let targetIds
      if (!worker) {
        const packet=await abi.prepareMeshFrame(0.005,budget), before=surfaceIds(old.draws)
        assert.strictEqual(abi.reuseReplacementPlan(packet.nativePlan,before),null,
          'A different target reused an obsolete boundary proof')
        const bytes=abi.replacementWorkBytes(packet.nativePlan,before)
        const proof=await abi.createReplacementTask(packet.nativePlan,before,bytes).run()
        assert.strictEqual(proof.groups.length,flat ? 2 : 1)
        targetIds=surfaceIds(packet.draws)
        assert.deepStrictEqual(abi.reuseReplacementPlan(packet.nativePlan,before),proof)
        assert.throws(()=>abi.reuseReplacementPlan(packet.nativePlan,[0xffffffff]),e=>e.status===2)
        assert.throws(()=>abi.reuseReplacementPlan(packet.nativePlan,[before[0],before[0]]),e=>e.status===1)
        const payload=abi.meshPayloadBytes(), sequence=abi.getFrame().sequence
        const targetUv = preparedUv.read(abi, packet)
        const targetSurface = await preparedSurface.read(abi, packet)
        for (const ids of [[],[proof.groups.length],[0,0]])
          assert.throws(()=>abi.selectMeshGroups(packet.nativePlan,ids),e=>e.status===1)
        for(let i=0;i<proof.groups.length;++i) {
          const mixed=abi.selectMeshGroups(packet.nativePlan,[i])
          assert.strictEqual(abi.meshPayloadBytes(),payload,'Selection generated uncredited mesh arrays')
          assert.strictEqual(abi.getFrame().sequence,sequence,'Trial group selection published a frame')
          const expected=new Set(proof.groups.flatMap((g,j)=>i===j?g.after:g.before))
          assert.deepStrictEqual(surfaceIds(mixed.draws),Array.from(expected).sort((a,b)=>a-b))
          const sampled = preparedUv.read(abi, mixed)
          const sampledSurface = await preparedSurface.read(abi, mixed)
          for (const [id, mesh] of sampledSurface) if (targetSurface.has(id))
            preparedSurface.same(mesh.positions, targetSurface.get(id).positions, 'Group selection changed target positions')
          for (const [id, uv] of sampled) if (targetUv.has(id)) assert.deepStrictEqual(uv, targetUv.get(id))
          for (const id of targetIds) if (!expected.has(id)) {
            assert.strictEqual(abi.module.call('terra_get_prepared_mesh_uv', abi.context,
              mixed.nativePlan.id, id, 0, 0, 0), 1, 'UV read accepted an unselected target resource')
            assert.strictEqual(abi.module.call('terra_get_prepared_mesh_positions', abi.context,
              mixed.nativePlan.id, id, 0, 0, 0), 1, 'Position read accepted an unselected target resource')
          }
        }
        // A rejected fully produced target can select another safe boundary
        // group without advancing publication or rebuilding the whole model.
        const allGroups = proof.groups.map((_, i) => i)
        let staged = abi.selectMeshGroups(packet.nativePlan, allGroups)
        const generate = value => {
          const credit = frames.ledger.reserve('mesh-native', value.nativePlan.additionalBytes)
          assert(credit, 'Staged group fixture lacks native credit')
          abi.nativeBudget.begin(credit)
          try { abi.materializeMeshFrame(value) } finally { abi.nativeBudget.finish() }
          assert.strictEqual(abi.getFrame().sequence, sequence, 'Staged group changed publication')
        }
        generate(staged)
        const previous = staged
        staged = abi.selectMeshGroups(staged.nativePlan, [0])
        assert.strictEqual(staged.nativePlan.additionalBytes, 0, 'Generated group was not reused')
        assert.throws(() => abi.commitMeshFrame(previous), /not prepared/, 'A superseded selection remained publishable')
        assert.strictEqual(abi.module.call('terra_commit_mesh_frame', abi.context, staged.nativePlan.id), 2,
          'Group reselection reused the old production completion')
        generate(staged)
        const stagedCopies = new Map(staged.draws.map(draw => [draw.resourceId, abi.copyMeshResource(draw)]))
        for (const [id, mesh] of targetSurface) if (stagedCopies.has(id))
          preparedSurface.same(mesh.positions, stagedCopies.get(id).positions, 'Reselection altered generated heights')
        abi.discardMeshPlan(staged.nativePlan)
        assert.throws(()=>abi.selectMeshGroups(packet.nativePlan,[0]),e=>e.status===2)
      }
      if (worker && !shared && flat) {
        // Exercise the real prepare protocol while the native plan is pending.
        // Reject admission afterwards: pricing/cancellation cannot publish it.
        const oldBytes = abi.nativeBudget.actual, prices = new Map()
        let released = false
        frames.prepareOutputs = packet => ({
          async admit(value) {
            if (value.replacementPlan.atomic) await assert.rejects(
              abi.send({type:'select-groups', planId:packet.nativePlan.id, groups:[0]}),
              /Stale mesh group selection/, 'Atomic proof authorized a partial native cut')
            const rows = value.draws.filter(draw => !prices.has(draw.resourceId))
              .map(draw => ({draw, cells: preparedUv.cells}))
            if (rows.length) {
              const bytes = Math.max(...rows.map(row => preparedPartitionBytes(row.draw)))
              const lease = await abi.reserveNativeWork('prepared-partition-work', bytes)
              assert(lease)
              try {
                const cancelled = abi.createMeshPartitionPlanTask(packet.nativePlan.id, rows, bytes,
                  () => assert.fail('Cancelled batch published costs'))
                cancelled.cancel(); await cancelled.promise
                const seen = []
                const task = abi.createMeshPartitionPlanTask(packet.nativePlan.id, rows, bytes, completed => {
                  for (const item of completed) {
                    seen.push(item.resourceId); prices.set(item.resourceId, item.prices)
                  }
                })
                assert(await task.promise)
                assert.deepStrictEqual(seen, rows.map(row => row.draw.resourceId), 'Batch lost or duplicated mesh costs')
                assert.strictEqual(abi.nativeBudget.actual, oldBytes)
              } finally { lease.release() }
            }
            return null
          },
          release() { released = true }
        })
        try { await assert.rejects(read, e => e.status === 9) }
        finally { frames.prepareOutputs = null }
        assert(released && prices.size >= 2)
        assert.strictEqual(frames.presented, old)
        // Existing old members in mixed groups must also sample their real UV.
        for (const draw of old.draws) if (prices.has(draw.resourceId)) {
          const mesh = old.resources.get(draw.resourceId)
          const model = surface.prepareSurface(mesh.positions, mesh.textureUv,
            frames.indices, draw.firstIndex, draw.indexCount)
          assert.deepStrictEqual(prices.get(draw.resourceId),
            await surface.createPartitionPlanTask(model, preparedUv.cells).run())
        }
        assert.strictEqual(frames.ledger.stats().reservedBytes, 0)
      }
      if (gpuOutputs) gpu.maximumBytes=size*4
      else budget.maximumMeshBytes=size*4
      const copied=frames.copiedBytes
      await assert.rejects(read,e=>e.status===9)
      assert.strictEqual(frames.copiedBytes,copied,'Refused groups copied meshes')
      assert.strictEqual(frames.presented,old)
      assert.strictEqual(frames.candidate,null)
      budget.maximumMeshBytes=shared || gpuOutputs ? 0 : size*5
      if (gpuOutputs) gpu.maximumBytes=shared ? 0 : size*5
      // Native + host (+ GPU) are physical payloads in both paths. Worker
      // loans retain Native ownership without another array reservation.
      // This fixture has one root and a zero residual. Idle detail records
      // can now yield to shared pressure; do not count that reclaimable cache
      // as a fixed cost or it would fund the supposedly one-byte-short group.
      const retainedRecordBytes = 4 * (64 * 64 + 65 * 65)
      const retainedHeightBytes = 65 * 66 * 2 * 2 // Active planar root fragments.
      const meshLimit = size*(gpuOutputs ? 5*3+1 : 4*2+4)-1
      if(shared&&worker)await abi.send({type:'trim-native-measurements',needed:abi.imageryInputPayloadBytes()})
      if (shared) frames.ledger.setLimit(meshLimit + retainedRecordBytes + retainedHeightBytes + imageryResidency())
      if(!flat) {
        await assert.rejects(read,e=>e.status===9,'An indivisible mountainous boundary was partially produced')
        assert.strictEqual(frames.copiedBytes,copied)
        frames.ledger.setLimit(0)
        budget.maximumMeshBytes=size*6
        if (gpuOutputs) gpu.maximumBytes=size*6
        const packet=await read()
        assert.strictEqual(packet.draws.length,2)
        assert.strictEqual(packet.updateState.pendingMeshGroups,0)
        await verifyProof(packet); await present(packet)
        continue
      }
      for (const target of [0,1]) {
        await abi.setPlanarLevel(target)
        // This contract isolates whole-group mesh admission. Height pressure
        // may now have evicted detail inputs: reconstruct the requested cut
        // first, then price its real protected inputs in addition to the same
        // one-byte-short mesh allowance. Height admission has its own contract.
        if (shared) {
          frames.ledger.setLimit(0)
          for (let turn = 0; turn < 4; ++turn) {
            const state = await abi.advanceTerrain(0.005, budget)
            const requests = worker ? state.requests : abi.getRequests()
            if (!requests.length) break
            for (const r of requests) await abi.submitRecord(r.kind,r.key,fs.readFileSync(path.join(__dirname,
              '../../testdata/miniprogram/golden', r.kind === 1 ? 'planar_root_record.bin' : 'planar_root_detail_record.bin')))
          }
          if (worker) {
            await abi.send({type:'trim-records',needed:abi.recordBudget.actual})
            await abi.send({type:'trim-heights',needed:abi.heightBudget.actual})
          } else { abi.reclaimRecords(abi.recordBudget.actual); abi.reclaimHeights(abi.heightBudget.actual) }
          // Optional derived models are not a fixed cost of this geometry
          // proof. Retire them before measuring protected imagery residency.
          if(worker)await abi.send({type:'trim-native-measurements',needed:abi.imageryInputPayloadBytes()})
          frames.ledger.setLimit(meshLimit + abi.recordBudget.actual + abi.heightBudget.actual + imageryResidency())
        }
        refusedGroup = gpuOutputs ? {count: 0} : null
        const before=frames.presented, first=await read()
        if (refusedGroup) assert(refusedGroup.count >= 2, 'First group must remain blocked across native trim')
        refusedGroup = null
        assert(!first.replacementPlan.atomic, 'Partial production retained an atomic proof: ' + JSON.stringify({worker, shared, flat, gpuOutputs, target, size, heights:abi.heightBudget.stats(), memory:frames.ledger.stats()}))
        assert.strictEqual(first.draws.length,3, JSON.stringify({worker, shared, flat, gpuOutputs, target, size,
          recordBytes: abi.recordBudget.actual, memory: frames.ledger.stats()}))
        assert.strictEqual(first.updateState.pendingMeshGroups,1)
        assert.strictEqual(first.frame.decisionsComplete,false,'Partial production claimed target convergence')
        assert(first.frame.coverageComplete)
        assert.strictEqual(first.additions.length,target===0?1:2,'Unselected groups generated payload')
        assert(first.draws.some(d=>before.resources.has(d.resourceId)),'Unselected old coverage was lost')
        if (budget.maximumMeshBytes) assert(first.updateState.meshBytes<=budget.maximumMeshBytes)
        assert.strictEqual(frames.ledger.stats().overBudgetBytes,0)
        await verifyProof(first); await verifyImagery(first); await present(first)
        if (worker) await abi.send({type:'trim-native',needed:abi.nativeBudget.actual})
        else abi.trimMeshCache()
        assert.strictEqual(abi.nativeBudget.actual,size*3,
          'Persistent proof retained retired or unselected native arrays')
        const scans=boundaryRuns
        const next=await read()
        assert.strictEqual(boundaryRuns,scans,'A fixed target rescanned complete boundaries after a partial receipt')
        assert.strictEqual(next.updateState.modelRevision,first.updateState.modelRevision)
        assert.strictEqual(next.updateState.pendingMeshGroups,0)
        assert.strictEqual(next.frame.decisionsComplete,true)
        assert.strictEqual(next.draws.length,target===0?2:4)
        if (!worker && target===0) assert.deepStrictEqual(surfaceIds(next.draws),targetIds,
          'Metadata continuation changed immutable target IDs after cancellation/cache reclamation')
        if (budget.maximumMeshBytes) assert(next.updateState.meshBytes<=budget.maximumMeshBytes)
        assert.strictEqual(frames.ledger.stats().overBudgetBytes,0)
        await verifyProof(next); await verifyImagery(next); await present(next)
        const stable=await read()
        assert.strictEqual(stable.additions.length,0)
        assert.strictEqual(stable.updateState.pendingMeshGroups,0)
        await present(stable)
      }
      assert(!frames.ledger.stats().reservedBytes,'Group production retained temporary credit')
    }
  } finally {
    for(const snapshot of snapshots)releaseMeasurements(snapshot)
    frames.clear();gpu.clear();frames.ledger.setLimit(0);abi[productionMethod]=produce;abi[operation]=original
  }
}
