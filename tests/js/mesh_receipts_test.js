const nativeFixture = require('./reference/native_mesh_fixture')
const adoptPacket = require('./reference/mesh_packet')
const assert = require('assert')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {MeshReceipts} = require('../../sdk/js/terrain/mesh_receipts')
const {TerrainWorkerHost, install} = require('./reference/measurement_host_fixture')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {holdMeshes, ownMeshWork} = require('../../sdk/js/resources/mesh_ownership')

function packet(sequence, ids, added = ids) {
  return {frame: {sequence}, draws: ids.map(resourceId => ({resourceId, textureResourceId: 4294967296 + resourceId, vertexCount: 3, firstIndex: 0, indexCount: 3})),
    indices: new Uint16Array([0, 1, 2]), additions: added.map(resourceId => ({resourceId,
      positions: new Float32Array(9), textureUv: new Float32Array(6)}))}
}
function fixture() {
  const frames = new MeshFrames()
  adoptPacket(frames, packet(1, [1, 2, 3, 4])); frames.present(1)
  adoptPacket(frames, packet(2, [4, 5, 6], [5, 6]))
  return frames
}
const ids = map => Array.from(map.keys()).sort((a, b) => a - b)
const retained = values => values.map(resourceId => ({resourceId, textureResourceId: 4294967296 + resourceId, vertexCount: 3, firstIndex: 0, indexCount: 3}))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => {resolve = a; reject = b})
  return {promise, resolve, reject}
}

