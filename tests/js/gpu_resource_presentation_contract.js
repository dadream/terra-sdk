const assert = require('assert')

module.exports = async function testResourcePresentation({Renderer, AsyncGl, FakeCanvas, publishFrame, frame, draw, settle}) {
  const performance = global.performance
  let clock = 1000
  global.performance = {now: () => clock}
  try {
    for (const interrupt of [null, 'camera', 'camera-mesh', 'fade', 'handoff', 'fade-deadline',
      'explicit', 'validation', 'deadline', 'loss', 'destroy']) {
      const gl = new AsyncGl(), renderer = new Renderer(new FakeCanvas(gl), {
        mode: 'height', urlForTile: () => 'unused', directTextureTargets: true,
        maximumTextureEntries: 32, textureCacheBytes: 32 * 349524, uploadBudgetBytes: 350000
      })
      const publish = (height = 0, view = frame()) => publishFrame(renderer, view, [draw(0)],
        new Float32Array([0,0,height, 1,0,height, 0,1,height]), new Float32Array([0,0, 1,0, 0,1]),
        new Uint16Array([0,1,2]))
      try {
        publish()
        renderer.render()
        for (let i = 0; i < 8; ++i) { gl.complete(); renderer.render(false) }
        assert.strictEqual(renderer.pendingSubmission, null)
        if (interrupt === 'handoff') {
          publish(1)
          assert(renderer.holdCandidate(renderer.current.frame.sequence), 'Fixture did not hold the next terrain cut')
          renderer.render()
          for (let i = 0; i < 8; ++i) { gl.complete(); renderer.render(false) }
          assert.strictEqual(renderer.pendingSubmission, null)
          assert.notStrictEqual(renderer.submittedSequence, renderer.current.frame.sequence,
            'Fixture must retain the old display during a pending handoff')
          assert.strictEqual(renderer.presentedCameraVersion, renderer.cameraVersion)
        }
        const store = renderer.textures
        const key = t => [t.level,t.matrix,t.row,t.column].join('/')
        const tiles = [0,2,4,6].map(column => ({level:2, matrix:3, row:0, column}))
        for (const column of [0,1]) store.cache.set(`0/1/0/${column}`,
          {image:{}, texture:{}, width:256, height:256}, 349524)
        store.buildRequirementTree(tiles.map(texture => ({texture})))
        store.recomputeAvailability()
        tiles.forEach(tile => store.cache.set(key(tile),
          {image:{}, texture:null, width:256, height:256}, 349524))
        store.advance()
        const drawCount = () => gl.calls.filter(call => call.name === 'drawElements').length
        const before = drawCount()
        renderer.render(false) // First bounded upload, no change to display yet.
        assert.strictEqual(drawCount(), before)
        assert.strictEqual(renderer.pendingSubmission.items.length, 1, 'First image upload: ' + interrupt)
        ++clock; gl.complete()
        if (interrupt === 'validation') gl.getError = () => { clock += 20; return AsyncGl.prototype.getError.call(gl) }
        if (interrupt === 'camera') {
          const camera = frame(); camera.projectionView[3] = 0.25
          renderer.setCameraFrame(camera)
        }
        // A model carrying a genuinely new view keeps input priority. Same-view
        // partial groups are covered by terrain_publication_cadence_contract.
        if (interrupt === 'camera-mesh') publish(0, Object.assign(frame(),{cameraPosition:[11,20,30]}))
        if (interrupt === 'fade' || interrupt === 'fade-deadline') renderer.presentation.active = 1
        renderer.render(interrupt === 'explicit')
        if (['camera','camera-mesh','explicit','validation'].includes(interrupt)) {
          assert.strictEqual(drawCount(), before + 1, interrupt + ' waited behind background image groups')
          if (interrupt === 'camera') {
            const matrix = gl.calls.filter(call => call.name === 'uniformMatrix4fv' &&
              call.args[0].name === 'u_projection_view').pop().args[2]
            assert(Math.abs(matrix[12] - 10.25) < 1e-5, 'Resource pumping replayed an old camera')
          }
        } else {
          assert.strictEqual(drawCount(), before, 'Each available group inserted terrain work ahead of cached images')
          assert.strictEqual(gl.syncs.size, 1, 'Coalescing exceeded the GPU submission limit')
          assert(tiles.some(tile => store.availableKeys.has(key(tile))), 'Upload completion failed to publish readiness')
          if (interrupt === 'loss') {
            renderer.contextWasLost(); gl.syncs.clear()
            assert.strictEqual(renderer.pendingSubmission, null)
          } else if (interrupt !== 'destroy') {
            if (interrupt === 'deadline' || interrupt === 'fade-deadline') clock += 20
            else ++clock
            gl.complete(); renderer.render(false)
            if (interrupt === 'deadline' || interrupt === 'fade-deadline') {
              assert.strictEqual(drawCount(), before + 1, 'Continuous uploads starved a stationary presentation')
              assert(tiles.some(tile => !store.gpuReady(key(tile))), 'Fixture exhausted uploads before testing fairness')
            } else {
              for (let i = 0; i < 6; ++i) { ++clock; gl.complete(); renderer.render(false) }
              assert(tiles.every(tile => store.availableKeys.has(key(tile))))
              assert.strictEqual(drawCount(), before + 1, 'A cached burst did not merge into one presentation')
              assert.strictEqual(gl.syncs.size, 0, 'Settled resources kept the GPU pump alive')
            }
          }
        }
      } finally { renderer.destroy() }
      await settle()
      assert.strictEqual(gl.syncs.size, 0)
      assert.strictEqual(renderer.resourceLedger.stats().bytes, 0, 'Pending coalesced resources leaked on teardown')
    }
  } finally { global.performance = performance }
}
