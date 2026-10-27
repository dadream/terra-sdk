const nativeFixture = require('./reference/native_mesh_fixture')
const assert = require('assert')
const {MessageChannel} = require('worker_threads')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ResourceCache} = require('../../sdk/js/resources/resource_cache')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {holdMeshes, ownMesh} = require('../../sdk/js/resources/mesh_ownership')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')
const {install} = require('./reference/measurement_host_fixture')
const {WORKER_PROTOCOL} = require('../../adapters/wasm/worker_protocol')
const surfacePlan = require('../../sdk/js/terrain/terra_surface_plan')

async function main() {
  const indexBytes = 2 * 3 * 2 // One six-byte strip in the Worker and one on the host.
  const ledger = new ResourceLedger(124 + indexBytes), frames = new MeshFrames(ledger)
  const gpu = new ResourceCache({ledger, owner: 'geometry-gpu'})
  const channel = new MessageChannel()
  let productions = 0, commits = 0, failPayload = false
  let boundaries = 0, boundaryRuns = 0
  let copies = 0, sequence = 0, ids = [1], failCopy = 0, failTransfer = false
  const native = new Map()
  const abi = {
    incrementalLayout: true, setViewport() {}, setCamera() {}, setGlobeTarget() {},
    ...nativeFixture,
    prepareMeshFrame(threshold, budget) {
      const frame = this.updateStep(threshold, budget)
      return {frame, updateState: this.getUpdateState(), draws: this.getMeshResources().map(nativeFixture.meshDraw),
        nativePlan: {id: 1, residentBytes: native.size*60,
          additionalBytes: ids.filter(id => !native.has(id)).length*60,
          reclaimableBytes: 0, maximumBytes: 67108864}}
    },
    materializeMeshFrame(packet) {
      if (frames.reserveOutputs) assert(gpu.reservedBytes > 0, 'Native production lost its GPU destinations')
      ++productions; packet.nativePlan = null
      ids.forEach(id => { if (!native.has(id)) native.set(id, {holds:0}) })
      ++this.nativeRevision
    },
    commitMeshFrame(packet) {++commits;packet.nativePlan=null},
    discardMeshPlan() { for (const [id,r] of native) if (!r.holds) native.delete(id); ++this.nativeRevision },
    meshPayloadBytes() { return native.size*60 },
    borrowMeshResource(draw) {
      const value = native.get(draw.resourceId)
      if (!value.resource) value.resource = this.copyMeshResource(draw)
      ++value.holds
      return ownMesh(Object.assign({}, value.resource, {textureResourceId: draw.textureResourceId}), {bytes:36, mark() {}, release:() => {
        if (!--value.holds) native.delete(draw.resourceId)
        ++this.nativeRevision
      }})
    },
    replacementWorkBytes() { ++boundaries; return 4 },
    createReplacementTask() { ++boundaryRuns; return {async run() { return {groups: []} }, cancel() {}} },
    updateStep: () => ({sequence: ++sequence, projectionView: new Float64Array(16), cameraPosition: [0,0,2]}),
    getUpdateState: () => ({modelRevision: sequence}),
    getMeshResources: () => ids.map(resourceId => ({resourceId, vertexCount: 3,
      firstIndex: 0, indexCount: 3, flags: 0, origin: [0,0,0]})),
    copyMeshResource(draw) {
      ++copies
      if (draw.resourceId === failCopy) throw new Error('injected copy failure')
      return {resourceId: draw.resourceId, positions: new Float32Array([0,0,0,1,0,0,0,1,0]),
        textureUv: new Float32Array([0,0,1,0,0,1])}
    },
    getRequests: () => [{kind: 1, key: {level: 0}}],
    getIndices: () => new Uint16Array([0,1,2]), memoryBytes: () => 0, presentFrame() {}
  }
  const worker = {postMessage: (message, transfer) => channel.port1.postMessage(message, transfer),
    terminate() { channel.port1.close(); channel.port2.close() }}
  const scope = {postMessage(message, transfer) {
    if (failTransfer && message.value && message.value.additions) {
      failTransfer = false; throw new Error('injected post failure')
    }
    if (failPayload && message.value && message.value.additions) {
      failPayload=false;message.value.additions[0].positions=new Float32Array(0)
    }
    channel.port2.postMessage(message, transfer)
  }}
  channel.port1.on('message', message => worker.onmessage({data: message}))
  channel.port2.on('message', message => scope.onmessage({data: message}))
  install(scope, {abi})
  const client = new TerrainWorkerClient(worker)
  client.setViewport(100, 100, 1); client.setCamera({longitudeDegrees: 0, latitudeDegrees: 0})
  const read = () => client.step(1, {}, frames)
  const present = async () => {
    const seq = frames.candidate.frame.sequence
    await client.presentFrame(seq); frames.present(seq)
  }
  const makePartition = surfacePlan.createPartitionTask
  let releaseOld, releaseLast
  try {
    await client.send({type: 'initialize', protocol: WORKER_PROTOCOL})
    ledger.setLimit(120 + indexBytes - 1)
    await assert.rejects(read, error => error.status === 9)
    assert.strictEqual(productions, 0, 'Unfunded Worker strip started native mesh production')
    assert.strictEqual(copies, 0, 'Unfunded Worker strip created transfer arrays')
    assert.strictEqual(ledger.bytes, 0)
    ledger.setLimit(124 + indexBytes)
    await read(); await present()
    assert.strictEqual(copies, 1)
    assert.strictEqual(ledger.bytes, 120 + indexBytes, 'Native payload and host copy must both be charged')
    assert.strictEqual(ledger.stats().owners['mesh-native'].resident, 60)
    assert(!ledger.stats().owners['mesh-worker'], 'Borrowing charged a duplicate Worker payload')
    assert.strictEqual(ledger.stats().owners['mesh-host'].resident, 36)
    const first = frames.presented
    await read(); await present()
    assert.strictEqual(copies, 1, 'A reused immutable mesh was copied again')
    assert.strictEqual(boundaries, 0, 'An unchanged cut allocated a full native boundary task')
    assert.deepStrictEqual(frames.presented.replacementPlan, {groups: [{before: [1], after: [1]}]})
    releaseOld = holdMeshes(first.resources.values())
    const beforeProduction = productions
    ids = [2]
    await assert.rejects(read, error => error.status === 9 && error.requests.length === 1 &&
      error.capacitySelectedBytes === 60)
    assert.strictEqual(boundaries, 1, 'A changed cut bypassed native boundary proof')
    assert.strictEqual(copies, 1, 'Denied transfer allocated a Worker payload')
    assert.strictEqual(productions, beforeProduction, 'Denied transfer generated native arrays')
    assert.strictEqual(ledger.bytes, 120 + indexBytes)
    assert.strictEqual(frames.candidate, null)
    assert.strictEqual(frames.presented.resources.get(1), first.resources.get(1))
    ledger.setLimit(240 + indexBytes)
    await read(); await present()
    assert.strictEqual(boundaryRuns, 0, 'An admitted complete Worker transfer sampled boundaries')
    assert(frames.presented.replacementPlan.atomic)
    assert.strictEqual(ledger.bytes, 180 + indexBytes)
    assert.strictEqual(ledger.stats().owners['mesh-host'].retired, 36,
      'Retiring a frame forgot the renderer/query borrower')
    releaseOld(); releaseOld()
    assert.strictEqual(ledger.bytes, 120 + indexBytes)

    let entered
    const started = new Promise(resolve => {entered = resolve})
    surfacePlan.createPartitionTask = () => ({step() {entered(); return {done: false}}, cancel() {}})
    const partition = client.createPartitionTask(2, [], 1024)
    await started
    ids = [3]
    await read(); await present()
    assert.strictEqual(ledger.bytes, 180 + indexBytes)
    assert.strictEqual(ledger.stats().owners['mesh-native'].resident, 120,
      'An active partition lost its retired native input loan')
    partition.cancel(); await partition.promise
    assert.strictEqual(ledger.bytes, 120 + indexBytes)
    surfacePlan.createPartitionTask = makePartition

    frames.reserveOutputs = (packet, bytes) => gpu.reserveBatch(new Map(packet.draws.map(draw =>
      [draw.resourceId, draw.vertexCount * 20])), bytes, 'mesh-transfer')
    ledger.setLimit(480 + indexBytes)
    ids = [4,5]; failCopy = 5
    await assert.rejects(read, /injected copy failure/)
    assert.strictEqual(ledger.bytes, 120 + indexBytes, 'Partial construction leaked input or transfer credit')
    assert.strictEqual(gpu.reservedBytes, 0, 'Failed copy leaked future GPU destinations')
    assert.strictEqual(frames.candidate, null)
    assert(frames.presented.resources.has(3))
    failCopy = 0; ids = [6]; failTransfer = true
    await assert.rejects(read, /injected post failure/)
    assert.strictEqual(ledger.bytes, 120 + indexBytes, 'Failed transfer leaked remote credit')
    assert.strictEqual(gpu.reservedBytes, 0, 'Failed transfer leaked future GPU destinations')
    const committedBeforeInvalid = commits
    failPayload=true
    await assert.rejects(read,/Mesh transfer differs/)
    assert.strictEqual(commits,committedBeforeInvalid,'Malformed consumer arrays were committed in the Worker')
    assert.strictEqual(ledger.bytes,120 + indexBytes,'Malformed consumer arrays leaked their private credit')
    frames.reserveOutputs = null
    ledger.setLimit(360 + indexBytes)
    await read(); await present()
    assert.strictEqual(ledger.bytes, 120 + indexBytes)
    releaseLast = holdMeshes(frames.presented.resources.values())
    client.destroy(); frames.clear(); gpu.clear()
    assert.strictEqual(ledger.bytes, 60 + indexBytes / 2, 'Worker termination released a host display borrower')
    releaseLast()
    assert.strictEqual(ledger.bytes, 0)
    assert.strictEqual(client.nativeBudget.resident, null)
  } finally {
    surfacePlan.createPartitionTask = makePartition
    if (releaseOld) releaseOld()
    if (releaseLast) releaseLast()
    client.destroy(); frames.clear()
  }
  const directLedger = new ResourceLedger(59), direct = new MeshFrames(directLedger)
  const directAbi = Object.assign({}, abi, {nativeBudget: null})
  direct.prepareOutputs = () => {
    const held = directLedger.reserve('handoff', 8)
    return {admit: async () => null, release: () => held.release()}
  }
  let refused
  try { await direct.read(directAbi, 1, {}) } catch (error) { refused = error }
  assert(refused && refused.status === 9)
  assert.strictEqual(refused.capacitySelectedBytes, 60, 'Refusal lost the failed target footprint')
  assert.strictEqual(refused.capacityRevision, directLedger.availabilityRevision,
    'Direct handoff cleanup woke its own unchanged-capacity refusal')
  assert.strictEqual(directLedger.bytes, 0)
  directAbi.nativeBudget.close(); direct.clear()
  console.log('Mesh credit before copy, transfer failure, retirement and cross-generation ownership passed')
}
main().catch(error => {console.error(error.stack); process.exitCode = 1})
