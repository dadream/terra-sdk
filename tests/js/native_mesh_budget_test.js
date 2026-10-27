const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {NativeMeshBudget} = require('../../sdk/js/resources/native_mesh_budget')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')

async function main() {
  const ledger = new ResourceLedger(100), native = new NativeMeshBudget(ledger, 40)
  const credit = ledger.reserve('mesh-native', 60)
  const revision = ledger.availabilityRevision
  native.begin(credit)
  native.observe(70)
  assert.strictEqual(ledger.bytes, 100, 'Progress refunded uncompleted production')
  assert.strictEqual(ledger.reserve('competitor', 1), null)
  native.finish()
  assert.strictEqual(ledger.bytes, 70, 'Partial failure lost its surviving native cache')
  assert.strictEqual(ledger.stats().owners['mesh-native'].resident, 70)
  assert(ledger.availabilityRevision > revision)
  assert.throws(() => native.observe(71), /exceeded its credit/)
  const unchanged = ledger.availabilityRevision
  native.observe(70)
  assert.strictEqual(ledger.availabilityRevision, unchanged)
  const foreign = new ResourceLedger().reserve('mesh-native', 1)
  assert.throws(() => native.begin(foreign), /not credited/)
  foreign.release()
  native.observe(30)
  native.begin(ledger.reserve('mesh-native', 60))
  // Lowering a cap cannot erase allocations or force another admission while
  // converting an already reserved allocation to resident ownership.
  ledger.setLimit(50)
  native.observe(65); native.finish()
  assert.strictEqual(ledger.bytes, 65)
  assert.strictEqual(ledger.stats().overBudgetBytes, 15)
  native.close(); native.close()
  assert.strictEqual(ledger.bytes, 0)

  // Direct Wasm must destroy an owner that reports uncredited allocation before
  // refunding its credit, just as the remote path terminates a corrupt Worker.
  const direct = Object.create(TerraAbi.prototype)
  direct.context = 1
  direct.nativeRevision = 0
  direct.imageryPlanners = new Set()
  direct.imageryScratchOwners = new Set()
  direct.nativeAllocations = new Map()
  direct.nativeBudget = new NativeMeshBudget(ledger)
  direct.nativeBudget.begin(ledger.reserve('mesh-native', 10))
  let destroyed = false
  direct.module = {call(name) {
    if (name === 'terra_mesh_payload_bytes') return 11
    if (name === 'terra_destroy') destroyed = true
    return 0
  }}
  assert.throws(() => direct.nativeCall('injected'), /exceeded its credit/)
  assert(destroyed && direct.context === 0 && ledger.bytes === 0)

  // Real client protocol ordering: a trim cannot fund production until its
  // reply arrives; failed materialization keeps the reported native residue.
  for (const result of ['success', 'partial-failure', 'over-credit', 'timeout']) {
    const frames = new MeshFrames(new ResourceLedger(100))
    let client, trimReply, materializeReply, produced = 0, committed = 0, terminated = false
    const worker = {terminate() {terminated = true}, postMessage(message) {
      const reply = (value, bytes, error) => client.receive({id: message.id, value, recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 0, nativeBytes: bytes, error})
      if (message.type === 'step') Promise.resolve().then(() => reply({sequence: 1, draws: [], missing: [], requests: [],
        nativePlan: {id: 4, residentBytes: 80, additionalBytes: 40, reclaimableBytes: 60, maximumBytes: 200}}, 80))
      else if (message.type === 'trim-native') trimReply = () => reply(60, 20)
      else if (message.type === 'materialize') {
        ++produced
        assert.strictEqual(message.maximumNativeBytes, 40)
        assert.strictEqual(frames.ledger.bytes, 60)
        assert.strictEqual(frames.ledger.stats().owners['mesh-native'].reserved, 40)
        materializeReply = () => reply({frame: {sequence: 1}, draws: [], additions: [], textureAdditions: [],
          indices: new Uint16Array(0)}, result === 'over-credit' ? 61 : result === 'partial-failure' ? 35 : 60,
        result === 'partial-failure' ? 'native generation failed' : undefined)
      } else if (message.type === 'commit-mesh') {
        ++committed
        assert.strictEqual(message.planId, 4)
        Promise.resolve().then(() => reply({updateState: {}}, 60))
      } else Promise.resolve().then(() => reply(true, result === 'partial-failure' ? 35 : 60))
    }}
    client = new TerrainWorkerClient(worker, {workerTimeoutMs: 1000})
    client.nativeBytes = 80
    client.setResourceLedger(frames.ledger)
    assert.throws(() => client.setResourceLedger(new ResourceLedger()), /occupied/)
    const operation = client.step(1, {}, frames)
    const checked = result === 'success' ? operation : assert.rejects(operation,
      result === 'partial-failure' ? /native generation failed/ : result === 'timeout' ? /timed out/ : /exceeded its credit/)
    for (let i = 0; i < 20 && !trimReply; ++i) await Promise.resolve()
    assert(trimReply)
    assert.strictEqual(frames.ledger.bytes, 80, 'Unacknowledged trim refunded memory')
    assert.strictEqual(produced, 0)
    trimReply()
    for (let i = 0; i < 20 && !materializeReply; ++i) await Promise.resolve()
    assert(materializeReply)
    if (result === 'timeout') {
      const pending = Array.from(client.pending.values()).find(p => p.type === 'materialize')
      pending.timeout()
    } else materializeReply()
    await checked
    assert.strictEqual(committed, result === 'success' ? 1 : 0,
      'Failed or unfinished production must not commit a candidate')
    if (result === 'success' || result === 'partial-failure') {
      assert.strictEqual(frames.ledger.bytes, result === 'success' ? 60 : 35)
      assert.strictEqual(frames.ledger.stats().reservedBytes, 0)
      assert(!terminated)
    } else assert(terminated && frames.ledger.bytes === 0,
      'Uncertain Worker allocation was refunded before terminating its owner')
    client.destroy(); frames.clear()
    assert.strictEqual(frames.ledger.bytes, 0)
  }
  console.log('Native production credit, delayed trim, partial failure, cap change and termination passed')
}
const deadline = setTimeout(() => {console.error('Native credit contract did not finish'); process.exit(1)}, 10000)
main().catch(error => {console.error(error); process.exitCode = 1}).finally(() => clearTimeout(deadline))
