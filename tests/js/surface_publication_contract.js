const assert = require('assert')

module.exports = async function ({Renderer, AsyncGl, FakeCanvas, frame, draw, publishFrame}) {
  const originalPerformance = global.performance
  let clock = 1000
  global.performance = {now: () => clock}
  const gl = new AsyncGl(), canvas = new FakeCanvas(gl)
  canvas.width = canvas.height = 64
  const renderer = new Renderer(canvas, {
    mode: 'height', urlForTile: () => 'unused', uploadBudgetObjects: 3})
  const count = () => gl.calls.filter(call => /^(drawElements|drawArrays)$/.test(call.name)).length
  const tick = () => {clock += 40; gl.complete(); renderer.advanceResources(); return renderer.render(false)}
  const idle = async () => {
    for (let i = 0; i < 30; ++i) {
      tick(); await new Promise(resolve => setTimeout(resolve, 0))
      if (!renderer.pendingSubmission && !renderer.renderRequested && !renderer.resourcesRequested) return
    }
    throw Error('Surface publication did not become idle')
  }
  try {
    publishFrame(renderer, frame(), [draw(0)],
      new Float32Array([0,0,0, 1,0,0, 0,1,0]),
      new Float32Array([0,0, 1,0, 0,1]), new Uint16Array([0,1,2]))
    await idle()
    let before = count()
    const submittedAt=renderer.performanceStats.lastFrameAt
    renderer.requestRender()
    assert.strictEqual(tick(), null, 'Preparation-only work reported a submitted frame to the display clock')
    assert.strictEqual(count(), before, 'Unchanged display inputs submitted the same GPU draw again')
    assert.strictEqual(renderer.pendingSubmission, null, 'Unchanged scene created a draw fence')
    assert.strictEqual(renderer.performanceStats.lastFrameAt,submittedAt,'Preparation-only work counted as a displayed frame')
    const lease = renderer.surfaceCommands.lease
    assert(lease && lease.bytes === renderer.surfaceCommands.values.byteLength)
    const plan = {draws: renderer.current.draws.slice(), levels: new Map(), quality: {
      planningComplete: true, cameraCurrent: true, targetPixelError: 1.25}}
    renderer.setImageryPlan(renderer.current.frame.sequence, plan, [])
    await idle()
    before = count()
    renderer.setImageryPlan(renderer.current.frame.sequence,
      Object.assign({},plan,{draws:plan.draws.slice(),quality:Object.assign({},plan.quality)}), [])
    await idle()
    assert.strictEqual(count(), before, 'Equivalent imagery plan repainted the unchanged surface')
    renderer.render()
    assert(count() > before, 'Explicit forced rendering was suppressed')
    await idle(); before = count()
    const camera = frame(); camera.projectionView[3] = 0.25
    renderer.setCameraFrame(camera); tick()
    assert(count() > before, 'Camera movement reused a stale draw')
    await idle(); before = count()
    renderer.setDebugOptions({textureState:true}); tick()
    assert(count() > before, 'Changed material parameters did not repaint')
    await idle(); before = count()
    renderer.resize(renderer.canvas.width,renderer.canvas.height); tick()
    assert(count() > before, 'Same-size drawing-buffer reset reused invalid contents')
    await idle(); before = count()
    // Comparison storage is optional. Pressure must reclaim it before keeping
    // this optimisation alive at the expense of real terrain/image work.
    renderer.surfaceCommands.lease.reclaim()
    assert(!renderer.surfaceCommands.values)
    renderer.requestRender(); tick()
    assert(count() > before, 'A reclaimed command snapshot suppressed repaint')
    await idle(); before = count()
    renderer.visibility = {needsDraw:()=>true, publicationGuard:()=>null, observe(){}, destroy(){}}
    renderer.requestRender(); tick()
    assert(count() > before, 'A pending visibility sweep lost its depth/query pass')
    await idle()
    renderer.visibility = null
    before = count()
    renderer.render()
    const poll=gl.clientWaitSync
    gl.clientWaitSync=()=>0x911d // WAIT_FAILED: no usable completion receipt.
    tick();gl.clientWaitSync=poll
    assert.strictEqual(renderer.surfaceCommands.values,null,'Failed GPU completion retained reusable draw evidence')
    renderer.requestRender(); tick()
    assert(count() > before + 1,'Failed submission suppressed its successor')
    await idle()
    renderer.contextWasLost({preventDefault(){}})
    assert(!renderer.surfaceCommands.values,'Lost context retained draw evidence')
    renderer.contextWasRestored();await idle()
    assert(renderer.surfaceCommands.values,'Restored context did not publish fresh evidence')
  } finally {
    renderer.destroy()
    await new Promise(resolve => setTimeout(resolve, 0))
    global.performance = originalPerformance
  }
  assert.strictEqual(renderer.resourceLedger.bytes,0)
  assert.strictEqual(gl.syncs.size,0)
}
