const common = require('./terra_globe_common')

const VERTEX_SHADER = [
  'attribute vec3 a_position;',
  'attribute vec2 a_uv;',
  'uniform mat4 u_projection_view;',
  'uniform vec3 u_origin;',
  'varying mediump vec2 v_uv;',
  'void main() {',
  '  gl_Position = u_projection_view * vec4(a_position + u_origin, 1.0);',
  '  v_uv = a_uv;',
  '}'
].join('\n')

const FRAGMENT_SHADER = [
  'precision mediump float;',
  'uniform sampler2D u_texture;',
  'varying mediump vec2 v_uv;',
  'void main() {',
  '  gl_FragColor = texture2D(u_texture, v_uv);',
  '}'
].join('\n')

function createShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'WebGL shader compilation failed'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function createProgram(gl) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  const program = gl.createProgram()
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'WebGL program link failed'
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0
}

function geometryHash(values) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset,
    values.byteLength)
  let hash = 0x811c9dc5
  for (let index = 0; index < bytes.length; ++index) {
    hash ^= bytes[index]
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function geometryKey(draw, positions, textureUv) {
  return `${common.patchKeyString('geometry', draw.key)}:${draw.fragment}:` +
    `${geometryHash(positions)}:${geometryHash(textureUv)}`
}

function imageTask(canvas, url) {
  let image = null
  let settled = false
  let rejectPromise = null
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject
    if (!canvas || typeof canvas.createImage !== 'function') {
      reject(new Error('Canvas image API is unavailable'))
      return
    }
    image = canvas.createImage()
    image.onload = () => {
      if (!settled) {
        settled = true
        resolve(image)
      }
    }
    image.onerror = (error) => {
      if (!settled) {
        settled = true
        reject(new Error('Texture image failed'))
      }
    }
    image.src = url
  })
  return {
    promise,
    abort() {
      if (!settled) {
        settled = true
        if (image) {
          image.src = ''
        }
        rejectPromise(new Error('Texture image request was cancelled'))
      }
    }
  }
}

class TextureStore {
  constructor(renderer, options) {
    this.renderer = renderer
    this.canvas = renderer.canvas
    common.invariant(typeof options.urlForTile === 'function',
      'Texture URL resolver is required')
    this.urlForTile = options.urlForTile
    this.onDiagnostic = options.onDiagnostic || (() => {})
    this.scheduler = new common.RequestScheduler(options.maximumConcurrent || 3)
    this.cache = new common.LruCache({
      maximumEntries: options.maximumEntries || 128,
      maximumBytes: options.maximumBytes || 32 * 1024 * 1024,
      dispose: (asset) => this.disposeAsset(asset)
    })
    this.maximumRetries = Number.isInteger(options.maximumRetries)
      ? common.clamp(options.maximumRetries, 0, 3)
      : 2
    this.retryDelayMs = options.retryDelayMs === undefined
      ? 400
      : Math.max(0, common.finiteNumber(options.retryDelayMs,
        'Texture retry delay'))
    this.desired = new Map()
    this.retries = new Map()
    this.failed = new Map()
    this.retryTimers = new Map()
  }

  sync(draws) {
    const desired = new Set()
    this.desired.clear()
    for (let index = 0; index < draws.length; ++index) {
      const tile = draws[index].texture
      const key = common.textureKeyString(tile)
      desired.add(key)
      this.desired.set(key, tile)
      if (!this.cache.has(key) && !this.failed.has(key)) {
        this.schedule(key, tile)
      }
    }
    this.scheduler.cancelExcept(desired)
    this.cancelStaleRetries(desired)
  }

  schedule(key, tile) {
    this.scheduler.enqueue(key, () => {
      let url
      let task
      try {
        url = this.urlForTile(tile)
        task = imageTask(this.canvas, url)
      } catch (error) {
        this.failed.set(key, tile)
        this.onDiagnostic('texture_request_failed', {
          key,
          message: error.message || String(error)
        })
        this.renderer.requestRender()
        return { promise: Promise.resolve(), abort() {} }
      }
      task.promise.then((image) => {
        const asset = {
          image,
          texture: null,
          width: Number(image.width) || 1,
          height: Number(image.height) || 1,
          url
        }
        this.retries.delete(key)
        this.failed.delete(key)
        this.cache.set(key, asset, asset.width * asset.height * 4)
        this.renderer.requestRender()
      }).catch((error) => {
        const message = error.message || String(error)
        if (/cancelled/.test(message) || !this.desired.has(key)) {
          return
        }
        const attempt = (this.retries.get(key) || 0) + 1
        this.retries.set(key, attempt)
        if (attempt <= this.maximumRetries) {
          this.scheduleRetry(key, tile, attempt)
          this.onDiagnostic('texture_retry', { key, attempt, message })
          this.renderer.requestRender()
          return
        }
        this.failed.set(key, tile)
        this.onDiagnostic('texture_load_failed', { key, message })
        this.renderer.requestRender()
      })
      return task
    })
  }

