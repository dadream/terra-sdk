const assert = require('assert')
const {EncodedTextureStore} = require('../../adapters/browser/encoded_texture_store')
const {ImageTextureStore} = require('../../adapters/webgl/image_texture_store')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {globalCoverageTextureTiles, descendantTextureTile, textureCellTransform} = require('../../sdk/js/imagery/terra_texture_tiles')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = async function verifyImageryOutput({Renderer, AsyncGl, FakeCanvas, frame, draw, imageSource = false}) {
  const saved = {Blob: global.Blob, AbortController: global.AbortController, createImageBitmap: global.createImageBitmap}
  if (!global.Blob) global.Blob = class {constructor(chunks) {this.size = chunks.reduce((n, c) => n + c.byteLength, 0)}}
  if (!global.AbortController) global.AbortController = class {constructor() {this.signal = {}} abort() {this.signal.aborted = true}}
  global.createImageBitmap = async () => ({width: 16, height: 16, close() {}})
  const gl = new AsyncGl(), requests = [], prices = []
  let holdPrice = true, renderer, competitor
  const descriptor = {kind: 'global-geodetic', level_zero_columns: 2, level_zero_rows: 1,
    matrix_level_offset: 0, tile_size: 16, maximum_level: 5}
  const checkInput = url => {
    const group = [renderer.partitionGroups.current, ...renderer.partitionGroups.prepared.values()]
      .find(group => group && group.future && group.future.has(url))
    assert(group && (group.pool || renderer.partitionGroups.prepared.has(group.futureName)), 'Image I/O started without a complete admitted UV footprint')
    assert(renderer.partitionReservedBytes || Array.from(group.rows.values()).every(row =>
      row.cells.every(cell => row.geometry.partitions.has(cell.key))), 'Image I/O has no UV destination guarantee')
  }
  const canvas = new FakeCanvas(gl)
  if (imageSource) canvas.createImage = () => ({width:16,height:16,
    set src(url) {
      if (!url) return
      checkInput(url)
      requests.push({url,finish:()=>{if(this.onload)this.onload()}})
    }})
  const Store = imageSource ? ImageTextureStore : EncodedTextureStore
  renderer = new Renderer(canvas, {mode: 'height', scheduledImagery: true, managedResources: true,
    // tick() owns the resource clock so the refusal receipt is observed before
    // independent installed-cut UV preparation starts on a later resource turn.
    requestResources() {},
    textureTransitionMs: 0, textureDescriptor: descriptor, maximumTextureRequests: 1,
    urlForTile: tile => key(tile), createTextureStore: (r, options) => new Store(r, options),
    fetchTextures: url => {
      checkInput(url)
      return new Promise(resolve => requests.push({url, finish: () => {
        let read = false
        resolve({ok: true, headers: {get: () => 'image/png'}, body: {getReader: () => ({
          read: async () => read ? {done: true} : (read = true, {done: false, value: new Uint8Array(16)}),
          cancel: async () => {}, releaseLock() {}})}})
      }}))
    },
    createPartitionPlanTask(id, cells, geometry) {
      const work = surface.createPartitionPlanTask(geometry.model, cells), task = {id}
      const gate = holdPrice ? new Promise(resolve => {task.finish = resolve}) : Promise.resolve()
      task.promise = gate.then(() => work.run())
      task.cancel = () => {task.cancelled = true; work.cancel(); if (task.finish) task.finish()}
      prices.push(task)
      return task
    }})
  renderer.canvas.width=renderer.canvas.height=256
  const tick = async () => {gl.complete(); renderer.advanceResources(); renderer.render(false); await new Promise(resolve => setTimeout(resolve, 0))}
  const until = async (predicate, message) => {
    for (let i = 0; i < 120 && !predicate(); ++i) await tick()
    assert(predicate(), message + ' ' + JSON.stringify({requests:requests.length,prices:prices.length,current:renderer.partitionGroups.current && {pending:Array.from(renderer.partitionGroups.current.pending), rows:Array.from(renderer.partitionGroups.current.rows,([id,row])=>[id,row.cells]),pool:Boolean(renderer.partitionGroups.current.pool)}, ledger:renderer.resourceLedger.stats()}))
  }
  try {
    const source = {level: 2, matrix: 2, row: 0, column: 0}
    const store = renderer.textures
    // This contract isolates destination/decoder admission while UV pricing
    // is suspended. Encoded-only warming has its own ownership/overlap contract.
    if (store.sourceCache) store.sourceCache.start = () => false
    const seed = tile => store.cache.set(key(tile), {texture: gl.createTexture(), width: 16, height: 16}, store.requestBytes())
    globalCoverageTextureTiles(descriptor).concat(source).forEach(seed)
    const draws = [101,102].map(resourceId => Object.assign(draw(0), {resourceId, textureResourceId: 4294967296+resourceId, texture: source,
      origin: [0,0,0], vertexCount: 4, indexCount: 4}))
    const resources = new Map(draws.map(d => [d.resourceId, {resourceId: d.resourceId,
      positions: new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]),
      textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])}]))
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 1, coverageComplete: true}),
      draws, resources, new Uint16Array([0,1,2,3]), {modelRevision: 1})
    await until(() => renderer.displaySurface && !renderer.pendingSubmission && !renderer.renderRequested, 'Coarse mesh did not settle')
    const measured = draws.map(d => ({resourceId: d.resourceId, pixelsPerUv: 64, visible: true, centerDistance: 0}))
    const plan = draws => ({draws, levels: new Set(), quality: {planningComplete: true, cameraCurrent: true,
      spatialCut: true, targetPixelError: 1.25}})
    renderer.setMode('texture')
    renderer.setImageryPlan(1, plan(renderer.current.draws), measured)
    await until(() => !renderer.pendingSubmission && !renderer.renderRequested, 'Coarse image did not settle')
    const fine = renderer.current.draws.flatMap(d => Array.from({length: 4}, (_, i) => {
      const texture = descendantTextureTile(source, 1, i >> 1, i & 1), t = textureCellTransform(source, texture)
      return Object.assign({}, d, {texture, sourceTexture: source, imageryClipCell: true,
        imageryCellScale: t.scale, imageryCellOffsetX: t.offsetX, imageryCellOffsetY: t.offsetY})
    }))
    const costs = []
    for (const geometry of renderer.geometry.values()) {
      const cells = fine.filter(d => d.geometryKey === geometry.key).map(d => renderer.partitionCell(d))
      costs.push(...await surface.createPartitionPlanTask(geometry.model, cells).run())
    }
    const uvBytes = costs.reduce((n, item) => n + item.bytes, 0), serialBytes = Math.max(...costs.map(item => item.bytes))
    renderer.setImageryPlan(1, plan(fine), measured)
    await until(() => prices.length === 1 && !renderer.pendingSubmission, 'Prospective UV price did not start')
    assert.strictEqual(requests.length, 0, 'Image request raced its UV price')
    // The UV producer is deliberately suspended. Unrelated measurement
    // refunds cannot satisfy that dependency or reopen every image request.
    const prepare = renderer.partitionGroups.prepareImagery
    const advance = store.advance
    let attempts = 0, passes = 0
    renderer.partitionGroups.prepareImagery = function (...args) {
      ++attempts
      return prepare.apply(this, args)
    }
    store.advance = function (...args) { ++passes; return advance.apply(this, args) }
    try {
      await tick(); await tick()
      const waitingAttempts = attempts, waitingPasses = passes
      for (let i = 0; i < 16; ++i) {
        const scratch = renderer.resourceLedger.reserve('measurement-scratch', 64)
        assert(scratch); scratch.release()
        await new Promise(resolve => setTimeout(resolve, 0))
        renderer.advanceResources()
        // Even another availability pass must preserve a dependency wait.
        store.advance()
      }
      assert.strictEqual(attempts, waitingAttempts,
        'Unrelated refunds repeatedly reopened a suspended imagery dependency')
      assert.strictEqual(passes - waitingPasses, 16,
        'Unrelated refunds rebuilt imagery availability instead of only waking refused admission')
    } finally { renderer.partitionGroups.prepareImagery = prepare; store.advance = advance }
    const cancelled = renderer.partitionGroups.current
    renderer.setImageryPlan(1, plan(fine.slice()), measured)
    assert.strictEqual(renderer.partitionGroups.current, cancelled, 'Equivalent demand discarded the prepared footprint')
    assert(!prices[0].cancelled)
    renderer.setPaused(true)
    assert(prices[0].cancelled && renderer.partitionGroups.current === cancelled,
      'Pause dropped the planning lane before its cancellation receipt')
    await until(() => !renderer.partitionGroups.current, 'Cancelled prospective price retained its lane')
    assert.strictEqual(requests.length, 0, 'Cancelled preparation started image I/O')
    assert.strictEqual(store.cache.reservations.size, 0)
    renderer.setPaused(false)
    // Install the exact one-byte-short limit after display promotion; the
    // pricing task remains held. Only this fixture owns the shared limit.
    await until(() => prices.length === 2 && !renderer.pendingSubmission && !renderer.renderRequested,
      'Resumed preparation did not restart')
    // Optional cached display commands may be reclaimed; old images and meshes may not.
    const before = store.cache.bytes + renderer.geometry.bytes + renderer.current.indices.byteLength +
      renderer.worldDisplay.snapshot().bytes
    // The resumable selector owns its immutable group metadata until actual
    // publication. Include that physical owner in BOTH one-byte-short and
    // affordable quotes; the production total and all image/UV prices stay fixed.
    const metadataBytes = renderer.partitionGroups.current.metadata.bytes
    assert(metadataBytes > 0, 'Pending UV footprint metadata has no owner')
    const completeBytes = 4 * store.requestBytes() + store.minimumWorkspaceBytes() + uvBytes + serialBytes + metadataBytes
    renderer.resourceLedger.setLimit(before + completeBytes - 1)
    holdPrice = false; prices[1].finish()
    await until(() => renderer.partitionGroups.refused.size > 0, 'An infeasible combined group was not refused')
    assert.strictEqual(requests.length, 0, 'Insufficient UV budget still started image I/O')
    assert.strictEqual(store.cache.reservations.size, 0, 'Refusal left partial image reservations')
    assert.strictEqual(renderer.partitionReservedBytes + renderer.partitionCpuBytes, 0)
    assert(store.gpuReady(key(source)), 'Refusal evicted the submitted old image')
    renderer.resourceLedger.setLimit(before + completeBytes)
    await until(() => requests.length === 1, 'One complete affordable group did not start')
    await until(() => renderer.partitionGroups.prepared.size === 1,
      'Ready UV output held the production lane while its image input was outstanding')
    assert.strictEqual(renderer.partitionGroups.current, null)
    const prepared = renderer.partitionGroups.prepared.values().next().value
    assert(Array.from(prepared.rows).every(([id, row]) => row.cells.every(cell =>
      row.geometry.partitions.has(cell.key) && renderer.partitionGroups.protects(id, cell.key))),
      'Releasing the producer lane abandoned the prepared GPU footprint')
    competitor = renderer.resourceLedger.reserve('competing-consumer',
      renderer.resourceLedger.maximumBytes - renderer.resourceLedger.bytes)
    assert(competitor)
    assert.strictEqual(renderer.resourceLedger.reserve('another-consumer', 1), null,
      'A competitor stole the reserved serial completion path')
    for (let i = 0; i < 4; ++i) {
      requests[i].finish()
      await until(() => i === 3 ? fine.every(d => store.gpuReady(key(d.texture))) : requests.length > i + 1,
        'The admitted group stalled during serial input/decode/upload')
    }
    await until(() => !renderer.partitionActive && !renderer.partitionUploads.length &&
      !renderer.pendingSubmission && !renderer.renderRequested &&
      Array.from(renderer.presentation.cells.values()).every(state => state.b.level === 3), 'Prepared images and UVs did not publish together')
    assert.strictEqual(requests.length, 4, 'Sibling preparation downloaded duplicate images')
    assert.strictEqual(renderer.partitionReservedBytes + renderer.partitionCpuBytes, 0)
    assert.strictEqual(store.inputBytes, 0)
    assert.strictEqual(renderer.partitionGroups.prepared.size, 0, 'Presented imagery retained an obsolete preparation owner')
    assert.strictEqual(renderer.resourceLedger.stats().overBudgetBytes, 0)
  } finally {
    requests.forEach(request => request.finish())
    prices.forEach(task => {if (task.finish) task.finish()})
    if (competitor) competitor.release()
    renderer.destroy()
    await new Promise(resolve => setTimeout(resolve, 0))
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete global[name]; else global[name] = value
    }
  }
  assert.strictEqual(renderer.resourceLedger.bytes, 0, 'Imagery preparation left owned resources after teardown')
}
