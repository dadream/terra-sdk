const wasmLoader = require('./terra_wasm')
const common = require('./terra_globe_common')
const { TerraWebGlRenderer } = require('./terra_webgl_renderer')

const STATUS_OK = 0
const STATUS_BUFFER_TOO_SMALL = 6
const TRANSFORM_CYLINDRICAL = 2
const REQUEST_ROOT = 1
const REQUEST_DETAIL = 2
const DEFAULT_FOV_RADIANS = 30.0 * (3.14 / 180.0)

const ABI_LAYOUT = {
  manifest: 80,
  viewport: 24,
  camera: 32,
  key: 16,
  texture: 16,
  request: 24,
  decision: 32,
  draw: 88,
  frame: 208,
  stats: 56
}

function statusError(operation, status) {
  return new Error(`${operation} failed with Terra status ${status}`)
}

function requireStatus(status, operation, allowed) {
  const accepted = allowed || [STATUS_OK]
  if (accepted.indexOf(status) < 0) {
    throw statusError(operation, status)
  }
  return status
}

function readU64(view, offset) {
  return view.getUint32(offset, true) +
    view.getUint32(offset + 4, true) * 4294967296
}

function writeKey(view, pointer, key) {
  view.setUint32(pointer, key.level, true)
  view.setInt32(pointer + 4, key.i, true)
  view.setInt32(pointer + 8, key.j, true)
  view.setInt32(pointer + 12, key.k, true)
}

function readKey(view, pointer) {
  return {
    level: view.getUint32(pointer, true),
    i: view.getInt32(pointer + 4, true),
    j: view.getInt32(pointer + 8, true),
    k: view.getInt32(pointer + 12, true)
  }
}

function requestWithWx(options) {
  common.invariant(typeof wx !== 'undefined' && typeof wx.request === 'function',
    'wx.request is unavailable')
  let request = null
  let rejectPromise = null
  let settled = false
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject
    request = wx.request({
      url: options.url,
      method: options.method || 'GET',
      responseType: options.responseType,
      timeout: options.timeout || 15000,
      success(response) {
        settled = true
        resolve(response)
      },
      fail(error) {
        settled = true
        reject(new Error(error && error.errMsg ? error.errMsg : 'wx.request failed'))
      }
    })
  })
  return {
    promise,
    abort() {
      if (!settled) {
        settled = true
        if (request && typeof request.abort === 'function') {
          request.abort()
        }
        rejectPromise(new Error('Terrain request was cancelled'))
      }
    }
  }
}

function parseJsonResponse(response, operation) {
  common.invariant(response && response.statusCode >= 200 && response.statusCode < 300,
    `${operation} returned an unsuccessful HTTP status`)
  if (typeof response.data === 'string') {
    return JSON.parse(response.data)
  }
  common.invariant(response.data && typeof response.data === 'object',
    `${operation} did not return JSON`)
  return response.data
}

class TerraAbi {
  constructor(module) {
    common.invariant(module && module.exports, 'Terra Wasm module is required')
    this.module = module
    this.exports = module.exports
    this.layout = this.readLayout()
    this.context = this.module.call('terra_create')
    common.invariant(this.context, 'terra_create returned null')
  }

  readLayout() {
    const exported = {
      manifest: 'terra_sizeof_manifest_v1',
      viewport: 'terra_sizeof_viewport_v1',
      camera: 'terra_sizeof_camera_v1',
      key: 'terra_sizeof_patch_key_v1',
      texture: 'terra_sizeof_texture_key_v1',
      request: 'terra_sizeof_request_v1',
      decision: 'terra_sizeof_patch_decision_v1',
      draw: 'terra_sizeof_draw_range_v1',
      frame: 'terra_sizeof_frame_v1',
      stats: 'terra_sizeof_stats_v1'
    }
    const layout = {}
    Object.keys(exported).forEach((name) => {
      layout[name] = this.module.call(exported[name])
      common.invariant(layout[name] === ABI_LAYOUT[name],
        `Unsupported Terra ABI ${name} size: ${layout[name]}`)
    })
    return layout
  }

  alloc(size) {
    return this.module.alloc(size)
  }

  free(pointer) {
    this.module.free(pointer)
  }

