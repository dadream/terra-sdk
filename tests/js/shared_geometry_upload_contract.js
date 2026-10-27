const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {MeshCopyPlan} = require('../../sdk/js/resources/mesh_coordinates')
const {GlSubmission, UploadBudget} = require('../../adapters/webgl/gl_allocation')

module.exports = async function verifySharedUploads({Renderer, AsyncGl, FakeCanvas, frame, draw}) {
  for (const action of ['complete', 'cancel', 'lost', 'failed-position']) {
    const ledger = new ResourceLedger(1024 * 1024), frames = new MeshFrames(ledger), gl = new AsyncGl()
    const renderer = new Renderer(new FakeCanvas(gl), {resourceLedger: ledger,
      geometryCacheBytes: 96, mode: 'height', urlForTile: () => 'unused'})
    const draws = [1,2].map(id => Object.assign(draw(0), {resourceId: id, textureResourceId: 512}))
    const copies = new MeshCopyPlan(frames, draws), outputs = renderer.reserveMeshOutputs({draws}, copies.bytes)
    let batch
    try {
      assert(outputs)
      copies.allocate(outputs.credit)
      const packet = copies.read({getIndices: () => new Uint16Array([0,2,1]),
        copyMeshPositions: () => new Float32Array([0,0,0, 1,0,0, 0,1,0]),
        copyMeshUv: () => new Float32Array([0,0, 1,0, 0,1])
      }, {draws, frame: Object.assign(frame(), {sequence: 1})})
      renderer.setMeshFrame(packet.frame, draws, packet.resources, packet.indices, {modelRevision: 1},
        null, null, {outputs, selectionCurrent: true})
      outputs.release(); outputs.credit.release(); copies.release()
      frames.clear()
      const charged = ledger.bytes, owners = ledger.stats().owners
      assert.strictEqual(owners['mesh-host'].retired + owners['mesh-uv-host'].retired +
        owners['geometry-gpu'].reserved, 192, 'Native-frame retirement refunded host input or GPU credit')
      assert.strictEqual(renderer.uploadQueue.length, 3, 'Shared coordinates acquired duplicate GPU producers')
      const before = gl.calls.filter(c => c.name === 'bufferData').length
      batch = renderer.uploadBatch = new GlSubmission(gl, null, new UploadBudget(96, 3))
      const createBuffer = gl.createBuffer
      let allocations = 0
      if (action === 'failed-position') gl.createBuffer = function () {
        return ++allocations === 2 ? null : createBuffer.call(this)
      }
      try {
        if (action === 'failed-position') assert.throws(() => renderer.processUploads(Infinity), /allocation failed/)
        else renderer.processUploads(Infinity)
      } finally { renderer.uploadBatch = null; gl.createBuffer = createBuffer }
      assert.strictEqual(renderer.geometry.entries.size, 0, 'Staging published before the GPU receipt')
      assert.strictEqual(ledger.bytes, charged)
      if (action === 'lost') renderer.contextWasLost()
      if (action !== 'complete') {
        batch.cancel(action === 'lost'); batch = null
        if (action !== 'lost') {
          assert.strictEqual(renderer.uploadQueue.length, 3, 'Cancellation lost or duplicated an admitted producer')
          renderer.processUploads(Infinity)
        }
      } else {
        assert.strictEqual(gl.calls.filter(c => c.name === 'bufferData').length - before, 3)
        assert(batch.defer()); assert(!batch.poll())
        gl.complete(); assert(batch.poll()); batch.commit(); batch = null
      }
      if (action !== 'lost') {
        const a = renderer.geometry.get('mesh:1'), b = renderer.geometry.get('mesh:2')
        assert(a && b)
        assert.strictEqual(a.uvBuffer, b.uvBuffer)
        assert.strictEqual(renderer.geometry.bytes, 96)
        assert.strictEqual(renderer.geometry.stats().coordinateEntries, 1)
        renderer.geometry.delete('mesh:1')
        assert(!gl.calls.some(c => c.name === 'deleteBuffer' && c.args[0] === b.uvBuffer),
          'Deleting one terrain mesh destroyed its neighbour\'s UV buffer')
      }
    } finally {
      renderer.uploadBatch = null
      if (batch) batch.cancel()
      copies.release(); if (outputs) {outputs.release(); outputs.credit.release()}
      frames.clear(); renderer.destroy()
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.strictEqual(ledger.bytes, 0, action + ' leaked CPU or GPU ownership')
    assert.strictEqual(gl.syncs.size, 0)
  }
}
