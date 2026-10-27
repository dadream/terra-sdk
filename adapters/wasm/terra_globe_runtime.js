const { FrameCoordinator } = require('../../sdk/js/runtime/frame_coordinator')
const { ResourceLedger } = require('../../sdk/js/resources/resource_ledger')
const {capacityCheckpoint,capacityRefusalRevision}=require('../../sdk/js/resources/capacity_refusal')
const {meshCutBytes} = require('../../sdk/js/resources/mesh_coordinates')
const {createResourcePolicy} = require('../../sdk/js/resources/resource_policy')
const {TerrainCapacity} = require('../../sdk/js/terrain/terrain_capacity')
const {TerrainDemand} = require('../../sdk/js/terrain/terrain_demand')
const {TerrainModelWork} = require('../../sdk/js/terrain/terrain_model_work')
const { TerrainEpoch } = require('../../sdk/js/terrain/terra_terrain_epoch')
const { TimingSeries, recordTiming, monotonicNow } = require('../../sdk/js/diagnostics/timing')
const { TerraAbi, ABI_LAYOUT } = require('./terra_abi')
const {LocalTerrainExecution} = require('./local_terrain_execution')
const {releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')
const {Cleanup,cleanupAfterError} = require('../../sdk/js/runtime/cleanup')
const { ImageryAdapter } = require('../../sdk/js/imagery/terra_imagery_adapter')
const wasmLoader = require('./terra_wasm')
const {
  RequestScheduler,
  ResourceCache,
  clamp,
  deriveFrameBudget,
  finiteNumber,
  invariant,
  isAllowedResourceUrl,
  joinServiceUrl,
  patchKeyString,
  redactSensitiveText,
  replaceTemplate,
  sanitizeDiagnosticDetail,
  terrainResourceBudget,
  validateManifest,
  validatePlanarManifest,
  validateRecordPayload
} = require('../../sdk/js/core/terra_globe_common')
const {preparedPartitionBytes, createPreparedPartitionBatch} = require('./prepared_partitions')
const {partitionGroupPlan} = require('./resident_partition_plan')
const { TerraWebGlRenderer } = require('../webgl/terra_webgl_renderer')
const { MeshFrames } = require('../../sdk/js/terrain/terra_mesh_frames')
const { MeshReceipts } = require('../../sdk/js/terrain/mesh_receipts')
const {SubmittedTerrain} = require('../../sdk/js/terrain/submitted_terrain')
const ground = require('../../sdk/js/terrain/terra_ground')
const { cameraSnapshot } = require('../../sdk/js/camera/terra_camera_snapshot')
const surfacePlan = require('../../sdk/js/terrain/terra_surface_plan')
const {TerrainTransport} = require('../../sdk/js/terrain/terrain_transport')
const {HeightQueries} = require('../../sdk/js/terrain/height_queries')
const {GroundDemands} = require('../../sdk/js/terrain/ground_demands')
const eyeView = require('../../sdk/js/camera/eye_view')
const {TerrainWalk} = require('../../sdk/js/camera/terrain_walk')
const {maximumEncodedRecordBytes, isMissingTerrainRecord} = require('../../sdk/js/terrain/terrain_record')
const {MAXIMUM_METADATA_BYTES} = require('../../sdk/js/transport/response_limits')
const {TerrainInputBudget} = require('../../sdk/js/terrain/terrain_input_budget')

const STATUS_OK = 0
const STATUS_BUFFER_TOO_SMALL = 6
const TRANSFORM_PLANAR = 1
const TRANSFORM_CYLINDRICAL = 2
const REQUEST_ROOT = 1
const REQUEST_DETAIL = 2
const DEFAULT_FOV_RADIANS = 30.0 * (3.14 / 180.0)
const DEGREES_TO_RADIANS = Math.PI / 180
const RADIANS_TO_DEGREES = 180 / Math.PI
const MIN_TILT_RADIANS = -89.5 * DEGREES_TO_RADIANS
const MAX_TILT_RADIANS = 0
const ANIMATION_LOD_INTERVAL_MS = 200
const DEFAULT_CAMERA_SETTLE_DELAY_MS = 160
const DEFAULT_TERRAIN_REFRESH_BATCH_MS = 24
const DEFAULT_TERRAIN_REFRESH_MAXIMUM_DELAY_MS = 120


function normalizeAtmosphereOptions(value) {
  const input = value || {}
  const result = {
    enabled: input.enabled !== false,
    sunEnabled: input.sunEnabled !== false,
    fogEnabled: input.fogEnabled === true,
    fogDensityMultiplier: input.fogDensityMultiplier === undefined
      ? 1 : finiteNumber(input.fogDensityMultiplier, 'Fog density'),
    sunAzimuthDegrees: input.sunAzimuthDegrees === undefined
      ? 135 : finiteNumber(input.sunAzimuthDegrees, 'Sun azimuth'),
    sunZenithDegrees: input.sunZenithDegrees === undefined
      ? 35 : finiteNumber(input.sunZenithDegrees, 'Sun zenith'),
    turbidity: input.turbidity === undefined
      ? 2 : finiteNumber(input.turbidity, 'Atmosphere turbidity'),
    exposure: input.exposure === undefined
      ? 1 : finiteNumber(input.exposure, 'Atmosphere exposure')
  }
  invariant(result.sunZenithDegrees >= 0 &&
    result.sunZenithDegrees <= 120 && result.turbidity >= 1 &&
    result.turbidity <= 20 && result.exposure > 0 && result.exposure <= 8 &&
    result.fogDensityMultiplier >= 0 && result.fogDensityMultiplier <= 10,
  'Atmosphere options are outside supported ranges')
  return result
}

function terrainRequestPriority(request) {
  return request && request.kind === REQUEST_ROOT
    ? 0x7fffffff : 0x40000000
}

function orderTerrainRequests(requests) {
  return (requests || []).map((request, index) => ({
    request,
    index,
    priority: terrainRequestPriority(request)
  })).sort((left, right) =>
    right.priority - left.priority || left.index - right.index)
    .map((item) => item.request)
}


function parseJsonResponse(response, operation) {
  invariant(response && response.statusCode >= 200 && response.statusCode < 300,
    `${operation} returned an unsuccessful HTTP status`)
  if (typeof response.data === 'string') {
    return JSON.parse(response.data)
  }
  invariant(response.data && typeof response.data === 'object',
    `${operation} did not return JSON`)
  return response.data
}

function manifestForImagerySource(rawManifest, source, expectedKind) {
  invariant(source && typeof source.id === 'string' && source.id.length > 0,
    'Imagery source ID is required')
  invariant(typeof source.resolveTile === 'function',
    'Imagery source resolver is required')
  const expectedKinds = Array.isArray(expectedKind)
    ? expectedKind : [expectedKind]
  invariant(!source.tileScheme ||
    expectedKinds.indexOf(source.tileScheme) >= 0,
  `Imagery tile scheme must be ${expectedKinds.join(' or ')}`)
  const textures = Array.isArray(rawManifest.textures)
    ? rawManifest.textures : []
  const configuredTexture = source.texture &&
    expectedKinds.indexOf(source.texture.kind) >= 0 ? source.texture : null
  const base = configuredTexture || textures.find((texture) => texture &&
    expectedKinds.indexOf(texture.kind) >= 0)
  invariant(base,
    `Manifest has no ${expectedKinds.join(' or ')} texture descriptor`)
  const texture = Object.assign({}, base, { id: source.id })
  if (source.matrixLevelOffset !== undefined) {
    invariant(Number.isInteger(source.matrixLevelOffset) &&
      source.matrixLevelOffset >= 0 && source.matrixLevelOffset <= 28,
    'Imagery matrix level offset is invalid')
    texture.matrix_level_offset = source.matrixLevelOffset
  }
  if (source.maximumLevel !== undefined) {
    invariant(Number.isInteger(source.maximumLevel) &&
      source.maximumLevel >= 0 && source.maximumLevel <= 28,
    'Imagery maximum level is invalid')
    texture.maximum_level = source.maximumLevel
  }
  if (source.minimumLevel !== undefined) {
    invariant(source.minimumLevel === 0,
      'Imagery minimum level must be zero in V1')
  }
  return Object.assign({}, rawManifest, { textures: [texture] })
}


function defaultCamera(radius, width, height, fovRadians) {
  const aspect = width / height
  const halfFov = Math.atan(Math.tan(fovRadians / 2) * Math.min(aspect, 1))
  return {
    distance: 1.05 * radius / Math.sin(halfFov) - radius,
    targetHeightMeters: 0,
    tiltRadians: 0,
    yawRadians: 0
  }
}

function targetHeight(value, radius) {
  const height = finiteNumber(value === undefined ? 0 : value, 'Target height')
  invariant(height > -radius && height <= radius * 20, 'Target height is outside globe limits')
  return height
}

function geographicCamera(radius, width, height, fovRadians, target) {
  const camera = defaultCamera(radius, width, height, fovRadians)
  camera.longitudeDegrees = 0
  camera.latitudeDegrees = 0
  if (!target) {
    return camera
  }
  const longitude = finiteNumber(target.longitudeDegrees,
    'Initial target longitude')
  const latitude = finiteNumber(target.latitudeDegrees,
    'Initial target latitude')
  invariant(longitude >= -180 && longitude <= 180,
    'Initial target longitude is outside [-180, 180]')
  invariant(latitude >= -90 && latitude <= 90,
    'Initial target latitude is outside [-90, 90]')
  camera.longitudeDegrees = longitude
  camera.latitudeDegrees = latitude
  camera.targetHeightMeters = targetHeight(target.heightMeters, radius)
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
    : finiteNumber(target.x, 'Initial planar target X')
  const y = target.y === undefined
    ? 0.5 * (manifest.minimumV + manifest.maximumV)
    : finiteNumber(target.y, 'Initial planar target Y')
  invariant(x >= manifest.minimumU && x <= manifest.maximumU &&
    y >= manifest.minimumV && y <= manifest.maximumV,
  'Initial planar target is outside dataset bounds')
  return {
    distance: 1.2 * Math.max(verticalDistance, horizontalDistance),
    targetHeightMeters: finiteNumber(target.heightMeters === undefined ? 0 : target.heightMeters, 'Initial target height'),
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
    invariant(this.canvas, 'A Mini Program canvas is required')
    this.fovRadians = this.options.verticalFovRadians || DEFAULT_FOV_RADIANS
    this.terrainPixelError = this.options.terrainPixelError === undefined
      ? 1.25 : finiteNumber(this.options.terrainPixelError,
        'Terrain pixel error')
    this.imageryPixelError = this.options.imageryPixelError === undefined
      ? 1.25 : finiteNumber(this.options.imageryPixelError,
        'Imagery pixel error')
    invariant(this.terrainPixelError > 0 &&
      this.terrainPixelError <= 16 && this.imageryPixelError > 0 &&
      this.imageryPixelError <= 16,
    'Terrain and imagery pixel errors are outside supported ranges')
    this.frameQuality = {
      terrainPixelError: this.terrainPixelError,
      verticalFovRadians: this.fovRadians
    }
    this.cameraSettleDelayMs = this.options.cameraSettleDelayMs === undefined
      ? DEFAULT_CAMERA_SETTLE_DELAY_MS
      : clamp(finiteNumber(
        this.options.cameraSettleDelayMs, 'Camera settle delay'), 0, 500)
    this.terrainRefreshBatchMs = this.options.terrainRefreshBatchMs === undefined
      ? DEFAULT_TERRAIN_REFRESH_BATCH_MS
      : clamp(finiteNumber(
        this.options.terrainRefreshBatchMs,
        'Terrain refresh batch delay'), 0, 100)
    this.terrainRefreshMaximumDelayMs =
      this.options.terrainRefreshMaximumDelayMs === undefined
        ? DEFAULT_TERRAIN_REFRESH_MAXIMUM_DELAY_MS
        : clamp(finiteNumber(
          this.options.terrainRefreshMaximumDelayMs,
          'Terrain refresh maximum delay'), 0, 500)
    this.terrainRefreshMaximumDelayMs = this.terrainRefreshBatchMs === 0
      ? 0
      : Math.max(this.terrainRefreshBatchMs,
        this.terrainRefreshMaximumDelayMs)
    this.serviceOrigin = this.options.serviceOrigin || ''
    this.request = this.options.request
    this.maximumTerrainRequests = Number.isInteger(
      this.options.maximumTerrainRequests)
      ? clamp(this.options.maximumTerrainRequests, 1, 8)
      : 4
    this.maximumTextureRequests = Number.isInteger(
      this.options.maximumTextureRequests)
      ? clamp(this.options.maximumTextureRequests, 1, 8)
      : 8
    this.maximumTerrainRetries = Number.isInteger(
      this.options.maximumTerrainRetries)
      ? clamp(this.options.maximumTerrainRetries, 0, 5)
      : 2
    this.terrainRetryDelayMs = this.options.terrainRetryDelayMs === undefined
      ? 400
      : Math.max(0, finiteNumber(this.options.terrainRetryDelayMs,
        'Terrain retry delay'))
    this.maximumRefreshRetries = Number.isInteger(
      this.options.maximumRefreshRetries)
      ? clamp(this.options.maximumRefreshRetries, 0, 3)
      : 1
    this.atmosphere = normalizeAtmosphereOptions(this.options.atmosphere)
    this.desiredRequests = new Map()
    this.retries = new Map()
    this.terrainRetryTimers = new Map()
    this.failedRequests = new Map()
    this.failureExpiry = new Map()
    this.resourcePolicy = createResourcePolicy(this.options,
      deriveFrameBudget(this.options.viewport || {width: 1, height: 1}, {}, this.frameQuality))
    this.resourceLedger = new ResourceLedger(this.resourcePolicy.maximumResourceBytes)
    this.terrainDemand = new TerrainDemand()
    this.terrainModel = new TerrainModelWork()
    this.terrainRecordRevision = 0
    this.maximumImageryBytes = this.resourcePolicy.maximumImageryBytes
    this.releaseMeshListener = this.resourceLedger.subscribe(() => {
      this.retryMeshCapacity()
      this.retryTerrainDemand()
      this.retryTerrainPrecision()
      if (this.imageryCapacityWait && this.imageryCapacityWait.availability !== this.resourceLedger.availabilityRevision)
        this.scheduleImageryContinuation()
    })
    this.recordCache = new ResourceCache({
      ledger: this.resourceLedger, owner: 'record-cache',
      maximumEntries: this.options.maximumRecordEntries || 256,
      maximumBytes: this.options.recordCacheBytes || 8 * 1024 * 1024
    })
    this.scheduler = new RequestScheduler(this.maximumTerrainRequests)
    this.terrainTransport = new TerrainTransport(this.request, this.maximumTerrainRequests)
    this.heightQueries = new HeightQueries(this)
    this.diagnosticTimes = new Map()
    this.diagnostics = []
    this.refreshPending = false
    this.refreshing = false
    this.terrainWorkRevision = 0
    this.terrainProgress = null
    this.destroyed = false
    this.paused = false
    this.manifest = null
    this.abi = null
    this.renderer = null
    this.budget = null
    this.camera = null
    this.lastFrame = null
    this.lastSurface = null
    this.meshFrames = new MeshFrames(this.resourceLedger)
    this.meshFrames.onPreparation = packet => this.beginTerrainPreparation(packet)
    this.meshReceipts = new MeshReceipts(this.meshFrames, () => this.abi,
      error => this.diagnostic('mesh_retention_failed', {message: error.message}))
    this.terrainEpoch = new TerrainEpoch()
    this.presentedFrame = null
    this.presentedSurface = null
    this.supersededCandidateCount = 0
    this.meshCapacityBlocked = false
    this.renderedSurface = null
    this.renderedSurfaceRevision = 0
    this.submittedTerrain = new SubmittedTerrain()
    this.lastError = ''
    this.cameraAnimation = null
    this.cameraRefreshTimer = null
    this.interactionRefreshTimer = null
    this.terrainRefreshTimer = null
    this.imageryContinuationTimer = null
    this.terrainRefreshStartedAt = 0
    this.interactionActive = false
    this.cameraPreviewDirty = false
    this.cameraRevision = 0
    this.cameraSignature = ''
    this.consecutiveRefreshFailures = 0
    this.performanceStats = {
      fullUpdate: new TimingSeries(),
      modelAdvance: new TimingSeries(),
      lodUpdate: new TimingSeries(),
      frameRead: new TimingSeries(),
      rendererSetFrame: new TimingSeries(),
      cameraPreview: new TimingSeries()
    }
    this.frameClock = new FrameCoordinator({
      setTask: this.options.setTask,
      clearTask: this.options.clearTask,
      requestFrame: callback => this.canvas.requestAnimationFrame
        ? this.canvas.requestAnimationFrame(callback)
        : setTimeout(() => callback(monotonicNow()), 16),
      cancelFrame: handle => this.canvas.cancelAnimationFrame
        ? this.canvas.cancelAnimationFrame(handle) : clearTimeout(handle),
      render: () => {
        if (!this.renderer || this.destroyed || this.paused) return false
        const result = this.renderer.render(false)
        return Boolean(result && result.submitted > 0)
      },
      notify: () => { this.completeTerrainRecovery(); this.publishState() },
      onError: error => this.diagnostic('frame_callback_failed', {
        message: redactSensitiveText(error.message || String(error)) })
    })
    this.walkController = new TerrainWalk(this)
    this.groundDemands = new GroundDemands(this, () => {
      this.frameClock.enqueueWork('ground-clearance', () => {
        if (this.destroyed || this.paused || this.workerRecovering) return
        if (this.constrainCamera()) { this.previewCamera(); this.scheduleRefresh() }
        this.publishState()
      })
    })
  }

  static async create(options) {
    const runtime = new TerraGlobeRuntime(options)
    try { await runtime.initialize(); return runtime }
    catch (error) {cleanupAfterError(error,()=>runtime.destroy())}
  }

  async initialize() {
    invariant(typeof this.request === 'function', 'Runtime requires a platform request adapter')
    this.workerEnabled = Boolean(this.options.abi ? this.options.abi.isWorker :
      this.options.workerUrl && this.options.createWorker &&
      (this.options.workerFactory || typeof Worker !== 'undefined'))
    // The explicit fake-ABI test seam may omit imagery entirely. Production
    // runtimes always prepare imagery outside the renderer in bounded jobs.
    this.scheduledImagery = this.workerEnabled || !this.options.abi || Boolean(this.options.abi.imageryLayout)
    const rawManifest = this.options.manifest || await this.fetchManifest()
    this.manifest = this.validateRuntimeManifest(rawManifest)
    const viewport = this.options.viewport || { width: 1, height: 1, devicePixelRatio: 1 }
    this.budget = this.frameBudget(viewport, {})
    this.terrainUpdateBudget()
    this.terrainInputs = new TerrainInputBudget(this.resourceLedger, this.manifest.patchDimension)
    if (this.manifest.transform === 'cylindrical' && this.groundDemands.options.enabled)
      this.heightQueries.reserveProgress()
    this.canvas.width = this.budget.physicalWidth
    this.canvas.height = this.budget.physicalHeight
    const partitionTask = (planning, resourceId, cells, geometry, maximumBytes) => {
      let task, cancelled = false
      const method = planning ? 'createPartitionPlanTask' : 'createPartitionTask'
      const local = () => {
        task = surfacePlan[method](geometry.model, cells, maximumBytes)
        return task.run()
      }
      const retired = this.abi.generation !== undefined &&
        (geometry.key !== `mesh:${this.abi.generation}:${resourceId}` ||
          !this.meshFrames.resources.has(resourceId))
      const promise = retired ? local() : (() => {
        task = this.abi[method](resourceId, cells, maximumBytes)
        return task.promise.then(parts => cancelled ? null : parts || local())
      })()
      return {promise, cancel: () => { cancelled = true; task.cancel() }}
    }
    const rendererOptions = {
      resourceLedger: this.resourceLedger,
      urlForTile: (tile) => this.textureUrl(tile),
      onDiagnostic: (kind, detail) => this.diagnostic(kind, detail),
      onContextChange: (event) => this.contextChanged(event),
      onPresented: (sequence) => this.presentMeshFrame(sequence),
      onDrawsSubmitted: surface => {
        this.renderedSurface = surface
        ++this.renderedSurfaceRevision
        this.frameClock.enqueueWork('clearance', () => {
          if (this.renderedSurface && this.constrainCamera()) { this.previewCamera(); this.scheduleRefresh() }
        })
      },
      onSurfaceSubmitted: (surface, partial) => {
        this.submittedTerrain.submit(surface, partial)
        if (partial) this.meshReceipts.retain(surface.frame.sequence, surface.draws)
      },
      createPartitionPlanTask: this.workerEnabled
        ? (id, cells, geometry) => partitionTask(true, id, cells, geometry) : null,
      createPartitionGroupPlanTask: rows => partitionGroupPlan(
        rows, this.abi.isWorker ? this.abi : null, geometry =>
          geometry.key === `mesh:${this.abi.generation}:${geometry.resourceId}` &&
          this.meshFrames.resources.has(geometry.resourceId)),
      createPartitionTask: this.workerEnabled
        ? (id, cells, geometry, maximumBytes) => partitionTask(false, id, cells, geometry, maximumBytes) : null,
      meshPartitionWorkspaceBytes: rows => rows.reduce((maximum, row) => Math.max(maximum,
        preparedPartitionBytes(row.draw, !this.meshFrames.indices)), 0),
      createMeshPartitionPlanTask: (planId, rows, onRows, credit) => {
        let task, cancelled = false
        const promise = (async () => {
          const bytes = rendererOptions.meshPartitionWorkspaceBytes(rows)
          invariant(credit && credit.bytes >= bytes, 'Prepared UV workspace is not credited')
          if (cancelled) return null
          task = this.abi.isWorker ? this.abi.createMeshPartitionPlanTask(planId, rows, bytes, onRows) :
            createPreparedPartitionBatch(this.abi, planId, rows, this.meshFrames.indices, bytes, row => {
              const prepared = this.localExecution && this.localExecution.preparedModel(planId, row.draw.resourceId)
              if (prepared) return prepared
              const entry = this.renderer.geometry.entries.get(row.geometryKey), geometry = entry && entry.value
              if (!geometry || !geometry.model) return null
              const release = this.renderer.geometry.retain(row.geometryKey)
              return release ? {model: geometry.model, release} : null
            })
          const result = await (task.promise || task.run(onRows))
          return cancelled ? null : result
        })()
        return {promise, cancel: () => { cancelled = true; if (task) task.cancel() }}
      },
      planImagery: (draws, measure, options) => this.abi && this.abi.imageryLayout && !this.abi.isWorker
        ? this.abi.planImagery(draws, measure, options) : null,
      requestRender: () => this.scheduleRender(),
      requestResources: delay => this.scheduleResources(delay),
      cancelResources: () => this.frameClock.cancelWork('resources'),
      onImageryPlanningChange: () => this.refreshImagery(),
      onResourcePressure: pressure => this.recoverSharedCapacity(pressure),
      geometryCacheBytes: this.budget.geometryCacheBytes,
      partitionCacheBytes: this.budget.partitionCacheBytes,
      managedResources: true,
      scheduledImagery: this.scheduledImagery,
      fetchTextures: this.options.fetchTextures,
      createTextureStore: this.options.createTextureStore,
      createTerrainVisibility: this.options.createTerrainVisibility,
      textureCacheBytes: this.budget.textureCacheBytes,
      imageryShareMaximumBytes: this.maximumImageryBytes,
      maximumTextureEntries: this.budget.maximumTextureEntries,
      uploadBudgetMs: this.budget.uploadBudgetMs,
      mode: this.renderMode,
      textureDescriptor: this.manifest.texture,
      devicePixelRatio: this.budget.devicePixelRatio,
      imageryPixelError: this.imageryPixelError,
      terrainBoundImagery: false,
      maximumImagerySubdivisionLevels:
        this.options.maximumImagerySubdivisionLevels,
      maximumImageryDraws: this.options.maximumImageryDraws,
      heightRange: this.options.heightRange,
      atmosphereCapable: this.manifest.transform === 'cylindrical',
      atmosphereEnabled: this.atmosphere.enabled &&
        this.manifest.transform === 'cylindrical',
      planetRadius: this.manifest.radius,
      maximumTextureRequests: this.maximumTextureRequests,
      maximumTextureRetries: this.options.maximumTextureRetries,
      textureRetryDelayMs: this.options.textureRetryDelayMs
    }
    const rendererFactory = this.options.rendererFactory ||
      ((canvas, options) => new TerraWebGlRenderer(canvas, options))
    this.renderer = rendererFactory(this.canvas, rendererOptions)
    const rendererMethods = ['capabilities', 'resize', 'setMeshFrame', 'setCameraFrame', 'render', 'advanceResources',
      'holdCandidate', 'discardCandidate', 'releaseCandidate', 'prepareMeshOutputs', 'reserveMeshOutputs',
      'beginCandidateForecast', 'admitCandidate', 'terrainRefinementDemand', 'reserveImageryDemand', 'stats', 'destroy']
    rendererMethods.forEach((name) => invariant(
      this.renderer && typeof this.renderer[name] === 'function',
      `Terra renderer is missing ${name}`))
    this.meshFrames.reserveOutputs = (packet, bytes) => this.renderer.reserveMeshOutputs(packet, bytes)
    this.meshFrames.prepareOutputs = packet => this.renderer.prepareMeshOutputs(packet)
    this.meshFrames.beginForecast = () => this.renderer.beginCandidateForecast()
    this.meshFrames.evaluateCandidate = packet => this.renderer.admitCandidate(packet)
    this.budget = this.frameBudget(viewport, this.renderer.capabilities())
    this.applyBudget()
    this.canvas.width = this.budget.physicalWidth
    this.canvas.height = this.budget.physicalHeight
    this.renderer.resize(this.budget.physicalWidth, this.budget.physicalHeight)
    if (this.options.abi) {
      this.abi = this.options.abi
    } else if (this.workerEnabled) {
      this.abi = await this.createWorker()
    } else {
      const module = this.options.terraModule || (this.options.wasmUrl
        ? await wasmLoader.instantiateTerraWasmBytes(await (await fetch(this.options.wasmUrl)).arrayBuffer())
        : await wasmLoader.instantiateTerraWasm(this.options.wasmPath))
      this.abi = new TerraAbi(module)
    }
    const abiMethods = this.requiredAbiMethods()
    abiMethods.forEach((name) => invariant(
      this.abi && typeof this.abi[name] === 'function',
      `Terra ABI is missing ${name}`))
    this.abi.setResourceLedger(this.resourceLedger)
    await this.abi.loadManifest(this.manifest, this.resourcePolicy.maximumTerrainMeshBytes)
    this.abi.setViewport(this.budget.physicalWidth, this.budget.physicalHeight,
      this.fovRadians)
    this.configureAbi()
    this.applyAtmosphere()
    this.camera = this.createInitialCamera()
    if (!this.abi.isWorker && this.scheduledImagery) {
      this.localExecution = new LocalTerrainExecution(this.abi, this.meshFrames, this.manifest, () => {
        const camera = Object.assign({}, this.camera)
        const viewport = {width:this.budget.physicalWidth, height:this.budget.physicalHeight, fovRadians:this.fovRadians}
        return {revision:this.cameraRevision, camera, viewport, snapshot:cameraSnapshot(this.manifest, camera, viewport)}
      }, this.options.createTaskTurn && this.options.createTaskTurn())
    }
    this.refresh()
  }

  createWorker(wasmBytes) {
    return this.options.createWorker({
      workerUrl: this.options.workerUrl, wasmUrl: this.options.wasmUrl,
      workerFactory: this.options.workerFactory,
      workerTimeoutMs: this.options.workerTimeoutMs,
      wasmBytes: wasmBytes && wasmBytes.slice(0),
      onFatal: error => { this.recoverWorker(error) },
      onError: error => {
        this.lastError = redactSensitiveText(error.message || String(error))
        this.diagnostic('terrain_worker_failed', { message: this.lastError })
        this.publishState()
      }
    })
  }

  async recoverWorker(error) {
    if (this.destroyed || this.workerRecovering || !this.abi || !this.abi.destroyed) return
    this.lastError = redactSensitiveText(error.message || String(error))
    this.diagnostic('terrain_worker_failed', { message: this.lastError })
    if (Date.now() - (this.workerRecoveryAt || 0) > 30000) this.workerRecoveryCount = 0
    const old = this.abi
    this.workerRecovering = true
    this.walkController.cancel()
    this.groundDemands.reset()
    this.heightQueries.cancelAll('terrain_query_cancelled')
    this.scheduler.pause()
    this.scheduler.clear()
    this.desiredRequests.clear()
    this.terrainRetryTimers.forEach(timer => clearTimeout(timer))
    this.terrainRetryTimers.clear()
    this.cancelCameraRefresh(); this.cancelTerrainRefresh(); this.cancelInteractionRefresh()
    clearTimeout(this.imageryContinuationTimer)
    this.imageryContinuationTimer = null
    let next
    try {
      // Termination rejects all old RPCs. Let their finally blocks finish before
      // replacing ownership; retain the renderer's last CPU/GPU display cut.
      while (this.refreshing || this.imageryRefreshing || this.presentingSequence) {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (this.destroyed) return
      }
      while ((this.workerRecoveryCount || 0) < 3 && !this.destroyed) {
        this.workerRecoveryAt = Date.now()
        this.workerRecoveryCount = (this.workerRecoveryCount || 0) + 1
        await new Promise(resolve => setTimeout(resolve, this.workerRecoveryCount * 100))
        if (this.destroyed) return
        try {
          next = await this.createWorker(old.wasmBytes)
          next.setResourceLedger(this.resourceLedger)
          await next.loadManifest(this.manifest, this.resourcePolicy.maximumTerrainMeshBytes)
          break
        } catch (failure) {
          if (next) next.destroy()
          next = null
          this.lastError = redactSensitiveText(failure.message || String(failure))
        }
      }
      if (!next || this.destroyed) { if (next) next.destroy(); return }
      this.abi = next
      this.abi.setViewport(this.budget.physicalWidth, this.budget.physicalHeight, this.fovRadians)
      this.meshReceipts.clear()
      this.meshFrames.clear()
      this.terrainEpoch.clear()
      this.terrainProgress = null
      this.terrainModel.clear()
      this.terrainChanges = undefined
      this.meshRecovery = null
      this.presentedFrame = null; this.presentedSurface = null
      this.lastFrame = null; this.lastSurface = null
      this.failedRequests.clear(); this.failureExpiry.clear(); this.retries.clear()
      if (this.renderer.resetWorker) this.renderer.resetWorker()
      this.configureAbi(); this.applyAtmosphere()
      this.refreshPending = true
      this.imageryRefreshPending = false
      this.lastError = ''
      this.diagnostic('terrain_worker_recovered', { attempt: this.workerRecoveryCount })
    } catch (failure) {
      if (next) next.destroy()
      this.lastError = redactSensitiveText(failure.message || String(failure))
    } finally {
      this.workerRecovering = false
      if (!this.destroyed && !this.abi.destroyed && !this.paused) {
        this.scheduler.resume()
        this.refreshPending = false
        this.scheduleRefresh()
      }
      if (!this.destroyed && this.abi.destroyed) this.diagnostic('terrain_worker_recovery_failed',
        {message: this.lastError, attempts: this.workerRecoveryCount || 0})
      if (!this.destroyed) this.publishState()
    }
  }

  validateRuntimeManifest(rawManifest) {
    const imagery = this.options.imagery || null
    if (imagery && typeof imagery.resolveTile === 'function') {
      this.textureUrlResolver = imagery.resolveTile
      return validateManifest(manifestForImagerySource(
        rawManifest, imagery, 'global-geodetic'), imagery.id)
    }
    if (imagery && imagery.texture) {
      invariant(typeof imagery.textureId === 'string' &&
        imagery.textureId.length > 0, 'Imagery profile texture ID is required')
      invariant(typeof imagery.urlForTile === 'function',
        'Imagery profile URL resolver is required')
    }
    const manifestForValidation = imagery && imagery.texture
      ? Object.assign({}, rawManifest, { textures: [imagery.texture] })
      : rawManifest
    this.textureUrlResolver = imagery && imagery.texture && imagery.urlForTile
    return validateManifest(manifestForValidation,
      imagery && imagery.texture ? imagery.textureId : this.options.textureId)
  }

  requiredAbiMethods() {
    if (this.abi && this.abi.isWorker) {
      return ['setResourceLedger', 'loadManifest', 'setViewport', 'setCamera', 'step', 'getCameraSnapshot',
        'advanceTerrain', 'submitRecord', 'failRecord', 'retryRecord', 'destroy',
        'retainMeshes', 'presentFrame', 'discardFrame']
    }
    const methods = ['setResourceLedger', 'loadManifest', 'setViewport', 'setCamera', 'prepareMeshFrame',
      'createMeshTask', 'commitMeshFrame', 'discardMeshPlan',
      'getUpdateState', 'getMeshResources', 'copyMeshPositions', 'copyMeshUv', 'getRequests',
      'getIndices', 'getCameraSnapshot', 'submitRecord', 'failRecord',
      'retryRecord', 'advanceTerrain', 'retainMeshes', 'presentFrame', 'destroy']
    if (this.manifest && this.manifest.transform === 'cylindrical') {
      methods.splice(3, 0, 'setGlobeTarget')
    }
    return methods
  }

  configureAbi() {}

  applyAtmosphere() {
    if (!this.renderer) return
    if (typeof this.renderer.setAtmosphereEnabled === 'function') {
      this.renderer.setAtmosphereEnabled(this.atmosphere.enabled)
    }
    if (this.atmosphere.enabled && this.abi &&
      typeof this.abi.computeAtmosphere === 'function' &&
      typeof this.renderer.setAtmosphere === 'function') {
      const atmosphere = this.abi.computeAtmosphere(this.atmosphere)
      if (atmosphere && typeof atmosphere.then === 'function') {
        const revision = this.atmosphere
        atmosphere.then(result => {
          if (this.destroyed || revision !== this.atmosphere) return
          this.installAtmosphere(result)
          this.scheduleRender()
        }).catch(error => this.diagnostic('atmosphere_failed', { message: error.message }))
        return
      }
      this.installAtmosphere(atmosphere)
    }
  }

  installAtmosphere(atmosphere) {
    if (atmosphere) {
      atmosphere.sunVisible = atmosphere.sunVisible &&
        this.atmosphere.sunEnabled
      atmosphere.fogEnabled = this.atmosphere.fogEnabled
      atmosphere.fogDensityMultiplier =
        this.atmosphere.fogDensityMultiplier
      this.renderer.setAtmosphere(atmosphere)
    }
  }

  getAtmosphere() {
    return Object.assign({}, this.atmosphere)
  }

  setAtmosphere(value) {
    invariant(this.manifest &&
      this.manifest.transform === 'cylindrical',
    'Atmosphere is only available in globe mode')
    invariant(value && typeof value === 'object',
      'Atmosphere options are required')
    this.atmosphere = normalizeAtmosphereOptions(
      Object.assign({}, this.atmosphere, value))
    this.applyAtmosphere()
    this.scheduleRender()
    this.publishState()
    return this.getAtmosphere()
  }

  createInitialCamera() {
    return geographicCamera(this.manifest.radius,
      this.budget.physicalWidth, this.budget.physicalHeight, this.fovRadians,
      this.options.initialTarget)
  }

  async fetchManifest() {
    invariant(this.serviceOrigin, 'Terrain service origin is required')
    const url = joinServiceUrl(this.serviceOrigin,
      this.options.manifestPath || '/terra/v1/datasets/globe/manifest')
    const task = this.request({ url, method: 'GET', timeout: 15000, maximumResponseBytes: MAXIMUM_METADATA_BYTES })
    const response = await task.promise
    return parseJsonResponse(response, 'Terrain manifest request')
  }

  resize(viewport) {
    invariant(!this.destroyed, 'Terra globe runtime is destroyed')
    this.budget = this.frameBudget(viewport, this.renderer.capabilities())
    this.applyBudget()
    this.canvas.width = this.budget.physicalWidth
    this.canvas.height = this.budget.physicalHeight
    this.renderer.resize(this.budget.physicalWidth, this.budget.physicalHeight)
    this.abi.setViewport(this.budget.physicalWidth, this.budget.physicalHeight,
      this.fovRadians)
    this.refresh()
  }

  frameBudget(viewport, capabilities) {
    return Object.assign(deriveFrameBudget(viewport, capabilities, this.frameQuality), this.resourcePolicy)
  }

  applyBudget() {
    // Resolution/scheduling changes cannot rewrite instance capacities.
    Object.assign(this.budget, this.resourcePolicy)
    const maximumTerrainRequests = Math.max(1, Math.min(
      this.maximumTerrainRequests, this.budget.maximumConcurrentRequests))
    this.scheduler.maximumConcurrent = maximumTerrainRequests
    this.terrainTransport.scheduler.maximumConcurrent = maximumTerrainRequests
    if (this.renderer && typeof this.renderer.setBudget === 'function') {
      this.renderer.setBudget({
        geometryCacheBytes: this.budget.geometryCacheBytes,
        partitionCacheBytes: this.budget.partitionCacheBytes,
        textureCacheBytes: this.budget.textureCacheBytes,
        maximumTextureEntries: this.budget.maximumTextureEntries,
        uploadBudgetMs: this.budget.uploadBudgetMs,
        devicePixelRatio: this.budget.devicePixelRatio,
        // Network/body admission is independent of the viewport's CPU budget.
        maximumTextureRequests: this.maximumTextureRequests
      })
    }
  }

  viewMode() {
    return this.manifest.transform === 'planar' ? 'planar' : 'globe'
  }

  rangeLimits() {
    return {
      minimum: 0.1,
      maximum: this.manifest.radius * 19
    }
  }

  queryTerrain(u, v, options) { return this.heightQueries.query(u, v, options) }

  async sampleTerrain(u, v) {
    invariant(!this.destroyed && this.abi && !this.abi.destroyed,
      'Terrain query runtime is unavailable')
    invariant((this.pendingTerrainQueries || 0) < 16, 'Terrain query capacity exceeded')
    const abi = this.abi
    this.pendingTerrainQueries = (this.pendingTerrainQueries || 0) + 1
    try {
      const sample = await abi.sampleTerrain(u, v)
      invariant(!this.destroyed && this.abi === abi && !abi.destroyed,
        'Terrain query runtime was replaced')
      return sample
    } finally { --this.pendingTerrainQueries }
  }

  normalizeView(view) {
    invariant(view && typeof view === 'object', 'ViewState is required')
    if (view.schema === eyeView.SCHEMA) return eyeView.normalize(view, this.manifest.radius)
    invariant(!view.schema || view.schema === 'terra.view-state.v2',
      'ViewState schema is unsupported')
    const mode = this.viewMode()
    invariant(!view.mode || view.mode === mode,
      `ViewState mode must be ${mode}`)
    const target = view.target || {}
    const longitudeDegrees = finiteNumber(
      target.longitudeDegrees, 'View target longitude')
    const latitudeDegrees = finiteNumber(
      target.latitudeDegrees, 'View target latitude')
    invariant(longitudeDegrees >= -180 && longitudeDegrees <= 180 &&
      latitudeDegrees >= -90 && latitudeDegrees <= 90,
    'View target is outside globe bounds')
    const limits = this.rangeLimits()
    const rangeMeters = finiteNumber(view.rangeMeters, 'View range')
    invariant(rangeMeters >= limits.minimum &&
      rangeMeters <= limits.maximum, 'View range is outside runtime limits')
    const headingDegrees = finiteNumber(
      view.headingDegrees, 'View heading')
    const tiltDegrees = finiteNumber(view.tiltDegrees, 'View tilt')
    invariant(tiltDegrees >= 0 && tiltDegrees <= 89.5,
      'View tilt is outside [0, 89.5]')
    return {
      schema: 'terra.view-state.v2',
      mode,
      target: {
        longitudeDegrees,
        latitudeDegrees,
        heightMeters: targetHeight(target.heightMeters, this.manifest.radius)
      },
      rangeMeters,
      headingDegrees: wrapDegrees(headingDegrees),
      tiltDegrees
    }
  }

  getView() {
    if (this.camera.model === 'eye') return eyeView.fromCamera(this.camera)
    return {
      schema: 'terra.view-state.v2',
      mode: this.viewMode(),
      target: {
        longitudeDegrees: this.camera.longitudeDegrees,
        latitudeDegrees: this.camera.latitudeDegrees,
        heightMeters: this.camera.targetHeightMeters
      },
      rangeMeters: this.camera.distance,
      headingDegrees: wrapDegrees(this.camera.yawRadians * RADIANS_TO_DEGREES),
      tiltDegrees: this.camera.tiltRadians === 0 ? 0 :
        -this.camera.tiltRadians * RADIANS_TO_DEGREES
    }
  }

  assignView(view) {
    if (view.schema === eyeView.SCHEMA) { Object.assign(this.camera, eyeView.toCamera(view)); return }
    this.camera.model = 'orbit'
    this.camera.longitudeDegrees = view.target.longitudeDegrees
    this.camera.latitudeDegrees = view.target.latitudeDegrees
    this.camera.distance = view.rangeMeters
    this.camera.targetHeightMeters = view.target.heightMeters
    this.camera.yawRadians = view.headingDegrees * DEGREES_TO_RADIANS
    this.camera.tiltRadians = -view.tiltDegrees * DEGREES_TO_RADIANS
  }

  interpolateView(start, target, t, headingDelta) {
    if (start.schema === eyeView.SCHEMA) return eyeView.interpolate(start, target, t, headingDelta)
    return {
      schema: 'terra.view-state.v2',
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
    invariant(!animation.animate || normalized.schema === this.getView().schema,
      'Animated view changes require the same camera model')
    this.walkController.cancel()
    if (animation.animate) {
      this.animateView(normalized, animation.durationMs)
      return normalized
    }
    this.cancelAnimation()
    this.assignView(normalized)
    if (this.previewCamera()) this.scheduleRefresh()
    else this.refresh()
    return this.getView()
  }

  animateView(target, durationMs) {
    this.cancelAnimation()
    const start = this.getView()
    const duration = clamp(durationMs === undefined ? 250 :
      finiteNumber(durationMs, 'Animation duration'), 0, 3000)
    if (duration === 0) {
      this.assignView(target)
      this.refresh()
      return
    }
    const startedAt = this.frameClock.now()
    const headingDelta = wrapDegrees(
      target.headingDegrees - start.headingDegrees)
    const step = () => {
      if (!this.cameraAnimation) {
        return
      }
      const now = this.frameClock.now()
      const elapsed = now - startedAt
      const linear = clamp(elapsed / duration, 0, 1)
      const t = 1 - Math.pow(1 - linear, 3)
      const view = this.interpolateView(start, target, t, headingDelta)
      this.assignView(view)
      const lodRefreshDue = linear >= 1 ||
        now - this.cameraAnimation.lastLodRefreshAt >=
          ANIMATION_LOD_INTERVAL_MS
      if (lodRefreshDue) this.cameraAnimation.lastLodRefreshAt = now
      const previewed = this.previewCamera()
      if (lodRefreshDue || !previewed) this.scheduleRefresh()
      if (linear >= 1) {
        this.cameraAnimation = null
        this.cameraEvent('camerasettle', { view: this.getView() })
      } else {
        this.cameraAnimation.frame = this.frameClock.request('animation', step)
      }
    }
    this.cameraAnimation = {
      lastLodRefreshAt: startedAt,
      frame: this.frameClock.request('animation', step)
    }
  }

  cancelAnimation() {
    if (!this.cameraAnimation) {
      return false
    }
    this.frameClock.cancel(this.cameraAnimation.frame)
    this.cameraAnimation = null
    this.cameraEvent('animationcancel', { view: this.getView() })
    return true
  }

  cameraEvent(type, detail) {
    if (typeof this.options.onCameraEvent === 'function') {
      this.options.onCameraEvent(type, detail || {})
    }
  }

  panGround(deltaX, deltaY) {
    const dpr = Math.max(1, this.budget.devicePixelRatio || 1)
    const width = this.budget.physicalWidth / dpr, height = this.budget.physicalHeight / dpr
    const snapshot = cameraSnapshot(this.manifest, this.camera,
      { width: this.budget.physicalWidth, height: this.budget.physicalHeight, fovRadians: this.fovRadians })
    const ray = (x, y) => ground.cameraRay(snapshot, x, y, width, height, this.fovRadians)
    const globe = this.manifest.transform === 'cylindrical'
    const hit = r => ground.surfaceHit(this.renderedSurface, r) || (globe
      ? ground.sphereHit(r, this.manifest.radius + (this.camera.targetHeightMeters || 0))
      : (r.direction[2] < -1e-8 ? r.origin.map((v, i) => v - (r.origin[2] - (this.camera.targetHeightMeters || 0)) / r.direction[2] * r.direction[i]) : null))
    const anchor = hit(ray(width / 2, height / 2))
    const moved = hit(ray(width / 2 + deltaX, height / 2 + deltaY))
    if (!anchor || !moved) return false
    if (!globe) {
      this.camera.x = clamp(this.camera.x + anchor[0] - moved[0], this.manifest.minimumU, this.manifest.maximumU)
      this.camera.y = clamp(this.camera.y + anchor[1] - moved[1], this.manifest.minimumV, this.manifest.maximumV)
      return true
    }
    const lon = this.camera.longitudeDegrees * DEGREES_TO_RADIANS
    const lat = this.camera.latitudeDegrees * DEGREES_TO_RADIANS
    const target = [Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat)]
    const rotated = ground.rotateBetween(target, moved, anchor)
    if (!rotated) return false
    this.camera.longitudeDegrees = wrapDegrees(Math.atan2(rotated[0], rotated[2]) * RADIANS_TO_DEGREES)
    this.camera.latitudeDegrees = clamp(Math.asin(clamp(rotated[1], -1, 1)) * RADIANS_TO_DEGREES, -85, 85)
    return true
  }

  constrainCamera() {
    if (this.manifest.transform !== 'cylindrical') return false
    const signature = [this.camera.longitudeDegrees, this.camera.latitudeDegrees,
      this.camera.distance, this.camera.targetHeightMeters, this.camera.tiltRadians, this.camera.yawRadians,
      this.renderedSurfaceRevision, this.groundDemands && this.groundDemands.revision].join('|')
    if (signature === this.clearanceSignature) return false
    const clearance = this.options.minimumTerrainClearanceMeters === undefined
      ? 2 : finiteNumber(this.options.minimumTerrainClearanceMeters, 'Terrain clearance')
    invariant(clearance >= 0 && clearance <= 10000, 'Terrain clearance is invalid')
    let changed = false
    for (let pass = 0; pass < 3; ++pass) {
      const snapshot = cameraSnapshot(this.manifest, this.camera, {
        width: this.budget.physicalWidth, height: this.budget.physicalHeight, fovRadians: this.fovRadians })
      const radius = this.manifest.radius, length = Math.hypot(...snapshot.cameraPosition)
      if (this.groundDemands) this.groundDemands.update(snapshot)
      const demand = this.groundDemands && this.groundDemands.samples.eye
      const up = snapshot.cameraPosition.map(v => v / length)
      const surface = ground.surfaceHit(this.renderedSurface,
        { origin: up.map(v => v * (radius + 100000)), direction: up.map(v => -v) })
      const visibleHeight = surface ? Math.hypot(...surface) - radius : null
      const queriedHeight = demand && demand.available ? demand.heightMeters : null
      const available = visibleHeight !== null || queriedHeight !== null
      const elevation = available ? Math.max(visibleHeight === null ? -Infinity : visibleHeight,
        queriedHeight === null ? -Infinity : queriedHeight) : 0
      this.cameraGround = { eyeHeightMeters: length - radius, terrainHeightMeters: available ? elevation : null,
        appliedDemandRevision: this.groundDemands ? this.groundDemands.revision : 0,
        minimumClearanceMeters: clearance, terrainSampleAvailable: available,
        renderedHeightMeters: visibleHeight, queriedHeightMeters: queriedHeight,
        constraintSource: queriedHeight !== null && queriedHeight >= (visibleHeight === null ? -Infinity : visibleHeight)
          ? 'cbdam-query' : surface ? 'rendered-surface' : 'reference-sphere',
        demand: this.groundDemands ? this.groundDemands.state() : null }
      const height = elevation + clearance
      if (length - radius >= height - 0.01) break
      const targetHeight = this.camera.targetHeightMeters || 0
      // Raise the anchor, preserving the requested range and orientation. At
      // grazing angles increasing range would move the eye far from its region.
      const c = this.camera.distance * Math.cos(this.camera.tiltRadians)
      const s = this.camera.distance * Math.sin(this.camera.tiltRadians)
      const eyeHeight = length - radius
      this.camera.targetHeightMeters = targetHeight + (height - eyeHeight) * (2 * radius + height + eyeHeight) /
        (Math.sqrt((radius + height) ** 2 - s * s) + radius + targetHeight + c)
      changed = true
    }
    this.clearanceSignature = changed ? null : signature
    return changed
  }

  getTerrainState() { return this.groundDemands.state() }
  retryTerrain() {
    this.groundDemands.retry(); this.clearanceSignature = null
    if (!this.paused && !this.destroyed) this.scheduleRefresh()
  }

  applyPanPixels(deltaX, deltaY) {
    if (this.panGround(deltaX, deltaY)) return
    const radius = this.manifest.radius
    const devicePixelRatio = Math.max(1, this.budget.devicePixelRatio || 1)
    const viewportHeight = Math.max(1,
      this.budget.physicalHeight / devicePixelRatio)
    const altitude = Math.max(0.1, this.camera.distance)
    const metersPerPixel = 2 * altitude * Math.tan(this.fovRadians / 2) /
      viewportHeight
    const tiltScale = 1 / Math.max(0.25,
      Math.cos(Math.abs(this.camera.tiltRadians)))
    const localEast = -deltaX * metersPerPixel
    const localNorth = deltaY * metersPerPixel * tiltScale
    const heading = this.camera.yawRadians
    const east = localEast * Math.cos(heading) +
      localNorth * Math.sin(heading)
    const north = -localEast * Math.sin(heading) +
      localNorth * Math.cos(heading)
    const latitudeRadians = this.camera.latitudeDegrees * DEGREES_TO_RADIANS
    const longitudeRadius = radius * Math.max(Math.cos(latitudeRadians),
      Math.cos(85 * DEGREES_TO_RADIANS))
    this.camera.longitudeDegrees = wrapDegrees(
      this.camera.longitudeDegrees + east / longitudeRadius *
        RADIANS_TO_DEGREES)
    this.camera.latitudeDegrees = clamp(
      this.camera.latitudeDegrees + north / radius * RADIANS_TO_DEGREES,
      -85, 85)
  }

  applyZoomScale(value, name) {
    invariant(this.camera.model !== 'eye', 'Zoom requires an orbit view')
    const scale = finiteNumber(value, name || 'Zoom scale')
    invariant(scale > 0, `${name || 'Zoom scale'} must be positive`)
    const limits = this.rangeLimits(), previous = this.camera.distance
    this.camera.distance = clamp(previous * scale, limits.minimum, limits.maximum)
    return this.camera.distance / previous
  }

  applyInteraction(change) {
    const value = change || {}
    this.cancelAnimation()
    if (this.camera.model === 'eye') {
      const scale = this.fovRadians / this.budget.physicalHeight * (this.budget.devicePixelRatio || 1)
      this.camera.yawRadians = wrapRadians(this.camera.yawRadians +
        finiteNumber(value.headingDegrees || 0, 'Look heading') * DEGREES_TO_RADIANS -
        finiteNumber(value.xPixels || 0, 'Look X') * scale)
      this.camera.tiltRadians = clamp(this.camera.tiltRadians -
        finiteNumber(value.tiltDegrees || 0, 'Look pitch') * DEGREES_TO_RADIANS -
        finiteNumber(value.yPixels || 0, 'Look Y') * scale, -179.5 * DEGREES_TO_RADIANS, -0.5 * DEGREES_TO_RADIANS)
      if (this.previewCamera()) this.scheduleInteractionRefresh()
      else this.refresh()
      return
    }
    const panX = finiteNumber(value.xPixels || 0,
      'Interaction pan X')
    const panY = finiteNumber(value.yPixels || 0,
      'Interaction pan Y')
    const headingDegrees = finiteNumber(
      value.headingDegrees || 0, 'Heading delta')
    const tiltDegrees = finiteNumber(
      value.tiltDegrees || 0, 'Tilt delta')
    const zoomChanged = value.zoomScale !== undefined && value.zoomScale !== 1
    if (panX || panY) {
      this.applyPanPixels(panX, panY)
    }
    if (zoomChanged) {
      const effectiveScale = this.applyZoomScale(value.zoomScale,
        'Interaction zoom scale')
      if (value.anchor) {
        const dpr = Math.max(1, this.budget.devicePixelRatio || 1)
        const width = this.budget.physicalWidth / dpr
        const height = this.budget.physicalHeight / dpr
        const anchorScale = 1 - 1 / effectiveScale
        this.applyPanPixels(
          (finiteNumber(value.anchor.x, 'Zoom anchor X') - width / 2) *
            anchorScale,
          (finiteNumber(value.anchor.y, 'Zoom anchor Y') - height / 2) *
            anchorScale)
      }
    }
    this.camera.yawRadians = wrapRadians(this.camera.yawRadians +
      headingDegrees * DEGREES_TO_RADIANS)
    this.camera.tiltRadians = clamp(this.camera.tiltRadians -
      tiltDegrees * DEGREES_TO_RADIANS, MIN_TILT_RADIANS, MAX_TILT_RADIANS)
    const changed = panX || panY || zoomChanged ||
      headingDegrees || tiltDegrees
    if (!changed) return
    if (this.interactionActive && this.previewCamera()) {
      this.scheduleInteractionRefresh()
      return
    }
    this.refresh()
  }

  cancelCameraRefresh() {
    if (this.cameraRefreshTimer === null) {
      return
    }
    clearTimeout(this.cameraRefreshTimer)
    this.cameraRefreshTimer = null
  }

  scheduleCameraRefresh() {
    if (this.destroyed || this.paused) {
      this.cameraPreviewDirty = true
      this.refreshPending = true
      return
    }
    if (!this.previewCamera()) {
      this.refresh()
      return
    }
    if (this.cameraRefreshTimer !== null) return
    this.cameraRefreshTimer = setTimeout(() => {
      this.cameraRefreshTimer = null
      if (this.destroyed) return
      if (this.paused || this.interactionActive) {
        this.refreshPending = true
        return
      }
      this.refresh()
    }, this.cameraSettleDelayMs)
  }

  panBy(change) {
    if (this.camera.model === 'eye') { this.applyInteraction(change); return }
    const value = change || {}
    this.cancelAnimation()
    this.applyPanPixels(finiteNumber(value.xPixels, 'Pan X'),
      finiteNumber(value.yPixels, 'Pan Y'))
    this.scheduleCameraRefresh()
  }

  zoomBy(scale, options) {
    invariant(this.camera.model !== 'eye', 'Zoom requires an orbit view')
    this.cancelAnimation()
    const effectiveScale = this.applyZoomScale(scale, 'Zoom scale')
    const anchor = options && options.anchor
    if (anchor) {
      const dpr = Math.max(1, this.budget.devicePixelRatio || 1)
      const width = this.budget.physicalWidth / dpr
      const height = this.budget.physicalHeight / dpr
      const anchorScale = 1 - 1 / effectiveScale
      this.applyPanPixels(
        (finiteNumber(anchor.x, 'Zoom anchor X') - width / 2) *
          anchorScale,
        (finiteNumber(anchor.y, 'Zoom anchor Y') - height / 2) *
          anchorScale)
    }
    this.scheduleCameraRefresh()
  }

  orbitBy(change) {
    if (this.camera.model === 'eye') { this.applyInteraction(change); return }
    const value = change || {}
    this.cancelAnimation()
    this.camera.yawRadians = wrapRadians(this.camera.yawRadians +
      finiteNumber(value.headingDegrees || 0, 'Heading delta') *
        DEGREES_TO_RADIANS)
    this.camera.tiltRadians = clamp(this.camera.tiltRadians -
      finiteNumber(value.tiltDegrees || 0, 'Tilt delta') *
        DEGREES_TO_RADIANS, MIN_TILT_RADIANS, MAX_TILT_RADIANS)
    this.scheduleCameraRefresh()
  }

  setTilt(tiltDegrees) {
    invariant(this.camera.model !== 'eye', 'Use eye view pitch or orbitBy to look in eye mode')
    const value = finiteNumber(tiltDegrees, 'Tilt')
    invariant(value >= 0 && value <= 89.5,
      'Tilt is outside [0, 89.5]')
    this.cancelAnimation()
    this.camera.tiltRadians = -value * DEGREES_TO_RADIANS
    this.scheduleCameraRefresh()
  }

  reset() {
    this.walkController.cancel()
    this.cancelAnimation()
    this.camera = geographicCamera(this.manifest.radius,
      this.budget.physicalWidth, this.budget.physicalHeight, this.fovRadians,
      this.options.initialTarget)
    this.refresh()
  }

  retryFailed() {
    invariant(!this.destroyed, 'Terra globe runtime is destroyed')
    if (this.abi && this.abi.isWorker && this.abi.destroyed) {
      this.workerRecoveryCount = 0
      this.recoverWorker(new Error('Retry terrain Worker'))
      return true
    }
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
        this.retryTerrainRecord(request)
        this.failedRequests.delete(key)
        this.failureExpiry.delete(key)
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
    const longitude = finiteNumber(longitudeDegrees,
      'Target longitude')
    const latitude = finiteNumber(latitudeDegrees, 'Target latitude')
    invariant(longitude >= -180 && longitude <= 180,
      'Target longitude is outside [-180, 180]')
    invariant(latitude >= -90 && latitude <= 90,
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
      this.applyZoomScale(value.zoomScale, 'Zoom scale')
    }
    if (value.tiltDelta !== undefined) {
      this.camera.tiltRadians = clamp(
        this.camera.tiltRadians +
          finiteNumber(value.tiltDelta, 'Tilt delta'),
        MIN_TILT_RADIANS, MAX_TILT_RADIANS)
    }
    if (value.yawDelta !== undefined) {
      this.camera.yawRadians = wrapRadians(this.camera.yawRadians +
        finiteNumber(value.yawDelta, 'Yaw delta'))
    }
    this.scheduleCameraRefresh()
  }

  setTiltRadians(value) {
    this.setTilt(-finiteNumber(value, 'Tilt') * RADIANS_TO_DEGREES)
  }

  tilt45() {
    this.setTiltRadians(-Math.PI / 4)
  }

  rotateYaw(delta) {
    this.camera.yawRadians = wrapRadians(this.camera.yawRadians +
      finiteNumber(delta, 'Yaw'))
    this.scheduleCameraRefresh()
  }

  topDown() {
    this.camera.tiltRadians = 0
    this.scheduleCameraRefresh()
  }

  northUp() {
    this.camera.yawRadians = 0
    this.scheduleCameraRefresh()
  }

  focusInitialTarget(rangeMeters) {
    this.camera.model = 'orbit'
    const range = rangeMeters === undefined ? this.manifest.radius * 0.45 :
      finiteNumber(rangeMeters, 'Focus range')
    const limits = this.rangeLimits()
    invariant(range >= limits.minimum && range <= limits.maximum, 'Focus range is outside limits')
    const target = this.options.initialTarget || {
      longitudeDegrees: 0,
      latitudeDegrees: 0
    }
    this.camera.longitudeDegrees = finiteNumber(
      target.longitudeDegrees, 'Initial target longitude')
    this.camera.latitudeDegrees = finiteNumber(
      target.latitudeDegrees, 'Initial target latitude')
    this.camera.distance = range
    this.camera.targetHeightMeters = target.heightMeters || 0
    this.camera.tiltRadians = 0
    this.camera.yawRadians = 0
    this.refresh()
  }

  synchronizeCameraRevision() {
    if (!this.camera || !this.budget) {
      return this.cameraRevision
    }
    const target = this.manifest.transform === 'cylindrical'
      ? [this.camera.longitudeDegrees, this.camera.latitudeDegrees]
      : [this.camera.x, this.camera.y]
    this.constrainCamera()
    const signature = target.concat([
      this.camera.distance,
      this.camera.targetHeightMeters,
      this.camera.tiltRadians,
      this.camera.yawRadians,
      this.budget.physicalWidth,
      this.budget.physicalHeight,
      this.manifest.texture.id, this.manifest.texture.matrix_level_offset,
      this.manifest.texture.maximum_level,
      this.imageryRevision || 0
    ]).join('|')
    if (signature !== this.cameraSignature) {
      this.failureExpiry.forEach((expires, key) => {
        if (expires > Date.now()) return
        const request = this.failedRequests.get(key)
        if (request && this.abi) this.retryTerrainRecord(request)
        this.failedRequests.delete(key)
        this.failureExpiry.delete(key)
      })
      this.cameraSignature = signature
      this.retries.clear()
      this.consecutiveRefreshFailures = 0
      this.cameraRevision += 1
      this.frameClock.markCamera()
    }
    return this.cameraRevision
  }

  applyNativeCamera() {
    this.synchronizeCameraRevision()
    this.applyAbiCamera(this.camera)
    if (this.localExecution) this.localExecution.observeView()
  }

  applyAbiCamera(camera, viewport) {
    if (viewport) this.abi.setViewport(viewport.width, viewport.height, viewport.fovRadians)
    if (!this.abi.isWorker && this.manifest.transform === 'cylindrical') {
      this.abi.setGlobeTarget(camera.longitudeDegrees, camera.latitudeDegrees)
    } else if (!this.abi.isWorker) this.abi.setPlanarTarget(camera.x, camera.y)
    this.abi.setCamera(camera)
  }

  previewCamera() {
    if (!this.lastFrame || !this.abi ||
      typeof this.abi.getCameraSnapshot !== 'function' ||
      !this.renderer || typeof this.renderer.setCameraFrame !== 'function') {
      return false
    }
    const startedAt = monotonicNow()
    try {
      this.applyNativeCamera()
      const snapshot = this.abi.getCameraSnapshot()
      this.lastFrame = Object.assign({}, this.lastFrame, snapshot)
      if (this.presentedFrame) this.presentedFrame = Object.assign({}, this.presentedFrame, snapshot)
      this.renderer.setCameraFrame(snapshot)
      this.cameraPreviewDirty = true
      if (this.scheduledImagery) this.scheduleImageryContinuation()
      recordTiming(this.performanceStats.cameraPreview,
        monotonicNow() - startedAt)
      this.lastError = ''
      this.scheduleRender()
      return true
    } catch (error) {
      this.diagnostic('camera_preview_failed', {
        message: redactSensitiveText(error.message || String(error))
      })
      return false
    }
  }

  cancelInteractionRefresh() {
    if (this.interactionRefreshTimer !== null) clearTimeout(this.interactionRefreshTimer)
    this.interactionRefreshTimer = null
  }

  scheduleInteractionRefresh() {
    if (this.destroyed || this.paused || !this.interactionActive ||
        this.interactionRefreshTimer !== null) return
    // Keep the camera path responsive and bound planning to at most one pending
    // latest-camera update. I/O completions use the same coalesced wake-up.
    const delay = Math.max(120, Math.min(500,
      this.performanceStats.fullUpdate.lastMs * 4))
    this.interactionRefreshTimer = setTimeout(() => {
      this.interactionRefreshTimer = null
      if (this.destroyed || this.paused || !this.interactionActive) return
      if (!this.cameraPreviewDirty && !this.refreshPending) return
      this.refreshPending = false
      this.refresh()
    }, delay)
  }

  setInteractionActive(active) {
    const next = Boolean(active)
    if (this.interactionActive === next) {
      return
    }
    this.interactionActive = next
    if (!next) this.cancelInteractionRefresh()
    if (this.renderer && typeof this.renderer.setInteractionActive === 'function') {
      this.renderer.setInteractionActive(next)
    }
    const settleRefresh = !next &&
      (this.cameraPreviewDirty || this.refreshPending)
    if (settleRefresh) {
      this.cancelCameraRefresh()
      this.cameraPreviewDirty = false
      this.scheduleSettledRefresh()
      return
    }
    this.publishState()
  }

  setDebugRendering(options) {
    if (this.renderer && typeof this.renderer.setDebugOptions === 'function') {
      this.renderer.setDebugOptions(options)
      this.publishState()
    }
  }

  scheduleImageryContinuation(delayMs = 16) {
    if (this.destroyed || this.paused || this.imageryContinuationTimer !== null) return
    this.imageryContinuationTimer = setTimeout(() => {
      this.imageryContinuationTimer = null
      this.refreshImagery()
    }, delayMs)
  }

  async refreshImagery() {
    if (this.destroyed || this.paused || this.workerRecovering || this.abi && this.abi.destroyed) return
    if (this.candidateEvaluating) { this.imageryRefreshPending = true; return }
    const waiting = this.imageryCapacityWait
    if (waiting && waiting.availability === this.resourceLedger.availabilityRevision &&
        waiting.camera === this.cameraRevision && waiting.source === (this.imageryRevision || 0)) return
    this.imageryCapacityWait = null
    const execution = this.abi && (this.abi.isWorker ? this.abi : this.localExecution)
    if (!execution || !this.renderer.setImageryPlan) {
      this.cameraSignature = ''
      this.scheduleRefresh()
      return
    }
    if (this.imageryRefreshing) { this.imageryRefreshPending = true; return }
    const surface = this.meshFrames.candidate || this.meshFrames.presented
    if (!surface) return
    const revision = this.cameraRevision, source = this.imageryRevision || 0
    const options = this.renderer.imageryPlanningOptions()
    const signature = value => JSON.stringify(Object.assign({}, value, {admissionRevision: undefined}))
    const planningSignature = signature(options)
    this.imageryRefreshing = true
    this.imageryRefreshPending = false
    const applyResult = (result, streaming) => {
      // Terrain admission can suspend this producer while retaining its
      // cursor. Even if the replacement is refused, the displayed surface
      // must resume that work; otherwise its retained input can itself keep
      // the next terrain attempt out of the shared budget.
      if (this.candidateEvaluating) { this.imageryRefreshPending = true; return }
      if (result.superseded) { this.imageryRefreshPending = true; return }
      if (this.destroyed || this.paused) return
      const currentOptions = this.renderer.imageryPlanningOptions()
      if (source !== (this.imageryRevision || 0) ||
          planningSignature !== signature(currentOptions)) {
        // Source and capacity changes need a fresh plan. A partition eviction
        // alone can reuse this snapshot; GPU admission still checks its bytes.
        if (streaming && execution.cancelImagery) {
          this.imageryRefreshPending = true
          execution.cancelImagery(options, currentOptions)
        } else this.scheduleImageryContinuation()
        return
      }
      if (result.pending) { if (!streaming) this.scheduleImageryContinuation(4); return }
      const currentSurface = this.meshFrames.candidate || this.meshFrames.presented
      if (!currentSurface) return
      const currentCamera = result.viewRevision === undefined ? revision === this.cameraRevision :
        result.viewRevision === (this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision)
      const nativePlan = result.imageryPlan, quality = nativePlan.quality
      // Coarse snapshots can span terrain publications. The renderer validates
      // every current immutable resource before calling that plan complete.
      const currentView = currentCamera && (quality.coarsening ||
        (surface === currentSurface || result.sequence === currentSurface.frame.sequence) &&
        (result.modelRevision === undefined || result.modelRevision === currentSurface.updateState.modelRevision)) &&
        (result.meshIdentity === undefined || result.meshIdentity === currentSurface.meshIdentity)
      const plan = Object.assign({}, nativePlan, {
        draws: currentView ? nativePlan.draws : nativePlan.draws.map(draw =>
          Object.assign({}, draw, {imageryCapacityCoarsened: false})),
        quality: Object.assign({}, quality,
        {planningComplete: quality.planningComplete !== false && currentView,
          cameraCurrent: currentCamera,
          coarsening: Boolean(quality.coarsening && currentCamera)})})
      if (this.renderer.setImageryPlan(currentSurface.frame.sequence, plan,
        currentCamera ? result.measurements : []) === false) {
        this.scheduleImageryContinuation()
        return
      }
      this.retryTerrainDemand()
      this.retryTerrainPrecision()
      if (streaming) { this.scheduleRender(); return }
      if (result.continuation) this.scheduleImageryContinuation(4)
      else if (plan.quality.planningComplete === false || this.renderer.current &&
          this.renderer.current.imageryPlan.quality.planningComplete === false) this.scheduleImageryContinuation()
      this.scheduleRender()
    }
    try {
      this.imageryRefreshRequest = execution.planImagery(surface.frame.sequence, options, value => applyResult(value, true))
      const result = await this.imageryRefreshRequest
      try{applyResult(result, false)}finally{releaseMeasurements(result.measurements)}
    } catch (error) {
      if (!this.destroyed && !this.workerRecovering) {
        if (error.status === 9) {
          if (revision !== this.cameraRevision || source !== (this.imageryRevision || 0) ||
              surface !== (this.meshFrames.candidate || this.meshFrames.presented) ||
              planningSignature !== signature(this.renderer.imageryPlanningOptions())) {
            this.scheduleImageryContinuation()
            return
          }
          this.imageryCapacityWait = {availability:error.capacityRevision === undefined
            ? this.resourceLedger.availabilityRevision : error.capacityRevision, camera:revision, source}
          const recovering = this.recoverSharedCapacity({kind:'imagery-input',
            sequence:surface.frame.sequence, keys:['imagery-input'], shortfallBytes:error.capacityShortfallBytes})
          this.diagnostic('imagery_input_capacity', {message:error.message, bytes:this.abi.imageryInputPayloadBytes(),
            shortfallBytes:error.capacityShortfallBytes, recovering})
          return
        }
        this.diagnostic('imagery_refresh_failed', { message: error.message })
        if (!this.abi.destroyed) this.scheduleImageryContinuation()
      }
    } finally {
      this.imageryRefreshing = false
      this.imageryRefreshRequest = null
      if (this.imageryRefreshPending && !this.destroyed && !this.paused) this.refreshImagery()
    }
  }

  async refresh() {
    if (this.destroyed || this.workerRecovering || this.abi && this.abi.destroyed) {
      return
    }
    this.cancelCameraRefresh()
    if (this.paused) {
      this.refreshPending = true
      return
    }
    if (this.refreshing) {
      this.refreshPending = true
      this.schedulePreparationAdvance()
      return
    }
    if (this.meshRecovery) { this.refreshPending = false; await this.advanceTerrain(true); return }
    if (!this.meshFrames.candidate && this.lastFrame && this.lastFrame.decisionsComplete === false &&
        this.terrainDemand.blocked && this.terrainDemand.reason !== 'capacity' && !this.pendingTerrainTarget()) {
      const budget = this.terrainModelBudget()
      const view = this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision
      if (this.terrainModel.needsAdvance(this.terrainModelInput(budget), view,
        this.resourceLedger.availabilityRevision)) {
        if (!await this.advanceTerrain()) return
        if (this.destroyed || this.paused || this.workerRecovering) return
      }
      if (!this.terrainModel.needsPublication()) { this.refreshPending = false; return }
    }
    const candidate = this.meshFrames.candidate
    let held = null
    if (candidate && (candidate.frame.coverageComplete !== false ||
        this.presentingSequence === candidate.frame.sequence)) {
      this.refreshPending = true
      if (this.presentingSequence === candidate.frame.sequence) return
      if (!await this.advanceTerrain()) return
      const model = this.terrainProgress && this.terrainProgress.progress
      // Refine in the background, but finish the admitted handoff for this
      // view. A newer model alone must not restart its partition/upload work.
      // Native modelRevision describes a complete published cut, even while
      // priorities/heights for further work are pending. Waiting for that work
      // here can starve this usable checkpoint during continuous camera input.
      if (this.destroyed || this.paused || this.refreshing || this.meshFrames.candidate !== candidate ||
          candidate.selectionViewRevision === (this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision) ||
          this.presentingSequence || !model ||
          !(model.modelRevision > candidate.updateState.modelRevision) ||
          !this.renderer.candidateCanYield(candidate.frame.sequence)) return
      held = this.renderer.holdCandidate(candidate.frame.sequence)
      if (!held) return
    }
    const startedAt = monotonicNow()
    this.refreshing = true
    this.refreshPending = false
    let frameMeasurements
    try {
      // An incomplete coverage cut cannot receive a display receipt. New
      // records or a camera change must be able to replace it while the last
      // presented cut remains owned and visible.
      if (candidate) {
        const owner = this.abi
        // Stop new promotions before draining receipts. The exact submitted
        // mixed cut then survives removal of this candidate in all CPU owners.
        const retained = !held || await this.meshReceipts.retain(candidate.frame.sequence, held.draws)
        if (this.destroyed || this.paused || owner !== this.abi || this.meshFrames.candidate !== candidate) return
        if (!retained) throw new Error('Candidate replacement retention failed')
        if (this.abi.isWorker) await this.abi.discardFrame(candidate.frame.sequence)
        if (this.destroyed || owner !== this.abi) return
        this.meshFrames.discard(candidate.frame.sequence)
        if (held) {
          this.renderer.discardCandidate(held)
          ++this.supersededCandidateCount
        }
        if (this.destroyed) return
        if (this.paused) { this.refreshPending = true; return }
      }
      this.applyNativeCamera()
      let phaseStartedAt = monotonicNow()
      const revision = this.cameraRevision
      const dataRevision = this.terrainRecordRevision
      let meshFrame, background
      const updateBudget = this.terrainUpdateBudget(this.meshCapacityBlocked)
      // Recovery includes publication. Re-enabling refinement here rebuilds
      // speculative leaf heights before the smaller surface can return bytes.
      updateBudget.coarseningOnly = this.meshCapacityBlocked || updateBudget.coarseningOnly
      // Publish the observed model unchanged; a refused physical selection
      // must not enlarge itself on retry. Logical rounds advance separately.
      // Infinity retains the same protection after a call may have mutated
      // topology. A held successor and incomplete boundary group also keep
      // their existing target until its output has acquired ownership.
      if (held || this.terrainChanges > 0 || this.pendingTerrainTarget()) updateBudget.maximumChangeCount = 0
      try {
        this.candidateEvaluating = true
        const execution = this.abi.isWorker ? this.abi : this.localExecution
        if (this.imageryRefreshing && execution) execution.suspendImagery()
        if (this.imageryRefreshRequest) await this.imageryRefreshRequest.catch(() => {})
        if (this.abi.isWorker) {
          const packet = await this.abi.step(this.budget.lodThreshold,
            updateBudget, this.meshFrames,
            this.renderMode !== 'height' && this.renderer.imageryPlanningOptions && this.renderer.imageryPlanningOptions())
          if (packet.superseded) { this.refreshPending = true; return }
          meshFrame = packet
          // Selection and presentation have separate cameras. A late immutable
          // model still advances terrain and I/O; it never moves the live camera.
          if (packet.selectionViewRevision !== this.abi.viewRevision) this.refreshPending = true
        } else {
          const viewport = {width: this.budget.physicalWidth, height: this.budget.physicalHeight,
            fovRadians: this.fovRadians}
          const selection = this.terrainEpoch.begin({camera: this.camera, viewport,
            viewRevision: revision, threshold: this.budget.lodThreshold})
          try {
            this.applyAbiCamera(selection.camera, selection.viewport)
            meshFrame = this.localExecution
              ? await this.localExecution.step(selection.threshold, updateBudget, Object.assign({}, selection,
                {imagery:this.renderMode !== 'height' && this.renderer.imageryPlanningOptions && this.renderer.imageryPlanningOptions()}))
              : await this.meshFrames.read(this.abi, selection.threshold, updateBudget)
            meshFrame.selectionViewRevision = selection.viewRevision
          } finally {
            if (!this.destroyed) this.applyAbiCamera(this.camera, viewport)
          }
          if (meshFrame.selectionViewRevision !== revision) this.refreshPending = true
        }
      } finally {
        this.candidateEvaluating = false
        frameMeasurements=meshFrame&&meshFrame.measurements
        background = await this.finishTerrainPreparation()
      }
      if (this.destroyed) return
      if (this.paused) {
        if (this.abi.isWorker) await this.abi.discardFrame(meshFrame.frame.sequence)
        this.meshFrames.discard(meshFrame.frame.sequence)
        this.refreshPending = true
        return
      }
      const frame = meshFrame.frame
      if (meshFrame.imageryPlan && meshFrame.imageryViewRevision !==
          (this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision)) {
        meshFrame.imageryPlan.quality = Object.assign({}, meshFrame.imageryPlan.quality,
          {cameraCurrent:false, planningComplete:false})
        meshFrame.measurements = []
      }
      recordTiming(this.performanceStats.lodUpdate,
        monotonicNow() - phaseStartedAt)
      phaseStartedAt = monotonicNow()
      const requests = background && background.requests || meshFrame.requests || this.abi.getRequests()
      const { draws, indices } = meshFrame
      recordTiming(this.performanceStats.frameRead,
        monotonicNow() - phaseStartedAt)
      phaseStartedAt = monotonicNow()
      const presentation = {
        outputs: meshFrame.outputs,
        replacementPlan: meshFrame.replacementPlan,
        camera: this.abi.getCameraSnapshot(),
        selectionCurrent: meshFrame.selectionViewRevision === (this.abi.isWorker ? this.abi.viewRevision : revision)
      }
      // MeshFrames owns fixed imagery footprints and unclaimed destinations
      // until the presentation receipt (or discard), not just frame transfer.
      try {
        this.renderer.setMeshFrame(frame, draws, meshFrame.resources, indices,
          meshFrame.updateState, meshFrame.imageryPlan, meshFrame.measurements, presentation)
        this.terrainModel.accepted(meshFrame.selectionViewRevision, meshFrame.updateState, dataRevision)
        if (this.renderMode !== 'height' && presentation.selectionCurrent) {
          this.terrainDemand.expect(this.terrainDemandView(), frame.sequence)
          this.updateTerrainDemand()
        }
      } catch (error) {
        if (error.candidateAdmissionRejected) {
          const owner = this.abi
          try { if (owner.isWorker) await owner.discardFrame(frame.sequence) }
          finally { if (owner === this.abi) this.meshFrames.discard(frame.sequence) }
          error.requests = requests
          error.modelRevision = meshFrame.updateState.modelRevision
          error.capacitySelectedBytes = meshCutBytes(draws)
        }
        if (meshFrame.outputs) meshFrame.outputs.release()
        throw error
      }
      this.lastSurface = {selectionViewRevision: meshFrame.selectionViewRevision, updateState: meshFrame.updateState}
      this.lastFrame = Object.assign({}, frame, presentation.camera)
      if (draws.length === 0) this.presentMeshFrame(frame.sequence)
      if (this.scheduledImagery && this.renderer.setImageryPlan) this.imageryRefreshPending = true
      recordTiming(this.performanceStats.rendererSetFrame,
        monotonicNow() - phaseStartedAt)
      this.cameraPreviewDirty = meshFrame.selectionViewRevision !== (this.abi.isWorker ? this.abi.viewRevision : revision)
      this.syncTerrainRequests(requests)
      this.meshCapacityBlocked = false
      this.terrainChanges = background && background.changes
      this.lastError = ''
      this.consecutiveRefreshFailures = 0
      recordTiming(this.performanceStats.fullUpdate,
        monotonicNow() - startedAt)
      this.scheduleRender()
      // The publication can consume a queued model wake. An incomplete,
      // unpriced cut still needs one logical observation; its idle clock
      // suppresses equivalent output instead of waiting for an image receipt.
      if (frame.decisionsComplete === false && (!this.terrainDemand.blocked && requests.length === 0 ||
        this.terrainDemand.blocked && this.terrainDemand.reason !== 'capacity' && !this.pendingTerrainTarget() ||
        (meshFrame.updateState.pendingPriorityUpdateCount > 0 || meshFrame.updateState.pendingMeshGroups > 0 ||
          meshFrame.updateState.budgetExhausted &&
            (!this.terrainDemand.blocked || this.terrainDemand.reason === 'capacity')))) {
        this.scheduleRefresh()
      }
      this.publishState()
    } catch (error) {
      if (this.destroyed) return
      if (error.superseded) { this.refreshPending = true; return }
      recordTiming(this.performanceStats.fullUpdate,
        monotonicNow() - startedAt)
      this.terrainEpoch.clear()
      if (error.status === 9) {
        this.reduceTerrainCapacity(error.capacityShortfallBytes, error.capacitySelectedBytes)
        this.terrainChanges = Infinity
        this.meshCapacityBlocked = true
        this.meshCapacityRevision = error.capacityRevision === undefined
          ? this.resourceLedger.availabilityRevision : error.capacityRevision
        // A changed frustum can expose more resident leaves than fit in a new
        // GPU cut. Freezing all topology here prevents the necessary coarsening.
        this.meshRecovery = {changed: false, revision: error.modelRevision}
        this.scheduleRefresh()
        this.lastError = ''
        this.syncTerrainRequests(error.requests || [])
        this.diagnostic('terrain_mesh_capacity_pending', {message: error.message,
          shortfallBytes: error.capacityShortfallBytes, modelRevision: error.modelRevision})
        this.publishState()
        return
      }
      this.meshCapacityBlocked = false
      this.lastError = redactSensitiveText(error.message || String(error))
      this.diagnostic('runtime_refresh_failed', { message: this.lastError })
      this.consecutiveRefreshFailures += 1
      if (this.consecutiveRefreshFailures <= this.maximumRefreshRetries) {
        this.scheduleRefresh()
      }
      this.publishState()
    } finally {
      releaseMeasurements(frameMeasurements)
      if (held) this.renderer.releaseCandidate(held)
      this.refreshing = false
      this.retryMeshCapacity()
      this.retryTerrainDemand()
      this.retryTerrainPrecision()
      if (this.imageryRefreshPending) this.refreshImagery()
      if (this.refreshPending) {
        this.refreshPending = false
        this.scheduleRefresh()
      }
    }
  }

  retryMeshCapacity() {
    if (!this.meshCapacityBlocked || this.destroyed || this.paused || this.refreshing ||
        this.meshCapacityRevision === this.resourceLedger.availabilityRevision) return
    // Coarsening is not the physical admission woken by this refund. Keep
    // the event pending until recovery ends, even if its topology is unchanged.
    if (!this.meshRecovery) this.meshCapacityRevision = this.resourceLedger.availabilityRevision
    this.scheduleRefresh()
  }

  retryTerrainPrecision() {
    if (!this.terrainCapacity || !this.renderer || !this.canRestoreTerrainPrecision()) return
    if (this.terrainCapacity.bytes === this.terrainCapacity.preferred) {
      this.completeTerrainRecovery()
      return
    }
    const demand = this.renderer.terrainRefinementDemand()
    // Finish pricing this relief surface before reopening topology. Its image
    // continuation owns credit before the terrain producer competes for space.
    if (!demand || demand.admission) return
    if (demand.refinable) { this.renderer.refineImageryDemand(); return }
    if (!this.renderer.reserveImageryDemand(demand)) return
    if (this.terrainCapacity.beginRestore(this.cameraRevision)) this.scheduleRefresh()
  }

  completeTerrainRecovery() {
    const capacity = this.terrainCapacity, surface = this.presentedSurface, frame = this.presentedFrame
    if (!capacity || capacity.recoveryView !== this.cameraRevision || capacity.bytes !== capacity.preferred ||
        !surface || !frame || !this.renderer || !this.canRestoreTerrainPrecision()) return
    const state = surface.updateState
    if (surface.selectionViewRevision !== (this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision) ||
        frame.decisionsComplete !== true || frame.coverageComplete !== true ||
        state.pendingMeshGroups || state.pendingPriorityUpdateCount || state.budgetExhausted || state.limitedByCapacity ||
        !Number.isFinite(state.achievedLodError) || !Number.isFinite(state.requestedLodThreshold) ||
        state.achievedLodError > state.requestedLodThreshold) return
    // A terrain receipt can precede its imagery's planning, upload and fade.
    // Keep the relief history until that shared working set actually settles;
    // otherwise later imagery pressure can repeat the same terrain recovery.
    if (this.renderMode !== 'height') {
      const quality = this.renderer.stats().quality
      if (!quality || quality.settled !== true) return
    }
    capacity.complete(this.cameraRevision)
  }

  terrainDemandView() {
    return [this.cameraRevision, this.imageryRevision || 0,
      this.abi && this.abi.generation || 0, this.renderMode || 'texture'].join(':')
  }

  updateTerrainDemand() {
    const blocked = this.terrainDemand.update(this.terrainDemandView(),
      this.renderer ? this.renderer.terrainRefinementDemand() : null,
      demand => this.renderer.reserveImageryDemand(demand))
    if (this.terrainDemand.reason === 'measurement') this.renderer.refineImageryDemand()
    return blocked
  }

  retryTerrainDemand() {
    if (this.destroyed || this.paused || this.workerRecovering) return
    const blocked = this.terrainDemand.blocked
    // Pricing a converged cut is not new terrain work. Reopening it would
    // prepare another identical frame and immediately create another wait.
    if (!this.updateTerrainDemand() && blocked &&
        (!this.lastFrame || this.lastFrame.decisionsComplete === false)) {
      // A planning-only lookahead has no topology to publish. Reuse its
      // unspent window instead of materializing the same coarse cut forever.
      // Real mutations and failed/recovering windows keep their existing cap.
      if (this.terrainChanges === 0) this.terrainChanges = undefined
      this.scheduleRefresh()
    }
  }

  canRestoreTerrainPrecision() {
    return !this.destroyed && !this.paused && !this.workerRecovering && !this.refreshing &&
      !this.meshCapacityBlocked && !this.meshRecovery && !this.terrainPreparation &&
      !this.meshFrames.candidate && !this.presentingSequence && !this.pendingTerrainTarget()
  }

  beginTerrainPreparation(packet) {
    invariant(!this.terrainPreparation, 'A terrain preparation is already active')
    const epoch = this.terrainEpoch.active
    const viewRevision = packet.selectionViewRevision === undefined
      ? epoch ? epoch.viewRevision : this.cameraRevision : packet.selectionViewRevision
    if (!this.abi.isWorker) this.terrainEpoch.finish(packet.updateState)
    let releaseDemand
    const surface = this.meshFrames.candidate || this.meshFrames.presented
    const price = this.renderer.terrainRefinementDemand()
    const priced = price && surface && price.sequence === surface.frame.sequence &&
      packet.updateState.modelRevision === surface.updateState.modelRevision &&
      packet.draws && packet.draws.length === surface.draws.length &&
      packet.draws.every((draw, i) => draw.resourceId === surface.draws[i].resourceId &&
        draw.textureResourceId === surface.draws[i].textureResourceId && draw.flags === surface.draws[i].flags)
    if (this.renderMode !== 'height' && viewRevision ===
        (this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision) && !priced) {
      releaseDemand = this.terrainDemand.prepare(this.terrainDemandView(), packet.frame.sequence)
    }
    this.terrainPreparation = {active: true, changes: 0, ran: false, pending: null, blocked: this.meshCapacityBlocked,
      modelRevision: packet.updateState.modelRevision, viewRevision, releaseDemand}
    // The snapshot keeps its paid output; independent logical rounds continue
    // priorities, topology and I/O without producing intermediate mesh arrays.
    this.schedulePreparationAdvance()
  }

  schedulePreparationAdvance() {
    const work = this.terrainPreparation
    if (!work || !work.active || work.pending || work.blocked || this.destroyed || this.paused) return
    this.frameClock.enqueueWork('terrain-model', () => {
      if (!work.active || work.pending || work.blocked || this.destroyed || this.paused) return
      work.pending = this.advancePreparedTerrain(work)
    })
  }

  pendingTerrainTarget() {
    const surface = this.meshFrames.candidate || this.meshFrames.presented
    return Boolean(surface && surface.updateState.pendingMeshGroups > 0 &&
      surface.selectionViewRevision === (this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision))
  }

  reduceTerrainCapacity(shortfall, selectedBytes) {
    const restoring = this.terrainCapacity.restoring
    if (!restoring && Number.isSafeInteger(selectedBytes) && selectedBytes > 0)
      return this.terrainCapacity.refuse(shortfall, this.cameraRevision, selectedBytes)
    const surface = this.meshFrames.presented
    const positions = new Map(), uv = new Map()
    if (surface) for (const draw of surface.draws) {
      if (!draw.positionFloatCount || !draw.textureFloatCount) continue
      positions.set(draw.resourceId, draw.positionFloatCount * 4)
      uv.set(draw.textureResourceId, draw.textureFloatCount * 4)
    }
    const selected = [...positions.values(), ...uv.values()].reduce((n, bytes) => n + bytes, 0)
    // A refused restoration can have a larger unproduced target than the
    // current relief cut. Back off below the latter's real cost; otherwise a
    // tiny shortfall can repeat the same unchanged cut thousands of times.
    const target = Number.isSafeInteger(selectedBytes) && selectedBytes > 0 ? selectedBytes : Infinity
    return this.terrainCapacity.refuse(shortfall, this.cameraRevision,
      selected ? Math.min(selected, target) : target === Infinity ? undefined : target)
  }

  recoverSharedCapacity(pressure) {
    if (this.destroyed || this.paused || this.meshRecovery || !this.terrainCapacity) return false
    const demand = this.renderer.terrainRefinementDemand()
    // Input production precedes measurement refinement. Waiting for that same
    // unfunded planner would strand both terrain and imagery. Its real byte
    // deficit must enter the existing coarsening/publication recovery path.
    if (pressure.kind !== 'imagery-input' && demand && demand.refinable) {
      this.renderer.refineImageryDemand()
      // The producer still owns this refusal. If measurement keeps the same
      // footprint, its completion must be able to request actual recovery.
      return false
    }
    const signature = [this.abi.generation || 0, this.cameraRevision, pressure.sequence, pressure.keys.join(',')].join(':')
    if (signature === this.lastResourcePressure || !this.reduceTerrainCapacity(pressure.shortfallBytes)) return false
    this.lastResourcePressure = signature
    this.terrainChanges = Infinity
    this.meshCapacityBlocked = true
    this.meshCapacityRevision = this.resourceLedger.availabilityRevision
    this.meshRecovery = {changed: false, revision: this.lastSurface && this.lastSurface.updateState.modelRevision}
    this.scheduleRefresh()
    return true
  }

  terrainModelBudget(recover = false) {
    const dimension = this.manifest.patchDimension
    const budget = terrainResourceBudget(dimension, this.budget, this.options.terrainUpdateBudget)
    if (!this.terrainCapacity || this.terrainCapacity.preferred !== budget.meshBudgetBytes)
      this.terrainCapacity = new TerrainCapacity(budget.meshBudgetBytes,
        32 * (dimension + 1) * (dimension + 2) / 2 * 20)
    this.terrainCapacity.updateView(this.cameraRevision)
    budget.meshBudgetBytes = this.terrainCapacity.bytes
    const blocked = this.updateTerrainDemand()
    budget.coarseningOnly = recover || blocked && this.terrainDemand.reason === 'capacity'
    return budget
  }

  terrainUpdateBudget(recover = false) {
    const budget = this.terrainModelBudget(recover)
    // Physical selection retains its pricing barrier. Logical work owns only
    // bounded native records/heights, never uncredited mesh/GPU destinations.
    if (!recover && this.terrainDemand.blocked && this.terrainDemand.reason !== 'capacity') budget.maximumChangeCount = 0
    return budget
  }

  terrainModelInput(budget) {
    return JSON.stringify([this.abi.generation || 0, this.terrainRecordRevision, this.cameraRevision,
      this.budget.lodThreshold, this.budget.physicalWidth, this.budget.physicalHeight, this.fovRadians,
      this.pendingTerrainTarget(), {...budget, maximumChangeCount: budget.maximumChangeCount === undefined ? 32 : budget.maximumChangeCount}])
  }

  async advanceModel(budget, recover = false) {
    this.applyNativeCamera()
    // Finish a fixed view's selected cut before extending its topology again.
    // Otherwise each partial receipt restarts boundary planning for a new target
    // and can indefinitely postpone its larger groups. Priorities, heights and
    // I/O still advance; camera changes and capacity recovery can revise the cut.
    if (!recover && this.pendingTerrainTarget()) budget.maximumChangeCount = 0
    if (this.abi.isWorker) return this.abi.advanceTerrain(this.budget.lodThreshold, budget)
    const viewport = {width: this.budget.physicalWidth, height: this.budget.physicalHeight,
      fovRadians: this.fovRadians}
    const selection = this.terrainEpoch.begin({camera: this.camera, viewport,
      viewRevision: this.cameraRevision, threshold: this.budget.lodThreshold})
    try {
      this.applyAbiCamera(selection.camera, selection.viewport)
      const progress = await this.abi.advanceTerrain(selection.threshold, budget)
      this.terrainEpoch.finish(progress)
      return {progress, selectionViewRevision: selection.viewRevision, requests: this.abi.getRequests()}
    } finally { if (!this.destroyed) this.applyAbiCamera(this.camera, viewport) }
  }

  async advancePreparedTerrain(work) {
    const started = monotonicNow(), revision = this.terrainWorkRevision
    let continuation = false, input
    try {
      const budget = this.terrainModelBudget()
      const maximum = budget.maximumChangeCount === undefined ? 32 : budget.maximumChangeCount
      budget.maximumChangeCount = maximum
      const dataRevision = this.terrainRecordRevision
      input = this.terrainModelInput(budget)
      const result = await this.advanceModel(budget)
      const changes = result.progress.topologyChangeCount
      this.terrainModel.observe(input, result.selectionViewRevision, result.progress, budget.maximumChangeCount, dataRevision)
      work.ran = true; work.changes += changes; work.requests = result.requests
      if (this.destroyed || this.paused) return
      this.terrainProgress = {workerGeneration: this.abi.generation || 0,
        viewRevision: result.selectionViewRevision, progress: result.progress}
      this.syncTerrainRequests(result.requests)
      continuation = result.progress.pendingPriorityUpdateCount > 0 ||
        result.progress.budgetExhausted && budget.maximumChangeCount > 0 &&
          !result.progress.limitedByCapacity ||
        result.selectionViewRevision !== (this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision)
      if (continuation || result.progress.modelRevision !== work.modelRevision ||
          result.selectionViewRevision !== work.viewRevision) this.refreshPending = true
      this.publishState()
    } catch (error) {
      this.terrainEpoch.clear()
      // A failed call may already have changed topology. Preserve the admitted
      // publication, stop this lookahead and reopen credit only after handoff.
      work.ran = true; work.changes = Infinity; work.blocked = true
      if (error.status === 9) {
        this.terrainModel.refused(input,
          this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision,
          this.resourceLedger.availabilityRevision)
        this.refreshPending = true
        if (!this.destroyed && !this.paused) this.diagnostic('terrain_model_capacity_pending',
          {message: redactSensitiveText(error.message || String(error)), status: error.status})
        return
      }
      if (!this.destroyed && !this.paused) this.diagnostic('terrain_preparation_advance_failed',
        {message: redactSensitiveText(error.message || String(error)), status: error.status})
    } finally {
      work.pending = null
      recordTiming(this.performanceStats.modelAdvance, monotonicNow() - started)
      if (continuation || revision !== this.terrainWorkRevision) this.schedulePreparationAdvance()
    }
  }

  async finishTerrainPreparation() {
    const work = this.terrainPreparation
    if (!work) return undefined
    work.active = false
    this.frameClock.cancelWork('terrain-model')
    if (work.pending) await work.pending
    if (work.releaseDemand) work.releaseDemand()
    this.terrainPreparation = null
    return work.ran ? {changes: work.changes, requests: work.requests} : undefined
  }

  async advanceTerrain(recover = false) {
    const started = monotonicNow(), workRevision = this.terrainWorkRevision
    const before = recover && this.meshCapacityBlocked &&
      this.meshCapacityRevision === this.resourceLedger.availabilityRevision
      ? capacityCheckpoint(this.resourceLedger) : null
    this.refreshing = true
    let continueModel = false, capacityFailure = false
    const viewRevision = this.cameraRevision
    try {
      const budget = this.terrainModelBudget(recover)
      // A model round is bounded independently of presentation receipts.
      // Physical producers still acquire their own complete destinations.
      const maximum = budget.maximumChangeCount === undefined ? 32 : budget.maximumChangeCount
      const used = this.terrainChanges || 0
      budget.maximumChangeCount = maximum
      budget.coarseningOnly = recover || budget.coarseningOnly
      const dataRevision = this.terrainRecordRevision
      const input = this.terrainModelInput(budget)
      this.terrainChanges = Infinity // A failed call may have mutated native state.
      const result = await this.advanceModel(budget, recover)
      const changes = result.progress.topologyChangeCount
      this.terrainModel.observe(input, result.selectionViewRevision, result.progress, budget.maximumChangeCount, dataRevision)
      this.terrainChanges = recover ? Infinity : used + changes
      if (this.destroyed || this.paused) return
      this.terrainProgress = {workerGeneration: this.abi.generation || 0,
        viewRevision: result.selectionViewRevision, progress: result.progress}
      this.syncTerrainRequests(result.requests)
      continueModel = result.progress.pendingPriorityUpdateCount > 0 ||
        result.progress.budgetExhausted && budget.maximumChangeCount > 0 &&
          (recover || !result.progress.limitedByCapacity) ||
        result.selectionViewRevision !== (this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision)
      if (recover) {
        this.meshRecovery.changed = this.meshRecovery.changed || changes > 0 ||
          this.meshRecovery.revision !== undefined && this.meshRecovery.revision !== result.progress.modelRevision
        this.meshRecovery.revision = result.progress.modelRevision
        if (!continueModel) {
          continueModel = this.meshRecovery.changed
          this.meshRecovery = null
        }
      }
      this.publishState()
      return true
    } catch (error) {
      this.terrainEpoch.clear()
      if (error.status === 9) {
        capacityFailure = true
        const reduced = this.reduceTerrainCapacity(error.capacityShortfallBytes, error.capacitySelectedBytes)
        this.meshCapacityBlocked = true
        this.meshCapacityRevision = error.capacityRevision === undefined
          ? this.resourceLedger.availabilityRevision : error.capacityRevision
        // The height cursor was cancelled before this refusal. Allow one
        // coarsening pass; if it also cannot fit, park until real input or
        // ownership changes instead of retrying the same unfunded production.
        this.meshRecovery = recover && !reduced ? null : {changed: false, revision: error.modelRevision}
        continueModel = !recover || reduced
        this.lastError = ''
        this.syncTerrainRequests(error.requests || [])
        this.diagnostic('terrain_height_capacity_pending', {message: error.message,
          shortfallBytes: error.capacityShortfallBytes, recovering: recover, reduced})
        this.publishState()
      } else {
        this.lastError = redactSensitiveText(error.message || String(error))
        this.diagnostic('terrain_advance_failed', {message: this.lastError})
        continueModel = ++this.consecutiveRefreshFailures <= this.maximumRefreshRetries
      }
    } finally {
      recordTiming(this.performanceStats.modelAdvance, monotonicNow() - started)
      // Coarsening can allocate and return private height work without freeing
      // any previously occupied payload. Consume that self-refund only when no
      // real wake was already pending; topology/input continuations still run.
      if (before && !capacityFailure && this.meshCapacityBlocked)
        this.meshCapacityRevision = capacityRefusalRevision(this.resourceLedger, before)
      this.refreshing = false
      this.retryMeshCapacity()
      // A settled model parks while presentation is blocked. A new camera,
      // data arrival or bounded model continuation wakes it; never poll the GPU
      // barrier. A coherent changed model may subsequently replace preparation.
      if (!this.destroyed && !this.paused && (continueModel || !capacityFailure && !recover && (!this.meshFrames.candidate ||
          workRevision !== this.terrainWorkRevision) || viewRevision !== this.cameraRevision)) {
        this.refreshPending = false
        this.scheduleRefresh()
      }
    }
  }

  async presentMeshFrame(sequence) {
    if (this.destroyed || !this.meshFrames.candidate ||
        this.meshFrames.candidate.frame.sequence !== sequence ||
        this.presentingSequence === sequence) return
    const candidate = this.meshFrames.candidate, shown = this.meshFrames.presented
    // Missing/reclaimed data is not an empty-view display receipt. Keep the
    // old native/host cut and its boundary proof until an actual replacement
    // submits; the incomplete candidate can still be discarded on new data.
    // Bootstrap and genuinely complete empty views have no such dependency.
    if (!candidate.draws.length && candidate.frame.coverageComplete === false &&
        shown && shown.draws.length) return
    this.presentingSequence = sequence
    try {
      if (!await this.meshReceipts.present(sequence) || this.destroyed) return
      this.consecutiveRefreshFailures = 0
      this.lastError = ''
      this.presentedFrame = this.meshFrames.presented.frame
      if (this.cameraPreviewDirty) this.presentedFrame = Object.assign({},
        this.presentedFrame, this.abi.getCameraSnapshot())
      this.presentedSurface = {selectionViewRevision: this.meshFrames.presented.selectionViewRevision,
        updateState: this.meshFrames.presented.updateState}
      if (this.refreshPending || this.meshFrames.presented.updateState.pendingMeshGroups > 0) {
        this.refreshPending = false
        this.scheduleRefresh()
      }
    } catch (error) {
      if (!this.destroyed) this.diagnostic('frame_receipt_failed', { message: error.message })
    } finally {
      this.presentingSequence = null
      this.retryTerrainDemand()
      this.retryTerrainPrecision()
      if (this.imageryRefreshPending) this.refreshImagery()
    }
  }

  scheduleRefresh() {
    ++this.terrainWorkRevision
    this.schedulePreparationAdvance()
    if (this.destroyed) {
      return
    }
    if (this.paused || this.interactionActive) {
      this.refreshPending = true
      if (this.interactionActive) this.scheduleInteractionRefresh()
      return
    }
    if (this.refreshing) {
      this.refreshPending = true
      return
    }
    this.refreshPending = true
    this.queueTerrainRefresh()
  }

  queueTerrainRefresh() {
    this.refreshPending = true
    this.frameClock.enqueueWork('terrain', () => {
      if (this.destroyed || this.paused || this.interactionActive || !this.refreshPending) return
      this.refreshPending = false
      this.refresh()
    })
  }

  scheduleTerrainRefresh() {
    if (this.destroyed || this.terrainRefreshTimer !== null) {
      return
    }
    if (this.terrainRefreshStartedAt === 0) {
      this.terrainRefreshStartedAt = Date.now()
    }
    const flush = () => {
      this.terrainRefreshTimer = null
      if (this.destroyed) {
        this.terrainRefreshStartedAt = 0
        return
      }
      const requests = this.scheduler.stats()
      const elapsed = Date.now() - this.terrainRefreshStartedAt
      if (requests.active === 0 && requests.queued === 0 ||
        elapsed >= this.terrainRefreshMaximumDelayMs) {
        this.terrainRefreshStartedAt = 0
        this.scheduleRefresh()
        return
      }
      const remaining = this.terrainRefreshMaximumDelayMs - elapsed
      this.terrainRefreshTimer = setTimeout(flush,
        Math.min(this.terrainRefreshBatchMs, remaining))
    }
    this.terrainRefreshTimer = setTimeout(flush,
      this.terrainRefreshBatchMs)
  }

  cancelTerrainRefresh() {
    if (this.terrainRefreshTimer !== null) {
      clearTimeout(this.terrainRefreshTimer)
      this.terrainRefreshTimer = null
    }
    this.terrainRefreshStartedAt = 0
  }

  scheduleSettledRefresh() {
    if (!this.destroyed) this.queueTerrainRefresh()
  }

  scheduleRender() {
    if (!this.destroyed && !this.paused && this.renderer) this.frameClock.invalidate()
  }

  scheduleResources(delay = 0) {
    if (this.destroyed || this.paused || !this.renderer || this.renderer.contextLost) return
    this.frameClock.enqueueWork('resources', () => {
      if (!this.destroyed && !this.paused) this.renderer.advanceResources()
    }, delay)
  }

  syncTerrainRequests(requests) {
    const ordered = orderTerrainRequests(requests)
    const desired = new Set(ordered.map(request => patchKeyString(request.kind, request.key)))
    this.desiredRequests.clear()
    ordered.forEach(request => this.desiredRequests.set(patchKeyString(request.kind, request.key), request))
    this.scheduler.cancelExcept(desired)
    ordered.forEach((request) => {
      const key = patchKeyString(request.kind, request.key)
      desired.add(key)
      this.desiredRequests.set(key, request)
      const cached = this.recordCache.get(key)
      if (cached || !this.failedRequests.has(key)) {
        this.enqueueTerrainRequest(key, request, this.cameraRevision)
      }
    })
    this.failedRequests.forEach((request, key) => {
      if (!desired.has(key) && this.failedRequests.size > 1024) {
        this.failedRequests.delete(key)
        this.failureExpiry.delete(key)
        this.retries.delete(key)
      }
    })
    this.scheduler.cancelExcept(desired)
  }

  enqueueTerrainRequest(key, request, revision) {
    this.scheduler.enqueue(key,
      () => this.startTerrainRequest(key, request, revision),
      terrainRequestPriority(request))
  }

  terrainRecordChanged(owner) {
    if (this.destroyed || owner !== this.abi || owner.destroyed) return false
    ++this.terrainRecordRevision
    this.scheduleTerrainRefresh()
    return true
  }

  retryTerrainRecord(request) {
    const owner = this.abi
    Promise.resolve(owner.retryRecord(request.kind, request.key)).then(() => this.terrainRecordChanged(owner), error => {
      if (!this.destroyed && owner === this.abi) this.diagnostic('terrain_retry_record_failed',
        {message: redactSensitiveText(error.message || String(error))})
    })
  }

  startTerrainRequest(key, request, revision) {
    const owner = this.abi
    let cancelled = false
    const endpoint = request.kind === REQUEST_ROOT
      ? this.manifest.rootEndpoint
      : this.manifest.detailEndpoint
    const url = joinServiceUrl(this.serviceOrigin,
      replaceTemplate(endpoint, request.key))
    const maximumBytes = maximumEncodedRecordBytes(this.manifest.patchDimension, request.kind)
    let cached = this.recordCache.get(key)
    if (cached && cached.byteLength > maximumBytes) { this.recordCache.delete(key); cached = null }
    const releaseCached = cached ? this.recordCache.retain(key) : () => {}
    const waiting = this.terrainInputs.acquire(cached ? 2 * cached.byteLength : 3 * maximumBytes)
    let task = null, credit = null, submission = null
    const current = () => !this.destroyed && !cancelled && owner === this.abi && !owner.destroyed
    const submitted = waiting.promise.then(async owned => {
      credit = owned
      if (!current()) return
      if (cached) {
        submission = owner.submitRecord(request.kind, request.key, cached)
        await submission
        if (current()) this.retries.delete(key)
        this.terrainRecordChanged(owner)
        return
      }
      task = this.terrainTransport.request({url, method: 'GET', responseType: 'arraybuffer',
        maximumResponseBytes: maximumBytes, timeout: 15000}, terrainRequestPriority(request))
      const response = await task.promise
      if (!current()) return
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(
          `Terrain record returned HTTP ${response.statusCode}`)
        error.statusCode = response.statusCode
        if (request.kind === REQUEST_DETAIL && response.statusCode === 404) {
          error.noData = isMissingTerrainRecord(response.data)
        }
        throw error
      }
      const bytes = validateRecordPayload(response.data, response.header)
      if (!this.desiredRequests.has(key)) return
      submission = owner.submitRecord(request.kind, request.key, bytes)
      await submission
      if (!current()) { this.terrainRecordChanged(owner); return }
      const reservation = this.recordCache.reserve(key, bytes.byteLength)
      if (reservation) {
        try { reservation.commit(bytes.slice()) } finally { reservation.cancel() }
      }
      this.retries.delete(key)
      this.terrainRecordChanged(owner)
    }).catch((error) => {
      if (current()) {
        if (cached) this.recordCache.delete(key)
        this.handleTerrainFailure(key, request, revision, error)
      }
    }).finally(async () => {
      // A cancelled shared consumer can reject before its physical GET exits.
      // Its input envelope cannot fund another producer until that receipt.
      if (task) await task.done
      releaseCached()
      if (credit) credit.release()
    })
    // Keep the request slot until decode/submission finishes in the Worker;
    // otherwise fast network completions can queue unbounded record copies.
    return { promise: submitted, abort() { cancelled = true; waiting.cancel();
      if (submission && submission.cancel) submission.cancel()
      if (task) task.abort() } }
  }

  handleTerrainFailure(key, request, revision, error) {
    if (this.destroyed || this.paused || !this.desiredRequests.has(key)) {
      return
    }
    if (revision !== this.cameraRevision) {
      this.scheduleRefresh()
      return
    }
    if (error && error.noData && typeof this.abi.noDataRecord === 'function') {
      const owner = this.abi
      Promise.resolve(owner.noDataRecord(request.key)).then(() => {
        if (this.destroyed || owner !== this.abi) return
        this.retries.delete(key)
        this.terrainRecordChanged(owner)
      }).catch(failure => this.diagnostic('terrain_no_data_recording_failed', { key, message: failure.message }))
      return
    }
    const attempt = (this.retries.get(key) || 0) + 1
    this.retries.set(key, attempt)
    const unavailable = error && (error.statusCode === 404 || error.statusCode === 410)
    if (!unavailable && !(error && error.retryable === false) && attempt <= this.maximumTerrainRetries) {
      const delay = attempt * this.terrainRetryDelayMs
      const timer = setTimeout(() => {
        this.terrainRetryTimers.delete(key)
        if (!this.destroyed && !this.paused && revision === this.cameraRevision &&
          this.desiredRequests.has(key)) {
          this.enqueueTerrainRequest(key, request, revision)
        }
      }, delay)
      const previous = this.terrainRetryTimers.get(key)
      if (previous) clearTimeout(previous)
      this.terrainRetryTimers.set(key, timer)
      this.diagnostic('terrain_retry', { key, attempt,
        message: error && error.message ? error.message : String(error) })
      return
    }
    this.failedRequests.set(key, request)
    this.failureExpiry.set(key, unavailable ? Infinity : Date.now() + 30000)
    try {
      const owner = this.abi
      Promise.resolve(owner.failRecord(request.kind, request.key)).then(() => this.terrainRecordChanged(owner), failure => {
        if (!this.destroyed && owner === this.abi) this.diagnostic('terrain_failure_recording_failed',
          {key, message: redactSensitiveText(failure.message || String(failure))})
      })
    } catch (failure) {
      this.diagnostic('terrain_failure_recording_failed', {
        key, message: failure.message || String(failure) })
    }
    this.diagnostic('terrain_request_failed', { key,
      message: error && error.message ? error.message : String(error) })
    this.scheduleTerrainRefresh()
  }

  textureUrl(tile) {
    tile = new ImageryAdapter(this.manifest.texture).requestTile(tile)
    const url = this.textureUrlResolver
      ? this.textureUrlResolver(tile)
      : replaceTemplate(this.manifest.texture.url_template, {
        z: tile.matrix,
        x: tile.column,
        y: tile.row
      })
    invariant(isAllowedResourceUrl(url),
      'Texture URL must use HTTPS or loopback HTTP')
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
    const sanitizedDetail = sanitizeDiagnosticDetail(detail)
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
    if (this.meshCapacityBlocked && renderer && renderer.quality) {
      renderer.quality = Object.assign({}, renderer.quality, {state: 'limited', ready: false,
        settled: false, limitationReasons: (renderer.quality.limitationReasons || []).concat('terrain-memory')})
    }
    return {
      schema: 'terra.miniprogram.globe-runtime.v1',
      datasetId: this.manifest && this.manifest.datasetId,
      imageryId: this.manifest && this.manifest.texture.id,
      radiusMeters: this.manifest && this.manifest.radius,
      terrainProgress: this.terrainProgress,
      frame: this.lastFrame && {
        sequence: this.lastFrame.sequence,
        decisionsComplete: this.lastFrame.decisionsComplete,
        patchCount: this.lastFrame.patchCount,
        requestCount: this.lastFrame.requestCount,
        loadedRecordCount: this.lastFrame.loadedRecordCount,
        failedRecordCount: this.lastFrame.failedRecordCount,
        drawCount: this.lastFrame.drawCount,
        vertexCount: this.lastFrame.vertexCount
      },
      camera: this.camera && Object.assign({}, this.camera),
      cameraGround: this.cameraGround ? Object.assign({}, this.cameraGround,
        {demand: this.groundDemands.state()}) : null,
      view: this.camera && this.getView(),
      walk: this.walkController.state(),
      budget: this.budget,
      resources: this.lastSurface ? Object.assign({}, this.lastSurface.updateState,
        this.abi && this.abi.nativeBudget ? {meshBytes: this.abi.nativeBudget.actual} : null) : null,
      resourceMemory: this.resourceLedger.stats(),
      terrainSelection: {
        model: this.terrainModel.stats(),
        demand: this.terrainDemand.stats(),
        capacity: this.terrainCapacity && this.terrainCapacity.stats(),
        submitted: this.submittedTerrain.snapshot(),
        meshCapacityBlocked: this.meshCapacityBlocked,
        recovery: this.meshRecovery && Object.assign({}, this.meshRecovery),
        supersededCandidateCount: this.supersededCandidateCount,
        retiredMeshCount: this.meshFrames.retiredCount,
        retiredMeshArrayBytes: this.meshFrames.retiredBytes,
        desiredViewRevision: this.abi && this.abi.isWorker ? this.abi.viewRevision : this.cameraRevision,
        preparedViewRevision: this.lastSurface && this.lastSurface.selectionViewRevision,
        presentedViewRevision: this.presentedSurface && this.presentedSurface.selectionViewRevision,
        presentedSequence: this.presentedFrame && this.presentedFrame.sequence,
        presentedModelRevision: this.presentedSurface && this.presentedSurface.updateState &&
          this.presentedSurface.updateState.modelRevision
      },
      terrain: Object.assign(this.recordCache.stats(), this.scheduler.stats(), {
        failedRequestCount: this.failedRequests.size,
        input: this.terrainInputs ? this.terrainInputs.stats() : null,
        decoded: this.abi && this.abi.recordBudget ? this.abi.recordBudget.stats() : null,
        heights: this.abi && this.abi.heightBudget ? this.abi.heightBudget.stats() : null
      }),
      terrainQueries: this.heightQueries.stats(),
      atmosphere: this.getAtmosphere(),
      performance: this.performanceSnapshot(),
      renderer,
      contextLost: this.renderer ? this.renderer.contextLost : false,
      paused: this.paused,
      error: this.lastError,
      diagnostics: this.diagnostics.slice(-8)
    }
  }

  performanceSnapshot(exact = false) {
    const execution = this.abi && (this.abi.isWorker ? this.abi : this.localExecution)
    const result = { frameCoordinator: this.frameClock.snapshot(exact),
      workerMeasurementHistory: execution && execution.measurementHistory || null,
      workerImageryPlanning: execution && execution.imageryPlanning || null,
      workerMeasurementTransport: this.abi && this.abi.measurementReceiver ? this.abi.measurementReceiver.stats() : null,
      nativeImageryBytes: this.abi && typeof this.abi.imageryPayloadBytes === 'function' ? this.abi.imageryPayloadBytes() : 0,
      imageryInput: this.abi && this.abi.imageryInputBudget ? this.abi.imageryInputBudget.stats() : null,
      imageryReferences: this.abi && this.abi.imageryReferenceBudget ? this.abi.imageryReferenceBudget.stats() : null,
      imageryOutput: this.abi && this.abi.imageryOutputBudget ? this.abi.imageryOutputBudget.stats() : null,
      imageryReferenceReclamation: this.abi && this.abi.imageryReferenceReclamation || null,
      imageryInputCapacity: Boolean(this.imageryCapacityWait),
      wasmMemoryBytes: this.abi && typeof this.abi.memoryBytes === 'function' ? this.abi.memoryBytes() : 0 }
    const now = monotonicNow()
    for (const [name, series] of Object.entries(this.performanceStats)) result[name] = series.snapshot(now, exact)
    return result
  }

  diagnosticsSnapshot() {
    return { schema: 'terra.performance.v3', runtime: this.performanceSnapshot(true),
      renderer: this.renderer ? this.renderer.stats(true).performance || null : null }
  }

  resetDiagnostics() {
    this.frameClock.resetMetrics()
    for (const series of Object.values(this.performanceStats)) series.reset()
    if (this.renderer && this.renderer.resetTimings) this.renderer.resetTimings()
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
    this.walkController.cancel()
    this.groundDemands.pause()
    this.heightQueries.cancelAll()
    this.frameClock.setPaused(true)
    if (this.abi && this.abi.cancelImagery) this.abi.cancelImagery()
    if (this.localExecution) this.localExecution.cancelImagery()
    this.refreshPending = true
    this.scheduler.pause()
    this.terrainRetryTimers.forEach(timer => clearTimeout(timer))
    this.terrainRetryTimers.clear()
    this.cancelCameraRefresh()
    this.cancelTerrainRefresh()
    if (this.renderer.setPaused) this.renderer.setPaused(true)
    this.cancelInteractionRefresh()
    this.cancelAnimation()
    clearTimeout(this.imageryContinuationTimer)
    this.imageryContinuationTimer = null
  }

  resume() {
    if (this.destroyed || !this.paused) {
      return
    }
    this.paused = false
    this.groundDemands.resume()
    this.clearanceSignature = null
    this.frameClock.setPaused(false)
    this.retryMeshCapacity()
    this.scheduler.resume()
    if (this.renderer.setPaused) this.renderer.setPaused(false)
    // Resuming model work may only advance a held candidate. Its display
    // submission must wake independently, even when no new frame is published.
    this.scheduleRender()
    if (this.refreshPending) {
      this.refreshPending = false
      this.refresh()
    }
  }

  destroy() {
    if(this.destroyingRuntime)return
    this.destroyingRuntime=true
    this.destroyed = true
    const cleanup=new Cleanup()
    try {
      clearTimeout(this.imageryContinuationTimer);this.imageryContinuationTimer=null
      for(const action of [()=>this.cancelAnimation(),()=>this.cancelCameraRefresh(),
        ()=>this.cancelInteractionRefresh(),()=>this.cancelTerrainRefresh(),()=>this.walkController.cancel(),
        ()=>this.groundDemands.destroy(),()=>this.heightQueries.destroy(),()=>this.terrainTransport.destroy(),
        ()=>this.releaseMeshListener(),()=>this.frameClock.destroy(),()=>this.scheduler.clear()])cleanup.run(action)
      if(this.terrainInputs)cleanup.run(()=>this.terrainInputs.destroy())
      this.terrainRetryTimers.forEach(timer=>clearTimeout(timer));this.terrainRetryTimers.clear()
      cleanup.run(()=>this.recordCache.clear())
      if(this.localExecution)cleanup.run(()=>this.localExecution.destroy())
      cleanup.run(()=>this.meshReceipts.clear());cleanup.run(()=>this.meshFrames.clear())
      this.renderedSurface=null
      cleanup.run(()=>this.terrainEpoch.clear());this.meshRecovery=null
      if(this.renderer)cleanup.run(()=>this.renderer.destroy())
      if(this.abi)cleanup.run(()=>this.abi.destroy())
      cleanup.finish()
    }finally{this.destroyingRuntime=false}
  }
}