async function testAdmission() {
  const frames = new MeshFrames()
  adoptPacket(frames, packet(1, [1])); frames.present(1)
  const displayed = frames.presented, mesh = frames.resources.get(1), indices = frames.indices
  const copied = frames.copiedBytes
  const unchanged = () => {
    assert.strictEqual(frames.presented, displayed)
    assert.strictEqual(frames.candidate, null)
    assert.strictEqual(frames.resources.get(1), mesh)
    assert.deepStrictEqual(ids(frames.resources), [1])
    assert.strictEqual(frames.indices, indices)
    assert.strictEqual(frames.copiedBytes, copied)
  }
  const invalid = [packet(2, [1, 2]), packet(2, [2], [2, 2]),
    packet(2, [2], [2, 3]), packet(2, [2, 3], [2])]
  const malformed = packet(2, [2])
  malformed.additions[0].textureUv = new Float32Array(4)
  invalid.push(malformed)
  for (const value of invalid) { assert.throws(() => adoptPacket(frames, value)); unchanged() }
  const next = packet(2, [1, 2, 3], [2, 3])
  const abi = {
    ...nativeFixture,
    prepareMeshFrame(threshold, budget) {
      const frame = this.updateStep(threshold, budget)
      return {frame, updateState: this.getUpdateState(), draws: this.getMeshResources().map(nativeFixture.meshDraw),
        nativePlan: {id: 1, residentBytes: 0, additionalBytes: 0, reclaimableBytes: 0, maximumBytes: 67108864}}
    },
    materializeMeshFrame(packet) { packet.nativePlan = null },
    discardMeshPlan() {},
    replacementWorkBytes() { return 128 },
    createReplacementTask() { return {async run() { return {groups: []} }, cancel() {}} },
    updateStep: () => next.frame, getUpdateState: () => ({}),
    getMeshResources: () => next.draws,
    copyMeshResource(draw) {
      if (draw.resourceId === 3) throw new Error('mesh copy failed')
      return Object.assign({}, next.additions.find(value => value.resourceId === draw.resourceId))
    },
    getIndices() { throw new Error('Existing indices should be reused') }
  }
  await assert.rejects(frames.read(abi, 1, {}), /mesh copy failed/)
  unchanged()
  const wait = deferred(), boundaryEntered = deferred()
  const cancelledFrames = new MeshFrames()
  adoptPacket(cancelledFrames, packet(1, [1])); cancelledFrames.present(1)
  next.frame.coverageComplete = true
  // Boundary work now starts only after the complete destinations are denied.
  cancelledFrames.reserveOutputs = () => null
  const cancellable = Object.assign({}, abi, {nativeBudget: null, createReplacementTask() {
    return {run: () => {boundaryEntered.resolve(); return wait.promise}, cancel: () => wait.resolve(null)}
  }})
  const pending = cancelledFrames.read(cancellable, 1, {})
  const rejected = assert.rejects(pending, /cancelled/)
  await boundaryEntered.promise
  assert.strictEqual(cancelledFrames.ledger.stats().owners['terrain-boundary-work'].reserved, 128)
  cancelledFrames.clear()
  await rejected
  assert.strictEqual(cancelledFrames.ledger.bytes, 0, 'Clear leaked suspended native scratch')
  const productionFrames = new MeshFrames(), productionWait = deferred(), productionEntered = deferred()
  let productionCancelled = false
  const productionAbi = Object.assign({}, abi, {nativeBudget: null,
    prepareMeshFrame(...args) {const packet = abi.prepareMeshFrame(...args);packet.nativePlan.additionalBytes = 60;return packet},
    createMeshTask() {return {
      run() {productionAbi.nativeBudget.observe(12);productionEntered.resolve();return productionWait.promise},
      cancel() {productionCancelled = true}
    }}
  })
  const producing = productionFrames.read(productionAbi, 1, {})
  const productionRejected = assert.rejects(producing, /production was cancelled/)
  await productionEntered.promise
  productionFrames.clear()
  assert(productionCancelled && productionAbi.nativeBudget.credit.bytes === 60,
    'Clear refunded the producer before its cancellation receipt')
  productionWait.resolve(null)
  await productionRejected
  assert.strictEqual(productionFrames.ledger.bytes, 12,
    'Cancellation forgot retained native cache or leaked output reservations')
  productionAbi.nativeBudget.close()
  assert.strictEqual(productionFrames.ledger.bytes, 0)
  let copies = 0
  abi.copyMeshResource = draw => { ++copies; return Object.assign({}, next.additions.find(value => value.resourceId === draw.resourceId)) }
  next.draws.push({resourceId: 2, vertexCount: 3, firstIndex: 0, indexCount: 3})
  const accepted = await frames.read(abi, 1, {})
  assert.strictEqual(copies, 4, 'Repeated draws copied the same resource again')
  assert.strictEqual(accepted.resources.get(1), mesh)
  assert.strictEqual(accepted.indices, indices)
  assert.strictEqual(frames.copiedBytes, copied + 120)
  assert.deepStrictEqual(ids(frames.resources), [1, 2, 3])
  assert(frames.present(2))
}

