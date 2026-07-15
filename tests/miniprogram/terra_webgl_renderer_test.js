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
  activeTexture() { this.record('activeTexture', arguments) }
  enableVertexAttribArray() { this.record('enableVertexAttribArray', arguments) }
  vertexAttribPointer() { this.record('vertexAttribPointer', arguments) }
  uniform3f() { this.record('uniform3f', arguments) }
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

async function main() {
  assert.strictEqual(rendererModule.isPowerOfTwo(256), true)
  assert.strictEqual(rendererModule.isPowerOfTwo(255), false)
  assert.strictEqual(rendererModule.geometryHash(new Float32Array([1, 2])),
    rendererModule.geometryHash(new Float32Array([1, 2])))

  const gl = new FakeGl()
  const canvas = new FakeCanvas(gl)
  const contextEvents = []
  const renderRequests = []
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    urlForTile: (tile) =>
      `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
    onContextChange: (event) => contextEvents.push(event),
    requestRender: () => renderRequests.push('requested'),
    uploadBudgetMs: 20,
    maximumTextureRetries: 0,
    textureRetryDelayMs: 0
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

  renderer.setFrame(frame(), [draw(4)], positions, textureUv, indices)
  assert.strictEqual(canvas.images.length, 1)
  renderer.setFrame(frame(), [draw(5)], positions, textureUv, indices)
  assert.deepStrictEqual(canvas.images[0].sources,
    ['https://tiles.example/2/4/3.jpg', ''])
  await settle()
  await settle()
  assert.strictEqual(canvas.images.length, 2)
  canvas.images[1].onload()
  await settle()

  const stats = renderer.render()
  assert.deepStrictEqual(stats, { submitted: 1, queued: 0 })
  assert.strictEqual(gl.calls.filter((call) => call.name === 'drawElements').length,
    1)
  assert(gl.calls.some((call) => call.name === 'pixelStorei' &&
    call.args[1] === false))
  assert(gl.calls.some((call) => call.name === 'generateMipmap'))
  assert(renderRequests.length > 0)

  renderer.setFrame(frame(), [draw(6)], positions, textureUv, indices)
  await settle()
  assert.strictEqual(canvas.images.length, 3)
  canvas.images[2].onerror(new Error('offline'))
  await settle()
  assert.strictEqual(renderer.stats().textures.failed, 1)
  assert.strictEqual(renderer.retryTextures(), true)
  await settle()
  await settle()
  assert.strictEqual(canvas.images.length, 4)
  canvas.images[3].onload()
  await settle()
  assert.strictEqual(renderer.stats().textures.failed, 0)

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
