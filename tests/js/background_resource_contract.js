const assert = require('assert')
const {FrameCoordinator} = require('../../sdk/js/runtime/frame_coordinator')

// Hold the host display callback, independently deliver work turns and GPU
// receipts, and inspect the real renderer's uploads, pins and submitted camera.
module.exports = async ({Renderer, AsyncGl, FakeCanvas, publishFrame, frame, draw, settle}) => {
  const gl = new AsyncGl(), frames = new Map(), tasks = new Map(), plans = [], outputs = [], receipts = []
  let now = 0, serial = 0, renderer
  const clock = new FrameCoordinator({
    now: () => now,
    requestFrame(callback) { const id = ++serial; frames.set(id, callback); return id },
    cancelFrame(id) { frames.delete(id) },
    setTask(callback, delay) { const id = ++serial; tasks.set(id, {callback, due: now + delay}); return id },
    clearTask(id) { tasks.delete(id) },
    render: () => Boolean(renderer.render(false))
  })
  const task = queue => {
    const value = {cancel() { this.finish(null) }}
    value.promise = new Promise(resolve => { value.finish = resolve })
    queue.push(value); return value
  }
  const work = async () => {
    if (!tasks.size) { await settle(); return }
    now = Math.max(now, Math.min(...[...tasks.values()].map(t => t.due)))
    const ready = [...tasks].filter(([, t]) => t.due <= now)
    for (const [id, t] of ready) { if (tasks.delete(id)) t.callback() }
    await settle()
  }
  const display = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(f => f()) }
  const drawCount = () => gl.calls.filter(c => c.name === 'drawElements').length
  renderer = new Renderer(new FakeCanvas(gl), {
    mode: 'height', urlForTile: () => 'unused',
    requestRender: () => clock.invalidate(),
    requestResources: delay => clock.enqueueWork('gpu', () => renderer.advanceResources(), delay),
    cancelResources: () => clock.cancelWork('gpu'),
    createPartitionPlanTask: () => task(plans), createPartitionTask: () => task(outputs),
    onPresented: sequence => receipts.push(sequence)
  })
  const publish = sequence => publishFrame(renderer, Object.assign(frame(), {sequence}), [draw(0)],
    new Float32Array([0,0,0, 1,0,0, 0,1,0]), new Float32Array([0,0, 1,0, 0,1]), new Uint16Array([0,2,1]))
  try {
    publish(1)
    await work()
    assert(renderer.pendingSubmission, 'Uploads still depend on display delivery')
    assert.strictEqual(renderer.geometry.entries.size, 0, 'An upload was published before its receipt')
    for (let i = 0; i < 5; ++i) { gl.complete(); await work() }
    assert.strictEqual(drawCount(), 0, 'Background progress submitted a display')
    assert.strictEqual(renderer.geometry.values().length, 1)
    assert.strictEqual(renderer.displaySurface, null, 'Preparation claimed display ownership')
    assert.deepStrictEqual(receipts, [])
    display()
    const submitted = renderer.pendingSubmission, before = drawCount(), old = renderer.displaySurface
    assert(submitted && submitted.drawn && before > 0)
    assert.deepStrictEqual(receipts, [1])
    const geometry = renderer.geometry.values()[0], uploadsBefore = gl.calls.filter(c => c.name === 'bufferData').length
    const cells = Array.from({length: 8}, (_, i) => ({key: 'clock-' + i, sourceUv: true,
      bounds: {minimumU: 0, maximumU: 0.5, minimumV: 0, maximumV: 0.5}}))
    cells.forEach(cell => renderer.partitionPublication.handoff.add(geometry.key + ':' + cell.key))
    renderer.requestPartitionSet(geometry, cells)
    for (let i = 0; i < 4; ++i) await work()
    assert.strictEqual(plans.length, 1)
    plans[0].finish(cells.map(cell => ({key: cell.key, bytes: 6}))); await settle()
    assert.strictEqual(outputs.length, 0, 'Pricing completion bypassed the background clock')
    await work()
    assert.strictEqual(outputs.length, 1)
    outputs[0].finish(cells.map(cell => ({cell, indices: new Uint16Array([0,2,1]),
      positions: new Float32Array(0), uv: new Float32Array(0)}))); await settle()
    for (let i = 0; i < 4; ++i) await work()
    assert.strictEqual(gl.calls.filter(c => c.name === 'bufferData').length, uploadsBefore + 8)
    assert.strictEqual(gl.syncs.size, 2, 'Display/upload work exceeded the two-lane bound')
    assert.strictEqual(geometry.partitions.size, 0)
    assert.strictEqual(renderer.displaySurface, old)
    assert.strictEqual(drawCount(), before)
    submitted.sync.ready = true; await work()
    assert.strictEqual(geometry.partitions.size, 0, 'The earlier display receipt published later allocations')
    assert.strictEqual(gl.syncs.size, 1)
    gl.complete(); await work()
    assert.strictEqual(geometry.partitions.size, 8, 'Resource completion waited for a display callback')
    assert.strictEqual(drawCount(), before)
    assert.strictEqual(renderer.displaySurface, old)

    // Background readiness cannot replay queued camera revisions.
    for (let i = 1; i <= 10; ++i) {
      const camera = frame(); camera.projectionView[3] = i / 1000
      renderer.setCameraFrame(camera)
    }
    display()
    assert.strictEqual(drawCount(), before + 1)
    const matrix = gl.calls.filter(c => c.name === 'uniformMatrix4fv' && c.args[0].name === 'u_projection_view').pop().args[2]
    assert(Math.abs(matrix[12] - 10.01) < 1e-5)

    // Cancel callbacks, reject late delivery, then resume the same GPU receipt.
    const late = [...tasks.values()].map(t => t.callback), checks = gl.checks
    clock.setPaused(true); renderer.setPaused(true)
    assert.strictEqual(tasks.size, 0); late.forEach(f => f())
    assert.strictEqual(gl.checks, checks)
    renderer.setPaused(false); clock.setPaused(false)
    gl.complete(); for (let i = 0; i < 3; ++i) await work()
    assert.strictEqual(renderer.pendingSubmission, null)
    const stale = [...tasks.values()].map(t => t.callback)
    renderer.contextWasLost(); gl.syncs.clear()
    assert.strictEqual(tasks.size, 0); stale.forEach(f => f())
    renderer.requestResources()
    assert.strictEqual(tasks.size, 0, 'Context loss restarted the resource pump')
  } finally { renderer.destroy(); clock.destroy() }
  await settle()
  assert.strictEqual(tasks.size, 0); assert.strictEqual(frames.size, 0)
  assert.strictEqual(gl.syncs.size, 0); assert.strictEqual(renderer.resourceLedger.bytes, 0)
}