  loadManifest(manifest) {
    const pointer = this.alloc(this.layout.manifest)
    try {
      const view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.manifest, true)
      view.setUint32(pointer + 4, 1, true)
      view.setUint32(pointer + 8, manifest.formatVersion, true)
      view.setUint32(pointer + 12, manifest.patchDimension, true)
      view.setUint32(pointer + 16, TRANSFORM_CYLINDRICAL, true)
      view.setFloat64(pointer + 24, manifest.heightScale, true)
      view.setFloat64(pointer + 32, manifest.minimumU, true)
      view.setFloat64(pointer + 40, manifest.minimumV, true)
      view.setFloat64(pointer + 48, manifest.maximumU, true)
      view.setFloat64(pointer + 56, manifest.maximumV, true)
      view.setFloat64(pointer + 64, manifest.radius, true)
      view.setUint32(pointer + 72,
        manifest.texture.matrix_level_offset, true)
      view.setUint32(pointer + 76, manifest.texture.maximum_level, true)
      requireStatus(this.module.call('terra_load_manifest', this.context, pointer),
        'terra_load_manifest')
    } finally {
      this.free(pointer)
    }
  }

  setViewport(width, height, fovRadians) {
    const pointer = this.alloc(this.layout.viewport)
    try {
      const view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.viewport, true)
      view.setUint32(pointer + 4, width, true)
      view.setUint32(pointer + 8, height, true)
      view.setFloat64(pointer + 16, fovRadians, true)
      requireStatus(this.module.call('terra_set_viewport', this.context, pointer),
        'terra_set_viewport')
    } finally {
      this.free(pointer)
    }
  }

  setCamera(camera) {
    const pointer = this.alloc(this.layout.camera)
    try {
      const view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.camera, true)
      view.setFloat64(pointer + 8, camera.distance, true)
      view.setFloat64(pointer + 16, camera.tiltRadians, true)
      view.setFloat64(pointer + 24, camera.yawRadians, true)
      requireStatus(this.module.call('terra_set_camera', this.context, pointer),
        'terra_set_camera')
    } finally {
      this.free(pointer)
    }
  }

  update(lodThreshold) {
    requireStatus(this.module.call('terra_update', this.context, lodThreshold),
      'terra_update')
    return this.getFrame()
  }

  getFrame() {
    const pointer = this.alloc(this.layout.frame)
    try {
      let view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.frame, true)
      requireStatus(this.module.call('terra_get_frame', this.context, pointer),
        'terra_get_frame')
      view = this.module.refreshMemory().dataView
      const projectionView = new Float64Array(16)
      for (let index = 0; index < projectionView.length; ++index) {
        projectionView[index] = view.getFloat64(pointer + 64 + index * 8, true)
      }
      return {
        sequence: readU64(view, pointer + 8),
        decisionsComplete: view.getUint32(pointer + 16, true) !== 0,
        patchCount: view.getUint32(pointer + 20, true),
        requestCount: view.getUint32(pointer + 24, true),
        loadedRecordCount: view.getUint32(pointer + 28, true),
        failedRecordCount: view.getUint32(pointer + 32, true),
        cameraPosition: [
          view.getFloat64(pointer + 40, true),
          view.getFloat64(pointer + 48, true),
          view.getFloat64(pointer + 56, true)
        ],
        projectionView,
        drawCount: view.getUint32(pointer + 192, true),
        vertexCount: view.getUint32(pointer + 196, true),
        positionFloatCount: view.getUint32(pointer + 200, true),
        textureFloatCount: view.getUint32(pointer + 204, true)
      }
    } finally {
      this.free(pointer)
    }
  }

  getRequests() {
    const buffer = this.copyVector('terra_get_requests', this.layout.request)
    const view = new DataView(buffer)
    const result = []
    for (let offset = 0; offset < buffer.byteLength; offset += this.layout.request) {
      result.push({
        kind: view.getUint32(offset + 4, true),
        key: readKey(view, offset + 8)
      })
    }
    return result
  }

  getDrawRanges() {
    const buffer = this.copyVector('terra_get_draw_ranges', this.layout.draw)
    const view = new DataView(buffer)
    const result = []
    for (let offset = 0; offset < buffer.byteLength; offset += this.layout.draw) {
      result.push({
        fragment: view.getUint32(offset + 4, true),
        key: readKey(view, offset + 8),
        texture: {
          level: view.getUint32(offset + 24, true),
          matrix: view.getInt32(offset + 28, true),
          row: view.getInt32(offset + 32, true),
          column: view.getInt32(offset + 36, true)
        },
        firstVertex: view.getUint32(offset + 40, true),
        vertexCount: view.getUint32(offset + 44, true),
        firstIndex: view.getUint32(offset + 48, true),
        indexCount: view.getUint32(offset + 52, true),
        origin: [
          view.getFloat64(offset + 56, true),
          view.getFloat64(offset + 64, true),
          view.getFloat64(offset + 72, true)
        ],
        flags: view.getUint32(offset + 80, true)
      })
    }
    return result
  }

  getPositions() {
    return new Float32Array(this.copyVector('terra_get_position_buffer', 4))
  }

  getTextureUv() {
    return new Float32Array(this.copyVector('terra_get_texture_uv_buffer', 4))
  }

  getIndices() {
    return new Uint16Array(this.copyVector('terra_get_index_buffer', 2))
  }

  submitRecord(kind, key, bytes) {
    const keyPointer = this.alloc(this.layout.key)
    const dataPointer = this.alloc(bytes.byteLength)
    try {
      let memory = this.module.refreshMemory()
      writeKey(memory.dataView, keyPointer, key)
      memory.bytes.set(bytes, dataPointer)
      requireStatus(this.module.call('terra_submit_record', this.context, kind,
        keyPointer, dataPointer, bytes.byteLength), 'terra_submit_record')
    } finally {
      this.free(dataPointer)
      this.free(keyPointer)
    }
  }

  failRecord(kind, key) {
    const pointer = this.alloc(this.layout.key)
    try {
      writeKey(this.module.refreshMemory().dataView, pointer, key)
      requireStatus(this.module.call('terra_fail_record', this.context, kind,
        pointer), 'terra_fail_record')
    } finally {
      this.free(pointer)
    }
  }

  copyVector(functionName, elementSize) {
    const countPointer = this.alloc(4)
    try {
      let memory = this.module.refreshMemory()
      memory.dataView.setUint32(countPointer, 0, true)
      const status = this.module.call(functionName, this.context, 0, 0,
        countPointer)
      requireStatus(status, `${functionName} sizing`,
        [STATUS_OK, STATUS_BUFFER_TOO_SMALL])
      memory = this.module.refreshMemory()
      const count = memory.dataView.getUint32(countPointer, true)
      if (count === 0) {
        return new ArrayBuffer(0)
      }
      const byteLength = count * elementSize
      const pointer = this.alloc(byteLength)
      try {
        requireStatus(this.module.call(functionName, this.context, pointer,
          count, countPointer), functionName)
        memory = this.module.refreshMemory()
        return memory.bytes.slice(pointer, pointer + byteLength).buffer
      } finally {
        this.free(pointer)
      }
    } finally {
      this.free(countPointer)
    }
  }

  destroy() {
    if (this.context) {
      this.module.call('terra_destroy', this.context)
      this.context = 0
    }
  }
}

