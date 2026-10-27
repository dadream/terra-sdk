// Standalone GPU fixture; runs before the main runtime exists. A controlled
// display clock makes the 16ms arbitration window deterministic, while real
// fences, uploads and texture blending still execute in WebGL2.
window.verifyGpuProgress = async function (sdk) {
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now')
  let clock = 1000
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128
  const gl = canvas.getContext('webgl2', {alpha: false, depth: true, stencil: true, antialias: false})
  let renderer, draws = 0, maximumFences = 0
  const fences = new Set(), draw = gl.drawElements.bind(gl), fence = gl.fenceSync.bind(gl), drop = gl.deleteSync.bind(gl)
  gl.drawElements = (...args) => {++draws; return draw(...args)}
  gl.fenceSync = (...args) => {const value = fence(...args); fences.add(value); maximumFences = Math.max(maximumFences, fences.size); return value}
  gl.deleteSync = value => {fences.delete(value); return drop(value)}
  const require = (value, message) => {if (!value) throw Error(message)}
  const until = async (step, message) => {
    const deadline = Date.now() + 10000
    do {if (step()) return; await new Promise(resolve => setTimeout(resolve, 1))} while (Date.now() < deadline)
    throw Error(message)
  }
  const key = tile => [tile.level, tile.matrix, tile.row, tile.column].join('/')
  const root = {level: 0, matrix: 1, row: 0, column: 0}, fine = {level: 1, matrix: 2, row: 0, column: 0}
  const red = [240,20,0,255], blue = [0,40,220,255]
  const pixel = () => {const value = new Uint8Array(4); gl.readPixels(64,64,1,1,gl.RGBA,gl.UNSIGNED_BYTE,value); return Array.from(value)}
  const close = (actual, expected) => actual.every((v,i) => Math.abs(v-expected[i]) <= 2)
  try {
    Object.defineProperty(performance, 'now', {configurable: true, value: () => clock})
    // This arbitration fixture advances uploads explicitly from render(). Its
    // frozen clock must not also deliver the standalone renderer's real timers.
    renderer = new sdk.webgl.TerraWebGlRenderer(canvas, {gl, requestResources() {},
      mode: 'height', scheduledImagery: true, terrainBoundImagery: false,
      textureDescriptor: {kind: 'global-geodetic', matrix_level_offset: 1, minimum_level: 0, maximum_level: 8,
        tile_size: 256, level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180,-90],[180,90]]},
      textureTransitionMs: 200, textureClock: () => clock, directTextureTargets: true,
      maximumTextureEntries: 32, textureCacheBytes: 32 * 611668, uploadBudgetBytes: 350000,
      maximumResourceBytes: 32*1024*1024 + 32*611668,
      urlForTile: () => {throw Error('GPU progress fixture must not fetch images')}})
    const drive=(force=true)=>{renderer.advanceResources();return renderer.render(force)}
    renderer.textures.scheduler.pause()
    const image = color => {
      const value = document.createElement('canvas'); value.width = value.height = 256
      const context = value.getContext('2d'); context.fillStyle = `rgb(${color.slice(0,3).join(',')})`
      context.fillRect(0,0,256,256); return value
    }
    const seed = (tile, color) => {
      const source = image(color)
      renderer.uploadTexture(source,256,256,texture => renderer.textures.cache.set(key(tile),
        {image: source, texture, width: 256, height: 256},611668), () => {})
    }
    for (const tile of renderer.textures.coverageTiles) seed(tile, blue)
    // The fade's fine endpoint is explicit fixture input, independent of the
    // runtime's minimum global coverage policy.
    seed(fine, red)
    renderer.textures.scheduler.resume()
    const geometry = {resourceId:1, textureResourceId:4294967296 + (1), flags: 0, key: {level: 0, i: 0, j: 0, k: 0}, fragment: 0,
      texture: fine, origin: [0,0,0], firstIndex: 0, indexCount: 4, vertexCount: 4}
    renderer.setMeshFrame({sequence: 1, coverageComplete: true,
      projectionView: new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]), cameraPosition: [0,0,2]},
    [geometry], new Map([[1, {resourceId: 1,
      positions: new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
      textureUv: new Float32Array([0,0,1,0,0,1,1,1])}]]), new Uint16Array([1,0,3,2]), {modelRevision: 1})
    await until(() => {drive(); return renderer.displaySurface}, 'Initial GPU geometry did not publish')
    renderer.setMode('texture')
    const select = coarse => renderer.setImageryPlan(1, {draws: renderer.current.draws.map(d => ({...d,
      texture: coarse ? root : fine, sourceTexture: fine, imageryCellScale: coarse ? 0.5 : 1,
      imageryCellOffsetX: 0, imageryCellOffsetY: 0, imageryClipCell: false})), levels: new Set(),
    quality: {planningComplete: true, cameraCurrent: true, coarsening: coarse, targetPixelError: 1.25}},
    [{resourceId: 1, visible: true, pixelsPerUv: coarse ? 1 : 256, centerDistance: 0}])
    const sample = async () => {await until(() => {
      renderer.advanceResources()
      if(!renderer.worldDisplay.targetPrepared())return false
      return renderer.render()
    }, 'Explicit GPU frame did not submit'); return pixel()}
    select(false); const first = await sample(); require(close(first,red), 'Initial fine pixel differs: ' + JSON.stringify(first))
    select(true); require(close(await sample(),red), 'Coarsening jumped instead of starting a fade')
    clock += 100
    const middle = await sample()
    require(close(middle,[120,30,110,255]) && renderer.presentation.active, 'Fixture lacks an actual half-completed fade')
    const tiles = [0,2,4,6].map(column => ({level: 2, matrix: 3, row: 2, column}))
    const store = renderer.textures, source = image(red)
    store.buildRequirementTree(tiles.map(texture => ({texture})))
    store.recomputeAvailability()
    tiles.forEach(tile => store.cache.set(key(tile), {image: source, texture: null, width: 256, height: 256},611668))
    store.advance()
    const before = draws
    let firstUploads = 0
    await until(() => {
      drive(false)
      require(draws === before, 'An active fade put terrain drawing ahead of bounded resource progress')
      firstUploads = tiles.filter(tile => store.gpuReady(key(tile))).length
      return firstUploads > 0
    }, 'Active fade starved image uploads')
    require(firstUploads < tiles.length, 'Fixture did not retain background work for the deadline check')
    clock += 20
    let deadlinePixel
    await until(() => {
      const submitted = drive(false)
      if (submitted) deadlinePixel = pixel()
      return submitted
    }, 'Resources starved fade presentation after its deadline')
    require(close(deadlinePixel,[96,32,132,255]), 'Deferred fade did not advance from elapsed time')
    require(tiles.some(tile => !store.gpuReady(key(tile))), 'Deadline was tested only after the upload queue emptied')
    clock += 201
    const done = await sample()
    require(close(done,blue) && !renderer.presentation.active, 'Coarse fade failed to finish')
    require(maximumFences <= 2, 'Resource progress exceeded one display plus one upload batch')
    return {firstUploads, middle, deadlinePixel, done, maximumFences}
  } finally {
    if (renderer) renderer.destroy()
    gl.drawElements = draw; gl.fenceSync = fence; gl.deleteSync = drop
    const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext()
    canvas.remove()
    if (descriptor) Object.defineProperty(performance, 'now', descriptor)
    else delete performance.now
    if (renderer) require(renderer.resourceLedger.stats().bytes === 0 && fences.size === 0,
      'GPU progress fixture retained resources after teardown')
  }
}
