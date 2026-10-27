const assert = require('assert')
const { MessageChannel } = require('worker_threads')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const { TerrainWorkerClient } = require('../../adapters/wasm/terra_worker_client')

async function main() {
  await require('./mesh_index_ownership_contract')()
  await require('./worker_memory_receipt_contract')()
  require('./imagery_input_batch_test')()
  await require('./imagery_input_credit_test')()
  await require('./measurement_delivery_test')()
  const ledger = new (require('../../sdk/js/resources/resource_ledger').ResourceLedger)(100)
  const observer = new TerrainWorkerClient({postMessage() {}, terminate() {}})
  observer.nativeBytes = 100
  observer.setResourceLedger(ledger)
  observer.receive({type: 'native-ownership', recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 1, nativeBytes: 80})
  assert.strictEqual(ledger.bytes, 80, 'Idle cancellation failed to return Native credit')
  observer.receive({id: 999, recordBytes: 0, heightBytes: 0, imageryBytes: 1234, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 2, nativeBytes: 60, value: {superseded: true}})
  assert.strictEqual(ledger.bytes, 60, 'A completed cancelled RPC lost its ownership report')
  assert.strictEqual(observer.imageryPayloadBytes(), 1234, 'Late ownership lost imagery residency')
  observer.destroy()
  assert.strictEqual(ledger.bytes, 0)
  assert.strictEqual(observer.imageryPayloadBytes(), 0, 'Terminated Worker retained imagery residency')
  let finishTermination
  const retiring = new TerrainWorkerClient({postMessage() {},
    terminate: () => new Promise(resolve => { finishTermination = resolve })})
  retiring.nativeImageryBytes = 1234
  const termination = retiring.destroy()
  assert.strictEqual(retiring.imageryPayloadBytes(), 1234, 'Destroy intent refunded live native imagery')
  finishTermination(); await termination
  assert.strictEqual(retiring.imageryPayloadBytes(), 0)
  for (const bytes of [-1, NaN, undefined]) {
    let terminated = false
    const invalid = new TerrainWorkerClient({postMessage() {}, terminate() { terminated = true }})
    invalid.receive({memoryBytes:0,nativeRevision:0, nativeBytes:0, recordBytes:0, heightBytes:0, imageryBytes:bytes, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes:0})
    assert(terminated && invalid.destroyed, 'Invalid imagery ownership was accepted')
  }
  const views = []
  const atomic = new TerrainWorkerClient({postMessage: value => views.push(value), terminate() {}})
  atomic.setGlobeTarget(0, 0)
  atomic.setCamera({longitudeDegrees: 120, latitudeDegrees: 40, yawRadians: 1, distance: 6500000})
  assert.strictEqual(views.length, 2)
  assert.deepStrictEqual(views[1].camera, {longitudeDegrees: 120, latitudeDegrees: 40, yawRadians: 1, distance: 6500000},
    'A complete camera publication mixed old target coordinates with a new orientation')
  atomic.setGlobeTarget(120, 40)
  assert.strictEqual(views.length, 2, 'An unchanged target created a redundant view revision')
  atomic.destroy()
  const failedMessages = []
  const receiver = new TerrainWorkerClient({terminate() {}, postMessage(message) {
    failedMessages.push(message)
    Promise.resolve().then(() => receiver.receive({recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 0, nativeBytes: 0, id: message.id, value: message.type === 'step'
      ? {sequence: 7, draws: [], missing: [], nativePlan: {id: 9, residentBytes: 0,
        additionalBytes: 0, reclaimableBytes: 0, maximumBytes: 67108864}} : message.type === 'materialize'
      ? {frame: {sequence: 7}, draws: [], additions: [{resourceId: 1}], indices: new Uint16Array(3)}
      : message.type === 'commit-mesh' ? {updateState: {}} : true}))
  }})
  try {
    await assert.rejects(receiver.step(1, {}, new MeshFrames()))
    assert.deepStrictEqual(failedMessages.map(m => m.type), ['step', 'materialize', 'discard-plan', 'discard'],
      'Failed consumer preparation committed the native candidate')
    assert.strictEqual(failedMessages[2].planId, 9)
    assert.strictEqual(failedMessages[3].sequence, 7, 'Failed preparation left the producer candidate held')
    assert.strictEqual(receiver.pending.size, 0)
  } finally { receiver.destroy() }
  // After complete destinations are refused, boundary scratch is admitted
  // before any mesh copies and lives until its operation ends or the Worker dies.
  for (const outcome of ['capacity', 'copy-capacity', 'error', 'destroy', 'success']) {
    const frames = new MeshFrames(), events = []
    frames.presented = {frame: {coverageComplete: true}, draws: [], resources: new Map()}
    if (outcome !== 'success') frames.reserveOutputs = () => null
    frames.ledger.setLimit(outcome === 'capacity' ? 127 : 128)
    let workerClient, terminated = false
    const worker = {terminate() {terminated = true}, postMessage(message) {
      events.push(message.type)
      if (message.type === 'replacement') {
        assert.strictEqual(frames.ledger.stats().owners['terrain-boundary-work'].reserved, 128)
        assert.strictEqual(frames.ledger.bytes, 128)
        if (outcome === 'destroy') { workerClient.destroy(); return }
      }
      if (message.type === 'materialize') assert.strictEqual(frames.ledger.bytes, 0,
        'Mesh generation overlapped boundary scratch credit')
      Promise.resolve().then(() => workerClient.receive(message.type === 'replacement' && outcome === 'error'
        ? {recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 0, nativeBytes: 0, id: message.id, error: 'boundary failed'}
        : {recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 0, nativeBytes: 0, id: message.id, value: message.type === 'step'
          ? {sequence: 1, frame: {coverageComplete: true}, replacementPlan: {atomic: true, groups: []},
            draws: outcome === 'copy-capacity' ? [{resourceId: 1, textureResourceId: 4294967297, vertexCount: 9, firstIndex: 0, indexCount: 3}] : [],
            missing: outcome === 'copy-capacity' ? [1] : [], boundaryBytes: 128, requests: [],
            nativePlan: {id: 1, residentBytes: 0, additionalBytes: 0, reclaimableBytes: 0, maximumBytes: 100}}
          : message.type === 'replacement' ? {groups: []}
          : message.type === 'materialize' ? {frame: {sequence: 1}, draws: [],
            additions: [], textureAdditions: [], indices: new Uint16Array(0)}
          : message.type === 'commit-mesh' ? {updateState: {}} : true}))
    }}
    workerClient = new TerrainWorkerClient(worker)
    try {
      if (outcome === 'success') await workerClient.step(1, {}, frames)
      else await assert.rejects(workerClient.step(1, {}, frames), outcome.includes('capacity')
        ? error => error.status === 9 && Array.isArray(error.requests) &&
          error.capacityRevision === frames.ledger.availabilityRevision : undefined)
      assert.strictEqual(frames.ledger.bytes, 0, 'Finished boundary work leaked credit')
      assert.strictEqual(events.includes('materialize'), outcome === 'success')
      assert.strictEqual(events.includes('commit-mesh'), outcome === 'success')
      assert.strictEqual(events.includes('replacement'), outcome !== 'capacity' && outcome !== 'success')
      if (outcome === 'destroy') assert(terminated)
    } finally {workerClient.destroy(); frames.clear()}
  }
  const sent = []
  const partitionClient = new TerrainWorkerClient({postMessage: message => sent.push(message), terminate() {}})
  assert.throws(() => partitionClient.createPartitionTask(1, []), /credit is required/)
  const partition = partitionClient.createPartitionTask(1, [], 1024)
  assert.strictEqual(sent[0].maximumBytes, 1024)
  const partitionId = sent[0].id
  partitionClient.receive({recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 0, nativeBytes: 0, id: partitionId, progress: true, value: {pending: true}})
  assert(partitionClient.pending.has(partitionId), 'A continuation closed the partition request')
  partition.cancel()
  assert.deepStrictEqual(sent[1], {type: 'cancel-partition', id: partitionId})
  partitionClient.receive({recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 0, nativeBytes: 0, id: partitionId, value: []})
  assert.strictEqual(await partition.promise, null, 'A late completion overrode explicit cancellation')
  assert.strictEqual(partitionClient.pending.size, 0)
  const sample = partitionClient.sampleTerrain(116.4, 39.9)
  const message = sent[sent.length - 1]
  assert.deepStrictEqual(message.args, [116.4, 39.9])
  const rejectedQuery = assert.rejects(sample, /destroyed/)
  partitionClient.destroy()
  await rejectedQuery
  for (const failure of ['timeout', 'error', 'post']) {
    let terminated = 0, failures = 0
    const worker = { postMessage() { if (failure === 'post') throw new Error('post failed') },
      terminate() { ++terminated } }
    const client = new TerrainWorkerClient(worker, {workerTimeoutMs: 15, onFatal() { ++failures }})
    const first = client.send({type: 'step'})
    const second = client.send({type: 'imagery'})
    const rejected = Promise.all([assert.rejects(first), assert.rejects(second)])
    if (failure === 'error') worker.onerror({message: 'Worker failed'})
    await rejected
    assert.strictEqual(client.destroyed, true)
    assert.strictEqual(client.pending.size, 0)
    assert.strictEqual(terminated, 1)
    assert.strictEqual(failures, 1, 'Fatal failure must notify recovery exactly once')
    worker.onmessage({data: {id: 1, value: {frame: {sequence: 1}}}})
    client.destroy()
    assert.strictEqual(terminated, 1, 'Late replies or destruction must not resurrect a failed owner')
  }
  let initialized
  const original = new Uint8Array([1, 2, 3]).buffer
  const client = await TerrainWorkerClient.create({wasmBytes: original.slice(0),
    workerFactory: () => {
      const worker = {terminate() {}, postMessage(message, transfer) {
        const {port1, port2} = new MessageChannel()
        port2.once('message', value => {
          initialized = value
          port1.close(); port2.close()
          worker.onmessage({data: {recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 0, nativeBytes: 0, id: message.id, value: {ready: true, protocol: message.protocol}}})
        })
        port1.postMessage(message, transfer)
      }}
      return worker
    }})
  assert.deepStrictEqual(Array.from(new Uint8Array(initialized.bytes)), [1, 2, 3])
  assert.deepStrictEqual(Array.from(new Uint8Array(client.wasmBytes)), [1, 2, 3],
    'Recovery must retain an owned Wasm copy after transfer')
  assert.strictEqual(original.byteLength, 3)
  client.destroy()
  let mismatchedTerminated = 0
  await assert.rejects(TerrainWorkerClient.create({wasmBytes: original.slice(0), workerFactory: () => {
    const worker = {terminate() { ++mismatchedTerminated }, postMessage(message) {
      Promise.resolve().then(() => worker.onmessage({data: {recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 0, nativeBytes: 0, id: message.id, value: {ready: true}}}))
    }}
    return worker
  }}), /protocol mismatch/)
  assert.strictEqual(mismatchedTerminated, 1, 'A Worker without output-credit enforcement remained active')
  console.log('Worker timeout, fatal notification, late reply, and recovery bytes contracts passed.')
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
