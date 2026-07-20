const wasmLoader = require('./terra_wasm')
const common = require('./terra_globe_common')
const { TerraWebGlRenderer } = require('./terra_webgl_renderer')

const STATUS_OK = 0
const STATUS_BUFFER_TOO_SMALL = 6
const TRANSFORM_PLANAR = 1
const TRANSFORM_CYLINDRICAL = 2
const REQUEST_ROOT = 1
const REQUEST_DETAIL = 2
const DEFAULT_FOV_RADIANS = 30.0 * (3.14 / 180.0)
const DEGREES_TO_RADIANS = Math.PI / 180
const RADIANS_TO_DEGREES = 180 / Math.PI
const MIN_TILT_RADIANS = -80 * DEGREES_TO_RADIANS
const MAX_TILT_RADIANS = 0

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

function statusError(operation, status, detail) {
  const suffix = detail ? `: ${detail}` : ''
  return new Error(
    `${operation} failed with Terra status ${status}${suffix}`)
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

function manifestForImagerySource(rawManifest, source, expectedKind) {
  common.invariant(source && typeof source.id === 'string' && source.id.length > 0,
    'Imagery source ID is required')
  common.invariant(typeof source.resolveTile === 'function',
    'Imagery source resolver is required')
  common.invariant(!source.tileScheme || source.tileScheme === expectedKind,
    `Imagery tile scheme must be ${expectedKind}`)
  const textures = Array.isArray(rawManifest.textures)
    ? rawManifest.textures : []
  const configuredTexture = source.texture &&
    source.texture.kind === expectedKind ? source.texture : null
  const base = configuredTexture || textures.find((texture) => texture &&
    texture.kind === expectedKind)
  common.invariant(base, `Manifest has no ${expectedKind} texture descriptor`)
  const texture = Object.assign({}, base, { id: source.id })
  if (source.matrixLevelOffset !== undefined) {
    common.invariant(Number.isInteger(source.matrixLevelOffset) &&
      source.matrixLevelOffset >= 0 && source.matrixLevelOffset <= 28,
    'Imagery matrix level offset is invalid')
    texture.matrix_level_offset = source.matrixLevelOffset
  }
  if (source.maximumLevel !== undefined) {
    common.invariant(Number.isInteger(source.maximumLevel) &&
      source.maximumLevel >= 0 && source.maximumLevel <= 28,
    'Imagery maximum level is invalid')
    texture.maximum_level = source.maximumLevel
  }
  if (source.minimumLevel !== undefined) {
    common.invariant(source.minimumLevel === 0,
      'Imagery minimum level must be zero in V1')
  }
  return Object.assign({}, rawManifest, { textures: [texture] })
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

  lastError() {
    const countPointer = this.alloc(4)
    try {
      let memory = this.module.refreshMemory()
      memory.dataView.setUint32(countPointer, 0, true)
      const sizing = this.module.call('terra_get_last_error', this.context,
        0, 0, countPointer)
      memory = this.module.refreshMemory()
      const count = memory.dataView.getUint32(countPointer, true)
      if (sizing !== STATUS_BUFFER_TOO_SMALL || count <= 1) {
        return ''
      }
      const pointer = this.alloc(count)
      try {
        const status = this.module.call('terra_get_last_error', this.context,
          pointer, count, countPointer)
        if (status !== STATUS_OK) {
          return ''
        }
        memory = this.module.refreshMemory()
        let result = ''
        for (let index = 0; index + 1 < count; ++index) {
          result += String.fromCharCode(memory.bytes[pointer + index])
        }
        return result
      } finally {
        this.free(pointer)
      }
    } catch (error) {
      return ''
    } finally {
      this.free(countPointer)
    }
  }

  loadManifest(manifest) {
    const pointer = this.alloc(this.layout.manifest)
    try {
      const view = this.module.refreshMemory().dataView
      view.setUint32(pointer, this.layout.manifest, true)
      view.setUint32(pointer + 4, 1, true)
      view.setUint32(pointer + 8, manifest.formatVersion, true)
      view.setUint32(pointer + 12, manifest.patchDimension, true)
      view.setUint32(pointer + 16,
        manifest.transform === 'planar' ? TRANSFORM_PLANAR : TRANSFORM_CYLINDRICAL, true)
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

  setGlobeTarget(longitudeDegrees, latitudeDegrees) {
    requireStatus(this.module.call('terra_set_globe_target', this.context,
      longitudeDegrees, latitudeDegrees), 'terra_set_globe_target')
  }

  setPlanarTarget(x, y) {
    requireStatus(this.module.call('terra_set_planar_target', this.context,
      x, y), 'terra_set_planar_target')
  }

  setPlanarLevel(targetLevel) {
    requireStatus(this.module.call('terra_set_planar_level', this.context,
      targetLevel), 'terra_set_planar_level')
  }

  update(lodThreshold) {
    const status = this.module.call('terra_update', this.context, lodThreshold)
    if (status !== STATUS_OK) {
      throw statusError('terra_update', status, this.lastError())
    }
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

  retryRecord(kind, key) {
    const pointer = this.alloc(this.layout.key)
    try {
      writeKey(this.module.refreshMemory().dataView, pointer, key)
      requireStatus(this.module.call('terra_retry_record', this.context, kind,
        pointer), 'terra_retry_record')
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

function geographicCamera(radius, width, height, fovRadians, target) {
  const camera = defaultCamera(radius, width, height, fovRadians)
  camera.longitudeDegrees = 0
  camera.latitudeDegrees = 0
  if (!target) {
    return camera
  }
  const longitude = common.finiteNumber(target.longitudeDegrees,
    'Initial target longitude')
  const latitude = common.finiteNumber(target.latitudeDegrees,
    'Initial target latitude')
  common.invariant(longitude >= -180 && longitude <= 180,
    'Initial target longitude is outside [-180, 180]')
  common.invariant(latitude >= -90 && latitude <= 90,
    'Initial target latitude is outside [-90, 90]')
  camera.longitudeDegrees = longitude
  camera.latitudeDegrees = latitude
  return camera
}

function wrapDegrees(value) {
  return ((value + 180) % 360 + 360) % 360 - 180
}

function wrapRadians(value) {
  const fullTurn = Math.PI * 2
  return ((value + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI
}

function planarCamera(manifest, width, height, fovRadians, tiltRadians,
  initialTarget) {
  const terrainWidth = manifest.maximumU - manifest.minimumU
  const terrainHeight = manifest.maximumV - manifest.minimumV
  const aspect = width / height
  const tangent = Math.tan(fovRadians / 2)
  const verticalDistance = 0.5 * terrainHeight / tangent
  const horizontalDistance = 0.5 * terrainWidth / (tangent * aspect)
  const target = initialTarget || {}
  const x = target.x === undefined
    ? 0.5 * (manifest.minimumU + manifest.maximumU)
    : common.finiteNumber(target.x, 'Initial planar target X')
  const y = target.y === undefined
    ? 0.5 * (manifest.minimumV + manifest.maximumV)
    : common.finiteNumber(target.y, 'Initial planar target Y')
  common.invariant(x >= manifest.minimumU && x <= manifest.maximumU &&
    y >= manifest.minimumV && y <= manifest.maximumV,
  'Initial planar target is outside dataset bounds')
  return {
    distance: 1.2 * Math.max(verticalDistance, horizontalDistance),
    tiltRadians,
    yawRadians: 0,
    x,
    y
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
    this.failedRequests = new Map()
    this.diagnosticTimes = new Map()
    this.diagnostics = []
    this.refreshPending = false
    this.refreshing = false
    this.destroyed = false
    this.paused = false
    this.manifest = null
    this.abi = null
    this.renderer = null
    this.budget = null
    this.camera = null
    this.lastFrame = null
    this.lastSurface = null
    this.lastError = ''
    this.cameraAnimation = null
  }

  static async create(options) {
    const runtime = new TerraGlobeRuntime(options)
    await runtime.initialize()
    return runtime
  }

  async initialize() {
    const rawManifest = this.options.manifest || await this.fetchManifest()
    this.manifest = this.validateRuntimeManifest(rawManifest)
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
      mode: this.renderMode,
      heightRange: this.options.heightRange,
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
    const abiMethods = this.requiredAbiMethods()
    abiMethods.forEach((name) => common.invariant(
      this.abi && typeof this.abi[name] === 'function',
      `Terra ABI is missing ${name}`))
    this.abi.loadManifest(this.manifest)
    this.abi.setViewport(this.budget.physicalWidth, this.budget.physicalHeight,
      this.fovRadians)
    this.configureAbi()
    this.camera = this.createInitialCamera()
    this.refresh()
  }

  validateRuntimeManifest(rawManifest) {
    const imagery = this.options.imagery || null
    if (imagery && typeof imagery.resolveTile === 'function') {
      this.textureUrlResolver = imagery.resolveTile
      return common.validateManifest(manifestForImagerySource(
        rawManifest, imagery, 'global-geodetic'), imagery.id)
    }
    if (imagery && imagery.texture) {
      common.invariant(typeof imagery.textureId === 'string' &&
        imagery.textureId.length > 0, 'Imagery profile texture ID is required')
      common.invariant(typeof imagery.urlForTile === 'function',
        'Imagery profile URL resolver is required')
    }
    const manifestForValidation = imagery && imagery.texture
      ? Object.assign({}, rawManifest, { textures: [imagery.texture] })
      : rawManifest
    this.textureUrlResolver = imagery && imagery.texture && imagery.urlForTile
    return common.validateManifest(manifestForValidation,
      imagery && imagery.texture ? imagery.textureId : this.options.textureId)
  }

  requiredAbiMethods() {
    const methods = ['loadManifest', 'setViewport', 'setCamera', 'update',
      'getRequests', 'getDrawRanges', 'getPositions', 'getTextureUv',
      'getIndices', 'submitRecord', 'failRecord', 'retryRecord', 'destroy']
    if (this.manifest && this.manifest.transform === 'cylindrical') {
      methods.splice(3, 0, 'setGlobeTarget')
    }
    return methods
  }

  configureAbi() {}

  createInitialCamera() {
    return geographicCamera(this.manifest.radius,
      this.budget.physicalWidth, this.budget.physicalHeight, this.fovRadians,
      this.options.initialTarget)
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

  viewMode() {
    return this.manifest.transform === 'planar' ? 'planar' : 'globe'
  }

  rangeLimits() {
    return {
      minimum: this.manifest.radius * 1.001,
      maximum: this.manifest.radius * 20
    }
  }

  normalizeView(view) {
    common.invariant(view && typeof view === 'object', 'ViewState is required')
    common.invariant(!view.schema || view.schema === 'terra.view-state.v1',
      'ViewState schema is unsupported')
    const mode = this.viewMode()
    common.invariant(!view.mode || view.mode === mode,
      `ViewState mode must be ${mode}`)
    const target = view.target || {}
    const longitudeDegrees = common.finiteNumber(
      target.longitudeDegrees, 'View target longitude')
    const latitudeDegrees = common.finiteNumber(
      target.latitudeDegrees, 'View target latitude')
    common.invariant(longitudeDegrees >= -180 && longitudeDegrees <= 180 &&
      latitudeDegrees >= -90 && latitudeDegrees <= 90,
    'View target is outside globe bounds')
    const limits = this.rangeLimits()
    const rangeMeters = common.finiteNumber(view.rangeMeters, 'View range')
    common.invariant(rangeMeters >= limits.minimum &&
      rangeMeters <= limits.maximum, 'View range is outside runtime limits')
    const headingDegrees = common.finiteNumber(
      view.headingDegrees, 'View heading')
    const tiltDegrees = common.finiteNumber(view.tiltDegrees, 'View tilt')
    common.invariant(tiltDegrees >= 0 && tiltDegrees <= 80,
      'View tilt is outside [0, 80]')
    return {
      schema: 'terra.view-state.v1',
      mode,
      target: {
        longitudeDegrees,
        latitudeDegrees,
        heightMeters: target.heightMeters === undefined ? 0 :
          common.finiteNumber(target.heightMeters, 'View target height')
      },
      rangeMeters,
      headingDegrees: wrapDegrees(headingDegrees),
      tiltDegrees
    }
  }

  getView() {
    return {
      schema: 'terra.view-state.v1',
      mode: this.viewMode(),
      target: {
        longitudeDegrees: this.camera.longitudeDegrees,
        latitudeDegrees: this.camera.latitudeDegrees,
        heightMeters: 0
      },
      rangeMeters: this.camera.distance,
      headingDegrees: wrapDegrees(this.camera.yawRadians * RADIANS_TO_DEGREES),
      tiltDegrees: this.camera.tiltRadians === 0 ? 0 :
        -this.camera.tiltRadians * RADIANS_TO_DEGREES
    }
  }

  assignView(view) {
    this.camera.longitudeDegrees = view.target.longitudeDegrees
    this.camera.latitudeDegrees = view.target.latitudeDegrees
    this.camera.distance = view.rangeMeters
    this.camera.yawRadians = view.headingDegrees * DEGREES_TO_RADIANS
    this.camera.tiltRadians = -view.tiltDegrees * DEGREES_TO_RADIANS
  }

  interpolateView(start, target, t, headingDelta) {
    return {
      schema: 'terra.view-state.v1',
      mode: start.mode,
      target: {
        longitudeDegrees: start.target.longitudeDegrees +
          wrapDegrees(target.target.longitudeDegrees -
            start.target.longitudeDegrees) * t,
        latitudeDegrees: start.target.latitudeDegrees +
          (target.target.latitudeDegrees - start.target.latitudeDegrees) * t,
        heightMeters: start.target.heightMeters +
          (target.target.heightMeters - start.target.heightMeters) * t
      },
      rangeMeters: start.rangeMeters +
        (target.rangeMeters - start.rangeMeters) * t,
      headingDegrees: start.headingDegrees + headingDelta * t,
      tiltDegrees: start.tiltDegrees +
        (target.tiltDegrees - start.tiltDegrees) * t
    }
  }

  setView(view, options) {
    const normalized = this.normalizeView(view)
    const animation = options || {}
    if (animation.animate) {
      this.animateView(normalized, animation.durationMs)
      return normalized
    }
    this.cancelAnimation()
    this.assignView(normalized)
    this.refresh()
    return this.getView()
  }

  animateView(target, durationMs) {
    this.cancelAnimation()
    const start = this.getView()
    const duration = common.clamp(durationMs === undefined ? 250 :
      common.finiteNumber(durationMs, 'Animation duration'), 0, 3000)
    if (duration === 0) {
      this.assignView(target)
      this.refresh()
      return
    }
    const startedAt = Date.now()
    const headingDelta = wrapDegrees(
      target.headingDegrees - start.headingDegrees)
    const step = () => {
      if (!this.cameraAnimation) {
        return
      }
      const elapsed = Date.now() - startedAt
      const linear = common.clamp(elapsed / duration, 0, 1)
      const t = 1 - Math.pow(1 - linear, 3)
      const view = this.interpolateView(start, target, t, headingDelta)
      this.assignView(view)
      this.refresh()
      if (linear >= 1) {
        this.cameraAnimation = null
        this.cameraEvent('camerasettle', { view: this.getView() })
      } else {
        this.cameraAnimation.timer = setTimeout(step, 16)
      }
    }
    this.cameraAnimation = { timer: setTimeout(step, 0) }
  }

  cancelAnimation() {
    if (!this.cameraAnimation) {
      return false
    }
    clearTimeout(this.cameraAnimation.timer)
    this.cameraAnimation = null
    this.cameraEvent('animationcancel', { view: this.getView() })
    return true
  }

  cameraEvent(type, detail) {
    if (typeof this.options.onCameraEvent === 'function') {
      this.options.onCameraEvent(type, detail || {})
    }
  }

  applyPanPixels(deltaX, deltaY) {
    const referenceDistance = defaultCamera(this.manifest.radius,
      this.budget.physicalWidth, this.budget.physicalHeight,
      this.fovRadians).distance
    const distanceScale = common.clamp(
      this.camera.distance / referenceDistance, 0.04, 1)
    const devicePixelRatio = Math.max(1, this.budget.devicePixelRatio || 1)
    const viewportSize = Math.max(1, Math.min(
      this.budget.physicalWidth / devicePixelRatio,
      this.budget.physicalHeight / devicePixelRatio))
    const degreesPerPixel = 180 * distanceScale / viewportSize
    this.camera.longitudeDegrees = wrapDegrees(
      this.camera.longitudeDegrees - deltaX * degreesPerPixel)
    this.camera.latitudeDegrees = common.clamp(
      this.camera.latitudeDegrees + deltaY * degreesPerPixel, -85, 85)
  }

  applyInteraction(change) {
    const value = change || {}
    this.cancelAnimation()
    const panX = common.finiteNumber(value.xPixels || 0,
      'Interaction pan X')
    const panY = common.finiteNumber(value.yPixels || 0,
      'Interaction pan Y')
    if (panX || panY) {
      this.applyPanPixels(panX, panY)
    }
    if (value.zoomScale !== undefined && value.zoomScale !== 1) {
      const scale = common.finiteNumber(value.zoomScale,
        'Interaction zoom scale')
      common.invariant(scale > 0, 'Interaction zoom scale must be positive')
      const previous = this.camera.distance
      const limits = this.rangeLimits()
      this.camera.distance = common.clamp(previous * scale,
        limits.minimum, limits.maximum)
      if (value.anchor) {
        const dpr = Math.max(1, this.budget.devicePixelRatio || 1)
        const width = this.budget.physicalWidth / dpr
        const height = this.budget.physicalHeight / dpr
        const effectiveScale = this.camera.distance / previous
        this.applyPanPixels(
          -(common.finiteNumber(value.anchor.x, 'Zoom anchor X') - width / 2) *
            (1 - effectiveScale),
          -(common.finiteNumber(value.anchor.y, 'Zoom anchor Y') - height / 2) *
            (1 - effectiveScale))
      }
    }
    this.camera.yawRadians = wrapRadians(this.camera.yawRadians +
      common.finiteNumber(value.headingDegrees || 0, 'Heading delta') *
        DEGREES_TO_RADIANS)
    this.camera.tiltRadians = common.clamp(this.camera.tiltRadians -
      common.finiteNumber(value.tiltDegrees || 0, 'Tilt delta') *
        DEGREES_TO_RADIANS, MIN_TILT_RADIANS, MAX_TILT_RADIANS)
    this.refresh()
  }

  panBy(change) {
    const value = change || {}
    this.cancelAnimation()
    this.applyPanPixels(common.finiteNumber(value.xPixels, 'Pan X'),
      common.finiteNumber(value.yPixels, 'Pan Y'))
    this.refresh()
  }

  zoomBy(scale, options) {
    const value = common.finiteNumber(scale, 'Zoom scale')
    common.invariant(value > 0, 'Zoom scale must be positive')
    this.cancelAnimation()
    const previous = this.camera.distance
    const limits = this.rangeLimits()
    this.camera.distance = common.clamp(previous * value,
      limits.minimum, limits.maximum)
    const anchor = options && options.anchor
    if (anchor) {
      const dpr = Math.max(1, this.budget.devicePixelRatio || 1)
      const width = this.budget.physicalWidth / dpr
      const height = this.budget.physicalHeight / dpr
      const effectiveScale = this.camera.distance / previous
      this.applyPanPixels(
        -(common.finiteNumber(anchor.x, 'Zoom anchor X') - width / 2) *
          (1 - effectiveScale),
        -(common.finiteNumber(anchor.y, 'Zoom anchor Y') - height / 2) *
          (1 - effectiveScale))
    }
    this.refresh()
  }

  orbitBy(change) {
    const value = change || {}
    this.cancelAnimation()
    this.camera.yawRadians = wrapRadians(this.camera.yawRadians +
      common.finiteNumber(value.headingDegrees || 0, 'Heading delta') *
        DEGREES_TO_RADIANS)
    this.camera.tiltRadians = common.clamp(this.camera.tiltRadians -
      common.finiteNumber(value.tiltDegrees || 0, 'Tilt delta') *
        DEGREES_TO_RADIANS, MIN_TILT_RADIANS, MAX_TILT_RADIANS)
    this.refresh()
  }

  setTilt(tiltDegrees) {
    const view = this.getView()
    view.tiltDegrees = common.finiteNumber(tiltDegrees, 'Tilt')
    this.setView(view)
  }

  reset() {
    this.cancelAnimation()
    this.camera = geographicCamera(this.manifest.radius,
      this.budget.physicalWidth, this.budget.physicalHeight, this.fovRadians,
      this.options.initialTarget)
    this.refresh()
  }

  retryFailed() {
    common.invariant(!this.destroyed, 'Terra globe runtime is destroyed')
    const terrainFailures = Array.from(this.failedRequests.entries())
    const terrainRetry = terrainFailures.length || this.retries.size
    const textureRetry = this.renderer &&
      typeof this.renderer.retryTextures === 'function' &&
      this.renderer.retryTextures()
    if (!terrainRetry && !textureRetry) {
      return false
    }
    terrainFailures.forEach(([key, request]) => {
      try {
        this.abi.retryRecord(request.kind, request.key)
        this.failedRequests.delete(key)
      } catch (error) {
        this.diagnostic('terrain_retry_record_failed', {
          key, message: error.message || String(error)
        })
      }
    })
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
    this.zoomBy(scale)
  }

  setTargetDegrees(longitudeDegrees, latitudeDegrees) {
    const longitude = common.finiteNumber(longitudeDegrees,
      'Target longitude')
    const latitude = common.finiteNumber(latitudeDegrees, 'Target latitude')
    common.invariant(longitude >= -180 && longitude <= 180,
      'Target longitude is outside [-180, 180]')
    common.invariant(latitude >= -90 && latitude <= 90,
      'Target latitude is outside [-90, 90]')
    this.camera.longitudeDegrees = longitude
    this.camera.latitudeDegrees = latitude
    this.refresh()
  }

  moveSurfacePixels(deltaX, deltaY) {
    this.panBy({ xPixels: deltaX, yPixels: deltaY })
  }

  applyCamera(change) {
    const value = change || {}
    if (value.zoomScale !== undefined) {
      common.finiteNumber(value.zoomScale, 'Zoom scale')
      this.camera.distance = common.clamp(this.camera.distance * value.zoomScale,
        this.manifest.radius * 1.001, this.manifest.radius * 20)
    }
    if (value.tiltDelta !== undefined) {
      this.camera.tiltRadians = common.clamp(
        this.camera.tiltRadians +
          common.finiteNumber(value.tiltDelta, 'Tilt delta'),
        MIN_TILT_RADIANS, MAX_TILT_RADIANS)
    }
    if (value.yawDelta !== undefined) {
      this.camera.yawRadians = wrapRadians(this.camera.yawRadians +
        common.finiteNumber(value.yawDelta, 'Yaw delta'))
    }
    this.refresh()
  }

  setTiltRadians(value) {
    this.setTilt(-common.finiteNumber(value, 'Tilt') * RADIANS_TO_DEGREES)
  }

  tilt45() {
    this.setTiltRadians(-Math.PI / 4)
  }

  rotateYaw(delta) {
    this.camera.yawRadians = wrapRadians(this.camera.yawRadians +
      common.finiteNumber(delta, 'Yaw'))
    this.refresh()
  }

  topDown() {
    this.camera.tiltRadians = 0
    this.refresh()
  }

  northUp() {
    this.camera.yawRadians = 0
    this.refresh()
  }

  focusInitialTarget(distanceScale) {
    const scale = distanceScale === undefined
      ? 1.45
      : common.finiteNumber(distanceScale, 'Focus distance scale')
    common.invariant(scale >= 1.001 && scale <= 20,
      'Focus distance scale is outside [1.001, 20]')
    const target = this.options.initialTarget || {
      longitudeDegrees: 0,
      latitudeDegrees: 0
    }
    this.camera.longitudeDegrees = common.finiteNumber(
      target.longitudeDegrees, 'Initial target longitude')
    this.camera.latitudeDegrees = common.finiteNumber(
      target.latitudeDegrees, 'Initial target latitude')
    this.camera.distance = this.manifest.radius * scale
    this.camera.tiltRadians = 0
    this.camera.yawRadians = 0
    this.refresh()
  }

  refresh() {
    if (this.destroyed) {
      return
    }
    if (this.paused) {
      this.refreshPending = true
      return
    }
    if (this.refreshing) {
      this.refreshPending = true
      return
    }
    this.refreshing = true
    try {
      if (this.manifest.transform === 'cylindrical') {
        this.abi.setGlobeTarget(this.camera.longitudeDegrees,
          this.camera.latitudeDegrees)
      } else {
        this.abi.setPlanarTarget(this.camera.x, this.camera.y)
      }
      this.abi.setCamera(this.camera)
      const frame = this.abi.update(this.budget.lodThreshold)
      const requests = this.abi.getRequests()
      const draws = this.abi.getDrawRanges()
      const positions = this.abi.getPositions()
      const textureUv = this.abi.getTextureUv()
      const indices = this.abi.getIndices()
      this.lastFrame = frame
      this.lastSurface = { draws, positions, textureUv, indices }
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
    if (this.destroyed) {
      return
    }
    if (this.paused) {
      this.refreshPending = true
      return
    }
    if (this.refreshPending) {
      return
    }
    this.refreshPending = true
    Promise.resolve().then(() => {
      if (!this.destroyed && !this.paused) {
        this.refreshPending = false
        this.refresh()
      }
    })
  }

  scheduleRender() {
    if (this.destroyed || this.paused || !this.renderer) {
      return
    }
    if (this.renderScheduled) {
      return
    }
    this.renderScheduled = true
    const render = () => {
      this.renderScheduled = false
      if (!this.destroyed && !this.paused) {
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
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(
          `Terrain record returned HTTP ${response.statusCode}`)
        error.statusCode = response.statusCode
        throw error
      }
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
    const unavailable = error && error.statusCode === 404
    if (!unavailable && attempt <= this.maximumTerrainRetries) {
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
    this.failedRequests.set(key, request)
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
      view: this.camera && this.getView(),
      budget: this.budget,
      terrain: Object.assign(this.recordCache.stats(), this.scheduler.stats(), {
        failedRequestCount: this.failedRequests.size
      }),
      renderer,
      contextLost: this.renderer ? this.renderer.contextLost : false,
      paused: this.paused,
      error: this.lastError,
      diagnostics: this.diagnostics.slice(-8)
    }
  }

  publishState() {
    if (typeof this.options.onState === 'function') {
      this.options.onState(this.state())
    }
  }

  pause() {
    if (this.destroyed || this.paused) {
      return
    }
    this.paused = true
    this.cancelAnimation()
  }

  resume() {
    if (this.destroyed || !this.paused) {
      return
    }
    this.paused = false
    if (this.refreshPending) {
      this.refreshPending = false
      this.refresh()
    } else {
      this.scheduleRender()
    }
  }

  destroy() {
    this.cancelAnimation()
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

class TerraPlanarRuntime extends TerraGlobeRuntime {
  constructor(options) {
    super(options)
    this.planarLevel = Number.isInteger(this.options.planarLevel)
      ? common.clamp(this.options.planarLevel, 0, 2)
      : 1
    this.defaultTiltRadians = this.options.initialTiltRadians === undefined
      ? -Math.PI / 4
      : common.finiteNumber(this.options.initialTiltRadians,
        'Initial planar tilt')
    this.renderMode = this.options.renderMode === 'height' ? 'height' : 'texture'
  }

  static async create(options) {
    const runtime = new TerraPlanarRuntime(options)
    await runtime.initialize()
    return runtime
  }

  validateRuntimeManifest(rawManifest) {
    const imagery = this.options.imagery || null
    if (imagery && typeof imagery.resolveTile === 'function') {
      this.textureUrlResolver = imagery.resolveTile
      return common.validatePlanarManifest(manifestForImagerySource(
        rawManifest, imagery, 'planar-single'), imagery.id)
    }
    this.textureUrlResolver = null
    return common.validatePlanarManifest(rawManifest, this.options.textureId)
  }

  requiredAbiMethods() {
    return super.requiredAbiMethods().concat(['setPlanarTarget',
      'setPlanarLevel'])
  }

  configureAbi() {
    this.abi.setPlanarLevel(this.planarLevel)
  }

  createInitialCamera() {
    return planarCamera(this.manifest, this.budget.physicalWidth,
      this.budget.physicalHeight, this.fovRadians, this.defaultTiltRadians,
      this.options.initialTarget)
  }

  rangeLimits() {
    const width = this.manifest.maximumU - this.manifest.minimumU
    const height = this.manifest.maximumV - this.manifest.minimumV
    const diagonal = Math.sqrt(width * width + height * height)
    return { minimum: diagonal * 0.25, maximum: diagonal * 20 }
  }

  normalizeView(view) {
    common.invariant(view && typeof view === 'object', 'ViewState is required')
    common.invariant(!view.schema || view.schema === 'terra.view-state.v1',
      'ViewState schema is unsupported')
    common.invariant(!view.mode || view.mode === 'planar',
      'ViewState mode must be planar')
    const target = view.target || {}
    const x = common.finiteNumber(target.x, 'View target X')
    const y = common.finiteNumber(target.y, 'View target Y')
    common.invariant(x >= this.manifest.minimumU &&
      x <= this.manifest.maximumU && y >= this.manifest.minimumV &&
      y <= this.manifest.maximumV,
    'View target is outside planar bounds')
    const limits = this.rangeLimits()
    const rangeMeters = common.finiteNumber(view.rangeMeters, 'View range')
    common.invariant(rangeMeters >= limits.minimum &&
      rangeMeters <= limits.maximum, 'View range is outside runtime limits')
    const tiltDegrees = common.finiteNumber(view.tiltDegrees, 'View tilt')
    common.invariant(tiltDegrees >= 0 && tiltDegrees <= 80,
      'View tilt is outside [0, 80]')
    return {
      schema: 'terra.view-state.v1',
      mode: 'planar',
      target: {
        x,
        y,
        height: target.height === undefined ? 0 :
          common.finiteNumber(target.height, 'View target height')
      },
      rangeMeters,
      headingDegrees: wrapDegrees(common.finiteNumber(
        view.headingDegrees, 'View heading')),
      tiltDegrees
    }
  }

  getView() {
    return {
      schema: 'terra.view-state.v1',
      mode: 'planar',
      target: { x: this.camera.x, y: this.camera.y, height: 0 },
      rangeMeters: this.camera.distance,
      headingDegrees: wrapDegrees(this.camera.yawRadians * RADIANS_TO_DEGREES),
      tiltDegrees: this.camera.tiltRadians === 0 ? 0 :
        -this.camera.tiltRadians * RADIANS_TO_DEGREES
    }
  }

  assignView(view) {
    this.camera.x = view.target.x
    this.camera.y = view.target.y
    this.camera.distance = view.rangeMeters
    this.camera.yawRadians = view.headingDegrees * DEGREES_TO_RADIANS
    this.camera.tiltRadians = -view.tiltDegrees * DEGREES_TO_RADIANS
  }

  interpolateView(start, target, t, headingDelta) {
    return {
      schema: 'terra.view-state.v1',
      mode: 'planar',
      target: {
        x: start.target.x + (target.target.x - start.target.x) * t,
        y: start.target.y + (target.target.y - start.target.y) * t,
        height: start.target.height +
          (target.target.height - start.target.height) * t
      },
      rangeMeters: start.rangeMeters +
        (target.rangeMeters - start.rangeMeters) * t,
      headingDegrees: start.headingDegrees + headingDelta * t,
      tiltDegrees: start.tiltDegrees +
        (target.tiltDegrees - start.tiltDegrees) * t
    }
  }

  applyPanPixels(deltaX, deltaY) {
    const dpr = Math.max(1, this.budget.devicePixelRatio || 1)
    const cssHeight = Math.max(1, this.budget.physicalHeight / dpr)
    const unitsPerPixel = 2 * this.camera.distance *
      Math.tan(this.fovRadians / 2) / cssHeight
    const yaw = this.camera.yawRadians
    const localX = -deltaX * unitsPerPixel
    const localY = deltaY * unitsPerPixel
    const worldX = localX * Math.cos(yaw) - localY * Math.sin(yaw)
    const worldY = localX * Math.sin(yaw) + localY * Math.cos(yaw)
    this.camera.x = common.clamp(this.camera.x + worldX,
      this.manifest.minimumU, this.manifest.maximumU)
    this.camera.y = common.clamp(this.camera.y + worldY,
      this.manifest.minimumV, this.manifest.maximumV)
  }

  reset() {
    this.cancelAnimation()
    this.camera = this.createInitialCamera()
    this.refresh()
  }

  birdView() {
    this.camera.tiltRadians = 0
    this.camera.yawRadians = 0
    this.refresh()
  }

  tilt45() {
    this.camera.tiltRadians = -Math.PI / 4
    this.camera.yawRadians = 0
    this.refresh()
  }

  zoom(scale) {
    this.zoomBy(scale)
  }

  setRenderMode(mode) {
    common.invariant(mode === 'texture' || mode === 'height',
      'Planar render mode is unsupported')
    this.renderMode = mode
    if (this.renderer && typeof this.renderer.setMode === 'function') {
      this.renderer.setMode(mode)
    }
    this.scheduleRender()
    this.publishState()
  }

  textureUrl(tile) {
    if (this.textureUrlResolver) {
      const resolved = this.textureUrlResolver(tile)
      common.invariant(typeof resolved === 'string' && resolved.length > 0,
        'Planar texture URL resolver returned an empty URL')
      return resolved
    }
    const endpoint = this.manifest.texture.url_template
    return /^https:\/\//.test(endpoint)
      ? endpoint
      : common.joinServiceUrl(this.serviceOrigin, endpoint)
  }

  state() {
    const result = super.state()
    result.schema = 'terra.miniprogram.planar-runtime.v1'
    result.planarLevel = this.planarLevel
    result.renderMode = this.renderMode
    return result
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
  TerraPlanarRuntime,
  defaultCamera,
  geographicCamera,
  planarCamera,
  parseJsonResponse,
  requestWithWx
}