function defaultCamera(radius, width, height, fovRadians) {
  const aspect = width / height
  const halfFov = Math.atan(Math.tan(fovRadians / 2) * Math.min(aspect, 1))
  return {
    distance: 1.05 * radius / Math.sin(halfFov),
    tiltRadians: 0,
    yawRadians: 0
  }
}

class TerraGlobeRuntime {
  constructor(options) {
    this.options = options || {}
    this.canvas = this.options.canvas
    common.invariant(this.canvas, 'A Mini Program canvas is required')
    this.fovRadians = this.options.verticalFovRadians || DEFAULT_FOV_RADIANS
    this.serviceOrigin = this.options.serviceOrigin || ''
    this.request = this.options.request || requestWithWx
    this.maximumTerrainRequests = Number.isInteger(
      this.options.maximumTerrainRequests)
      ? common.clamp(this.options.maximumTerrainRequests, 1, 8)
      : 4
    this.maximumTerrainRetries = Number.isInteger(
      this.options.maximumTerrainRetries)
      ? common.clamp(this.options.maximumTerrainRetries, 0, 5)
      : 2
    this.terrainRetryDelayMs = this.options.terrainRetryDelayMs === undefined
      ? 400
      : Math.max(0, common.finiteNumber(this.options.terrainRetryDelayMs,
        'Terrain retry delay'))
    this.recordCache = new common.LruCache({
      maximumEntries: this.options.maximumRecordEntries || 256,
      maximumBytes: this.options.recordCacheBytes || 8 * 1024 * 1024
    })
    this.scheduler = new common.RequestScheduler(this.maximumTerrainRequests)
    this.desiredRequests = new Map()
    this.retries = new Map()
    this.failedRequests = new Set()
    this.diagnosticTimes = new Map()
    this.diagnostics = []
    this.refreshPending = false
    this.refreshing = false
    this.destroyed = false
    this.manifest = null
    this.abi = null
    this.renderer = null
    this.budget = null
    this.camera = null
    this.lastFrame = null
    this.lastError = ''
  }

