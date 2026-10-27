const assert = require('assert')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')
const {install} = require('./reference/measurement_host_fixture')
const {WORKER_PROTOCOL} = require('../../adapters/wasm/worker_protocol')
const fixture = require('./reference/native_mesh_fixture')

module.exports = async function () {
  for (const cancel of [false, true]) {
    const frames = new MeshFrames(new ResourceLedger(1024))
    let bytes = 0, produced = 0, cancelled = 0, progress = 0, queried = 0, intervention
    const draws = [1,2,3].map(resourceId => fixture.meshDraw({resourceId, vertexCount: 3,
      positionFloatCount: 9, textureFloatCount: 6, origin: [0,0,0], flags: 0, firstIndex: 0, indexCount: 3}))
    const abi = {...fixture, incrementalLayout: true, setViewport() {}, setCamera() {}, setGlobeTarget() {},
      prepareMeshFrame() {return {nativePlan: {id: 1, additionalBytes: 180, residentBytes: 0, reclaimableBytes: 0, maximumBytes: 1024},
        frame: {sequence: 1, coverageComplete: true, projectionView: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], cameraPosition: [0,0,1]},
        updateState: {modelRevision: 1}, draws}},
      createMeshTask(packet) {
        let complete = false
        return new CooperativeTask((function* () {
          try {
            for (let i = 0; i < 3; ++i) {bytes += 60; ++produced; yield}
            packet.nativePlan = null; complete = true
            return packet
          } finally {if (!complete) {++cancelled; bytes = 0; packet.nativePlan = null}}
        })(), 1)
      },
      sampleTerrain() {
        assert(produced > 0 && produced < 3, 'Background work waited for the whole candidate')
        assert.strictEqual(frames.candidate, null, 'Partial output reached the consumer')
        ++queried; return {available: false}
      },
      meshPayloadBytes: () => bytes,
      getIndices: () => new Uint16Array([0,1,2]), getRequests: () => [], memoryBytes: () => 0,
      copyMeshResource: draw => ({resourceId: draw.resourceId, positions: new Float32Array([0,0,0,1,0,0,0,1,0]),
        textureUv: new Float32Array([0,0,1,0,0,1])}),
      discardMeshPlan() {}, destroy() {bytes = 0}
    }
    const worker = {postMessage: message => queueMicrotask(() => scope.onmessage({data: message})), terminate() {}}
    const client = new TerrainWorkerClient(worker, {workerTimeoutMs: 2500})
    const scope = {postMessage(message) {
      queueMicrotask(() => worker.onmessage({data: message}))
      if (message.progress && message.value.pending) {
        assert.strictEqual(frames.candidate, null)
        assert(client.nativeBudget.credit && client.nativeBudget.credit.bytes === 180,
          'An intermediate reply released production credit')
        if (++progress === 1) intervention = cancel
          ? client.send({type: 'discard-plan', planId: 1})
          : client.send({type: 'call', method: 'sampleTerrain', args: [0,0]})
      }
    }}
    install(scope, {abi})
    client.setViewport(100, 100, 1); client.setCamera({longitudeDegrees: 0, latitudeDegrees: 0})
    try {
      await client.send({type: 'initialize', protocol: WORKER_PROTOCOL})
      const pending = client.step(1, {}, frames)
      if (cancel) await assert.rejects(pending, /Stale mesh transfer/)
      else {
        const result = await pending
        assert(result && frames.candidate && produced === 3 && queried === 1 && progress === 3)
      }
      assert(intervention, 'Production never yielded a progress reply')
      await intervention
      assert.strictEqual(cancelled, cancel ? 1 : 0)
      assert.strictEqual(client.nativeBudget.credit, null)
      if (cancel) assert.strictEqual(frames.ledger.bytes, 0, 'Cancelled producer leaked reservation/copies')
      await client.send({type: 'destroy'})
    } finally {client.destroy(); frames.clear()}
    assert.strictEqual(frames.ledger.bytes, 0)
  }
  console.log('Production progress preserves credit, schedules background work and waits for cancellation receipts')
}
if (require.main === module) module.exports().catch(error => {console.error(error);process.exitCode = 1})