async function main() {
  await testAdmission()
  const ledger = new ResourceLedger(66), bounded = new MeshFrames(ledger)
  const source = packet(1, [1,2]), initial = packet(1, [1])
  let copies = 0
  const producer = {...nativeFixture,
    prepareMeshFrame(threshold, budget) {
      const frame = this.updateStep(threshold, budget)
      return {frame, updateState: this.getUpdateState(), draws: this.getMeshResources().map(nativeFixture.meshDraw),
        nativePlan: {id: 1, residentBytes: 0, additionalBytes: 0, reclaimableBytes: 0, maximumBytes: 67108864}}
    },
    materializeMeshFrame(packet) { packet.nativePlan = null },
    discardMeshPlan() {},
    replacementWorkBytes() { return 128 },
    createReplacementTask() { return {async run() { return {groups: []} }, cancel() {}} },
    updateStep: () => source.frame, getUpdateState: () => ({}),
    getMeshResources: () => source.draws, getIndices: () => source.indices, getRequests: () => [],
    copyMeshResource(draw) { ++copies; return Object.assign({}, source.additions.find(r => r.resourceId === draw.resourceId)) }}
  await assert.rejects(bounded.read(producer, 1), error => error.status === 9)
  assert.strictEqual(copies, 0, 'Direct Wasm copied part of a refused publication')
  assert.strictEqual(ledger.bytes, 0)
  adoptPacket(bounded, initial); bounded.present(1)
  const release = holdMeshes(bounded.resources.values())
  const work = ownMeshWork((function* () {yield 1; throw new Error('work failed')})(), bounded.resources.values())
  bounded.clear()
  assert.strictEqual(ledger.stats().retiredBytes, 66)
  release(); release()
  assert.strictEqual(ledger.bytes, 66)
  work.next(); assert.throws(() => work.next(), /work failed/)
  assert.strictEqual(ledger.bytes, 0, 'Failed immutable work leaked retired input')
  const frames = fixture(), candidate = frames.candidate
  const snapshot = frames.presented
  for (const [sequence, resources] of [[1, [1]], [2, [1, 99]],
    [2, [0]], [2, [-1]], [2, [1.5]], [2, [0x100000000]]]) {
    assert.throws(() => frames.prepareRetention(sequence, retained(resources)))
    assert.deepStrictEqual(ids(frames.resources), [1, 2, 3, 4, 5, 6], 'Invalid retention mutated ownership')
  }
  const prepared = frames.prepareRetention(2, retained([2,3,4,5]))
  assert.strictEqual(frames.presented, snapshot, 'Preparation changed display ownership')
  frames.commitRetention(prepared)
  assert.deepStrictEqual(ids(frames.presented.resources), [2,3,4,5])
  assert.deepStrictEqual(frames.presented.draws.map(r => r.resourceId), [2,3,4,5])
  assert(!frames.resources.has(1) && frames.candidate === candidate)
  assert.strictEqual(frames.retiredBytes, 60)
  assert.strictEqual(frames.retiredCount, 1)
  assert.deepStrictEqual(ids(snapshot.resources), [1,2,3,4], 'Mixed presentation invalidated an active immutable job')
  assert.strictEqual(snapshot.draws.length, 4)
  assert.throws(() => frames.prepareRetention(2, retained([1])), /presentation owner/)
  assert(frames.presented.partial, 'Local receipt acknowledged the complete candidate')
  frames.discard(2)
  assert.deepStrictEqual(ids(frames.resources), [2,3,4,5], 'Discarding a candidate lost its already displayed mesh')
  assert.throws(() => frames.commitRetention(prepared), /Stale/)
  adoptPacket(frames, packet(3, [5,7], [7]))
  frames.commitRetention(frames.prepareRetention(3, retained([2,3,5,7])))
  assert.deepStrictEqual(ids(frames.resources), [2,3,5,7], 'A second mixed version lost its predecessor')
  assert(frames.present(3))
  assert.deepStrictEqual(ids(frames.resources), [5,7])

  const events = [], wait = deferred(), entered = deferred(), errors = []
  const queued = fixture()
  let owner = {async retainMeshes(sequence, values) {
    events.push(['retain', sequence, values])
    if (events.length === 1) {entered.resolve(); await wait.promise}
  }, async presentFrame(sequence) { events.push(['present', sequence]) }}
  const receipts = new MeshReceipts(queued, () => owner, error => errors.push(error))
  const first = receipts.retain(2, retained([2, 3, 4, 5]))
  await entered.promise
  const second = receipts.retain(2, retained([3, 4, 5]))
  receipts.retain(2, retained([4, 5, 6]))
  assert.strictEqual(first, second, 'An unbounded RPC queue grew behind retirement')
  const full = receipts.present(2)
  await Promise.resolve()
  assert.strictEqual(events.length, 1, 'Full receipt overtook an in-flight local receipt')
  assert(queued.resources.has(1), 'Host released its mesh before owner acknowledgement')
  wait.resolve()
  assert(await full)
  await first
  assert.deepStrictEqual(events, [['retain', 2, retained([2,3,4,5])], ['retain', 2, retained([4,5,6])], ['present', 2]])
  assert.deepStrictEqual(ids(queued.resources), [4, 5, 6])
  assert.strictEqual(queued.retiredBytes, 180)
  assert.strictEqual(errors.length, 0)

  const failed = fixture()
  owner = {async retainMeshes() {throw new Error('owner failed')}, async presentFrame() {}}
  const retry = new MeshReceipts(failed, () => owner, error => errors.push(error))
  assert.strictEqual(await retry.retain(2, retained([2, 3, 4, 5])), false)
  assert(failed.resources.has(1), 'Failed RPC released CPU ownership')
  assert.strictEqual(errors.length, 1)
  assert(await retry.present(2), 'Full receipt could not recover from local failure')
  assert.deepStrictEqual(ids(failed.resources), [4, 5, 6])

  const reset = fixture(), oldWait = deferred(), oldEntered = deferred()
  owner = {async retainMeshes() {oldEntered.resolve(); await oldWait.promise}, presentFrame() {}}
  const generations = new MeshReceipts(reset, () => owner, error => errors.push(error))
  const old = generations.retain(2, retained([2, 3, 4, 5]))
  await oldEntered.promise
  generations.clear(); reset.clear()
  // Reuse the numeric IDs/sequence in a new Worker; old completion must do nothing.
  Object.assign(reset, fixture())
  owner = {async retainMeshes() {}, async presentFrame() {}}
  oldWait.resolve()
  assert.strictEqual(await old, false)
  assert(reset.resources.has(1))
  assert(await generations.retain(2, retained([2, 3, 4, 5])))
  assert(!reset.resources.has(1))
  assert(await generations.present(2))

  let nativeRetired = 0
  const host = new TerrainWorkerHost()
  host.frames = fixture()
  host.abi = {retainMeshes(sequence, values) {nativeRetired += values.length}, presentFrame() {}}
  const active = Object.assign({}, host.frames.presented)
  await assert.rejects(host.handle({type: 'retain', sequence: 2, draws: retained([1,99])}))
  assert.strictEqual(nativeRetired, 0, 'Worker validated after mutating the native owner')
  await host.handle({type: 'retain', sequence: 2, draws: retained([2,3,4,5])})
  assert.strictEqual(nativeRetired, 4)
  assert(!host.frames.resources.has(1) && active.resources.has(1))
  await host.handle({type: 'present', sequence: 2})
  assert.deepStrictEqual(ids(host.frames.resources), [4, 5, 6])

  // Both receipts must outrank background work and retain their FIFO order.
  const order = [], gate = deferred(), inWork = deferred()
  const original = TerrainWorkerHost.prototype.handle
  TerrainWorkerHost.prototype.handle = async function (message) {
    if (message.type === 'busy') {inWork.resolve(); await gate.promise; await this.yieldWork()}
    order.push(message.type)
    return true
  }
  let client
  try {
    const scope = {postMessage: message => worker.onmessage({data: message})}
    const worker = {postMessage: message => scope.onmessage({data: message}), terminate() {}}
    install(scope)
    client = new TerrainWorkerClient(worker)
    const busy = client.send({type: 'busy'})
    await inWork.promise
    const background = client.send({type: 'background'})
    const local = client.retainMeshes(2, retained([2,3,4,5]))
    const complete = client.presentFrame(2)
    gate.resolve()
    await Promise.all([busy, background, local, complete])
    assert.deepStrictEqual(order, ['retain', 'present', 'busy', 'background'])
  } finally {
    if (client) client.destroy()
    TerrainWorkerHost.prototype.handle = original
  }
  console.log('Local mesh ownership, immutable jobs, receipt ordering, failure and reset contracts passed.')
}
const deadline = setTimeout(() => {
  console.error('Mesh receipt contract did not finish'); process.exit(1)
}, 10000)
main().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(() => clearTimeout(deadline))
