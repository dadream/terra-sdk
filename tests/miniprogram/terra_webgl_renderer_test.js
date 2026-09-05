const assert = require('assert')

const rendererModule = require('../../apps/miniprogram/utils/terra_webgl_renderer')

class FakeGl {
  constructor() {
    this.VERTEX_SHADER = 0x8b31
    this.FRAGMENT_SHADER = 0x8b30
    this.COMPILE_STATUS = 0x8b81
    this.LINK_STATUS = 0x8b82
    this.DEPTH_TEST = 0x0b71
    this.LEQUAL = 0x0203
    this.CULL_FACE = 0x0b44
    this.BLEND = 0x0be2
    this.SRC_ALPHA = 0x0302
    this.ONE_MINUS_SRC_ALPHA = 0x0303
    this.MAX_TEXTURE_SIZE = 0x0d33
    this.MAX_VERTEX_ATTRIBS = 0x8869
    this.VERSION = 0x1f02
    this.ARRAY_BUFFER = 0x8892
    this.ELEMENT_ARRAY_BUFFER = 0x8893
    this.STATIC_DRAW = 0x88e4
    this.COLOR_BUFFER_BIT = 0x4000
    this.DEPTH_BUFFER_BIT = 0x0100
    this.FLOAT = 0x1406
    this.TEXTURE0 = 0x84c0
    this.TEXTURE_2D = 0x0de1
    this.TRIANGLE_STRIP = 0x0005
    this.POINTS = 0x0000
    this.LINE_STRIP = 0x0003
    this.UNSIGNED_SHORT = 0x1403
    this.NO_ERROR = 0
    this.RGBA = 0x1908
    this.UNSIGNED_BYTE = 0x1401
    this.TEXTURE_MIN_FILTER = 0x2801
    this.LINEAR = 0x2601
    this.TEXTURE_MAG_FILTER = 0x2800
    this.TEXTURE_WRAP_S = 0x2802
    this.CLAMP_TO_EDGE = 0x812f
    this.TEXTURE_WRAP_T = 0x2803
    this.LINEAR_MIPMAP_LINEAR = 0x2703
    this.UNPACK_FLIP_Y_WEBGL = 0x9240
    this.calls = []
    this.nextId = 1
  }

  record(name, args) {
    this.calls.push({ name, args: Array.from(args || []) })
  }

  object(name) {
    const value = { name, id: this.nextId }
    this.nextId += 1
    return value
  }

  createShader() { return this.object('shader') }
  shaderSource() { this.record('shaderSource', arguments) }
  compileShader() { this.record('compileShader', arguments) }
  getShaderParameter() { return true }
  getShaderInfoLog() { return '' }
  deleteShader() { this.record('deleteShader', arguments) }
  createProgram() { return this.object('program') }
  attachShader() { this.record('attachShader', arguments) }
  linkProgram() { this.record('linkProgram', arguments) }
  getProgramParameter() { return true }
  getProgramInfoLog() { return '' }
  deleteProgram() { this.record('deleteProgram', arguments) }
  getAttribLocation(program, name) { return name === 'a_position' ? 0 : 1 }
  getUniformLocation(program, name) { return { name } }
  createBuffer() { return this.object('buffer') }
  enable() { this.record('enable', arguments) }
  depthFunc() { this.record('depthFunc', arguments) }
  disable() { this.record('disable', arguments) }
  blendFunc() { this.record('blendFunc', arguments) }
  clearColor() { this.record('clearColor', arguments) }
  getParameter(parameter) {
    if (parameter === this.MAX_TEXTURE_SIZE) {
      return 4096
    }
    if (parameter === this.MAX_VERTEX_ATTRIBS) {
      return 8
    }
    if (parameter === this.VERSION) {
      return 'WebGL 1.0 fake'
    }
    return 0
  }
  viewport() { this.record('viewport', arguments) }
  bindBuffer() { this.record('bindBuffer', arguments) }
  bufferData() { this.record('bufferData', arguments) }
  createTexture() { return this.object('texture') }
  bindTexture() { this.record('bindTexture', arguments) }
  texImage2D() { this.record('texImage2D', arguments) }
  texParameteri() { this.record('texParameteri', arguments) }
  generateMipmap() { this.record('generateMipmap', arguments) }
  pixelStorei() { this.record('pixelStorei', arguments) }
  clear() { this.record('clear', arguments) }
  useProgram() { this.record('useProgram', arguments) }
  uniformMatrix4fv() { this.record('uniformMatrix4fv', arguments) }
  uniform1i() { this.record('uniform1i', arguments) }
  uniform1f() { this.record('uniform1f', arguments) }
  uniform2f() { this.record('uniform2f', arguments) }
  activeTexture() { this.record('activeTexture', arguments) }
  enableVertexAttribArray() { this.record('enableVertexAttribArray', arguments) }
  vertexAttribPointer() { this.record('vertexAttribPointer', arguments) }
  uniform3f() { this.record('uniform3f', arguments) }
  uniform4f() { this.record('uniform4f', arguments) }
  lineWidth() { this.record('lineWidth', arguments) }
  drawArrays() { this.record('drawArrays', arguments) }
  drawElements() { this.record('drawElements', arguments) }
  getError() { return this.NO_ERROR }
  deleteBuffer() { this.record('deleteBuffer', arguments) }
  deleteTexture() { this.record('deleteTexture', arguments) }
}

class FakeCanvas {
  constructor(gl) {
    this.gl = gl
    this.listeners = {}
    this.images = []
  }

  getContext() {
    return this.gl
  }

  addEventListener(name, handler) {
    this.listeners[name] = handler
  }

  removeEventListener(name) {
    delete this.listeners[name]
  }

  emit(name, event) {
    this.listeners[name](event || {})
  }