  scheduleRetry(key, tile, attempt) {
    if (this.retryTimers.has(key)) {
      return
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      if (this.desired.has(key) && !this.cache.has(key) &&
        !this.failed.has(key)) {
        this.schedule(key, tile)
      }
    }, attempt * this.retryDelayMs)
    this.retryTimers.set(key, timer)
  }

  cancelStaleRetries(desired) {
    this.retryTimers.forEach((timer, key) => {
      if (!desired.has(key)) {
        clearTimeout(timer)
        this.retryTimers.delete(key)
      }
    })
    this.retries.forEach((value, key) => {
      if (!desired.has(key)) {
        this.retries.delete(key)
      }
    })
    this.failed.forEach((value, key) => {
      if (!desired.has(key)) {
        this.failed.delete(key)
      }
    })
  }

  retryFailed() {
    if (!this.failed.size && !this.retries.size) {
      return false
    }
    this.retryTimers.forEach((timer) => clearTimeout(timer))
    this.retryTimers.clear()
    this.retries.clear()
    this.failed.clear()
    this.desired.forEach((tile, key) => {
      if (!this.cache.has(key)) {
        this.schedule(key, tile)
      }
    })
    return true
  }

  get(tile) {
    const asset = this.cache.get(common.textureKeyString(tile))
    if (!asset) {
      return this.renderer.fallbackTexture
    }
    if (!asset.texture && !this.renderer.contextLost) {
      asset.texture = this.renderer.uploadTexture(asset.image,
        asset.width, asset.height)
    }
    return asset.texture || this.renderer.fallbackTexture
  }

  restoreContext() {
    this.cache.values().forEach((asset) => {
      asset.texture = null
    })
  }

  disposeAsset(asset) {
    if (asset && asset.texture && this.renderer.gl) {
      this.renderer.gl.deleteTexture(asset.texture)
    }
  }

  clear() {
    this.scheduler.clear()
    this.retryTimers.forEach((timer) => clearTimeout(timer))
    this.retryTimers.clear()
    this.desired.clear()
    this.retries.clear()
    this.failed.clear()
    this.cache.clear()
  }

  stats() {
    return Object.assign(this.cache.stats(), this.scheduler.stats(), {
      failed: this.failed.size
    })
  }
}

class TerraWebGlRenderer {
  constructor(canvas, options) {
    this.canvas = canvas
    this.options = options || {}
    this.onDiagnostic = this.options.onDiagnostic || (() => {})
    this.onContextChange = this.options.onContextChange || (() => {})
    this.requestRenderCallback = this.options.requestRender || (() => {})
    this.contextLost = false
    this.gl = null
    this.program = null
    this.attributes = null
    this.uniforms = null
    this.indexBuffer = null
    this.fallbackTexture = null
    this.uploadQueue = []
    this.current = null
    this.drawStats = { submitted: 0, queued: 0 }
    this.geometry = new common.LruCache({
      maximumEntries: this.options.maximumGeometryEntries || 192,
      maximumBytes: this.options.geometryCacheBytes || 16 * 1024 * 1024,
      dispose: (value) => this.disposeGeometry(value)
    })
    this.textures = new TextureStore(this, {
      urlForTile: this.options.urlForTile,
      onDiagnostic: this.onDiagnostic,
      maximumConcurrent: this.options.maximumTextureRequests || 3,
      maximumEntries: this.options.maximumTextureEntries || 128,
      maximumBytes: this.options.textureCacheBytes || 32 * 1024 * 1024,
      maximumRetries: this.options.maximumTextureRetries,
      retryDelayMs: this.options.textureRetryDelayMs
    })
    this.handleContextLost = (event) => this.contextWasLost(event)
    this.handleContextRestored = () => this.contextWasRestored()
    if (canvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextlost', this.handleContextLost)
      canvas.addEventListener('webglcontextrestored', this.handleContextRestored)
    }
    this.initialize(this.options.gl)
  }

