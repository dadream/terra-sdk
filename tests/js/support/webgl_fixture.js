const assert = require('assert')

class FakeGl {
  constructor() {
    this.VERTEX_SHADER = 0x8b31
    this.FRAGMENT_SHADER = 0x8b30
    this.COMPILE_STATUS = 0x8b81
    this.LINK_STATUS = 0x8b82
    this.DEPTH_TEST = 0x0b71
    this.LEQUAL = 0x0203
    this.CULL_FACE = 0x0b44
    this.BACK = 0x0405
    this.CW = 0x0900
    this.BLEND = 0x0be2
    this.SRC_ALPHA = 0x0302
    this.ONE_MINUS_SRC_ALPHA = 0x0303
    this.MAX_TEXTURE_SIZE = 0x0d33
    this.MAX_VERTEX_ATTRIBS = 0x8869
    this.VERSION = 0x1f02
    this.ARRAY_BUFFER = 0x8892
    this.ELEMENT_ARRAY_BUFFER = 0x8893
    this.STATIC_DRAW = 0x88e4
    this.STENCIL_TEST = 0x0b90
    this.INCR = 0x1e02
    this.STENCIL_BUFFER_BIT = 0x0400
    this.ALWAYS = 0x0207
    this.EQUAL = 0x0202
    this.KEEP = 0x1e00
    this.REPLACE = 0x1e01
    this.COLOR_BUFFER_BIT = 0x4000
    this.DEPTH_BUFFER_BIT = 0x0100
    this.FLOAT = 0x1406
    this.TEXTURE0 = 0x84c0
    this.TEXTURE_2D = 0x0de1
    this.TRIANGLES = 0x0004
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
    this.REPEAT = 0x2901
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
  cullFace() { this.record('cullFace', arguments) }
  frontFace() { this.record('frontFace', arguments) }
  stencilMask() { this.record('stencilMask', arguments) }
  clearStencil() { this.record('clearStencil', arguments) }
  stencilFunc() { this.record('stencilFunc', arguments) }
  stencilOp() { this.record('stencilOp', arguments) }
  depthMask() { this.record('depthMask', arguments) }
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
  disableVertexAttribArray() { this.record('disableVertexAttribArray', arguments) }
  vertexAttribPointer() { this.record('vertexAttribPointer', arguments) }
  uniform3f() { this.record('uniform3f', arguments) }
  uniform4f() { this.record('uniform4f', arguments) }
  lineWidth() { this.record('lineWidth', arguments) }
  drawArrays() { this.record('drawArrays', arguments) }
  drawElements() { this.record('drawElements', arguments) }
  getError() { return this.NO_ERROR }
  isContextLost() { return false }
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

class AsyncGl extends FakeGl {
  constructor() {
    super()
    this.SYNC_GPU_COMMANDS_COMPLETE = 0x9117; this.TIMEOUT_EXPIRED = 0x911b
    this.ALREADY_SIGNALED = 0x911a; this.CONDITION_SATISFIED = 0x911c
    this.syncs = new Set(); this.checks = 0; this.error = 0
  }
  fenceSync() { const sync = {ready: false}; this.syncs.add(sync); return sync }
  flush() { this.record('flush') }
  clientWaitSync(sync, flags, timeout) {
    assert.strictEqual(flags, 0); assert.strictEqual(timeout, 0)
    return sync.ready ? this.ALREADY_SIGNALED : this.TIMEOUT_EXPIRED
  }
  deleteSync(sync) { this.syncs.delete(sync); this.record('deleteSync') }
  getError() {
    assert(Array.from(this.syncs).every(sync => sync.ready), 'Validation blocked on unfinished GPU work')
    ++this.checks; const error = this.error; this.error = 0; return error
  }
  complete() { this.syncs.forEach(sync => {sync.ready = true}) }
}

module.exports={FakeGl,FakeCanvas,AsyncGl,frame}