class TerraPlanarRuntime extends TerraGlobeRuntime {
  constructor(options) {
    super(options)
    this.atmosphere.enabled = false
    this.planarLevel = Number.isInteger(this.options.planarLevel)
      ? clamp(this.options.planarLevel, 0, 2)
      : 1
    this.defaultTiltRadians = this.options.initialTiltRadians === undefined
      ? -Math.PI / 4
      : finiteNumber(this.options.initialTiltRadians,
        'Initial planar tilt')
    this.renderMode = this.options.renderMode === 'height' ? 'height' : 'texture'
  }

  static async create(options) {
    const runtime = new TerraPlanarRuntime(options)
    try { await runtime.initialize(); return runtime }
    catch (error) {cleanupAfterError(error,()=>runtime.destroy())}
  }

  validateRuntimeManifest(rawManifest) {
    const imagery = this.options.imagery || null
    if (imagery && typeof imagery.resolveTile === 'function') {
      this.textureUrlResolver = imagery.resolveTile
      return validatePlanarManifest(manifestForImagerySource(
        rawManifest, imagery, ['planar-tms', 'planar-single']), imagery.id)
    }
    this.textureUrlResolver = null
    return validatePlanarManifest(rawManifest, this.options.textureId)
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
    return { minimum: 0.1, maximum: diagonal * 20 }
  }

