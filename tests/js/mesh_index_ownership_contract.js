const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {MeshCopyPlan} = require('../../sdk/js/resources/mesh_coordinates')
const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')

module.exports = async function verifyMeshIndexOwnership() {
  const draw = {resourceId: 1, textureResourceId: 1, vertexCount: 3, firstIndex: 0, indexCount: 3}
  const ledger = new ResourceLedger(65), frames = new MeshFrames(ledger)
  let plan = new MeshCopyPlan(frames, [draw]), credit, release, source
  const abi = {
    getIndices(maximumCount) { assert.strictEqual(maximumCount, 3); return source = new Uint16Array([0, 1, 2]) },
    copyMeshPositions: () => new Float32Array(9), copyMeshUv: () => new Float32Array(6)
  }
  try {
    assert.strictEqual(plan.bytes, 66)
    assert.throws(() => frames.reserve(plan.bytes), /capacity/)
    assert.strictEqual(source, undefined, 'Refused admission produced an index allocation')
    assert.strictEqual(ledger.bytes, 0)
    ledger.setLimit(66)
    credit = frames.reserve(plan.bytes); plan.allocate(credit)
    assert.strictEqual(plan.readIndices(abi), source)
    assert.strictEqual(plan.readIndices(abi), source, 'Direct execution copied its strip twice')
    const frame = plan.read(abi, {draws:[draw], frame:{sequence:1}})
    assert.strictEqual(frame.indices, source)
    frames.present(1); plan.release(); credit.release(); credit = null
    assert.strictEqual(ledger.stats().owners['terrain-index-host'].retired, 6)
    release = holdMeshes(frame.resources.values())
    frames.clear()
    assert.strictEqual(ledger.bytes, 66, 'Frame clear refunded a borrowed CPU strip')
    release(); release = null
    assert.strictEqual(ledger.bytes, 0)

    // An incomplete empty publication does not own/cache the future strip.
    plan = new MeshCopyPlan(frames, [])
    credit = frames.reserve(plan.bytes); plan.allocate(credit)
    plan.read({getIndices() {assert.fail('Empty cuts have no strip demand')}}, {draws:[],frame:{sequence:2}})
    frames.present(2); plan.release(); credit.release(); credit = null
    assert.strictEqual(frames.indices, null)
    plan = new MeshCopyPlan(frames, [draw])
    assert.strictEqual(plan.indexBytes, 6, 'An empty cut suppressed later index admission')
  } finally { if(release)release(); plan.release(); if(credit)credit.release(); frames.clear() }
  assert.strictEqual(ledger.bytes, 0)

  const {ownIndices} = require('../../sdk/js/resources/mesh_indices')
  const {createPreparedPartitionBatch, preparedPartitionBytes} = require('../../adapters/wasm/prepared_partitions')
  const surface = require('../../sdk/js/terrain/terra_surface_plan')
  for (const outcome of ['complete', 'cancel', 'failure']) {
    const workLedger = new ResourceLedger(100000)
    const indices = ownIndices(new Uint16Array([0, 1, 2]), workLedger.reserve('terrain-index-host', 6))
    const model = surface.prepareSurface(new Float32Array([0,0,0,1,0,0,0,1,0]),
      new Float32Array([0,0,1,0,0,1]), indices, 0, 3)
    const cells = [{key:'all', sourceUv:true, bounds:{minimumU:0,maximumU:1,minimumV:0,maximumV:1}}]
    const workspace = workLedger.reserve('uv-workspace', preparedPartitionBytes(draw))
    const task = createPreparedPartitionBatch({module:{call:()=>0}}, 1,
      Array.from({length:80}, () => ({draw, cells})), indices, workspace.bytes, () => {
        if(outcome === 'failure')throw new Error('index batch fixture')
        return {model, release() {}}
      })
    indices.ownership.retire()
    try {
      assert.strictEqual(workLedger.bytes, workspace.bytes + 6)
      if(outcome === 'failure')assert.throws(() => task.step(), /index batch fixture/)
      else if(outcome === 'complete') {
        const first = task.step()
        assert(!first.done && workLedger.bytes === workspace.bytes + 6,
          'A sliced batch refunded its shared index source')
        while(!task.step().done) {}
      } else task.cancel() // Also covers cancellation before the first step.
      assert.strictEqual(workLedger.bytes, workspace.bytes, 'UV batch retained its final index loan')
    } finally {task.cancel(); workspace.release()}
    assert.strictEqual(workLedger.bytes, 0)
  }

  const remoteLedger = new ResourceLedger(6)
  let finishTermination
  const client = new TerrainWorkerClient({postMessage() {}, terminate() {
    return new Promise(resolve => {finishTermination = resolve})
  }})
  client.setResourceLedger(remoteLedger)
  const budget = client.indexBudget
  const grant = budget.adopt(remoteLedger.reserve('terrain-index-worker', 6))
  const receipt = indexBytes => ({type:'native-ownership', memoryBytes:0, nativeRevision:0,
    nativeBytes:0, recordBytes:0, heightBytes:0, imageryBytes:0, imageryInputBytes:0,
    imageryOutputBytes:0, imageryReferenceBytes:0, imageryReferenceRevision:0, indexBytes})
  try {
    client.receive(receipt(6)); budget.finish(grant)
    assert.strictEqual(remoteLedger.bytes, 6)
    assert.strictEqual(remoteLedger.reserve('competitor', 1), null)
    const stopped = client.destroy()
    budget.finish(grant)
    assert.strictEqual(remoteLedger.bytes, 6, 'Destroy intent refunded live Worker indices')
    finishTermination(); await stopped
    assert.strictEqual(remoteLedger.bytes, 0)
    assert.strictEqual(client.workerIndexBytes, 0)
  } finally { if(finishTermination)finishTermination(); await client.destroy() }

  for (const indexBytes of [undefined, -1, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    let terminated = false
    const invalid = new TerrainWorkerClient({postMessage() {}, terminate() {terminated = true}})
    invalid.receive(receipt(indexBytes))
    assert(terminated && invalid.destroyed, 'Invalid Worker index ownership was accepted')
    await invalid.destroy()
  }
  console.log('Terrain CPU indices: prepaid copies, Direct reuse, empty cuts, mesh loans and Worker termination receipts passed')
}

if(require.main === module)module.exports().catch(error => {console.error(error); process.exitCode = 1})
