const assert = require('assert')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ownMesh} = require('../../sdk/js/resources/mesh_ownership')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')
const {install} = require('./reference/measurement_host_fixture')
const {WORKER_PROTOCOL} = require('../../adapters/wasm/worker_protocol')
const fixture = require('./reference/native_mesh_fixture')

module.exports = async function () {
  for (const cancel of [false, true]) {
    const f = require('./reference/grid_surface_fixture')(32)
    const memory = new WebAssembly.Memory({initial: 1}), frames = new MeshFrames(new ResourceLedger(1024 * 1024))
    new Float32Array(memory.buffer, 0, f.positions.length).set(f.positions)
    new Float32Array(memory.buffer, f.positions.byteLength, f.uv.length).set(f.uv)
    const draw = fixture.meshDraw({resourceId: 1, vertexCount: f.positions.length / 3,
      positionFloatCount: f.positions.length, textureFloatCount: f.uv.length,
      origin: [0,0,0], flags: 0, firstIndex: 0, indexCount: f.indices.length})
    const bytes = f.positions.byteLength + f.uv.byteLength
    let production = 0, loans = 0, queried = 0, progress = 0, indexReads = 0, intervention
    const abi = {...fixture, incrementalLayout: true, setViewport() {}, setCamera() {}, setGlobeTarget() {},
      prepareMeshFrame() { return {nativePlan: {id: 1, additionalBytes: bytes, residentBytes: 0,
        reclaimableBytes: 0, maximumBytes: 1024 * 1024}, draws: [draw], updateState: {modelRevision: 1},
      frame: {sequence: 1, coverageComplete: true, projectionView: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], cameraPosition: [0,0,1]}} },
      materializeMeshFrame(packet) {++production; packet.nativePlan = null},
      getIndices: () => {++indexReads; return f.indices}, getRequests: () => [], memoryBytes: () => memory.buffer.byteLength,
      borrowMeshResource() {
        ++loans
        return ownMesh({resourceId: 1, textureResourceId: draw.textureResourceId,
          get positions() {return new Float32Array(memory.buffer, 0, f.positions.length)},
          get textureUv() {return new Float32Array(memory.buffer, f.positions.byteLength, f.uv.length)}},
        {bytes: f.positions.byteLength, mark() {}, release() {--loans}})
      },
      sampleTerrain() {
        assert.strictEqual(frames.candidate, null, 'A query waited for complete preparation/transfer')
        assert.strictEqual(loans, 1)
        memory.grow(1); ++queried
        return {available: false}
      },
      discardMeshPlan() {}, destroy() {}
    }
    const worker = {postMessage: message => queueMicrotask(() => scope.onmessage({data: message})), terminate() {}}
    const client = new TerrainWorkerClient(worker, {workerTimeoutMs: 2500})
    const scope = {postMessage(message) {
      queueMicrotask(() => worker.onmessage({data: message}))
      if (message.progress && message.value.pending) {
        assert.strictEqual(frames.candidate, null)
        assert(client.nativeBudget.credit, 'Preparation progress released production credit')
        if (++progress === 1) intervention = cancel
          ? client.send({type: 'discard-plan', planId: 1})
          : client.send({type: 'call', method: 'sampleTerrain', args: [0,0]})
      }
    }}
    install(scope, {abi})
    client.setViewport(100,100,1); client.setCamera({longitudeDegrees: 0, latitudeDegrees: 0})
    try {
      await client.send({type: 'initialize', protocol: WORKER_PROTOCOL})
      const pending = client.step(1, {}, frames)
      if (cancel) await assert.rejects(pending, /Stale mesh transfer/)
      else {
        const result = await pending, resource = result.resources.get(1)
        assert.strictEqual(queried, 1, 'Background work was starved by surface preparation')
        assert.deepStrictEqual(resource.positions, f.positions)
        assert.deepStrictEqual(resource.textureUv, f.uv)
        assert(resource.model.blocks.length && resource.model.hull.length)
      }
      assert(intervention && progress > 0)
      await intervention
      assert.strictEqual(production, 1, 'A metadata continuation restarted native production')
      assert.strictEqual(indexReads, 1, 'Preparation and publication duplicated the shared CPU indices')
      assert.strictEqual(client.nativeBudget.credit, null)
      if (cancel) assert.strictEqual(loans, 0, 'Cancelled preparation retained native mesh loans')
      await client.send({type: 'destroy'})
    } finally {client.destroy(); frames.clear()}
    assert.strictEqual(loans, 0)
    assert.strictEqual(frames.ledger.bytes, 0)
  }
  console.log('Surface preparation schedules queries, retains credit, survives memory growth and cancels native loans')
}

if (require.main === module) module.exports().catch(error => {console.error(error);process.exitCode = 1})