  createImage() {
    const canvas = this
    const image = {
      width: 256,
      height: 256,
      onload: null,
      onerror: null,
      sources: []
    }
    Object.defineProperty(image, 'src', {
      get() {
        return image.sources[image.sources.length - 1] || ''
      },
      set(value) {
        image.sources.push(value)
        if (value) {
          canvas.images.push(image)
        }
      }
    })
    return image
  }
}

function frame() {
  return {
    projectionView: new Float64Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]),
    cameraPosition: [10, 20, 30]
  }
}

function draw(column) {
  return {
    key: { level: 0, i: 1, j: 2, k: 3 },
    fragment: 0,
    texture: { level: 2, matrix: 2, row: 3, column },
    firstVertex: 0,
    vertexCount: 3,
    firstIndex: 0,
    indexCount: 3,
    origin: [100, 200, 300]
  }
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitForImageCount(canvas, count) {
  for (let attempt = 0; attempt < 20 && canvas.images.length < count;
    ++attempt) {
    await settle()
  }
  assert(canvas.images.length >= count,
    `Expected ${count} texture requests, received ${canvas.images.length}`)
}

async function waitUntil(message, predicate) {
  for (let attempt = 0; attempt < 20 && !predicate(); ++attempt) {
    await settle()
  }
  assert(predicate(), message)
}

async function loadAllImages(canvas, startIndex) {
  let index = startIndex || 0
  let loaded = 0
  while (index < canvas.images.length) {
    const image = canvas.images[index++]
    image.onload()
    await settle()
    await settle()
    loaded += 1
    assert(loaded < 1000, 'Texture refinement did not converge')
  }
  return index
}

async function main() {
  assert.strictEqual(rendererModule.isPowerOfTwo(256), true)
  assert.strictEqual(rendererModule.isPowerOfTwo(255), false)
  assert.strictEqual(rendererModule.geometryHash(new Float32Array([1, 2])),
    rendererModule.geometryHash(new Float32Array([1, 2])))
  assert.deepStrictEqual(rendererModule.ancestorTextureTiles({
    level: 3, matrix: 4, row: 5, column: 11
  }), [
    { level: 2, matrix: 3, row: 2, column: 5 },
    { level: 1, matrix: 2, row: 1, column: 2 },
    { level: 0, matrix: 1, row: 0, column: 1 }
  ])
  assert.deepStrictEqual(rendererModule.ancestorUvTransform(
    { level: 3, matrix: 3, row: 7, column: 11 },
    { level: 2, matrix: 2, row: 3, column: 5 }), {
    scale: 0.5,
    offsetX: 0.5,
    offsetY: 0.5
  })
  const coverage = rendererModule.globalCoverageTextureTiles({
    kind: 'global-geodetic',
    matrix_level_offset: 1,
    maximum_level: 17,
    level_zero_columns: 2,
    level_zero_rows: 1
  })
  assert.strictEqual(coverage.length, 10)
  assert.deepStrictEqual(coverage[0],
    { level: 0, matrix: 1, row: 0, column: 0 })
  assert.deepStrictEqual(coverage[coverage.length - 1],
    { level: 1, matrix: 2, row: 1, column: 3 })
  assert.deepStrictEqual(rendererModule.globalCoverageTextureTiles({
    kind: 'planar-tms'
  }), [])

  const qualityDraw = draw(4)
  qualityDraw.origin = [0, 0, 0]
  qualityDraw.vertexCount = 4
  const qualityPositions = new Float32Array([
    -1, -1, 0,
    1, -1, 0,
    -1, 1, 0,
    1, 1, 0
  ])
  const qualityUv = new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    1, 1
  ])
  const refined = rendererModule.refineImageryDraws(frame(), [qualityDraw],
    qualityPositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, { targetPixelError: 1, maximumDraws: 64 })
  assert.strictEqual(refined.draws.length, 16)
  assert.deepStrictEqual(refined.draws[15].texture,
    { level: 4, matrix: 4, row: 15, column: 19 })
  assert.strictEqual(refined.quality.measuredMaxPixelError, 1)
  assert.strictEqual(refined.quality.limitedByBudget, false)
  assert.strictEqual(refined.coverageDraws.length, 1)
  assert.deepStrictEqual(refined.coverageDraws[0].texture,
    { level: 0, matrix: 0, row: 0, column: 1 })
  assert.strictEqual(refined.coverageDraws[0].imageryClipCell, false)
  assert.strictEqual(refined.coverageDraws[0].imageryCoverageDraw, true)
  assert(refined.draws.every((item) => item.imageryClipCell &&
    !item.imageryCoverageDraw))
  assert.strictEqual(refined.quality.sourceDrawCount, 1)
  assert.strictEqual(refined.quality.coverageDrawCount, 1)
  assert.strictEqual(refined.quality.clippedDrawCount, 16)
  assert.strictEqual(refined.quality.coverageGuaranteed, true)
  const terrainBound = rendererModule.refineImageryDraws(frame(),
    [qualityDraw], qualityPositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, {
      targetPixelError: 1,
      maximumSubdivisionLevels: 0,
      maximumDraws: 64
    })
  assert.strictEqual(terrainBound.draws.length, 1)
  assert.deepStrictEqual(terrainBound.draws[0].texture, qualityDraw.texture)
  assert.strictEqual(terrainBound.coverageDraws.length, 0)
  assert.strictEqual(terrainBound.quality.limitedByLevel, true)
  assert(terrainBound.quality.measuredMaxPixelError > 1)
  const terrainRefinedDraw = Object.assign({}, qualityDraw, {
    key: Object.assign({}, qualityDraw.key, { level: 8 })
  })
  assert.strictEqual(rendererModule.maximumTerrainTextureLevel(
    terrainRefinedDraw, [terrainRefinedDraw]), 4)
  const terrainCoarseDraw = Object.assign({}, qualityDraw, {
    key: Object.assign({}, qualityDraw.key, { level: 0 }),
    texture: { level: 0, matrix: 0, row: 0, column: 1 }
  })
  const terrainDescendantDraw = Object.assign({}, qualityDraw, {
    key: Object.assign({}, qualityDraw.key, { level: 8 }),
    texture: { level: 4, matrix: 4, row: 3, column: 19 }
  })
  assert.strictEqual(rendererModule.maximumTerrainTextureLevel(
    terrainCoarseDraw, [terrainCoarseDraw, terrainDescendantDraw]), 4)
  const terrainRefined = rendererModule.refineImageryDraws(frame(),
    [terrainRefinedDraw], qualityPositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, {
      targetPixelError: 1,
      maximumDraws: 64,
      terrainBound: true
    })
  assert.strictEqual(terrainRefined.draws.length, 16)
  assert.strictEqual(terrainRefined.quality.meetsTarget, true)
  const budgetLimited = rendererModule.refineImageryDraws(frame(),
    [qualityDraw], qualityPositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, { targetPixelError: 1, maximumDraws: 4 })
  assert.strictEqual(budgetLimited.draws.length, 4)
  assert.strictEqual(budgetLimited.quality.limitedByBudget, true)
  assert.strictEqual(budgetLimited.coverageDraws.length, 1)
  assert.strictEqual(budgetLimited.quality.coverageGuaranteed, true)
  const capacityDraws = Array.from({ length: 8 }, (value, index) => {
    const item = Object.assign({}, qualityDraw)
    item.texture = { level: 3, matrix: 4, row: 0, column: index * 2 }
    return item
  })
  const capacityLimited = rendererModule.refineImageryDraws(frame(),
    capacityDraws, qualityPositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, {
      targetPixelError: 1,
      maximumDraws: 0,
      maximumTextures: 2
    })
  const selectedCapacityKeys = new Set(capacityLimited.draws.map((item) =>
    `${item.texture.level}/${item.texture.matrix}/` +
    `${item.texture.row}/${item.texture.column}`))
  assert(selectedCapacityKeys.size <= 2)
  assert.strictEqual(capacityLimited.quality.selectedTextureCount,
    selectedCapacityKeys.size)
  assert.strictEqual(capacityLimited.quality.maximumTextureCount, 2)
  assert(capacityLimited.quality.coarsenedDrawCount > 0)
  assert.strictEqual(capacityLimited.quality.limitedByTextureBudget, true)
  assert.strictEqual(capacityLimited.draws.length, capacityDraws.length)
  assert(capacityLimited.draws.every((item) =>
    item.imageryCellScale > 0 && item.imageryCellScale <= 1))
  const partialUv = new Float32Array([
    0.25, 0.25,
    0.5, 0.25,
    0.25, 0.5,
    0.5, 0.5
  ])
  const partial = rendererModule.refineImageryDraws(frame(), [qualityDraw],
    qualityPositions, partialUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, { targetPixelError: 1, maximumDraws: 64 })
  assert.strictEqual(partial.draws.length, 16)
  assert(partial.draws.every((item) => item.texture.level === 6))
  assert.strictEqual(partial.quality.meetsTarget, true)
  assert.strictEqual(partial.coverageDraws.length, 1)
  assert.strictEqual(partial.quality.coverageGuaranteed, true)
  const distant = rendererModule.refineImageryDraws(frame(), [qualityDraw],
    qualityPositions, qualityUv,
    { width: 64, height: 64, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, { targetPixelError: 1, maximumDraws: 64 })
  assert.strictEqual(distant.draws.length, 1)
  assert.deepStrictEqual(distant.draws[0].texture,
    { level: 0, matrix: 0, row: 0, column: 1 })
  assert.strictEqual(distant.draws[0].imageryCellScale, 0.25)
  assert.strictEqual(distant.quality.coarsenedDrawCount, 1)
  assert.strictEqual(distant.quality.measuredMaxPixelError, 1)
  assert.strictEqual(distant.quality.meetsTarget, true)
  assert.strictEqual(distant.coverageDraws.length, 0)
  assert.strictEqual(distant.draws[0].imageryClipCell, false)
  assert.strictEqual(distant.quality.coverageGuaranteed, true)

  const gl = new FakeGl()
  const canvas = new FakeCanvas(gl)
  const contextEvents = []
  const diagnostics = []
  const renderRequests = []
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    urlForTile: (tile) =>
      `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
    onContextChange: (event) => contextEvents.push(event),
    onDiagnostic: (kind, detail) => diagnostics.push({ kind, detail }),
    requestRender: () => renderRequests.push('requested'),
    uploadBudgetMs: 20,
    maximumTextureRetries: 0,
    textureRetryDelayMs: 0,
    prefetchTextureAncestors: false
  })
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ])
  const textureUv = new Float32Array([
    0, 0,
    1, 0,
    0, 1
  ])
  const indices = new Uint16Array([0, 1, 2])

  const prefetchGl = new FakeGl()
  const prefetchCanvas = new FakeCanvas(prefetchGl)
  const pressureGl = new FakeGl()
  const pressureCanvas = new FakeCanvas(pressureGl)
  const pressureRenderer = new rendererModule.TerraWebGlRenderer(
    pressureCanvas, {
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureEntries: 4,
      textureCacheBytes: 4 * 256 * 256 * 4,
      maximumTextureRequests: 1,
      maximumTextureRetries: 0
    })
  const pressureDraws = [
    { texture: { level: 3, matrix: 4, row: 4, column: 8 } },
    { texture: { level: 3, matrix: 4, row: 6, column: 12 } }
  ]
  pressureRenderer.textures.sync(pressureDraws)
  const pressureStats = pressureRenderer.stats().textures
  assert.strictEqual(pressureStats.capacity, 3)
  assert.strictEqual(pressureStats.targetDesired, 2)
  assert.strictEqual(pressureStats.supportDesired, 5)
  assert.strictEqual(pressureStats.desired, 7)
  assert.strictEqual(pressureStats.rootDesired, 1)
  assert.strictEqual(pressureStats.coverageReady, false)
  assert.strictEqual(pressureStats.state, 'bootstrapping')
  assert.strictEqual(pressureStats.frontierTiles, 1)
  assert.strictEqual(pressureStats.limitedByCapacity, true)
  pressureRenderer.textures.sync([{
    texture: { level: 3, matrix: 4, row: 4, column: 8 },
    imageryCoverageDraw: true
  }])
  const coverageSupportStats = pressureRenderer.stats().textures
  assert.strictEqual(coverageSupportStats.targetDesired, 0)
  assert.strictEqual(coverageSupportStats.supportDesired, 4)
  pressureRenderer.destroy()
  await settle()

  const coverageGl = new FakeGl()
  const coverageCanvas = new FakeCanvas(coverageGl)
  const coverageRenderer = new rendererModule.TerraWebGlRenderer(
    coverageCanvas, {
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      textureDescriptor: {
        kind: 'global-geodetic',
        matrix_level_offset: 1,
        maximum_level: 17,
        level_zero_columns: 2,
        level_zero_rows: 1,
        tile_size: 256
      },
      maximumTextureRequests: 1,
      maximumTextureRetries: 0
    })
  const coverageDraw = draw(13)
  coverageDraw.texture = { level: 3, matrix: 4, row: 5, column: 13 }
  coverageRenderer.setFrame(frame(), [coverageDraw], positions, textureUv,
    indices)
  assert.strictEqual(coverageCanvas.images[0].src,
    'https://tiles.example/1/0/0.jpg')
  assert.strictEqual(coverageRenderer.stats().textures.coverageDesired, 10)
  assert.strictEqual(coverageRenderer.stats().textures.rootDesired, 2)
  assert.strictEqual(coverageRenderer.stats().textures.cachedCoverage, 0)
  assert.strictEqual(coverageRenderer.stats().textures.coverageReady, false)
  assert.strictEqual(coverageCanvas.images.length, 1)
  coverageCanvas.images[0].onload()
  await settle()
  assert.strictEqual(coverageCanvas.images.length, 2)
  assert.strictEqual(coverageCanvas.images[1].src,
    'https://tiles.example/1/1/0.jpg')
  assert.strictEqual(coverageRenderer.stats().textures.coverageReady, false)
  coverageCanvas.images[1].onload()
  await settle()
  assert.strictEqual(coverageRenderer.stats().textures.coverageReady, true)
  assert.strictEqual(coverageRenderer.stats().textures.cachedRoots, 2)
  assert.strictEqual(coverageCanvas.images[2].src,
    'https://tiles.example/2/0/0.jpg')
  coverageRenderer.destroy()

  const capacityGl = new FakeGl()
  const capacityCanvas = new FakeCanvas(capacityGl)
  capacityCanvas.width = 1024
  capacityCanvas.height = 1024
  const capacityRenderer = new rendererModule.TerraWebGlRenderer(
    capacityCanvas, {
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      textureDescriptor: {
        kind: 'global-geodetic',
        matrix_level_offset: 1,
        maximum_level: 17,
        level_zero_columns: 2,
        level_zero_rows: 1,
        tile_size: 256
      },
      maximumTextureEntries: 16,
      textureCacheBytes: 16 * 349524,
      maximumTextureRequests: 16,
      maximumTextureRetries: 0
    })
  capacityRenderer.setFrame(frame(), [qualityDraw], qualityPositions,
    qualityUv, indices)
  capacityRenderer.render()
  const capacityStats = capacityRenderer.stats()
  assert.strictEqual(capacityStats.textures.capacity, 16)
  assert.strictEqual(capacityStats.textures.targetCapacity, 2)
  assert(capacityStats.textures.targetDesired <=
    capacityStats.textures.targetCapacity)
  assert.strictEqual(capacityStats.textures.limitedByCapacity, false)
  assert.strictEqual(capacityStats.quality.terrainBound, true)
  assert.strictEqual(capacityStats.quality.limitedByTextureBudget, false)
  assert.strictEqual(capacityStats.quality.limitedByLevel, true)
  await loadAllImages(capacityCanvas)
  capacityRenderer.render()
  const loadedCapacityStats = capacityRenderer.stats()
  assert.strictEqual(loadedCapacityStats.textures.targetMissing, 0)
  assert(loadedCapacityStats.textures.entries <=
    loadedCapacityStats.textures.capacity)
  assert.strictEqual(loadedCapacityStats.quality.targetCoverage, 1)
  assert.strictEqual(loadedCapacityStats.quality.ready, true)
  assert.strictEqual(loadedCapacityStats.quality.settled, true)
  assert.strictEqual(loadedCapacityStats.quality.targetMet, false)
  assert.strictEqual(loadedCapacityStats.quality.state, 'limited')
  assert.strictEqual(loadedCapacityStats.quality.limitedByTextureBudget, false)
  assert.strictEqual(loadedCapacityStats.quality.limitedByLevel, true)
  capacityRenderer.destroy()
  await settle()

  const prefetchRenderer = new rendererModule.TerraWebGlRenderer(
    prefetchCanvas, {
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureRequests: 3,
      maximumTextureRetries: 0
    })
  const prefetchDraw = draw(11)
  prefetchDraw.texture = { level: 3, matrix: 4, row: 5, column: 11 }
  prefetchRenderer.textures.sync([{ texture: prefetchDraw.texture }])
  assert.deepStrictEqual(prefetchCanvas.images.map((image) => image.src), [
    'https://tiles.example/1/1/0.jpg'
  ])
  let prefetchStats = prefetchRenderer.stats().textures
  assert.strictEqual(prefetchStats.desired, 4)
  assert.strictEqual(prefetchStats.targetDesired, 1)
  assert.strictEqual(prefetchStats.targetMissing, 1)
  assert.strictEqual(prefetchStats.supportDesired, 3)
  assert.strictEqual(prefetchStats.rootDesired, 1)
  assert.strictEqual(prefetchStats.active, 1)
  assert.strictEqual(prefetchStats.queued, 0)
  assert.strictEqual(prefetchStats.state, 'bootstrapping')
  prefetchCanvas.images[0].onload()
  await waitForImageCount(prefetchCanvas, 2)
  assert.strictEqual(prefetchCanvas.images[1].src,
    'https://tiles.example/2/2/1.jpg')
  prefetchCanvas.images[1].onload()
  await waitForImageCount(prefetchCanvas, 3)
  assert.strictEqual(prefetchCanvas.images[2].src,
    'https://tiles.example/3/5/2.jpg')
  prefetchCanvas.images[2].onload()
  await waitForImageCount(prefetchCanvas, 4)
  assert.strictEqual(prefetchCanvas.images[3].src,
    'https://tiles.example/4/11/5.jpg')
  prefetchCanvas.images[3].onload()
  await waitUntil('Leaf texture did not commit', () =>
    prefetchRenderer.stats().textures.state === 'settled')
  prefetchStats = prefetchRenderer.stats().textures
  assert.strictEqual(prefetchStats.cachedTarget, 1)
  assert.strictEqual(prefetchStats.targetMissing, 0)
  assert.strictEqual(prefetchStats.state, 'settled')
  prefetchRenderer.destroy()
  await settle()

  const atomicGl = new FakeGl()
  const atomicCanvas = new FakeCanvas(atomicGl)
  const atomicRenderer = new rendererModule.TerraWebGlRenderer(atomicCanvas, {
    urlForTile: (tile) =>
      `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
    maximumTextureRequests: 4,
    maximumTextureRetries: 0
  })
  const atomicDraws = [
    { texture: { level: 2, matrix: 3, row: 0, column: 0 } },
    { texture: { level: 2, matrix: 3, row: 0, column: 1 } }
  ]
  atomicRenderer.textures.sync(atomicDraws)
  assert.strictEqual(atomicCanvas.images.length, 1)
  atomicCanvas.images[0].onload()
  await waitForImageCount(atomicCanvas, 2)
  assert.strictEqual(atomicCanvas.images.length, 2)
  atomicCanvas.images[1].onload()
  await waitForImageCount(atomicCanvas, 4)
  assert.strictEqual(atomicCanvas.images.length, 4)
  atomicCanvas.images[2].onload()
  await waitUntil('First sibling did not commit independently', () =>
    atomicRenderer.stats().textures.cachedTarget === 1)
  let atomicStats = atomicRenderer.stats().textures
  assert.strictEqual(atomicStats.residentTarget, 1)
  assert.strictEqual(atomicStats.cachedTarget, 1)
  assert.strictEqual(atomicStats.stagedTiles, 0)
  assert.strictEqual(atomicStats.state, 'refining')
  atomicCanvas.images[3].onload()
  await waitUntil('Sibling group did not finish refining', () =>
    atomicRenderer.stats().textures.state === 'settled')
  atomicStats = atomicRenderer.stats().textures
  assert.strictEqual(atomicStats.cachedTarget, 2)
  assert.strictEqual(atomicStats.stagedTiles, 0)
  assert.strictEqual(atomicStats.state, 'settled')
  atomicRenderer.textures.sync([{
    texture: { level: 1, matrix: 2, row: 0, column: 0 }
  }])
  atomicStats = atomicRenderer.stats().textures
  assert.strictEqual(atomicStats.targetDesired, 1)
  assert.strictEqual(atomicStats.cachedTarget, 1)
  assert.strictEqual(atomicStats.presentationTiles, 1)
  assert.strictEqual(atomicRenderer.textures.committedKeys.has('2/3/0/0'),
    false)
  assert.strictEqual(atomicRenderer.textures.committedKeys.has('2/3/0/1'),
    false)
  atomicRenderer.destroy()
  await settle()

  const stagedGl = new FakeGl()
  const stagedCanvas = new FakeCanvas(stagedGl)
  const stagedRenderer = new rendererModule.TerraWebGlRenderer(
    stagedCanvas, {
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureEntries: 128,
      textureCacheBytes: 128 * 349524,
      maximumTextureRequests: 1,
      maximumTextureRetries: 0
    })
  const stagedDraws = []
  for (let index = 0; index < 17; ++index) {
    const parent = {
      level: 3,
      matrix: 4,
      row: Math.floor(index / 16),
      column: index % 16
    }
    const resident = {
      level: 4,
      matrix: 5,
      row: parent.row * 2,
      column: parent.column * 2
    }
    const missing = Object.assign({}, resident, {
      column: resident.column + 1
    })
    rendererModule.ancestorTextureTiles(resident).reverse()
      .concat([resident]).forEach((tile) => {
        const key = `${tile.level}/${tile.matrix}/${tile.row}/${tile.column}`
        if (!stagedRenderer.textures.cache.has(key)) {
          stagedRenderer.textures.cache.set(key, {
            image: null,
            texture: null,
            width: 1,
            height: 1,
            url: key
          }, 4)
        }
        stagedRenderer.textures.committedKeys.add(key)
      })
    stagedDraws.push({ texture: resident }, { texture: missing })
  }
  stagedRenderer.textures.sync(stagedDraws)
  const stagedStats = stagedRenderer.stats().textures
  assert.strictEqual(stagedStats.transitionCapacity, 16)
  assert.strictEqual(stagedStats.transitionGroups, 8)
  assert.strictEqual(stagedStats.transitionReserved, 16)
  assert.strictEqual(stagedStats.stagedTiles, 0)
  assert.strictEqual(stagedStats.frontierTiles, 17)
  assert.strictEqual(stagedStats.blockedGroupCount, 9)
  assert.strictEqual(stagedStats.blockedTileCount, 9)
  assert.strictEqual(stagedStats.blockedByCapacity, true)
  assert.strictEqual(stagedStats.state, 'refining')
  assert.strictEqual(stagedStats.active, 1)
  assert.strictEqual(stagedStats.queued, 7)
  stagedRenderer.destroy()
  await settle()

  const logicalParentGl = new FakeGl()
  const logicalParentCanvas = new FakeCanvas(logicalParentGl)
  const logicalParentRenderer = new rendererModule.TerraWebGlRenderer(
    logicalParentCanvas, {
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureRequests: 1,
      maximumTextureRetries: 0
    })
  const logicalTarget = { level: 3, matrix: 4, row: 0, column: 0 }
  const logicalPath = rendererModule.ancestorTextureTiles(logicalTarget)
    .reverse()
  logicalPath.forEach((tile, index) => {
    const key = `${tile.level}/${tile.matrix}/${tile.row}/${tile.column}`
    logicalParentRenderer.textures.committedKeys.add(key)
    if (index < 2) {
      logicalParentRenderer.textures.cache.set(key, {
        image: null,
        texture: null,
        width: 1,
        height: 1,
        url: key
      }, 4)
    }
  })
  logicalParentRenderer.textures.sync([{ texture: logicalTarget }])
  const logicalParentStats = logicalParentRenderer.stats().textures
  assert.strictEqual(logicalParentStats.frontierTiles, 1)
  assert.strictEqual(logicalParentStats.active, 1)
  assert.strictEqual(logicalParentCanvas.images[0].src,
    'https://tiles.example/4/0/0.jpg')
  logicalParentRenderer.destroy()
  await settle()

  const failureGl = new FakeGl()
  const failureCanvas = new FakeCanvas(failureGl)
  const failureRenderer = new rendererModule.TerraWebGlRenderer(
    failureCanvas, {
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureRequests: 4,
      maximumTextureRetries: 0
    })
  failureRenderer.textures.sync(atomicDraws)
  failureCanvas.images[0].onload()
  await waitForImageCount(failureCanvas, 2)
  failureCanvas.images[1].onload()
  await waitForImageCount(failureCanvas, 4)
  failureCanvas.images[2].onload()
  failureCanvas.images[3].onerror(new Error('upstream failed'))
  await waitUntil('Failed sibling did not preserve the ready target', () => {
    const stats = failureRenderer.stats().textures
    return stats.state === 'degraded' && stats.cachedTarget === 1
  })
  let failureStats = failureRenderer.stats().textures
  assert.strictEqual(failureStats.state, 'degraded')
  assert.strictEqual(failureStats.blockedByFailure, true)
  assert.strictEqual(failureStats.cachedTarget, 1)
  failureRenderer.textures.beginFrame()
  atomicDraws.forEach((item) =>
    failureRenderer.textures.get(item.texture))
  failureStats = failureRenderer.stats().textures
  assert.strictEqual(failureStats.fallbackRatio, 0.5)
  assert.strictEqual(failureStats.missingRatio, 0)
  assert.strictEqual(failureRenderer.retryTextures(), true)
  await waitForImageCount(failureCanvas, 5)
  assert.strictEqual(failureCanvas.images.length, 5)
  failureCanvas.images[4].onload()
  await waitUntil('Retried sibling group did not commit', () =>
    failureRenderer.stats().textures.state === 'settled')
  failureStats = failureRenderer.stats().textures
  assert.strictEqual(failureStats.cachedTarget, 2)
  assert.strictEqual(failureStats.state, 'settled')
  failureRenderer.destroy()
  await settle()
  const transitionGl = new FakeGl()
  const transitionCanvas = new FakeCanvas(transitionGl)
  const transitionRenderer = new rendererModule.TerraWebGlRenderer(
    transitionCanvas, {
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureRequests: 1,
      maximumTextureRetries: 0,
      prefetchTextureAncestors: false,
      maximumGeometryEntries: 1,
      uploadBudgetMs: 20
    })
  const firstTransitionDraw = draw(20)
  transitionRenderer.setFrame(frame(), [firstTransitionDraw], positions,
    textureUv, indices)
  transitionRenderer.render()
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, false)
  const drawCallsBeforeEmptyFrame = transitionGl.calls.filter((call) =>
    call.name === 'drawElements').length
  transitionRenderer.setFrame(frame(), [], new Float32Array(0),
    new Float32Array(0), indices)
  const emptyFrameStats = transitionRenderer.render()
  assert.strictEqual(emptyFrameStats.submitted, 1)
  assert.strictEqual(transitionGl.calls.filter((call) =>
    call.name === 'drawElements').length, drawCallsBeforeEmptyFrame + 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, true)
  const originalProcessUploads = transitionRenderer.processUploads.bind(
    transitionRenderer)
  transitionRenderer.processUploads = () => {}
  const secondTransitionDraw = draw(21)
  const secondTransitionPositions = new Float32Array([
    0, 0, 0,
    2, 0, 0,
    0, 2, 0
  ])
  transitionRenderer.setFrame(frame(), [secondTransitionDraw],
    secondTransitionPositions, textureUv, indices)
  const drawCallsBeforePendingRender = transitionGl.calls.filter((call) =>
    call.name === 'drawElements').length
  const pendingStats = transitionRenderer.render()
  assert.strictEqual(pendingStats.submitted, 1)
  assert.strictEqual(transitionGl.calls.filter((call) =>
    call.name === 'drawElements').length, drawCallsBeforePendingRender + 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, true)
  assert.strictEqual(transitionRenderer.stats().transition.pendingGeometry, 1)
  transitionRenderer.uploadQueue = []
  transitionRenderer.processUploads = originalProcessUploads
  transitionRenderer.render()
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, true)
  assert.strictEqual(transitionRenderer.stats().transition.pendingGeometry, 1)
  assert.strictEqual(transitionRenderer.stats().transition.queuedGeometry, 1)
  transitionRenderer.render()
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, false)
  assert.strictEqual(transitionRenderer.stats().transition.pendingGeometry, 0)
  assert.strictEqual(transitionRenderer.stats().transition.queuedGeometry, 0)
  assert.strictEqual(transitionRenderer.stats().geometry.entries, 1)
  assert.strictEqual(transitionRenderer.stats().transition.pinnedGeometry, 1)
  const incompleteGeometryFrame = frame()
  incompleteGeometryFrame.expectedDrawCount = 2
  incompleteGeometryFrame.omittedDrawCount = 1
  transitionRenderer.setFrame(incompleteGeometryFrame,
    [secondTransitionDraw], secondTransitionPositions, textureUv, indices)
  transitionRenderer.render()
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, true)
  assert.strictEqual(
    transitionRenderer.stats().transition.expectedGeometry, 2)
  assert.strictEqual(
    transitionRenderer.stats().transition.omittedGeometry, 1)
  assert.strictEqual(transitionRenderer.stats().quality.covered, false)

  const coveredGeometryFrame = frame()
  coveredGeometryFrame.expectedDrawCount = 2
  coveredGeometryFrame.omittedDrawCount = 1
  coveredGeometryFrame.coverageDrawCount = 1
  coveredGeometryFrame.coverageComplete = true
  const rootCoverageDraw = Object.assign({}, secondTransitionDraw, {
    flags: 1
  })
  const pendingDetailDraw = Object.assign({}, draw(22), {
    key: { level: 1, i: 4, j: 5, k: 6 },
    firstVertex: 3
  })
  const coveredPositions = new Float32Array([
    ...secondTransitionPositions,
    0, 0, 1,
    2, 0, 1,
    0, 2, 1
  ])
  const coveredUv = new Float32Array([
    ...textureUv,
    0, 0,
    1, 0,
    0, 1
  ])
  transitionRenderer.setFrame(coveredGeometryFrame,
    [rootCoverageDraw, pendingDetailDraw], coveredPositions,
    coveredUv, indices)
  transitionRenderer.processUploads = () => {}
  transitionRenderer.render()
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, false)
  assert.strictEqual(
    transitionRenderer.stats().transition.coverageGeometry, 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.pendingCoverageGeometry, 0)
  assert.strictEqual(
    transitionRenderer.stats().transition.pendingGeometry, 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.queuedGeometry, 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.coverageComplete, true)
  assert.strictEqual(
    transitionRenderer.stats().quality.geometryCoverageReady, true)
  assert.strictEqual(
    transitionRenderer.stats().quality.geometryTargetComplete, false)
  assert.strictEqual(
    transitionRenderer.stats().quality.sourceDrawCount, 2)
  transitionRenderer.destroy()
  await settle()

  renderer.textures.sync([{ texture: draw(4).texture }])
  assert.strictEqual(canvas.images.length, 1)
  renderer.textures.sync([{ texture: draw(5).texture }])
  assert.deepStrictEqual(canvas.images[0].sources,
    ['https://tiles.example/2/4/3.jpg'])
  await settle()
  await settle()
  assert.strictEqual(canvas.images.length, 2)
  canvas.images[1].onload()
  await waitUntil('Parent texture did not commit', () =>
    renderer.stats().textures.state === 'settled')

  const descendant = draw(11)
  descendant.texture = { level: 3, matrix: 3, row: 7, column: 11 }
  renderer.options.imageryPixelError = 0.0001
  renderer.setFrame(frame(), [descendant], positions, textureUv, indices)
  await settle()
  assert.strictEqual(renderer.stats().quality.terrainBound, true)
  assert.strictEqual(canvas.images.length, 3)
  renderer.render()
  renderer.textures.committedKeys.add('2/2/3/5')
  renderer.textures.beginFrame()
  const fallbackBinding = renderer.textures.get(descendant.texture)
  assert.strictEqual(fallbackBinding.kind, 'fallback')
  assert.strictEqual(fallbackBinding.scale, 0.5)
  assert.strictEqual(fallbackBinding.offsetX, 0.5)
  assert.strictEqual(fallbackBinding.offsetY, 0.5)
  assert.strictEqual(renderer.stats().textures.fallbackRatio, 1)
  assert.strictEqual(renderer.stats().textures.missingRatio, 0)
  assert.strictEqual(renderer.stats().quality.ready, false)
  canvas.images[2].onload()
  await waitUntil('Descendant texture did not commit', () =>
    renderer.stats().textures.state === 'settled')
  await settle()
  await settle()
  renderer.render()
  assert.strictEqual(renderer.stats().textures.fallbackRatio, 0)
  assert.strictEqual(renderer.stats().quality.ready, true)
  assert.strictEqual(renderer.stats().quality.settled, true)
  renderer.setOverlays({
    points: [{ id: 'beijing', world: [1, 2, 3], priority: 1 }],
    route: {
      worlds: [[0, 0, 0], [1, 1, 1]],
      color: '#2f7de1',
      opacity: 0.75,
      widthPixels: 3
    }
  })
  renderer.render()
  assert.strictEqual(renderer.stats().overlays.points, 1)
  assert.strictEqual(renderer.stats().overlays.routeVertices, 2)
  assert(gl.calls.some((call) => call.name === 'drawArrays' &&
    call.args[0] === gl.POINTS))
  assert(gl.calls.some((call) => call.name === 'drawArrays' &&
    call.args[0] === gl.LINE_STRIP))
  assert(gl.calls.some((call) => call.name === 'blendFunc' &&
    call.args[0] === gl.SRC_ALPHA &&
    call.args[1] === gl.ONE_MINUS_SRC_ALPHA))

  const stats = renderer.render()
  assert.deepStrictEqual(stats, { submitted: 3, queued: 0 })
  assert(gl.calls.filter((call) => call.name === 'drawElements').length >= 3)
  assert(gl.calls.some((call) => call.name === 'pixelStorei' &&
    call.args[1] === false))
  assert(gl.calls.some((call) => call.name === 'generateMipmap'))
  assert(renderRequests.length > 0)
  renderer.setMode('height')
  renderer.render()
  assert.strictEqual(renderer.stats().mode, 'height')
  assert(gl.calls.some((call) => call.name === 'uniform1f' &&
    call.args[1] === 1))
  assert(gl.calls.some((call) => call.name === 'uniform1f' &&
    call.args[0].name === 'u_height_origin' && call.args[1] === 300))

  renderer.textures.sync([{ texture: draw(6).texture }])
  await settle()
  assert.strictEqual(canvas.images.length, 4)
  canvas.images[3].onerror(new Error('https://tiles.example/?tk=secret-token'))
  await settle()
  assert.strictEqual(renderer.stats().textures.failed, 1)
  assert.strictEqual(diagnostics[diagnostics.length - 1].kind,
    'texture_load_failed')
  assert.strictEqual(diagnostics[diagnostics.length - 1].detail.message,
    'Texture image failed')
  assert.strictEqual(renderer.retryTextures(), true)
  await settle()
  await settle()
  assert.strictEqual(canvas.images.length, 5)
  canvas.images[4].onload()
  await settle()
  assert.strictEqual(renderer.stats().textures.failed, 0)

  const sourceSwitchDraw = draw(7)
  renderer.textures.sync([{ texture: sourceSwitchDraw.texture }])
  await settle()
  assert.strictEqual(canvas.images.length, 6)
  canvas.images[5].onload()
  renderer.textures.clear()
  renderer.textures.sync([{ texture: sourceSwitchDraw.texture }])
  await settle()
  assert.strictEqual(canvas.images.length, 7)
  assert.strictEqual(renderer.textures.cache.has('2/2/3/7'), false)
  canvas.images[6].onload()
  await settle()
  assert.strictEqual(renderer.textures.cache.has('2/2/3/7'), true)

  renderer.textures.prefetchAncestors = true
  const sourceGeneration = renderer.textures.generation
  let invalidSourceTiles = 0
  renderer.setImagerySource({
    kind: 'global-geodetic',
    matrix_level_offset: 1,
    maximum_level: 17,
    level_zero_columns: 2,
    level_zero_rows: 1,
    tile_size: 256
  }, (tile) => {
    if (tile.matrix !== tile.level + 1) {
      invalidSourceTiles += 1
      throw new Error('New imagery source received an invalid matrix')
    }
    return `https://new.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`
  })
  assert.strictEqual(renderer.textures.generation, sourceGeneration + 1)
  assert.strictEqual(renderer.textures.cache.has('2/2/3/7'), false)
  assert.deepStrictEqual(renderer.textures.configuredRootTiles, [
    { level: 0, matrix: 1, row: 0, column: 0 },
    { level: 0, matrix: 1, row: 0, column: 1 }
  ])
  await settle()
  assert.strictEqual(invalidSourceTiles, 0)
  assert.strictEqual(renderer.stats().textures.rootDesired, 2)
  assert.strictEqual(renderer.stats().textures.failed, 0)
  assert(canvas.images.slice(7).some((image) =>
    image.src === 'https://new.example/1/0/0.jpg'))

  renderer.setImagerySource({
    kind: 'global-geodetic',
    matrix_level_offset: 0,
    maximum_level: 7,
    level_zero_columns: 2,
    level_zero_rows: 1,
    tile_size: 256
  }, (tile) => {
    assert.strictEqual(tile.matrix, tile.level)
    return `https://original.example/${tile.matrix}/` +
      `${tile.column}/${tile.row}.jpg`
  })
  await settle()
  assert.strictEqual(renderer.stats().textures.rootDesired, 2)
  assert.strictEqual(renderer.stats().textures.failed, 0)
  assert(canvas.images.some((image) =>
    image.src === 'https://original.example/0/0/0.jpg'))

  let prevented = false
  canvas.emit('webglcontextlost', {
    preventDefault() {
      prevented = true
    }
  })
  assert.strictEqual(prevented, true)
  assert.strictEqual(renderer.contextLost, true)
  canvas.emit('webglcontextrestored')
  assert.strictEqual(renderer.contextLost, false)
  renderer.render()
  assert.deepStrictEqual(contextEvents, [{ lost: true }, { lost: false }])

  renderer.setBudget({
    geometryCacheBytes: 1,
    textureCacheBytes: 1,
    uploadBudgetMs: 3,
    maximumTextureRequests: 1
  })
  assert.strictEqual(renderer.geometry.maximumBytes, 1)
  assert.strictEqual(renderer.textures.cache.maximumBytes, 1)
  assert.strictEqual(renderer.textures.scheduler.maximumConcurrent, 1)
  renderer.destroy()
  assert(gl.calls.some((call) => call.name === 'deleteProgram'))
  console.log('Mini Program WebGL renderer tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
