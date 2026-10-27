const assert = require('assert')

// A completed GPU batch must not make the next camera wait for an unrelated
// host task. Keep that task withheld; the display may consume receipts only.
module.exports = async function ({Renderer, AsyncGl, FakeCanvas, publishFrame, frame, draw, settle}) {
  for (const kind of ['display', 'resource', 'mixed', 'timeout', 'allocation-error', 'wait-error']) {
    const gl = new AsyncGl(), errors = [], wakes = []
    const renderer = new Renderer(new FakeCanvas(gl), {
      mode: 'height', urlForTile: () => 'unused', directTextureTargets: true,
      maximumTextureEntries: 32, textureCacheBytes: 32 * 349524, uploadBudgetBytes: 350000,
      requestResources: delay => wakes.push(delay),
      onDiagnostic: (kind, detail) => errors.push({kind, detail})
    })
    try {
      publishFrame(renderer, frame(), [draw(0)], new Float32Array([0,0,0, 1,0,0, 0,1,0]),
        new Float32Array([0,0, 1,0, 0,1]), new Uint16Array([0,1,2]))
      renderer.render()
      for (let i = 0; i < 8; ++i) { gl.complete(); renderer.advanceResources(); renderer.render(false) }
      assert.strictEqual(renderer.pendingSubmission, null)
      assert(renderer.renderedSurface)

      if (kind === 'display' || kind === 'mixed') renderer.render(true)
      const tiles = [0,2].map(column => ({level: 2, matrix: 3, row: 0, column}))
      const key = t => [t.level, t.matrix, t.row, t.column].join('/')
      if (kind !== 'display') {
        const store = renderer.textures
        for (const column of [0,1]) store.cache.set(`0/1/0/${column}`,
          {image: {}, texture: {}, width: 256, height: 256}, 349524)
        store.buildRequirementTree(tiles.map(texture => ({texture}))); store.recomputeAvailability()
        for (const tile of tiles) store.cache.set(key(tile),
          {image: {}, texture: null, width: 256, height: 256}, 349524)
        store.advance(); renderer.advanceResources()
        assert(renderer.submissions.uploading)
      }
      assert.strictEqual(renderer.submissions.batches.length, kind === 'mixed' ? 2 : 1)
      const oldSurface = renderer.renderedSurface
      const draws = () => gl.calls.filter(c => c.name === 'drawElements').length
      const before = draws(), checks = gl.checks, allocated = gl.nextId
      const view = frame(); view.projectionView[3] = 0.5; renderer.setCameraFrame(view)

      // None of these producers is necessary to draw the retained surface.
      const methods = ['updateGpuResources', 'pumpPartitionRequests']
      const originals = methods.map(name => renderer[name])
      methods.forEach(name => { renderer[name] = () => { throw Error('Display started ' + name) } })
      const advance = renderer.textures.advance
      renderer.textures.advance = () => { throw Error('Display started texture scheduling') }
      try {
        assert.strictEqual(renderer.render(false), null)
        assert.strictEqual(draws(), before)
        assert.strictEqual(gl.checks, checks, 'An unfinished batch queried allocation errors')
        if (kind !== 'timeout') gl.complete()
        if (kind === 'allocation-error') gl.error = 0x0505
        if (kind === 'wait-error') gl.clientWaitSync = () => 0x911d
        const result = renderer.render(false)
        if (['timeout', 'allocation-error', 'wait-error'].includes(kind)) {
          assert.strictEqual(result, null)
          assert.strictEqual(draws(), before)
          assert.strictEqual(renderer.renderedSurface, oldSurface)
          if (kind !== 'timeout') assert.strictEqual(errors[0].kind, 'webgl_allocation_failed')
        } else {
          assert(result && result.submitted > 0, kind + ': completed receipt waited for a background task')
          assert.strictEqual(draws(), before + 1)
          assert.strictEqual(renderer.presentedCameraVersion, renderer.cameraVersion)
          const matrix = gl.calls.filter(c => c.name === 'uniformMatrix4fv' &&
            c.args[0].name === 'u_projection_view').pop().args[2]
          assert(Math.abs(matrix[12] - 10.5) < 1e-5, 'Display replayed an old camera')
          assert.strictEqual(gl.checks - checks, kind === 'display' ? 0 : 1)
          assert.strictEqual(renderer.submissions.batches.length, 1)
          assert(renderer.pendingSubmission.drawn)
          if (kind !== 'display') assert.strictEqual(tiles.filter(t => renderer.textures.gpuReady(key(t))).length, 1,
            'Display started another image upload')
          assert.deepStrictEqual(errors, [])
        }
        assert.strictEqual(gl.nextId, allocated, 'Display allocated GPU objects')
        assert(gl.syncs.size <= 2)
        assert(wakes.length > 0)
      } finally {
        methods.forEach((name, i) => { renderer[name] = originals[i] })
        renderer.textures.advance = advance
      }
    } finally { renderer.destroy() }
    await settle()
    assert.strictEqual(gl.syncs.size, 0)
    assert.strictEqual(renderer.resourceLedger.bytes, 0)
  }
  console.log('Display receipts: completed draw/upload, latest camera, zero-wait timeout, failure and teardown passed')
}