  static async create(options) {
    const runtime = new TerraGlobeRuntime(options)
    await runtime.initialize()
    return runtime
  }

  async initialize() {
    const rawManifest = this.options.manifest || await this.fetchManifest()
    const imagery = this.options.imagery || null
    if (imagery && imagery.texture) {
      common.invariant(typeof imagery.textureId === 'string' &&
        imagery.textureId.length > 0, 'Imagery profile texture ID is required')
      common.invariant(typeof imagery.urlForTile === 'function',
        'Imagery profile URL resolver is required')
    }
    const manifestForValidation = imagery && imagery.texture
      ? Object.assign({}, rawManifest, { textures: [imagery.texture] })
      : rawManifest
    this.manifest = common.validateManifest(manifestForValidation,
      imagery && imagery.texture ? imagery.textureId : this.options.textureId)
    this.textureUrlResolver = imagery && imagery.texture && imagery.urlForTile
    const viewport = this.options.viewport || { width: 1, height: 1, devicePixelRatio: 1 }
    this.budget = common.deriveFrameBudget(viewport, {})
    this.canvas.width = this.budget.physicalWidth
    this.canvas.height = this.budget.physicalHeight
    const rendererOptions = {
      urlForTile: (tile) => this.textureUrl(tile),
      onDiagnostic: (kind, detail) => this.diagnostic(kind, detail),
      onContextChange: (event) => this.contextChanged(event),
      requestRender: () => this.scheduleRender(),
      geometryCacheBytes: this.budget.geometryCacheBytes,
      textureCacheBytes: this.budget.textureCacheBytes,
      uploadBudgetMs: this.budget.uploadBudgetMs,
      maximumTextureRequests: Math.max(1,
        this.budget.maximumConcurrentRequests - 1),
      maximumTextureRetries: this.options.maximumTextureRetries,
      textureRetryDelayMs: this.options.textureRetryDelayMs
    }
    const rendererFactory = this.options.rendererFactory ||
      ((canvas, options) => new TerraWebGlRenderer(canvas, options))
    this.renderer = rendererFactory(this.canvas, rendererOptions)
    const rendererMethods = ['capabilities', 'resize', 'setFrame', 'render',
      'stats', 'destroy']
    rendererMethods.forEach((name) => common.invariant(
      this.renderer && typeof this.renderer[name] === 'function',
      `Terra renderer is missing ${name}`))
    this.budget = common.deriveFrameBudget(viewport, this.renderer.capabilities())
    this.applyBudget()
    this.canvas.width = this.budget.physicalWidth
    this.canvas.height = this.budget.physicalHeight
    this.renderer.resize(this.budget.physicalWidth, this.budget.physicalHeight)
    if (this.options.abi) {
      this.abi = this.options.abi
    } else {
      const module = this.options.terraModule || await wasmLoader.instantiateTerraWasm(
        this.options.wasmPath)
      this.abi = new TerraAbi(module)
    }
    const abiMethods = ['loadManifest', 'setViewport', 'setCamera', 'update',
      'getRequests', 'getDrawRanges', 'getPositions', 'getTextureUv',
      'getIndices', 'submitRecord', 'failRecord', 'destroy']
    abiMethods.forEach((name) => common.invariant(
      this.abi && typeof this.abi[name] === 'function',
      `Terra ABI is missing ${name}`))
    this.abi.loadManifest(this.manifest)
    this.abi.setViewport(this.budget.physicalWidth, this.budget.physicalHeight,
      this.fovRadians)
    this.camera = defaultCamera(this.manifest.radius, this.budget.physicalWidth,
      this.budget.physicalHeight, this.fovRadians)
    this.refresh()
  }

