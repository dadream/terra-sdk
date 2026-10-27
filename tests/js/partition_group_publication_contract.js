const assert = require('assert')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile, textureCellTransform} = require('../../sdk/js/imagery/terra_texture_tiles')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = async function verifyGroups({Renderer, AsyncGl, FakeCanvas, frame, draw, sourceUv = false}) {
  const originalPerformance = global.performance
  let clock = 1000
  global.performance = {now: () => clock}
  const gl = new AsyncGl(), jobs = [], prices = []
  if (sourceUv) {gl.getShaderPrecisionFormat = () => ({precision:23});gl.texStorage2D = () => {}}
  const renderer = new Renderer(new FakeCanvas(gl), {mode: 'height', scheduledImagery: true,
    textureTransitionMs: 0, urlForTile: () => 'unused', uploadBudgetObjects: 3,
    createPartitionPlanTask(id, cells, geometry) {
      const work = surface.createPartitionPlanTask(geometry.model, cells)
      const task = {id, cancelled: false}
      const gate = prices.length ? Promise.resolve() : new Promise(resolve => { task.finish = resolve })
      task.cancel = () => {task.cancelled = true; work.cancel(); if (task.finish) task.finish()}
      task.promise = gate.then(() => work.run())
      prices.push(task)
      return task
    },
    createPartitionTask(id, cells, geometry, maximumBytes) {
      const work = surface.createPartitionTask(geometry.model, cells, maximumBytes)
      let finish
      const gate = new Promise(resolve => { finish = resolve })
      const task = {id, cells, finish, cancelled: false}
      jobs.push(task)
      return {promise: gate.then(() => work.run()), cancel() {task.cancelled = true; work.cancel(); finish()}}
    }})
  renderer.canvas.width=renderer.canvas.height=256
  const tick = async () => {
    clock += 40; gl.complete(); renderer.advanceResources(); renderer.render(false)
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  const until = async (predicate, message, finish = () => false) => {
    for (let i = 0; i < 80 && !predicate(); ++i) {
      jobs.filter(finish).forEach(job => job.finish())
      await tick()
    }
    assert(predicate(), message)
  }
  let displays = 0
  const render = renderer.renderSurface.bind(renderer)
  renderer.renderSurface = force => {
    const result=render(force)
    if(renderer.surfaceDrawn)++displays
    return result
  }
  try {
    const roots = [0,1,0].map(column => ({level: 0, matrix: 0, row: 0, column}))
    const draws = roots.map((texture, i) => Object.assign(draw(0), {
      resourceId: 101+i, textureResourceId: 4294967397+i, texture, origin: [0,0,0], vertexCount: 4, indexCount: 4}))
    const resources = new Map(draws.map(d => [d.resourceId, {resourceId: d.resourceId,
      positions: new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]),
      textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])}]))
    const seed = tile => renderer.textures.cache.has(key(tile)) || renderer.textures.cache.set(key(tile),
      {image: {}, texture: gl.createTexture(), width: 256, height: 256}, 349524)
    roots.forEach(seed)
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 1, coverageComplete: true}),
      draws, resources, new Uint16Array([0,1,2,3]), {modelRevision: 1})
    await until(() => renderer.displaySurface && !renderer.pendingSubmission && !renderer.renderRequested,
      'Initial geometry did not publish')
    const measured = draws.map(d => ({resourceId: d.resourceId, pixelsPerUv: 512, visible: true, centerDistance: 0}))
    const plan = planned => ({draws: planned, levels: new Set(), quality: {
      planningComplete: true, cameraCurrent: true, spatialCut: true, targetPixelError: 1.25}})
    renderer.setMode('texture')
    renderer.setImageryPlan(1, plan(renderer.current.draws), measured)
    await until(() => !renderer.pendingSubmission && !renderer.renderRequested, 'Coarse view did not settle')
    const fine = []
    renderer.current.draws.forEach(d => {
      for (let i = 0; i < 4; ++i) {
        const texture = descendantTextureTile(d.texture, 1, i >> 1, i & 1)
        seed(texture)
        const t = textureCellTransform(d.texture, texture)
        fine.push(Object.assign({}, d, {texture, sourceTexture: d.texture, imageryClipCell: true,
          imageryCellScale: t.scale, imageryCellOffsetX: t.offsetX, imageryCellOffsetY: t.offsetY}))
      }
    })
    renderer.setImageryPlan(1, plan(fine), measured)
    await until(() => prices.length === 1 && !renderer.pendingSubmission, 'Fine UV pricing did not start')
    const group = renderer.partitionGroups.current
    // Worker plans can complete repeatedly on the same camera and mesh cut.
    // Rebuilding desired imagery must not expose an empty preparation graph
    // to promotion, cancel the borrowed producer, or restart its pricing lane.
    for (let i = 0; i < 3; ++i) {
      renderer.setImageryPlan(1, plan(fine), measured)
      assert(!prices[0].cancelled, 'A compatible plan refresh cancelled in-flight UV pricing')
      assert.strictEqual(renderer.partitionGroups.current, group)
      assert(renderer.partitionGroups.valid(group), 'Plan refresh lost prepared display dependencies')
    }
    prices[0].finish()
    await until(() => jobs.length === 1 && !renderer.pendingSubmission, 'Fine UV producer did not start')
    const reserved = renderer.partitionReservedBytes, workspace = renderer.partitionCpuBytes
    renderer.setImageryPlan(1, plan(fine), measured)
    assert(!jobs[0].cancelled, 'A compatible plan refresh cancelled admitted UV production')
    assert.strictEqual(renderer.partitionGroups.current, group)
    assert.strictEqual(renderer.partitionReservedBytes, reserved, 'Plan refresh refunded promised destinations')
    assert.strictEqual(renderer.partitionCpuBytes, workspace, 'Plan refresh retired a borrowed workspace')
    await until(() => !renderer.pendingSubmission && !renderer.renderRequested, 'Compatible plan refresh did not present')
    const start = displays
    assert.strictEqual(jobs[0].id, 101)
    await until(() => renderer.geometry.get('mesh:101').partitions.size > 0 && !renderer.pendingSubmission,
      'First mesh UV output did not complete', job => job.id === 101)
    assert.strictEqual(displays, start, 'One mesh of an incomplete world group redrew unchanged terrain')
    await until(() => jobs.some(job => job.id === 102) && !renderer.pendingSubmission &&
      !renderer.partitionUploads.length && !renderer.renderRequested,
    'Shared group did not complete', job => job.id === 101 || job.id === 103)
    assert.strictEqual(displays, start + 1, 'A complete world group waited for an unrelated producer')
    assert(Array.from(renderer.presentation.cells.values()).some(s => s.cell.column < 2 && s.b.level === 1))
    assert(Array.from(renderer.presentation.cells.values()).filter(s => s.cell.column >= 2).every(s => s.b.level === 0),
      'An unfinished independent group started before its footprint was ready')
    renderer.setCameraFrame(Object.assign(frame(), {cameraPosition: [11,20,30]}))
    await until(() => !renderer.pendingSubmission && !renderer.renderRequested,
      'An unfinished UV producer delayed camera presentation')
    assert.strictEqual(displays, start + 2, 'Camera input did not draw the intact old group immediately')
    await until(() => !renderer.partitionActive && !renderer.partitionUploads.length &&
      !renderer.pendingSubmission && !renderer.renderRequested, 'Final world group did not publish', () => true)
    assert.strictEqual(displays, start + 3, 'The completed independent group did not cause exactly one display update')
    assert(Array.from(renderer.presentation.cells.values()).every(s => s.b.level === 1))
    assert.strictEqual(renderer.sourceUvPartitions, sourceUv)
    if (sourceUv) {
      assert.strictEqual(renderer.imageryPlanningOptions().sourceUvScale,2048)
      assert.strictEqual(renderer.partitionCell({...draws[0],imageryCellScale:4096,
        imageryCellOffsetX:0,imageryCellOffsetY:0}).sourceUv,false,
        'Deep imagery lost subtexel precision in common source UV')
    }
    if (sourceUv) for (const g of renderer.geometry.values()) for (const p of g.partitions.values()) {
      assert.strictEqual(p.vertexCount, 0)
      assert(!p.positionBuffer && !p.uvBuffer)
      assert.strictEqual(p.byteSize, p.indexCount * 2)
    }
    assert.strictEqual(renderer.partitionCpuBytes + renderer.partitionReservedBytes, 0)
  } finally {
    renderer.destroy()
    await new Promise(resolve => setTimeout(resolve, 0))
    global.performance = originalPerformance
  }
  assert.strictEqual(gl.syncs.size, 0)
  assert.strictEqual(renderer.resourceLedger.stats().bytes, 0)
}