  initialize(providedGl) {
    const gl = providedGl || this.canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      depth: true,
      preserveDrawingBuffer: false
    })
    if (!gl) {
      throw new Error('WebGL context creation failed')
    }
    this.gl = gl
    this.program = createProgram(gl)
    this.attributes = {
      position: gl.getAttribLocation(this.program, 'a_position'),
      uv: gl.getAttribLocation(this.program, 'a_uv')
    }
    this.uniforms = {
      projectionView: gl.getUniformLocation(this.program, 'u_projection_view'),
      origin: gl.getUniformLocation(this.program, 'u_origin'),
      texture: gl.getUniformLocation(this.program, 'u_texture')
    }
    common.invariant(this.attributes.position >= 0 && this.attributes.uv >= 0 &&
      this.uniforms.projectionView && this.uniforms.origin && this.uniforms.texture,
    'WebGL terrain shader locations are incomplete')
    this.indexBuffer = gl.createBuffer()
    this.fallbackTexture = this.createFallbackTexture()
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.disable(gl.CULL_FACE)
    gl.clearColor(0.025, 0.045, 0.07, 1.0)
  }

  capabilities() {
    const gl = this.gl
    return {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      version: gl.getParameter(gl.VERSION)
    }
  }

  resize(width, height) {
    if (!this.gl || this.contextLost) {
      return
    }
    this.gl.viewport(0, 0, width, height)
    this.requestRender()
  }

  setBudget(budget) {
    const value = budget || {}
    if (Number.isFinite(value.uploadBudgetMs) && value.uploadBudgetMs > 0) {
      this.options.uploadBudgetMs = value.uploadBudgetMs
    }
    if (Number.isFinite(value.geometryCacheBytes) &&
      value.geometryCacheBytes > 0) {
      this.geometry.maximumBytes = value.geometryCacheBytes
      this.geometry.evict()
    }
    if (Number.isFinite(value.textureCacheBytes) &&
      value.textureCacheBytes > 0) {
      this.textures.cache.maximumBytes = value.textureCacheBytes
      this.textures.cache.evict()
    }
    if (Number.isFinite(value.maximumTextureRequests) &&
      value.maximumTextureRequests > 0) {
      this.textures.scheduler.maximumConcurrent = Math.max(1,
        Math.floor(value.maximumTextureRequests))
    }
  }

  retryTextures() {
    return this.textures.retryFailed()
  }

  setFrame(frame, draws, positions, textureUv, indices) {
    common.invariant(frame && draws && positions && textureUv && indices,
      'Renderer frame data is incomplete')
    this.current = { frame, draws, positions, textureUv, indices }
    this.uploadIndexBuffer(indices)
    this.enqueueGeometry(draws, positions, textureUv)
    this.textures.sync(draws)
    this.requestRender()
  }

  requestRender() {
    this.requestRenderCallback()
  }

  render() {
    if (!this.gl || this.contextLost || !this.current) {
      return this.drawStats
    }
    this.processUploads()
    const gl = this.gl
    const current = this.current
    const relative = common.rowMajorToWebGlMatrix(
      common.relativeProjectionView(current.frame.projectionView,
        current.frame.cameraPosition))
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.uniformMatrix4fv(this.uniforms.projectionView, false, relative)
    gl.uniform1i(this.uniforms.texture, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    let submitted = 0
    for (let index = 0; index < current.draws.length; ++index) {
      const draw = current.draws[index]
      const geometry = this.geometry.get(draw.geometryKey)
      if (!geometry || !geometry.positionBuffer || !geometry.uvBuffer) {
        continue
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, geometry.positionBuffer)
      gl.enableVertexAttribArray(this.attributes.position)
      gl.vertexAttribPointer(this.attributes.position, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, geometry.uvBuffer)
      gl.enableVertexAttribArray(this.attributes.uv)
      gl.vertexAttribPointer(this.attributes.uv, 2, gl.FLOAT, false, 0, 0)
      gl.uniform3f(this.uniforms.origin,
        draw.origin[0] - current.frame.cameraPosition[0],
        draw.origin[1] - current.frame.cameraPosition[1],
        draw.origin[2] - current.frame.cameraPosition[2])
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(draw.texture))
      gl.drawElements(gl.TRIANGLE_STRIP, draw.indexCount, gl.UNSIGNED_SHORT,
        draw.firstIndex * 2)
      submitted += 1
    }
    const error = gl.getError()
    if (error !== gl.NO_ERROR) {
      this.onDiagnostic('webgl_error', { error })
    }
    this.drawStats = { submitted, queued: this.uploadQueue.length }
    return this.drawStats
  }

  enqueueGeometry(draws, positions, textureUv) {
    for (let index = 0; index < draws.length; ++index) {
      const draw = draws[index]
      const positionStart = draw.firstVertex * 3
      const positionEnd = positionStart + draw.vertexCount * 3
      const uvStart = draw.firstVertex * 2
      const uvEnd = uvStart + draw.vertexCount * 2
      const localPositions = positions.slice(positionStart, positionEnd)
      const localUv = textureUv.slice(uvStart, uvEnd)
      const key = geometryKey(draw, localPositions, localUv)
      draw.geometryKey = key
      if (!this.geometry.has(key) &&
        !this.uploadQueue.some((item) => item.key === key)) {
        this.uploadQueue.push({ key, positions: localPositions, uv: localUv })
      }
    }
  }

  processUploads() {
    const deadline = Date.now() + (this.options.uploadBudgetMs || 6)
    while (this.uploadQueue.length && Date.now() <= deadline) {
      const item = this.uploadQueue.shift()
      if (this.geometry.has(item.key)) {
        continue
      }
      const gl = this.gl
      const positionBuffer = gl.createBuffer()
      const uvBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, item.positions, gl.STATIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, item.uv, gl.STATIC_DRAW)
      this.geometry.set(item.key, {
        positionBuffer,
        uvBuffer,
        positions: item.positions,
        uv: item.uv
      }, item.positions.byteLength + item.uv.byteLength)
    }
    if (this.uploadQueue.length) {
      this.requestRender()
    }
  }

  uploadIndexBuffer(indices) {
    if (!this.gl || !this.indexBuffer) {
      return
    }
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, indices, this.gl.STATIC_DRAW)
  }

  createFallbackTexture() {
    const gl = this.gl
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
      gl.UNSIGNED_BYTE, new Uint8Array([25, 68, 98, 255]))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return texture
  }

  uploadTexture(image, width, height) {
    const gl = this.gl
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    // Surface-mesh V=0 is north; preserving the source's top row keeps rows aligned.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    const mipmapped = isPowerOfTwo(width) && isPowerOfTwo(height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
      mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (mipmapped) {
      gl.generateMipmap(gl.TEXTURE_2D)
    }
    return texture
  }

  contextWasLost(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault()
    }
    this.contextLost = true
    this.onContextChange({ lost: true })
  }

  contextWasRestored() {
    try {
      this.contextLost = false
      this.geometry.clear()
      this.uploadQueue = []
      this.initialize()
      this.textures.restoreContext()
      if (this.current) {
        this.uploadIndexBuffer(this.current.indices)
        this.enqueueGeometry(this.current.draws, this.current.positions,
          this.current.textureUv)
      }
      this.onContextChange({ lost: false })
      this.requestRender()
    } catch (error) {
      this.contextLost = true
      this.onDiagnostic('webgl_context_restore_failed', {
        message: error.message || String(error)
      })
    }
  }

  disposeGeometry(value) {
    if (!value || !this.gl) {
      return
    }
    if (value.positionBuffer) {
      this.gl.deleteBuffer(value.positionBuffer)
    }
    if (value.uvBuffer) {
      this.gl.deleteBuffer(value.uvBuffer)
    }
  }

  destroy() {
    this.textures.clear()
    this.geometry.clear()
    this.uploadQueue = []
    if (this.canvas && typeof this.canvas.removeEventListener === 'function') {
      this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
      this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored)
    }
    if (this.gl) {
      if (this.indexBuffer) {
        this.gl.deleteBuffer(this.indexBuffer)
      }
      if (this.fallbackTexture) {
        this.gl.deleteTexture(this.fallbackTexture)
      }
      if (this.program) {
        this.gl.deleteProgram(this.program)
      }
    }
    this.gl = null
  }

  stats() {
    return {
      geometry: this.geometry.stats(),
      textures: this.textures.stats(),
      draws: this.drawStats
    }
  }
}

module.exports = {
  TerraWebGlRenderer,
  geometryHash,
  geometryKey,
  isPowerOfTwo
}