  async fetchManifest() {
    common.invariant(this.serviceOrigin, 'Terrain service origin is required')
    const url = common.joinServiceUrl(this.serviceOrigin,
      this.options.manifestPath || '/terra/v1/datasets/globe/manifest')
    const task = this.request({ url, method: 'GET', timeout: 15000 })
    const response = await task.promise
    return parseJsonResponse(response, 'Terrain manifest request')
  }

  resize(viewport) {
    common.invariant(!this.destroyed, 'Terra globe runtime is destroyed')
    this.budget = common.deriveFrameBudget(viewport, this.renderer.capabilities())
    this.applyBudget()
    this.canvas.width = this.budget.physicalWidth
    this.canvas.height = this.budget.physicalHeight
    this.renderer.resize(this.budget.physicalWidth, this.budget.physicalHeight)
    this.abi.setViewport(this.budget.physicalWidth, this.budget.physicalHeight,
      this.fovRadians)
    this.refresh()
  }

  applyBudget() {
    const maximumTerrainRequests = Math.max(1, Math.min(
      this.maximumTerrainRequests, this.budget.maximumConcurrentRequests))
    this.scheduler.maximumConcurrent = maximumTerrainRequests
    if (this.renderer && typeof this.renderer.setBudget === 'function') {
      this.renderer.setBudget({
        geometryCacheBytes: this.budget.geometryCacheBytes,
        textureCacheBytes: this.budget.textureCacheBytes,
        uploadBudgetMs: this.budget.uploadBudgetMs,
        maximumTextureRequests: Math.max(1, maximumTerrainRequests - 1)
      })
    }
  }

  reset() {
    this.camera = defaultCamera(this.manifest.radius, this.budget.physicalWidth,
      this.budget.physicalHeight, this.fovRadians)
    this.refresh()
  }

  retryFailed() {
    common.invariant(!this.destroyed, 'Terra globe runtime is destroyed')
    const terrainRetry = this.failedRequests.size || this.retries.size
    const textureRetry = this.renderer &&
      typeof this.renderer.retryTextures === 'function' &&
      this.renderer.retryTextures()
    if (!terrainRetry && !textureRetry) {
      return false
    }
    this.failedRequests.clear()
    this.retries.clear()
    this.lastError = ''
    if (terrainRetry) {
      this.refresh()
    } else {
      this.scheduleRender()
      this.publishState()
    }
    return true
  }

  zoom(scale) {
    common.finiteNumber(scale, 'Zoom scale')
    this.camera.distance = common.clamp(this.camera.distance * scale,
      this.manifest.radius * 1.001, this.manifest.radius * 20)
    this.refresh()
  }

  applyCamera(change) {
    const value = change || {}
    if (value.zoomScale !== undefined) {
      common.finiteNumber(value.zoomScale, 'Zoom scale')
      this.camera.distance = common.clamp(this.camera.distance * value.zoomScale,
        this.manifest.radius * 1.001, this.manifest.radius * 20)
    }
    if (value.tiltDelta !== undefined) {
      this.camera.tiltRadians = common.clamp(this.camera.tiltRadians +
        common.finiteNumber(value.tiltDelta, 'Tilt delta'), -1.45, 1.45)
    }
    if (value.yawDelta !== undefined) {
      const fullTurn = Math.PI * 2
      this.camera.yawRadians = (this.camera.yawRadians +
        common.finiteNumber(value.yawDelta, 'Yaw delta')) % fullTurn
    }
    this.refresh()
  }

  setTiltRadians(value) {
    this.camera.tiltRadians = common.clamp(common.finiteNumber(value, 'Tilt'),
      -1.45, 1.45)
    this.refresh()
  }

