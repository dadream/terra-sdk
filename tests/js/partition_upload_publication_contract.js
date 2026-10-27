const assert = require('assert')

module.exports = async function verifyPartitionPublication({Renderer, AsyncGl, FakeCanvas,
  frame, draw, publishFrame, stagePartitionJob, settle}) {
  const originalPerformance = global.performance
  let clock = 1000
  global.performance = {now: () => clock}
  try {
    for (const interrupt of [null, 'camera', 'destroy']) {
      const gl = new AsyncGl(), renderer = new Renderer(new FakeCanvas(gl), {
        mode: 'height', urlForTile: () => 'unused', uploadBudgetObjects: 3
      })
      const pump=()=>{
        if(renderer.cameraVersion!==renderer.presentedCameraVersion)renderer.render(false)
        renderer.advanceResources();const value=renderer.render(false);renderer.advanceResources();return value
      }
      try {
        publishFrame(renderer, frame(), [draw(0)],
          new Float32Array([0,0,0, 1,0,0, 0,1,0]),
          new Float32Array([0,0, 1,0, 0,1]), new Uint16Array([0,1,2]))
        for (let i = 0; i < 8; ++i) { clock += 40; gl.complete(); pump() }
        assert.strictEqual(renderer.pendingSubmission, null)
        const geometry = renderer.geometry.values()[0]
        const cells = [0,1,2,3].map(i => ({key: 'region-' + i,
          bounds: {minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1}}))
        stagePartitionJob(renderer, geometry, cells, cells.map(cell => ({cell,
          positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]),
          uv: new Float32Array([0,0, 1,0, 0,1]), indices: new Uint16Array([0,1,2])})))
        renderer.requestResources()
        const draws = () => gl.calls.filter(call => call.name === 'drawElements').length
        let expected = draws()
        pump()
        for (let i = 0; i < cells.length; ++i) {
          const uploads = renderer.submissions.batches.filter(batch => !batch.drawn)
          assert.strictEqual(uploads.length, 1)
          assert.strictEqual(uploads[0].items.length, 1)
          assert.strictEqual(renderer.pendingSubmission.drawn, interrupt === 'camera' && i === 2)
          // Exceed the resource coalescing deadline: the task itself, rather
          // than a lucky clock interval, must prevent intermediate redraws.
          clock += 40
          gl.complete()
          if (interrupt === 'camera' && i === 1) {
            const camera = frame(); camera.projectionView[3] = 0.25
            renderer.setCameraFrame(camera)
            ++expected
          }
          pump()
          assert(geometry.partitions.has(cells[i].key))
          assert.strictEqual(draws(), expected,
            'An incomplete partition task inserted unchanged terrain before its remaining uploads')
          assert.strictEqual(gl.syncs.size, Number(i < cells.length - 1) + Number(interrupt === 'camera' && i === 1),
            'Partition uploads exceeded one resource batch plus the requested camera draw')
          if (interrupt === 'destroy') break
          // The requested camera draw has its own earlier completion receipt.
          if (renderer.pendingSubmission && renderer.pendingSubmission.drawn && i < cells.length - 1)
            assert.strictEqual(interrupt, 'camera')
        }
        if (interrupt !== 'destroy') {
          gl.complete(); pump()
          assert.strictEqual(renderer.partitionCpuBytes + renderer.partitionReservedBytes, 0)
          assert.strictEqual(renderer.pendingSubmission, null)
        }
      } finally { renderer.destroy() }
      await settle()
      assert.strictEqual(gl.syncs.size, 0)
      assert.strictEqual(renderer.resourceLedger.stats().bytes, 0)
    }
  } finally { global.performance = originalPerformance }
}
