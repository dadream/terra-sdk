// No display callbacks are delivered during image production. Actual WebGL2
// uploads and fences run through the SDK's independently scheduled work clock.
window.verifyBackgroundProgress = async function (sdk) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128
  const gl = canvas.getContext('webgl2', {alpha: false, antialias: false, depth: true, stencil: true,
    preserveDrawingBuffer: true})
  if (!gl) throw Error('Background progress fixture requires WebGL2')
  const errors = []
  const require = (value, message) => {if (!value) throw Error(message)}
  const until = async (test, message) => {
    const deadline = performance.now() + 10000
    while (!test()) {
      if (performance.now() >= deadline) throw Error(message + ': ' + JSON.stringify({errors,
        work: clock.snapshot(), geometry: renderer.geometry.stats(), queued: renderer.uploadQueue.length,
        resourcesRequested: renderer.resourcesRequested, pending: renderer.pendingSubmission && renderer.pendingSubmission.items.length}))
      await new Promise(r => setTimeout(r, 2))
    }
  }
  const frames = new Map(), fences = new Set()
  let serial = 0, renderer, held, releaseImage, draws = 0, maximumFences = 0, withholdWork = false
  const originalDraw = gl.drawElements.bind(gl), originalFence = gl.fenceSync.bind(gl)
  const originalDrop = gl.deleteSync.bind(gl), originalWait = gl.clientWaitSync.bind(gl)
  gl.drawElements = (...args) => {++draws; return originalDraw(...args)}
  gl.fenceSync = (...args) => {const s = originalFence(...args); fences.add(s); maximumFences = Math.max(maximumFences, fences.size); return s}
  gl.deleteSync = s => {fences.delete(s); originalDrop(s)}
  gl.clientWaitSync = (s, ...args) => s === held ? gl.TIMEOUT_EXPIRED : originalWait(s, ...args)
  const clock = new sdk.testFrame.FrameCoordinator({
    requestFrame(callback) {const id = ++serial; frames.set(id, callback); return id},
    cancelFrame(id) {frames.delete(id)},
    render: () => Boolean(renderer.render(false)),
    onError: error => errors.push(error.message)
  })
  const display = () => {const pending = [...frames.values()]; frames.clear(); pending.forEach(f => f())}
  const key = tile => [tile.level, tile.matrix, tile.row, tile.column].join('/')
  const pixel = () => {const p = new Uint8Array(4); gl.readPixels(64,64,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return [...p]}
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2)
  const blue = [0,40,220,255], red = [240,20,0,255], fine = {level: 2, matrix: 3, row: 0, column: 0}
  const image = color => {
    const c = document.createElement('canvas'); c.width = c.height = 256
    const context = c.getContext('2d'); context.fillStyle = `rgb(${color.slice(0,3).join(',')})`
    context.fillRect(0,0,256,256); return c
  }
  let result
  try {
    renderer = new sdk.webgl.TerraWebGlRenderer(canvas, {gl, mode: 'height', scheduledImagery: true,
      terrainBoundImagery: false, textureTransitionMs: 0, maximumTextureEntries: 16,
      textureCacheBytes: 16 * 611668, uploadBudgetBytes: 350000,
      maximumResourceBytes: 32*1024*1024 + 16*611668,
      textureDescriptor: {kind: 'global-geodetic', matrix_level_offset: 1, minimum_level: 0, maximum_level: 8,
        tile_size: 256, level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180,-90],[180,90]]},
      urlForTile: tile => 'fixture:' + key(tile),
      fetchTextures: (url, {signal}) => new Promise((resolve, reject) => {
        require(url === 'fixture:' + key(fine), 'Unexpected fixture image request: ' + url)
        const abort = () => reject(Error('Fixture image cancelled'))
        signal.addEventListener('abort', abort, {once: true})
        releaseImage = () => {
          signal.removeEventListener('abort', abort)
          resolve({ok: true, blob: () => new Promise(done => image(red).toBlob(done))})
        }
      }),
      onDiagnostic: (kind, detail) => errors.push({kind, detail}),
      requestRender: () => clock.invalidate(),
      requestResources: delay => {
        if (!withholdWork) clock.enqueueWork('resources', () => renderer.advanceResources(), delay)
      },
      cancelResources: () => clock.cancelWork('resources')})
    renderer.textures.scheduler.pause()
    for (const tile of renderer.textures.coverageTiles) {
      const source = image(blue)
      renderer.uploadTexture(source,256,256,texture => renderer.textures.cache.set(key(tile),
        {image: source, texture, width: 256, height: 256}, 611668), () => {})
    }
    renderer.textures.scheduler.resume()
    const geometry = {resourceId:1, textureResourceId:4294967296 + (1), flags: 0, key: {level: 0, i: 0, j: 0, k: 0}, fragment: 0,
      texture: fine, origin: [0,0,0], firstIndex: 0, indexCount: 4, vertexCount: 4}
    const frame = {sequence: 1, coverageComplete: true,
      projectionView: new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]), cameraPosition: [0,0,2]}
    renderer.setMeshFrame(frame, [geometry], new Map([[1, {resourceId: 1,
      positions: new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
      textureUv: new Float32Array([0,0,1,0,0,1,1,1])}]]), new Uint16Array([1,0,3,2]), {modelRevision: 1})
    await until(() => renderer.geometry.stats().entries === 1 && !renderer.pendingSubmission,
      'Geometry preparation waited for display delivery')
    require(draws === 0 && !renderer.displaySurface, 'Background preparation published a display')
    renderer.setMode('texture')
    renderer.setImageryPlan(1, {draws: renderer.current.draws, levels: new Set(),
      quality: {planningComplete: true, cameraCurrent: true, spatialCut: true, targetPixelError: 1.25}},
    [{resourceId: 1, pixelsPerUv: 128, visible: true, centerDistance: 0}])
    await until(() => renderer.worldDisplay.targetPrepared() &&
      renderer.preparedSurfaceSource === renderer.current && renderer.preparedSurface,
    'World display preparation waited for display delivery')
    require(draws === 0 && !renderer.displaySurface, 'World preparation published a display')
    display()
    require(draws === 1 && renderer.pendingSubmission && renderer.pendingSubmission.drawn, 'Initial display did not submit')
    held = renderer.pendingSubmission.sync
    const before = pixel(); require(close(before, blue), 'Initial coverage pixels are incorrect')
    const oldSurface = renderer.displaySurface
    await until(() => releaseImage, 'The fine image was not requested')
    releaseImage()
    await until(() => renderer.submissions.batches.length === 2,
      'Admitted image upload waited for a display callback or earlier draw receipt')
    require(!renderer.textures.gpuReady(key(fine)) && draws === 1, 'Image published or redrew before its receipt')
    held = null
    await until(() => renderer.textures.gpuReady(key(fine)) && !renderer.pendingSubmission,
      'Image completion waited for the display clock')
    require(draws === 1 && renderer.displaySurface === oldSurface && close(pixel(), before),
      'Background completion changed the submitted image')
    for (let i = 1; i <= 10; ++i) {
      const projectionView = frame.projectionView.slice(); projectionView[3] = i / 1000
      renderer.setCameraFrame({...frame, projectionView})
    }
    display()
    const after = pixel()
    require(draws === 2 && close(after, red), 'Latest display did not publish the prepared image')
    await until(() => !renderer.pendingSubmission && !clock.snapshot().pendingWork, 'Idle background work kept polling')

    // Reverse the original clock isolation: now retain an actual completed
    // draw receipt while withholding the background clock. A new camera must
    // use this display opportunity, without producing or uploading resources.
    withholdWork = true; clock.cancelWork('resources')
    const move = offset => {
      const projectionView = frame.projectionView.slice(); projectionView[3] = offset
      renderer.setCameraFrame({...frame, projectionView})
    }
    move(0.02); display()
    require(draws === 3 && renderer.pendingSubmission.drawn, 'Receipt fixture did not submit its first camera')
    const sync = renderer.pendingSubmission.sync
    await until(() => {
      const status = originalWait(sync, 0, 0)
      return status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED
    }, 'Receipt fixture GPU did not complete')
    const producers = ['updateGpuResources', 'pumpPartitionRequests']
    const originals = producers.map(name => renderer[name]), advance = renderer.textures.advance
    producers.forEach(name => {renderer[name] = () => {throw Error('Display started ' + name)}})
    renderer.textures.advance = () => {throw Error('Display started texture scheduling')}
    try {
      move(0.04); display()
      require(draws === 4 && renderer.presentedCameraVersion === renderer.cameraVersion,
        'Completed draw receipt waited for the withheld background clock')
      require(close(pixel(), red), 'Receipt consumption changed the prepared image')
      require(clock.snapshot().pendingWork === 0, 'Receipt fixture accidentally ran background work')
    } finally {
      producers.forEach((name, i) => {renderer[name] = originals[i]})
      renderer.textures.advance = advance
      withholdWork = false; renderer.requestResources()
    }
    await until(() => !renderer.pendingSubmission && !clock.snapshot().pendingWork, 'Display receipts did not retire')
    require(maximumFences <= 2 && gl.getError() === gl.NO_ERROR, 'Submission bound or WebGL error')
    result = {before, after, draws, maximumFences, preparedWithoutDisplay: true,
      displayReceiptWithoutBackground: true}
  } finally {
    if (renderer) renderer.destroy()
    clock.destroy()
    const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext()
  }
  require(fences.size === 0 && frames.size === 0 && renderer.resourceLedger.bytes === 0,
    'Background progress fixture retained resources')
  return result
}