  tilt45() {
    this.setTiltRadians(-Math.PI / 4)
  }

  rotateYaw(delta) {
    const fullTurn = Math.PI * 2
    this.camera.yawRadians = (this.camera.yawRadians +
      common.finiteNumber(delta, 'Yaw')) % fullTurn
    this.refresh()
  }

  refresh() {
    if (this.destroyed) {
      return
    }
    if (this.refreshing) {
      this.refreshPending = true
      return
    }
    this.refreshing = true
    try {
      this.abi.setCamera(this.camera)
      const frame = this.abi.update(this.budget.lodThreshold)
      const requests = this.abi.getRequests()
      const draws = this.abi.getDrawRanges()
      const positions = this.abi.getPositions()
      const textureUv = this.abi.getTextureUv()
      const indices = this.abi.getIndices()
      this.lastFrame = frame
      this.renderer.setFrame(frame, draws, positions, textureUv, indices)
      this.syncTerrainRequests(requests)
      this.lastError = ''
      this.scheduleRender()
      this.publishState()
    } catch (error) {
      this.lastError = common.redactSensitiveText(error.message || String(error))
      this.diagnostic('runtime_refresh_failed', { message: this.lastError })
      this.publishState()
    } finally {
      this.refreshing = false
      if (this.refreshPending) {
        this.refreshPending = false
        this.scheduleRefresh()
      }
    }
  }

  scheduleRefresh() {
    if (this.destroyed || this.refreshPending) {
      return
    }
    this.refreshPending = true
    Promise.resolve().then(() => {
      if (!this.destroyed) {
        this.refreshPending = false
        this.refresh()
      }
    })
  }

  scheduleRender() {
    if (this.destroyed || !this.renderer) {
      return
    }
    if (this.renderScheduled) {
      return
    }
    this.renderScheduled = true
    const render = () => {
      this.renderScheduled = false
      if (!this.destroyed) {
        this.renderer.render()
        this.publishState()
      }
    }
    if (this.canvas && typeof this.canvas.requestAnimationFrame === 'function') {
      this.canvas.requestAnimationFrame(render)
    } else {
      setTimeout(render, 0)
    }
  }

  syncTerrainRequests(requests) {
    const desired = new Set()
    this.desiredRequests.clear()
    requests.forEach((request) => {
      const key = common.patchKeyString(request.kind, request.key)
      desired.add(key)
      this.desiredRequests.set(key, request)
      const cached = this.recordCache.get(key)
      if (cached) {
        try {
          this.abi.submitRecord(request.kind, request.key, cached)
          this.scheduleRefresh()
        } catch (error) {
          this.recordCache.delete(key)
          this.diagnostic('record_cache_rejected', { key, message: error.message })
        }
        return
      }
      if (!this.failedRequests.has(key)) {
        this.enqueueTerrainRequest(key, request)
      }
    })
    this.scheduler.cancelExcept(desired)
  }

  enqueueTerrainRequest(key, request) {
    this.scheduler.enqueue(key, () => this.startTerrainRequest(key, request))
  }

  startTerrainRequest(key, request) {
    const endpoint = request.kind === REQUEST_ROOT
      ? this.manifest.rootEndpoint
      : this.manifest.detailEndpoint
    const url = common.joinServiceUrl(this.serviceOrigin,
      common.replaceTemplate(endpoint, request.key))
    let task
    try {
      task = this.request({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 15000
      })
      common.invariant(task && task.promise,
        'Terrain request must return a cancellable promise')
    } catch (error) {
      this.handleTerrainFailure(key, request, error)
      return { promise: Promise.resolve(), abort() {} }
    }
    task.promise.then((response) => {
      if (!this.desiredRequests.has(key) || this.destroyed) {
        return
      }
      common.invariant(response.statusCode >= 200 && response.statusCode < 300,
        `Terrain record returned HTTP ${response.statusCode}`)
      const bytes = common.validateRecordPayload(response.data, response.header)
      this.recordCache.set(key, bytes.slice(), bytes.byteLength)
      this.abi.submitRecord(request.kind, request.key, bytes)
      this.retries.delete(key)
      this.scheduleRefresh()
    }).catch((error) => this.handleTerrainFailure(key, request, error))
    return task
  }