  normalizeView(view) {
    invariant(view && typeof view === 'object', 'ViewState is required')
    invariant(!view.schema || view.schema === 'terra.view-state.v2',
      'ViewState schema is unsupported')
    invariant(!view.mode || view.mode === 'planar',
      'ViewState mode must be planar')
    const target = view.target || {}
    const x = finiteNumber(target.x, 'View target X')
    const y = finiteNumber(target.y, 'View target Y')
    invariant(x >= this.manifest.minimumU &&
      x <= this.manifest.maximumU && y >= this.manifest.minimumV &&
      y <= this.manifest.maximumV,
    'View target is outside planar bounds')
    const limits = this.rangeLimits()
    const rangeMeters = finiteNumber(view.rangeMeters, 'View range')
    invariant(rangeMeters >= limits.minimum &&
      rangeMeters <= limits.maximum, 'View range is outside runtime limits')
    const tiltDegrees = finiteNumber(view.tiltDegrees, 'View tilt')
    invariant(tiltDegrees >= 0 && tiltDegrees <= 89.5,
      'View tilt is outside [0, 89.5]')
    return {
      schema: 'terra.view-state.v2',
      mode: 'planar',
      target: {
        x,
        y,
        heightMeters: target.heightMeters === undefined ? 0 :
          finiteNumber(target.heightMeters, 'View target height')
      },
      rangeMeters,
      headingDegrees: wrapDegrees(finiteNumber(
        view.headingDegrees, 'View heading')),
      tiltDegrees
    }
  }