  handleTerrainFailure(key, request, error) {
    if (this.destroyed || !this.desiredRequests.has(key) ||
      /cancelled/.test(error && error.message ? error.message : '')) {
      return
    }
    const attempt = (this.retries.get(key) || 0) + 1
    this.retries.set(key, attempt)
    if (attempt <= this.maximumTerrainRetries) {
      const delay = attempt * this.terrainRetryDelayMs
      setTimeout(() => {
        if (!this.destroyed && this.desiredRequests.has(key)) {
          this.enqueueTerrainRequest(key, request)
        }
      }, delay)
      this.diagnostic('terrain_retry', { key, attempt,
        message: error && error.message ? error.message : String(error) })
      return
    }
    this.failedRequests.add(key)
    try {
      this.abi.failRecord(request.kind, request.key)
    } catch (failure) {
      this.diagnostic('terrain_failure_recording_failed', {
        key, message: failure.message || String(failure) })
    }
    this.diagnostic('terrain_request_failed', { key,
      message: error && error.message ? error.message : String(error) })
    this.scheduleRefresh()
  }

  textureUrl(tile) {
    const url = this.textureUrlResolver
      ? this.textureUrlResolver(tile)
      : common.replaceTemplate(this.manifest.texture.url_template, {
        z: tile.matrix,
        x: tile.column,
        y: tile.row
      })
    common.invariant(/^https:\/\//.test(url), 'Texture URL must use HTTPS')
    return url
  }

  contextChanged(event) {
    this.diagnostic(event.lost ? 'webgl_context_lost' : 'webgl_context_restored', {})
    if (!event.lost) {
      this.scheduleRefresh()
    }
    this.publishState()
  }

  diagnostic(kind, detail) {
    const now = Date.now()
    const previous = this.diagnosticTimes.get(kind) || 0
    if (now - previous < 2000) {
      return
    }
    this.diagnosticTimes.set(kind, now)
    const sanitizedDetail = common.sanitizeDiagnosticDetail(detail)
    this.diagnostics.push({ kind, detail: sanitizedDetail, at: now })
    if (this.diagnostics.length > 32) {
      this.diagnostics.shift()
    }
    if (typeof this.options.onDiagnostic === 'function') {
      this.options.onDiagnostic(kind, sanitizedDetail)
    }
  }

  state() {
    const renderer = this.renderer ? this.renderer.stats() : null
    return {
      schema: 'terra.miniprogram.globe-runtime.v1',
      datasetId: this.manifest && this.manifest.datasetId,
      imageryId: this.manifest && this.manifest.texture.id,
      frame: this.lastFrame && {
        sequence: this.lastFrame.sequence,
        patchCount: this.lastFrame.patchCount,
        requestCount: this.lastFrame.requestCount,
        loadedRecordCount: this.lastFrame.loadedRecordCount,
        failedRecordCount: this.lastFrame.failedRecordCount,
        drawCount: this.lastFrame.drawCount,
        vertexCount: this.lastFrame.vertexCount
      },
      camera: this.camera && Object.assign({}, this.camera),
      budget: this.budget,
      terrain: Object.assign(this.recordCache.stats(), this.scheduler.stats(), {
        failedRequestCount: this.failedRequests.size
      }),
      renderer,
      contextLost: this.renderer ? this.renderer.contextLost : false,
      error: this.lastError,
      diagnostics: this.diagnostics.slice(-8)
    }
  }

  publishState() {
    if (typeof this.options.onState === 'function') {
      this.options.onState(this.state())
    }
  }

  destroy() {
    this.destroyed = true
    this.scheduler.clear()
    this.recordCache.clear()
    if (this.renderer) {
      this.renderer.destroy()
    }
    if (this.abi) {
      this.abi.destroy()
    }
  }
}

module.exports = {
  ABI_LAYOUT,
  REQUEST_DETAIL,
  REQUEST_ROOT,
  STATUS_BUFFER_TOO_SMALL,
  STATUS_OK,
  TerraAbi,
  TerraGlobeRuntime,
  defaultCamera,
  parseJsonResponse,
  requestWithWx
}