  getView() {
    return {
      schema: 'terra.view-state.v2',
      mode: 'planar',
      target: { x: this.camera.x, y: this.camera.y, heightMeters: this.camera.targetHeightMeters },
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
    this.camera.targetHeightMeters = view.target.heightMeters
    this.camera.yawRadians = view.headingDegrees * DEGREES_TO_RADIANS
    this.camera.tiltRadians = -view.tiltDegrees * DEGREES_TO_RADIANS
  }

  interpolateView(start, target, t, headingDelta) {
    return {
      schema: 'terra.view-state.v2',
      mode: 'planar',
      target: {
        x: start.target.x + (target.target.x - start.target.x) * t,
        y: start.target.y + (target.target.y - start.target.y) * t,
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

  applyPanPixels(deltaX, deltaY) {
    if (this.panGround(deltaX, deltaY)) return
    const dpr = Math.max(1, this.budget.devicePixelRatio || 1)
    const cssHeight = Math.max(1, this.budget.physicalHeight / dpr)
    const unitsPerPixel = 2 * this.camera.distance *
      Math.tan(this.fovRadians / 2) / cssHeight
    const yaw = this.camera.yawRadians
    const localX = -deltaX * unitsPerPixel
    const localY = deltaY * unitsPerPixel
    const worldX = localX * Math.cos(yaw) + localY * Math.sin(yaw)
    const worldY = -localX * Math.sin(yaw) + localY * Math.cos(yaw)
    this.camera.x = clamp(this.camera.x + worldX,
      this.manifest.minimumU, this.manifest.maximumU)
    this.camera.y = clamp(this.camera.y + worldY,
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
    invariant(mode === 'texture' || mode === 'height',
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
      invariant(typeof resolved === 'string' && resolved.length > 0,
        'Planar texture URL resolver returned an empty URL')
      return resolved
    }
    const endpoint = this.manifest.texture.url_template
    const expanded = this.manifest.texture.kind === 'planar-tms'
      ? replaceTemplate(endpoint, {
        z: tile.level,
        x: tile.column,
        y: tile.row
      })
      : endpoint
    return /^https:\/\//.test(expanded) ||
      /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(expanded)
      ? expanded
      : joinServiceUrl(this.serviceOrigin, expanded)
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
  normalizeAtmosphereOptions,
  orderTerrainRequests,
  planarCamera,
  parseJsonResponse,
  terrainRequestPriority,
}
