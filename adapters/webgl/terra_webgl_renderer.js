const { TextureStore, textureByteSize, isPowerOfTwo } = require('./texture_store')
const { allocateGl, GlSubmission, UploadBudget } = require('./gl_allocation')
const {SubmissionQueue} = require('./submission_queue')
const {CameraSubmissionPriority} = require('./camera_submission_priority')
const {IndexBuffer} = require('./index_buffer')
const { SurfaceHandoff } = require('../../sdk/js/terrain/surface_handoff')
const { ResourceLedger, finiteResourceLimit } = require('../../sdk/js/resources/resource_ledger')
const {WorldDisplayPlan} = require('./world_display_plan')
const {terrainSourceDraws} = require('./world_display_inputs')
const {PartitionGroups} = require('./partition_groups')
const {MeshOutputPlan} = require('./mesh_output_plan')
const {GeometryCache, geometryRequests} = require('./geometry_cache')
const {textureResourceKey} = require('../../sdk/js/resources/mesh_coordinates')
const {PartitionPublication} = require('./partition_publication')
const {partitionStagingBudget} = require('./partition_staging')
const { holdMeshes } = require('../../sdk/js/resources/mesh_ownership')
const { bindReplacementPlan } = require('../../sdk/js/terrain/surface_replacement')
const {drawSurface} = require('./surface_draw')
const {submittedSurfaceWitness} = require('./surface_witness')
const {SurfaceCommands} = require('./surface_commands')
const {rendererStats} = require('./renderer_diagnostics')
const {initializePrograms} = require('./surface_programs')
const {normalized, defaultAtmosphere, renderAtmosphere, renderOverlays} = require('./surface_effects')
const { TimingSeries, recordTiming, monotonicNow } = require('../../sdk/js/diagnostics/timing')
const { invertMatrix4 } = require('../../sdk/js/math/matrix')
const {mergeImageryDemand} = require('../../sdk/js/imagery/imagery_demand')
const { ImageryAdapter } = require('../../sdk/js/imagery/terra_imagery_adapter')
const {patchKeyString,
  textureKeyString: tileKey, invariant} = require('../../sdk/js/core/terra_globe_common')
const surfacePlan = require('../../sdk/js/terrain/terra_surface_plan')
const {textureFootprintDensity} = require('../../sdk/js/terrain/texture_measurement')
const {MeasurementLoans,MeasurementKernel} = require('../../sdk/js/terrain/measurement_rows')
const { textureTileContains, parentTextureTile, globalCoverageTextureTiles, textureCellTransform } = require('../../sdk/js/imagery/terra_texture_tiles')
const { ImageryPresentation } = require('../../sdk/js/imagery/terra_imagery_presentation')

const DRAW_FLAG_COVERAGE = 1
const {CoverageImages}=require('./coverage_images')

function geometryKey(draw) {
  if (draw.resourceId && draw.workerGeneration !== undefined) return `mesh:${draw.workerGeneration}:${draw.resourceId}`
  if (draw.resourceId) return `mesh:${draw.resourceId}`
  // Submitted terrain records are immutable within a runtime, so the CBDAM
  // patch and fragment identity is also the stable GPU mesh identity.
  return `${patchKeyString('geometry', draw.key)}:${draw.fragment}`
}

function partitionByteSize(part) {
  return part.positions.byteLength + part.uv.byteLength + part.indices.byteLength
}

// One spatial imagery cut for the whole visible surface. Geometry fragments
// only contribute bounds; they never independently choose a parent or child.
class TerraWebGlRenderer {
  constructor(canvas, options) {
    this.canvas = canvas
    this.options = options || {}
    this.terrainBoundImagery =
      this.options.terrainBoundImagery !== false
    this.mode = this.options.mode === 'height' ? 'height' : 'texture'
    this.heightRange = Array.isArray(this.options.heightRange)
      ? this.options.heightRange.slice(0, 2)
      : [-50, 350]
    this.onDiagnostic = this.options.onDiagnostic || (() => {})
    this.onContextChange = this.options.onContextChange || (() => {})
    this.requestRenderCallback = this.options.requestRender || (() => {})
    this.requestResourcesCallback = this.options.requestResources || (delay => {
      const due = monotonicNow() + delay
      if (this.resourceTimer && this.resourceTimer.due <= due) return
      if (this.resourceTimer) clearTimeout(this.resourceTimer.handle)
      const token = {due}
      this.resourceTimer = token
      token.handle = setTimeout(() => {
        if (this.resourceTimer !== token) return
        this.resourceTimer = null
        this.advanceResources()
      }, delay)
    })
    this.cancelResourcesCallback = () => {
      if (this.resourceTimer) clearTimeout(this.resourceTimer.handle)
      this.resourceTimer = null
      if (this.options.cancelResources) this.options.cancelResources()
    }
    this.atmosphereCapable = this.options.atmosphereCapable === true
    this.atmosphereEnabled = this.options.atmosphereEnabled === true
    this.planetRadius = Number(this.options.planetRadius) || 6371000
    this.contextLost = false
    this.submissions = new SubmissionQueue()
    this.cameraSubmissionPriority = new CameraSubmissionPriority()
    this.gl = null
    this.program = null
    this.attributes = null
    this.uniforms = null
    this.indices = new IndexBuffer(this)
    this.atmosphere = defaultAtmosphere()
    this.atmosphereProgram = null
    this.atmosphereBuffer = null
    this.atmosphereTexture = null
    this.atmosphereAttributes = null
    this.atmosphereUniforms = null
    this.overlayProgram = null
    this.overlayBuffer = null
    this.overlayData = null
    this.overlayAttributes = null
    this.overlayUniforms = null
    this.overlays = { points: [], route: null }
    this.fallbackTexture = null
    this.uploadQueue = []
    this.current = null
    this.renderedSurface = null
    this.renderDraws = []
    this.coverageDraws = []
    this.geometryCoverageDraws = []
    this.displaySurface = null
    this.preparedSurface = null
    this.preparedSurfaceSource = null
    this.worldDisplay = new WorldDisplayPlan(this)
    this.handoff = new SurfaceHandoff()
    this.presentedTextures = new Map()
    this.presentation = new ImageryPresentation(this.options.textureTransitionMs)
    this.partitionPublication = new PartitionPublication(id => this.geometry.get(id),
      key => this.textures.gpuReady(key), draw => this.presentation.group(draw.texture, draw.imageryTarget))
    this.presentationBridges = []
    this.imageryLevels = new Map()
    this.cameraVersion = 0
    this.presentedCameraVersion = -1
    this.plannedCameraVersion = -1
    this.measurements = new Map()
    this.measurementLoans = new MeasurementLoans()
    this.partitionBytes = 0
    this.partitionReservedBytes = 0
    this.partitionCapacityBytes = this.options.partitionCacheBytes || this.options.geometryCacheBytes || 16 * 1024 * 1024
    this.partitionQueue = []
    this.partitionUploads = []
    this.partitionGroups = new PartitionGroups(this)
    this.partitionActive = null
    this.partitionGeneration = 0
    this.interactionActive = false
    this.debugOptions = { textureState: false, webglErrors: false }
    this.geometryPinnedKeys = new Set()
    this.meshHolds = new Map()
    this.qualityStats = {
      targetPixelError: this.options.imageryPixelError || 1.25,
      measuredMaxPixelError: 0,
      desiredDrawCount: 0,
      renderedDrawCount: 0,
      limitedByBudget: false,
      terrainBound: this.terrainBoundImagery
    }
    this.pendingQualityStats = this.qualityStats
    this.performanceStats = {
      textureUploads: 0,
      partitionBuilds: 0,
      partitionQueueWait: new TimingSeries(),
      partitionTask: new TimingSeries(),
      render: new TimingSeries(),
      allocationValidation: new TimingSeries(),
      drawSubmissionWait: new TimingSeries(),
      resourceSubmissionWait: new TimingSeries(),
      geometryPrepare: new TimingSeries(),
      imageryRebuild: new TimingSeries(),
      frameIntervalMs: 0,
      framesPerSecond: 0,
      lastFrameAt: 0
    }
    this.drawStats = { submitted: 0, queued: 0 }
    invariant(!this.options.resourceLedger || this.options.maximumResourceBytes === undefined,
      'Configure the total limit on the externally owned resource ledger')
    this.resourceLedger = this.options.resourceLedger || new ResourceLedger(finiteResourceLimit(
      this.options.maximumResourceBytes === undefined ? 64 * 1024 * 1024 : this.options.maximumResourceBytes))
    this.surfaceCommands = new SurfaceCommands(this.resourceLedger)
    this.coverageImages = new CoverageImages(this)
    this.partitionCpuBytes = 0
    this.geometry = new GeometryCache({
      ledger: this.resourceLedger, owner: 'geometry-gpu',
      // The entry count is an idle-cache target. Display handoff may
      // temporarily exceed that count, but every byte still needs admission.
      softEntryLimit: true,
      maximumEntries: this.options.managedResources ? 0 : (this.options.maximumGeometryEntries || 192),
      maximumBytes: this.options.geometryCacheBytes || 16 * 1024 * 1024,
      dispose: (value) => this.disposeGeometry(value),
      canEvict: (key) => !this.geometryPinnedKeys.has(key)
    })
    const createTextures = this.options.createTextureStore || ((renderer, options) => new TextureStore(renderer, options))
    this.textures = createTextures(this, {
      urlForTile: this.options.urlForTile,
      onDiagnostic: this.onDiagnostic,
      maximumConcurrent: this.options.maximumTextureRequests || 3,
      maximumEntries: this.options.maximumTextureEntries,
      maximumBytes: this.options.textureCacheBytes || 32 * 1024 * 1024,
      maximumShareBytes: this.options.imageryShareMaximumBytes,
      estimatedTileBytes: textureByteSize(
        (this.options.textureDescriptor &&
          this.options.textureDescriptor.tile_size) || 256,
        (this.options.textureDescriptor &&
          this.options.textureDescriptor.tile_size) || 256) +
        (this.options.managedResources ? 4 * Math.pow(Number(this.options.textureDescriptor &&
          this.options.textureDescriptor.tile_size) || 256, 2) : 0),
      transitionReserveEntries: this.options.textureTransitionReserveEntries,
      maximumRetries: this.options.maximumTextureRetries,
      retryDelayMs: this.options.textureRetryDelayMs,
      staleRequestGraceMs: this.options.textureRequestGraceMs,
      prefetchAncestors: this.options.prefetchTextureAncestors !== false,
      directTargets: this.options.directTextureTargets !== false,
      coverageTiles: globalCoverageTextureTiles(
        this.options.textureDescriptor)
    })
    this.releaseMemoryListener = this.resourceLedger.subscribe(() => {
      // Observe admission on the resource clock: an asynchronous refusal may
      // arrive after this refund notification but before the next work turn.
      this.resourceAdmissionDirty = true
      if (!this.destroyed && !this.paused) this.requestResources()
    })
    this.handleContextLost = (event) => this.contextWasLost(event)
    this.handleContextRestored = () => this.contextWasRestored()
    if (canvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextlost', this.handleContextLost)
      canvas.addEventListener('webglcontextrestored', this.handleContextRestored)
    }
    try { this.measurementKernel=new MeasurementKernel(this.resourceLedger);this.initialize(this.options.gl) }
    catch (error) { this.destroy(); throw error }
  }

  initialize(providedGl) { initializePrograms(this, providedGl) }

  get pendingSubmission() { return this.submissions.pending }
  get indexBuffer() { return this.indices.current ? this.indices.current.buffer : null }
  get uploadedIndices() { return this.indices.current ? this.indices.current.source : null }
  get queuedGeometryCount() { return this.uploadQueue.filter(item => item.kind === 'mesh').length }

  capabilities() {
    const gl = this.gl
    return {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      logarithmicDepth: this.depthSupported,
      version: gl.getParameter(gl.VERSION)
    }
  }

  allocateResources(label, build) {
    return allocateGl(this.gl, label, build, elapsed =>
      recordTiming(this.performanceStats.allocationValidation, elapsed))
  }

  stageResources(label, cost, build, publish, cancel = () => {}, redraw = true) {
    const commit = value => {
      const accepted = publish(value)
      if (accepted !== false && redraw) this.requestRender()
      return accepted
    }
    if (this.uploadBatch) {
      const accepted = this.uploadBatch.stage(label, build, commit, cancel, cost)
      if (!accepted) this.requestResources()
      return accepted
    }
    const batch = new GlSubmission(this.gl, elapsed =>
      recordTiming(this.performanceStats.allocationValidation, elapsed))
    try { batch.stage(label, build, commit, cancel); batch.commit(); return true }
    catch (error) { batch.cancel(); throw error }
  }

  checkContextLoss() {
    if (!this.contextLost && this.gl.isContextLost()) this.contextWasLost()
    return this.contextLost
  }

  resize(width, height) {
    if (!this.gl || this.contextLost) {
      return
    }
    this.surfaceCommands.clear()
    this.gl.viewport(0, 0, width, height)
    this.requestResources()
    this.requestRender()
  }

  setBudget(budget) {
    const value = budget || {}
    if (Number.isFinite(value.devicePixelRatio) &&
      value.devicePixelRatio > 0) {
      this.options.devicePixelRatio = value.devicePixelRatio
    }
    if (Number.isFinite(value.uploadBudgetMs) && value.uploadBudgetMs > 0) {
      this.options.uploadBudgetMs = value.uploadBudgetMs
    }
    if (Number.isFinite(value.geometryCacheBytes) &&
      value.geometryCacheBytes > 0) {
      this.geometry.maximumBytes = this.current && this.options.managedResources ? Math.max(this.geometry.maximumBytes, value.geometryCacheBytes) : value.geometryCacheBytes
      this.options.geometryCacheBytes = value.geometryCacheBytes
      this.geometry.evict()
    }
    if (Number.isFinite(value.partitionCacheBytes) && value.partitionCacheBytes > 0) {
      this.options.partitionCacheBytes = value.partitionCacheBytes
      this.partitionCapacityBytes = this.current && this.options.managedResources ? Math.max(this.partitionCapacityBytes, value.partitionCacheBytes) : value.partitionCacheBytes
    }
    if (Number.isFinite(value.maximumTextureEntries) &&
      value.maximumTextureEntries > 0) {
      this.textures.requestedMaximumEntries = Math.max(1, Math.floor(value.maximumTextureEntries))
      this.textures.cache.maximumEntries = Math.max(this.textures.cache.maximumEntries, this.textures.requestedMaximumEntries)
      this.textures.cache.evict()
    }
    if (Number.isFinite(value.textureCacheBytes) &&
      value.textureCacheBytes > 0) {
      this.textures.setPreferredBytes(value.textureCacheBytes)
    }
    if (Number.isFinite(value.maximumTextureRequests) &&
      value.maximumTextureRequests > 0) {
      this.textures.setMaximumConcurrent(value.maximumTextureRequests)
    }
    if (this.current) {
      this.rebuildImageryDraws()
      this.requestRender()
    }
  }

  retryTextures() {
    return this.textures.retryFailed()
  }

  setMode(mode) {
    invariant(mode === 'texture' || mode === 'height',
      'Renderer mode is unsupported')
    this.mode = mode
    this.worldDisplay.clear()
    this.partitionGroups.clear()
    this.preparedSurfaceSource=null
    this.geometryPublicationPending=true
    this.requestResources()
    this.textures.releaseDemand()
    this.partitionPublication.clear()
    this.requestRender()
  }

  setAtmosphereEnabled(enabled) {
    invariant(!enabled || this.atmosphereCapable,
      'Atmosphere is unavailable for this renderer')
    this.atmosphereEnabled = Boolean(enabled)
    this.requestRender()
  }

  setAtmosphere(value) {
    invariant(value && Number.isInteger(value.width) &&
      value.width > 0 && Number.isInteger(value.height) && value.height > 0 &&
      value.rgba && value.rgba.length === value.width * value.height * 4,
    'Atmosphere lookup texture is invalid')
    const atmosphere = {
      width: value.width,
      height: value.height,
      sunVisible: Boolean(value.sunVisible),
      fogEnabled: Boolean(value.fogEnabled),
      fogDensityMultiplier: Number.isFinite(value.fogDensityMultiplier)
        ? value.fogDensityMultiplier : 1,
      sunDirection: normalized(value.sunDirection),
      ambientColor: value.ambientColor.slice(0, 3),
      diffuseColor: value.diffuseColor.slice(0, 3),
      fogColor: value.fogColor.slice(0, 3),
      seaLevelFogDensity: value.seaLevelFogDensity,
      rgba: value.rgba
    }
    this.atmosphere = atmosphere
    this.requestResources()
    this.requestRender()
  }

  setInteractionActive(active) {
    const next = Boolean(active)
    if (this.interactionActive === next) return
    const previous = this.shouldRefineImageryBounds()
    this.interactionActive = next
    if (this.current && this.mode === 'texture' && !this.terrainBoundImagery &&
        previous !== this.shouldRefineImageryBounds() && this.options.onImageryPlanningChange) {
      this.options.onImageryPlanningChange()
    }
    this.requestRender()
  }

  shouldRefineImageryBounds() {
    // Fast bounds provide coverage while moving. A stopped view must finish
    // the same measurement regardless of whether capacity pressure occurred.
    return !this.interactionActive || this.refineImageryCamera === this.cameraVersion
  }

  setDebugOptions(options) {
    this.debugOptions = Object.assign({}, this.debugOptions, options || {})
    this.requestRender()
  }

  setImagerySource(textureDescriptor, urlForTile) {
    this.coverageImages.clear()
    invariant(textureDescriptor &&
      typeof urlForTile === 'function',
      'Imagery texture descriptor and URL resolver are required')
    const adapter = new ImageryAdapter(textureDescriptor)
    this.refineImageryCamera = null
    this.options.textureDescriptor = textureDescriptor
    if (this.current) this.current.draws = this.current.draws.map(draw => adapter.prepareDraw(draw))
    this.options.urlForTile = urlForTile
    if (this.current) this.current.imageryPlan = null
    if (this.current) {
      this.current.workerMeasurements = new Map()
      this.current.measurementCameraVersion = -1
    }
    if (this.current && this.options.scheduledImagery) {
      const draws = this.current.draws.filter(draw => !(draw.flags & DRAW_FLAG_COVERAGE))
        .map(draw => this.rootImageryDraw(draw))
      this.current.imageryPlan = { draws, levels: new Map(), quality: {
        targetPixelError: this.options.imageryPixelError || 1.25,
        measuredMaxPixelError: Infinity, desiredDrawCount: draws.length,
        provisional: true, spatialCut: false } }
    }
    this.partitionGeneration += 1
    this.clearPartitionWork()
    this.geometry.values().forEach(geometry => this.releasePartitions(geometry))
    this.textures.setSource(urlForTile,
      globalCoverageTextureTiles(textureDescriptor))
    this.displaySurface = null
    this.presentedTextures.clear()
    this.presentation.clear()
    this.presentationBridges = []
    this.restoringPresentation = false
    this.imageryLevels.clear()
    this.rebuildImageryDraws()
    this.requestRender()
  }

  rootImageryDraw(draw) {
    const source = Object.assign({}, draw.texture, {matrix: draw.texture.level +
      (Number(this.options.textureDescriptor && this.options.textureDescriptor.matrix_level_offset) || 0)})
    let root = source
    while (root.level > 0) root = parentTextureTile(root)
    const t = textureCellTransform(source, root)
    return Object.assign({}, draw, {texture: root, sourceTexture: source,
      imageryCellScale: t.scale, imageryCellOffsetX: t.offsetX,
      imageryCellOffsetY: t.offsetY, imageryClipCell: false})
  }

  residentImageryDraw(draw) {
    const coverage=this.rootImageryDraw(draw),source=coverage.sourceTexture
    // New terrain can reuse a resident ancestor even when it left the last
    // visible image cut. This is an already paid, whole-mesh mapping, not a
    // new request or a current-view precision proof. Ordinary publication
    // owns/pins it before display; pending uploads never qualify here.
    for(let tile=source;tile&&tile.level>0;tile=parentTextureTile(tile)) {
      if(!this.textures.gpuReady(tileKey(tile)))continue
      const t=textureCellTransform(source,tile)
      return Object.assign(coverage,{texture:tile,imageryCellScale:t.scale,
        imageryCellOffsetX:t.offsetX,imageryCellOffsetY:t.offsetY})
    }
    return coverage
  }

  setPaused(paused) {
    this.paused = Boolean(paused)
    if(this.paused)this.coverageImages.clear()
    if(this.paused)this.cameraSubmissionPriority.clear()
    if (this.paused && this.visibility && this.visibility.proofs) this.visibility.proofs.clear()
    if (this.paused) this.cancelResourcesCallback()
    if (this.paused && this.meshOutputPlan) this.meshOutputPlan.release()
    if (this.paused && this.forecastOutputPlan) this.forecastOutputPlan.release()
    if (this.paused) { this.surfaceCommands.clear(); this.worldDisplay.clear(); this.preparedSurfaceSource=null; this.partitionGroups.clear(); this.cancelPartitionTask(); this.clearReplacement(); this.partitionPublication.clear() }
    this.textures.setPaused(paused)
    if (!this.paused) { this.requestResources(); this.requestRender() }
  }

  geometryForDraw(draw) {
    const key = draw.geometryKey || geometryKey(draw)
    return this.geometry.get(key) || this.uploadQueue.find(item => item.key === key)
  }

  measureDraw(draw, tight = false) {
    const key = draw.geometryKey || geometryKey(draw)
    if (this.measurements.has(key) && (!tight || !this.measurements.get(key).refinable)) return this.measurements.get(key)
    const geometry = this.geometryForDraw(draw)
    const fromWorker = this.current && this.current.workerMeasurements &&
      this.current.workerMeasurements.get(draw.resourceId)
    const preview = this.options.scheduledImagery && !this.terrainBoundImagery
      ? !this.current || this.current.measurementCameraVersion !== this.cameraVersion
      : this.plannedCameraVersion !== this.cameraVersion
    const measured = preview || this.options.scheduledImagery && !this.terrainBoundImagery && !fromWorker
      ? this.terrainBoundImagery ? {pixelsPerUv:Infinity,visible:true,centerDistance:0} :
        surfacePlan.previewSurface(geometry && geometry.model, draw.origin, this.projectionContext) :
      fromWorker ? Object.assign({}, fromWorker) : geometry && geometry.model && this.projectionContext
      ? surfacePlan.measureSurface(geometry.model, draw.origin, this.projectionContext, tight)
      : { pixelsPerUv: Infinity, visible: true, centerDistance: 0 }
    if (geometry && geometry.model) {
      measured.bounds = geometry.model.bounds
      measured.hull = geometry.model.hull
    }
    this.measurements.set(key, measured)
    return measured
  }

  measureTextureDraw(draw, resolvedLevel) {
    if (this.visibility && this.visibility.hidden(draw.resourceId)) return 0
    const m = this.measureDraw(draw)
    const source = draw.sourceTexture || draw.texture
    // Projection belongs to this footprint/view, not to the image resolution.
    // Every pyramid level scales the same density by its fixed texel count.
    return textureFootprintDensity(m, source, draw.texture, this.measurementKernel) /
      ((Number(this.options.textureDescriptor && this.options.textureDescriptor.tile_size) || 256) *
      Math.pow(2, resolvedLevel - source.level))
  }

  syncMeasurementLoans() {
    if(!this.measurementLoans)this.measurementLoans=new MeasurementLoans()
    if(this.destroyed){this.measurementLoans.clear();return}
    const renderer=this
    function* values() {
      const roots=new Set([renderer.current,renderer.displaySurface&&renderer.displaySurface.current,
        renderer.replacement&&renderer.replacement.current,
        renderer.replacement&&renderer.replacement.mixed,
        renderer.heldCandidate&&renderer.heldCandidate.surface.current])
      for(const root of roots)if(root&&root.workerMeasurements)yield* root.workerMeasurements.values()
      if(renderer.measurements)yield* renderer.measurements.values()
    }
    this.measurementLoans.replace(values())
  }

  presentationDraws(draws, prepare = true) {
    const record=this.worldDisplay.prepared(draws)
    return record?(prepare?this.worldDisplay.read(draws):record.rows):null
  }

  sourceUvScale() {
    // Leave at least 16 Float32 UV steps per source texel. Deeper cuts use
    // clipped vertices and interpolate normalized cell UV instead.
    return this.sourceUvPartitions ? 2 ** 19 / ((this.options.textureDescriptor || {}).tile_size || 256) : 0
  }

  partitionCell(draw) {
    const scale = draw.imageryCellScale
    return { key: tileKey(draw.texture), sourceUv: scale <= this.sourceUvScale(), bounds: {
      minimumU: -draw.imageryCellOffsetX / scale,
      maximumU: (1 - draw.imageryCellOffsetX) / scale,
      minimumV: -draw.imageryCellOffsetY / scale,
      maximumV: (1 - draw.imageryCellOffsetY) / scale
    } }
  }

  requestPartitionSet(geometry, cells, priority = 1) {
    if (!geometry.partitionPending) geometry.partitionPending = new Set()
    if (geometry.partitionBlocked && (geometry.partitionBlockedRevision !== (this.partitionAdmissionRevision || 0) ||
        geometry.partitionBlockedLedgerRevision !== this.resourceLedger.availabilityRevision ||
        geometry.partitionBlockedCamera !== this.cameraVersion ||
        geometry.partitionBlockedCapacity < this.partitionCapacityBytes)) geometry.partitionBlocked.clear()
    let queued = this.partitionQueue.find(job => job.geometry === geometry)
    if (queued) {
      const demanded = new Set(cells.map(cell => cell.key))
      queued.cells.forEach(cell => {
        if (demanded.has(cell.key)) cell.priority = Math.max(cell.priority, priority)
      })
    }
    const missing = []
    for (const cell of cells) {
      if (geometry.partitions.has(cell.key) || geometry.partitionPending.has(cell.key) ||
          geometry.partitionBlocked && geometry.partitionBlocked.has(cell.key)) continue
      geometry.partitionPending.add(cell.key)
      missing.push(Object.assign({}, cell, {priority, queuedAt: monotonicNow()}))
    }
    if (!missing.length) return
    if (queued) queued.cells.push(...missing)
    else this.partitionQueue.push({ geometry, cells: missing, generation: this.partitionGeneration })
    // Preparation changes no pixels. Wake the resource pump; publication of
    // usable partitions (including empty intersections) wakes presentation.
    this.requestResources()
  }

  pumpPartitionRequests() {
    if (this.partitionActive || !this.partitionQueue.length || this.destroyed || this.contextLost || this.paused) return
    this.prunePartitionRequests(true)
    if (!this.partitionQueue.length) return
    // Elevate only the demanded cells. A handoff must not drag an unrelated
    // fine batch to the front merely because it shares the same terrain mesh.
    const prepared = (job, cell) => this.partitionGroups.rank(job.geometry.key, cell.key)
    const compare = (a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt
    this.partitionQueue.forEach(job => job.cells.sort((a,b) => prepared(job,b)-prepared(job,a) || compare(a,b)))
    this.partitionQueue.sort((a, b) => prepared(b,b.cells[0])-prepared(a,a.cells[0]) || compare(a.cells[0], b.cells[0]))
    if (!this.partitionGroups.prepare()) return
    const job = this.partitionQueue.shift()
    if (!this.geometryPinnedKeys.has(job.geometry.key)) {
      job.cells.forEach(cell => job.geometry.partitionPending.delete(cell.key))
      return
    }
    const count = this.partitionGroups.count(job.geometry.key, job.cells, Math.min(8,
      job.cells.filter(cell => cell.priority === job.cells[0].priority && prepared(job,cell) === prepared(job,job.cells[0])).length),
    partitionStagingBudget(this.partitionUploads, this.options))
    if (!count) { this.partitionQueue.unshift(job); return }
    if (job.cells.length > count) {
      this.partitionQueue.push(Object.assign({}, job, { cells: job.cells.slice(count) }))
      job.cells = job.cells.slice(0, count)
    }
    job.releaseMesh = holdMeshes([job.geometry.resource])
    job.owner = this.geometry.entries.get(job.geometry.key)
    job.startedAt = monotonicNow()
    recordTiming(this.performanceStats.partitionQueueWait, job.startedAt - job.cells[0].queuedAt)
    this.partitionActive = job
    const valid = () => !job.cancelled && job.generation === this.partitionGeneration &&
      this.geometryPinnedKeys.has(job.geometry.key) && this.geometry.entries.get(job.geometry.key) === job.owner
    const run = () => {
      const method = 'createPartitionTask'
      const task = this.options[method] && job.geometry.resourceId
        ? this.options[method](job.geometry.resourceId, job.cells, job.geometry, job.cpuBytes)
        : surfacePlan[method](job.geometry.model, job.cells, job.cpuBytes)
      job.cancel = () => task.cancel()
      return task.promise || task.run()
    }
    Promise.resolve().then(() => {
      if (!valid()) return null
      const reserved = this.partitionGroups.take(job.geometry.key, job.cells)
      if (!reserved) return null
      job.output = reserved.output; job.cpuBytes = reserved.bytes
      job.outputPlan = new Map(reserved.plan.filter(item => item.bytes).map(item => [item.key, item.bytes]))
      return run()
    }).then(parts => {
      if (!valid()) return
      if (!parts) {
        if (!job.blocked) job.cells.forEach(cell => job.geometry.partitionPending.delete(cell.key))
        return
      }
      if (parts.limited) { job.blocked = true; return }
      invariant(Array.isArray(parts), 'Invalid partition output')
      const expected = new Map(job.outputPlan)
      for (const part of parts) {
        invariant(part.cell && expected.get(part.cell.key) === partitionByteSize(part),
          'Partition output differs from its admitted plan')
        expected.delete(part.cell.key)
      }
      invariant(!expected.size, 'Partition output omitted an admitted cell')
      if (!parts.length) {
        // A proven empty intersection needs no GL submission or upload slot.
        job.cells.forEach(cell => {
          job.geometry.partitions.set(cell.key, {vertexCount: 0, indexCount: 0, byteSize: 0})
          job.geometry.partitionPending.delete(cell.key)
        })
        this.geometryPublicationPending = true
        this.requestResources()
        return
      }
      job.output.input.mark('resident')
      job.queued = true
      this.partitionUploads.push(Object.assign(job, {parts}))
    }).catch(error => {
      if (job.cancelled) return
      job.failed = true
      job.cells.forEach(cell => job.geometry.partitionPending.delete(cell.key))
      if (job.generation === this.partitionGeneration && this.geometryPinnedKeys.has(job.geometry.key)) {
        this.onDiagnostic('partition_prepare_failed', { message: error.message || String(error) })
      }
    }).finally(() => {
      if (!job.queued) this.releasePartitionInput(job)
      if (job.blocked || job.failed) this.partitionGroups.release()
      if (job.blocked) this.blockPartitionJob(job)
      recordTiming(this.performanceStats.partitionTask, monotonicNow() - job.startedAt)
      if (this.partitionActive === job) this.partitionActive = null
      if (!this.paused && !this.contextLost && !this.destroyed) this.requestResources()
    })
  }

  blockPartitionJob(job) {
    const geometry = job.geometry
    this.partitionBudgetLimited = true
    if (!geometry.partitionBlocked) geometry.partitionBlocked = new Set()
    geometry.partitionBlockedRevision = this.partitionAdmissionRevision || 0
    geometry.partitionBlockedLedgerRevision = this.resourceLedger.availabilityRevision
    geometry.partitionBlockedCamera = this.cameraVersion
    geometry.partitionBlockedCapacity = this.partitionCapacityBytes
    job.cells.forEach(cell => { geometry.partitionBlocked.add(cell.key); geometry.partitionPending.delete(cell.key) })
  }

  resizePartitionInput(job, bytes) {
    if (!job.output.workspace) this.partitionCpuBytes += bytes - job.cpuBytes
    job.cpuBytes = bytes
    invariant(job.output.input.resize(bytes), 'Partition output reservation expired')
  }

  releasePartitionInput(job) {
    if (job.output) {
      if (!job.output.workspace) this.partitionCpuBytes -= job.cpuBytes
      this.partitionReservedBytes -= job.output.output.bytes
      job.output.release(); job.output = null; job.cpuBytes = 0
    }
    if (job.releaseMesh) { job.releaseMesh(); job.releaseMesh = null }
    job.outputPlan = null
    job.parts = null
    this.partitionGroups.refresh()
    const group = this.partitionGroups.current
    if (this.partitionGroups.complete(group)) this.partitionGroups.release()
  }

  cancelPartitionTask(geometry) {
    const job = this.partitionActive
    if (!job || job.cancelled || geometry && job.geometry !== geometry) return
    job.cancelled = true
    if (job.output) job.output.retire()
    job.cells.forEach(cell => job.geometry.partitionPending.delete(cell.key))
    if (job.cancel) job.cancel()
  }

  clearPartitionWork() {
    this.worldDisplay.clear()
    this.preparedSurface=null;this.preparedSurfaceSource=null
    this.partitionPublication.clear()
    this.partitionGroups.clear()
    if (this.meshOutputPlan) this.meshOutputPlan.release()
    if (this.forecastOutputPlan) this.forecastOutputPlan.release()
    this.cancelPartitionTask()
    this.partitionQueue.concat(this.partitionUploads).forEach(job => {
      job.cells.forEach(cell => job.geometry.partitionPending.delete(cell.key))
      this.releasePartitionInput(job)
    })
    this.partitionQueue = []; this.partitionUploads = []
  }

  syncPartitionDemand() {
    if (!this.partitionQueue.length && !this.partitionActive && !this.partitionUploads.length) return
    this.worldDisplay.syncDemand()
    this.prunePartitionRequests(true)
  }

  prunePartitionRequests(demand = false) {
    this.partitionGroups.refresh()
    const needed = (job, cell) => {
      const owner = this.geometry.entries.get(job.geometry.key)
      return job.generation === this.partitionGeneration && owner && owner.value === job.geometry &&
        (this.partitionGroups.protects(job.geometry.key, cell.key) || this.geometryPinnedKeys.has(job.geometry.key) &&
          (!demand || this.partitionPublication.wanted(job.geometry.key, cell.key)))
    }
    this.partitionQueue = this.partitionQueue.filter(job => {
      job.cells = job.cells.filter(cell => {
        if (!job.geometry.partitions.has(cell.key) && needed(job, cell)) return true
        job.geometry.partitionPending.delete(cell.key)
        return false
      })
      return job.cells.length > 0
    })
    const active = this.partitionActive
    if (active && !active.cells.some(cell => needed(active, cell))) this.cancelPartitionTask()
    if (demand) this.partitionUploads = this.partitionUploads.filter(job => {
      if (job.cells.some(cell => needed(job, cell))) return true
      job.cells.forEach(cell => job.geometry.partitionPending.delete(cell.key))
      this.releasePartitionInput(job)
      return false
    })
  }

  processPartitionUploads(deadline) {
    // Each ready job already owns its CPU/GPU credit. Stage independent jobs
    // behind one fence, bounded by the shared upload budget and deadline. Limit
    // attempts to the initial queue length so synchronous refusal cannot spin.
    let stagedJobs = 0, stagedBytes = 0
    for (let remaining = this.partitionUploads.length; remaining > 0 && this.partitionUploads.length &&
        monotonicNow() < deadline; --remaining) {
      const job = this.partitionUploads.shift()
      if (job.generation !== this.partitionGeneration ||
          !this.geometry.values().includes(job.geometry)) { this.releasePartitionInput(job); continue }
      const geometry = job.geometry
      const owner = this.geometry.entries.get(geometry.key)
      const parts = [], work = this.uploadBatch && this.uploadBatch.budget
      let bytes = 0, objects = 0
      for (const part of job.parts) {
        const size = partitionByteSize(part), count = +(part.indices.length > 0) + (part.positions.length ? 2 : 0)
        if (work && !work.fits(bytes + size, objects + count, parts.length === 0)) break
        parts.push(part); bytes += size; objects += count
      }
      if (!parts.length) {
        this.partitionUploads.unshift(job); this.requestResources(); break
      }
      invariant(job.output && job.output.output.bytes >= bytes, 'Partition GPU output was not admitted')
      const allocation = job.output.takeOutput(bytes)
      const gl = this.gl
      const pending = geometry.partitionPending
      const valid = () => !this.destroyed && !this.contextLost && job.generation === this.partitionGeneration &&
        geometry.partitionPending === pending && this.geometry.entries.get(geometry.key) === owner
      const clear = () => job.cells.forEach(cell => pending.delete(cell.key))
      let reserved = true
      const release = (retry = false) => {
        if (!reserved) return
        reserved = false
        if (retry) job.output.returnOutput(allocation)
        else { this.partitionReservedBytes -= bytes; allocation.release() }
      }
      const staged = this.stageResources('partition', {bytes, objects}, resources => {
        const uploaded = []
        for (const part of parts) {
          const byteSize = partitionByteSize(part)
          const buffers = {}
          if (part.positions.length) {
            buffers.positionBuffer = resources.buffer(gl.ARRAY_BUFFER, part.positions)
            buffers.uvBuffer = resources.buffer(gl.ARRAY_BUFFER, part.uv)
          }
          if (part.indices.length) buffers.indexBuffer = resources.buffer(gl.ELEMENT_ARRAY_BUFFER, part.indices)
          uploaded.push({key: part.cell.key, asset: Object.assign(buffers, {
            sourceUv: part.cell.sourceUv, indexCount: part.indices.length, vertexCount: part.positions.length / 3,
            byteSize, lastUsed: monotonicNow() })})
        }
        return uploaded
      }, uploaded => {
        if (!valid()) { release(); clear(); this.releasePartitionInput(job); return false }
        const actual = uploaded.reduce((n, item) => n + item.asset.byteSize, 0)
        if (this.partitionBytes + actual > this.partitionCapacityBytes) {
          release(true); this.partitionUploads.unshift(job); return false
        }
        uploaded.forEach(({key, asset}) => {
          this.releasePartition(geometry, key)
          if (asset.byteSize) {
            asset.allocation = allocation.split(asset.byteSize, 'resident')
            asset.allocation.reclaimWith = () => geometry.partitions.get(key) === asset ? [owner.lease] : null
            asset.allocation.reclaimable = () => geometry.partitions.get(key) === asset &&
              !(this.partitionGroups.protects(geometry.key, key)) &&
              !this.geometryPinnedKeys.has(geometry.key) && !geometry.partitionPending.has(key) &&
              !this.textures.stagedKeys.has(key) && !this.textures.frontierKeys.has(key)
            asset.allocation.reclaim = () => this.releasePartition(geometry, key)
          }
          geometry.partitions.set(key, asset)
          geometry.partitionBytes = (geometry.partitionBytes || 0) + asset.byteSize
          this.partitionBytes += asset.byteSize
        })
        release()
        job.parts = job.parts.slice(uploaded.length)
        this.resizePartitionInput(job, job.parts.reduce((n, part) => n + partitionByteSize(part), 0))
        if (job.parts.length) {
          this.partitionUploads.unshift(job)
          this.requestResources()
        } else {
          this.releasePartitionInput(job)
          job.cells.forEach(cell => {
            if (!geometry.partitions.has(cell.key)) {
              geometry.partitions.set(cell.key, {vertexCount: 0, indexCount: 0, byteSize: 0})
            }
            geometry.partitionPending.delete(cell.key)
          })
          this.performanceStats.partitionBuilds += uploaded.length ? 1 : 0
          // A completed task may still be only part of a visible group.
          this.geometryPublicationPending = true
          this.requestResources()
        }
      }, () => {
        if (valid()) { release(true); this.partitionUploads.unshift(job) }
        else { release(); clear(); this.releasePartitionInput(job) }
      }, false)
      if (!staged) break
      ++stagedJobs; stagedBytes += bytes
    }
    this.partitionUploadHighWaterJobs = Math.max(this.partitionUploadHighWaterJobs || 0, stagedJobs)
    this.partitionUploadHighWaterBytes = Math.max(this.partitionUploadHighWaterBytes || 0, stagedBytes)
    this.partitionBudgetLimited = this.geometry.values().some(geometry =>
      this.geometryPinnedKeys.has(geometry.key) && geometry.partitionBlocked && geometry.partitionBlocked.size > 0)
    this.pumpPartitionRequests()
    if (!this.uploadBatch) this.textures.advance()
  }

  prunePartitions(incoming, capacity, job) {
    const idle = []
    const visible = new Set(this.displaySurface ? this.displaySurface.renderDraws.concat(
      this.displaySurface.geometryCoverageDraws || []).map(draw=>draw.geometryKey) : [])
    this.geometry.values().forEach(geometry => {
      const displayed = new Set((visible.has(geometry.key) ? geometry.partitionDraws || [] : []).filter(d => d.imageryClipCell)
        .map(d => d.imageryIndexCell || tileKey(d.texture)))
      geometry.partitions.forEach((part, key) => {
        if (displayed.has(key) || this.partitionGroups.protects(geometry.key, key) ||
            (geometry.partitionPending && geometry.partitionPending.has(key)) ||
            this.textures.stagedKeys.has(key) || this.textures.frontierKeys.has(key) ||
            (job && geometry === job.geometry && job.cells.some(cell => cell.key === key))) return
        idle.push({ geometry, key, part })
      })
    })
    idle.sort((a, b) => (a.part.lastUsed || 0) - (b.part.lastUsed || 0))
    for (const { geometry, key, part } of idle) {
      if (this.partitionBytes + this.partitionReservedBytes + this.partitionCpuBytes + incoming <= capacity) break
      this.releasePartition(geometry, key)
    }
  }

  releasePartition(geometry, key) {
    const part = geometry.partitions.get(key)
    if (!part) return
    geometry.partitions.delete(key)
    this.worldDisplay.partitionReleased(geometry.key,key)
    if (this.gl && !this.contextLost) {
      if (part.positionBuffer) this.gl.deleteBuffer(part.positionBuffer)
      if (part.uvBuffer) this.gl.deleteBuffer(part.uvBuffer)
      if (part.indexBuffer) this.gl.deleteBuffer(part.indexBuffer)
    }
    if (part.allocation) part.allocation.release()
    geometry.partitionBytes -= part.byteSize || 0
    this.partitionBytes -= part.byteSize || 0
    if (part.byteSize) this.partitionAdmissionRevision = (this.partitionAdmissionRevision || 0) + 1
  }

  preparePartitions(draws) {
    const groups = this.partitionPublication.prepare(draws)
    const publish = this.visibility && this.visibility.publicationGuard()
    const result = []
    groups.forEach((items, key) => {
      const geometry = this.geometry.get(key)
      if (!geometry) { result.push(...items); return }
      const cells = items.filter(draw => draw.imageryClipCell && !draw.imageryDirectClip).map(draw => this.partitionCell(draw))
      this.requestPartitionSet(geometry, cells, 2)
      if (cells.every(cell => geometry.partitions.has(cell.key)) && (!publish || publish(key, items))) {
        geometry.partitionDraws = items
        result.push(...items)
      } else if (geometry.partitionDraws) {
        result.coveragePending = true
        result.push(...geometry.partitionDraws)
      } else {
        const source = items[0].sourceTexture || items[0].texture
        result.push(Object.assign({}, items[0], { texture: source, sourceTexture: source,
          imageryCellScale: 1, imageryCellOffsetX: 0, imageryCellOffsetY: 0, imageryClipCell: false }))
      }
    })
    // Visibility alone cannot keep queued UV output alive. These are the
    // complete display-preparation and candidate-handoff frontiers. Submitted
    // GPU partitions remain owned until their existing display receipt retires.
    this.partitionGroups.publish()
    this.prunePartitionRequests(true)
    return result
  }

  partitionForDraw(geometry, draw) {
    const part = geometry.partitions.get(draw.imageryIndexCell || tileKey(draw.texture))
    if (part) { part.lastUsed = monotonicNow(); if (part.allocation) part.allocation.touch() }
    return part || { vertexCount: 0, indexCount: 0 }
  }

  releasePartitions(geometry) {
    this.cancelPartitionTask(geometry)
    this.partitionQueue = this.partitionQueue.filter(job => job.geometry !== geometry)
    this.partitionUploads = this.partitionUploads.filter(job => {
      if (job.geometry !== geometry) return true
      this.releasePartitionInput(job); return false
    })
    if (geometry.partitions) geometry.partitions.forEach((part, key) => this.releasePartition(geometry, key))
    geometry.partitions = new Map()
    geometry.partitionPending = new Set()
    geometry.partitionBlocked = new Set()
    geometry.partitionDraws = null
    if (geometry.partitionBytes) this.partitionAdmissionRevision = (this.partitionAdmissionRevision || 0) + 1
    this.partitionBytes -= geometry.partitionBytes || 0
    geometry.partitionBytes = 0
  }

  rebuildImageryDraws() {
    if (!this.current) { this.partitionPublication.clear(); return }
    // A new desired plan does not remove the prepared display dependencies.
    // Keep that complete snapshot until preparePartitions replaces it. Clearing
    // it here makes promotion/pin reconciliation cancel still-needed UV work
    // before the next presentation has even computed its dependency graph.
    const sourceDraws = terrainSourceDraws(this.current,this.options.textureDescriptor)
    this.geometryCoverageDraws = sourceDraws.filter((draw) =>
      (draw.flags & DRAW_FLAG_COVERAGE) !== 0)
      .map((draw) => Object.assign({}, draw, {
        imageryCoverageDraw: true,
        imageryClipCell: false
      }))
    const targetDraws = sourceDraws.filter((draw) =>
      (draw.flags & DRAW_FLAG_COVERAGE) === 0)
    this.measurements.clear()
    this.syncMeasurementLoans()
    // This pass measures the new view. Only immediate camera previews reuse
    // the displayed cut without running surface selection on the UI thread.
    this.plannedCameraVersion = this.current.imageryPlan &&
      this.current.imageryPlan.quality.cameraCurrent === false ? -1 : this.cameraVersion
    this.projectionContext = surfacePlan.projectionContext(this.current.frame, {
      width: this.canvas.width, height: this.canvas.height,
      devicePixelRatio: this.options.devicePixelRatio || 1
    }, invertMatrix4(this.current.frame.projectionView))
    const provisional = this.options.scheduledImagery && !this.terrainBoundImagery && !this.current.imageryPlan ? {
      draws: targetDraws.map(draw => this.residentImageryDraw(draw)),
      levels: new Map(), quality: { targetPixelError: this.options.imageryPixelError || 1.25,
        measuredMaxPixelError: Infinity, desiredDrawCount: targetDraws.length,
        provisional: true, planningComplete: false, spatialCut: false }
    } : null
    // The scheduled planner owns projection/refinement and its work credits.
    // Direct Wasm also exposes a synchronous callback; do not run and discard
    // that plan while this publication only needs provisional root coverage.
    let corePlan = this.mode === 'texture' && !this.current.imageryPlan && !provisional && this.options.planImagery &&
      this.options.planImagery(targetDraws, draw => this.measureDraw(draw), this.imageryPlanningOptions())
    while(corePlan) {
      const refine=surfacePlan.measurementRefinements(corePlan,draw=>this.measureDraw(draw),
        this.shouldRefineImageryBounds())
      if(!refine.length) break
      refine.forEach(draw=>this.measureDraw(draw,true))
      corePlan=this.options.planImagery(targetDraws,draw=>this.measureDraw(draw),this.imageryPlanningOptions())
    }
    let result = this.current.imageryPlan || (this.mode === 'texture' ? provisional || corePlan :
      {draws: targetDraws, levels: new Map(), quality: {}})
    invariant(result && result.quality && Array.isArray(result.draws), 'Imagery planner is required')
    if (corePlan) result.quality.refinableMeasurementCount = new Set(result.draws
      .filter(draw => this.measureDraw(draw).refinable).map(draw => draw.resourceId)).size
    if (!this.current.imageryPlan && !provisional && !this.terrainBoundImagery && this.options.managedResources) {
      result = surfacePlan.fitImageryPartitionBudget(result, this.imageryPlanningOptions(),
        draw => (this.geometryForDraw(draw) || {}).model)
    }
    this.imageryLevels = result.levels
    this.renderDraws = result.draws
    // Resolve fallback per region instead of overlaying a whole coarse mesh.
    this.coverageDraws = []
    result.quality.terrainBound = this.terrainBoundImagery
    result.quality.coverageDrawCount = 0
    this.pendingQualityStats = result.quality
    const retainedDraws = this.displaySurface &&
      this.displaySurface.current !== this.current
      ? (this.displaySurface.geometryCoverageDraws || []).concat(
        this.displaySurface.coverageDraws || [],
        this.displaySurface.renderDraws) : null
    const coarsening = result.quality.coarsening && this.plannedCameraVersion === this.cameraVersion
    this.textures.sync(this.geometryCoverageDraws.concat(
      this.coverageDraws, this.renderDraws), (retainedDraws || []).concat(
        Array.from(this.presentedTextures.values()).map(texture => ({ texture }))), Boolean(coarsening))
    this.geometryPublicationPending=true
    this.requestResources()
  }

  currentGeometryKeys() {
    if (!this.current) return new Set()
    return new Set(this.current.draws.map((draw) => draw.geometryKey)
      .filter((key) => Boolean(key)))
  }

  missingCurrentGeometryCount() {
    let missing = 0
    this.currentGeometryKeys().forEach((key) => {
      if (!this.geometry.has(key)) missing += 1
    })
    return missing
  }

  currentCoverageGeometryKeys() {
    return new Set(this.geometryCoverageDraws
      .map((draw) => draw.geometryKey)
      .filter((key) => Boolean(key)))
  }

  missingCurrentCoverageGeometryCount() {
    let missing = 0
    this.currentCoverageGeometryKeys().forEach((key) => {
      if (!this.geometry.has(key)) missing += 1
    })
    return missing
  }

  omittedCurrentGeometryCount() {
    return this.current && this.current.frame
      ? Math.max(0, Number(this.current.frame.omittedDrawCount) || 0) : 0
  }

  currentGeometryCoverageReady() {
    if (!this.current || !this.current.frame) return false
    if (typeof this.current.frame.coverageComplete === 'boolean') {
      return this.current.frame.coverageComplete
    }
    return this.omittedCurrentGeometryCount() === 0
  }

  currentGeometryReady() {
    if (!this.current || this.current.draws.length === 0) return false
    if (this.geometryCoverageDraws.length > 0 && (!this.displaySurface ||
        !(this.current.updateState && this.current.updateState.pendingMeshGroups) &&
        this.pendingQualityStats.coarsening && this.plannedCameraVersion === this.cameraVersion &&
        this.geometryCoverageDraws.every(draw => !this.measureDraw(draw).visible ||
          this.textures.presentationKeyFor(draw.texture)))) {
      return this.currentGeometryCoverageReady() && this.missingCurrentCoverageGeometryCount() === 0
    }
    return this.currentGeometryCoverageReady() && this.missingCurrentGeometryCount() === 0 &&
      this.omittedCurrentGeometryCount() === 0
  }

  currentSelectionReady() {
    return this.selectionEvaluated() && this.current.selectionCurrent !== false &&
      !(this.current.updateState && this.current.updateState.pendingMeshGroups)
  }

  selectionEvaluated() {
    return Boolean(this.current) && !(this.current.updateState &&
      this.current.updateState.pendingPriorityUpdateCount > 0)
  }

  currentTargetGeometryReady() {
    return Boolean(this.current && this.current.draws.some(draw =>
      !(draw.flags & DRAW_FLAG_COVERAGE))) &&
      this.missingCurrentGeometryCount() === 0 &&
      this.omittedCurrentGeometryCount() === 0
  }

  updateGeometryPins() {
    this.updateMeshHolds()
    const previousPins = this.geometryPinnedKeys
    const pinned = new Set()
    if (this.displaySurface && this.displaySurface.current) {
      this.displaySurface.current.draws.forEach((draw) => {
        if (draw.geometryKey) pinned.add(draw.geometryKey)
      })
    }
    this.currentGeometryKeys().forEach((key) => pinned.add(key))
    for (const surface of [this.current, this.displaySurface && this.displaySurface.current]) {
      if (surface) for (const draw of surface.draws)
        if (pinned.has(draw.geometryKey)) pinned.add(textureResourceKey(draw))
    }
    this.geometryPinnedKeys = pinned
    this.prunePartitionRequests()
    if (this.current && this.displaySurface && this.displaySurface.current === this.current) {
      const bytes = Array.from(pinned).reduce((total, key) => {
        const entry = this.geometry.entries.get(key)
        return total + (entry ? entry.byteSize : 0)
      }, 0)
      if (bytes <= this.options.geometryCacheBytes / 2) {
        this.geometry.maximumBytes = this.options.geometryCacheBytes
      }
      const capacity = this.options.partitionCacheBytes || this.options.geometryCacheBytes || 16 * 1024 * 1024
      this.prunePartitions(0, capacity)
      if (this.partitionBytes + this.partitionReservedBytes <= capacity) this.partitionCapacityBytes = capacity
    }
    this.geometry.evict()
    // A display handoff can unlock resident bytes without evicting them.
    // Observe the completed pin change: the earlier CPU loan return still
    // saw the old display pins and correctly advertised no new capacity.
    if (Array.from(previousPins).some(key => {
      const entry = !pinned.has(key) && this.geometry.entries.get(key)
      return entry && this.resourceLedger.canReclaim(entry.lease)
    })) this.resourceLedger.available()
    if (this.uploadQueue.length && (previousPins.size !== pinned.size ||
        Array.from(previousPins).some(key => !pinned.has(key)))) this.requestResources()
    if (this.partitionBudgetLimited && this.partitionNotifiedRevision !== this.partitionAdmissionRevision &&
        this.options.onImageryPlanningChange) {
      this.partitionNotifiedRevision = this.partitionAdmissionRevision
      this.options.onImageryPlanningChange()
    }
  }

  updateMeshHolds() {
    const resources = new Set()
    ;[this.current && this.current.meshResources,
      this.displaySurface && this.displaySurface.current.meshResources,
      this.renderedSurface && this.renderedSurface.resources].forEach(map => {
      if (map) map.forEach(resource => resources.add(resource))
    })
    resources.forEach(resource => {
      if (!this.meshHolds.has(resource)) this.meshHolds.set(resource, holdMeshes([resource]))
    })
    this.meshHolds.forEach((release, resource) => {
      if (!resources.has(resource)) { this.meshHolds.delete(resource); release() }
    })
  }

  ensureCurrentGeometryQueued() {
    if (!this.current || this.missingCurrentGeometryCount() === 0) return
    const queued = new Set(this.uploadQueue.map((item) => item.key))
    let requiresQueue = false
    this.currentGeometryKeys().forEach((key) => {
      if (!this.geometry.has(key) && !queued.has(key) && !this.geometry.reservations.has(key)) requiresQueue = true
    })
    if (requiresQueue) {
      this.enqueueGeometry(this.current.draws)
    }
  }

  presentationBridgeGoals() {
    if (this.meshOutputPlan && this.meshOutputPlan.valid()) return []
    if (this.mode !== 'texture' || !this.presentation.duration || !this.displaySurface ||
        this.displaySurface.current === this.current ||
        this.plannedCameraVersion !== this.cameraVersion) return []
    const goals = new Map(), targetError = this.options.imageryPixelError || 1.25
    this.renderDraws.forEach(draw => {
      if (!this.measureDraw(draw).visible) return
      const tile = draw.texture, key = tileKey(tile)
      const previous = goals.get(key)
      goals.set(key, {tile, error: Math.max(this.measureTextureDraw(draw, tile.level),
        previous ? previous.error : 0)})
    })
    // Different terrain fragments can demand nested tiles. Each submitted cell
    // follows its finest ready goal; an ancestor cannot also wait for that same
    // cell to become coarse. Keep settled goals as overrides during the fade.
    const bridges = Array.from(goals.values()).filter(({tile, error}) =>
      Number.isFinite(error) && error <= targetError && this.textures.gpuReady(tileKey(tile)))
      .map(goal => goal.tile).sort((a, b) => b.level - a.level ||
        a.matrix - b.matrix || a.row - b.row || a.column - b.column)
    const pending = Array.from(this.presentation.cells.values()).some(state => {
      const tile = bridges.find(goal => textureTileContains(goal, state.cell))
      return tile && tile.level < state.cell.level &&
        (tileKey(state.a) !== tileKey(tile) ||
         tileKey(state.b) !== tileKey(tile))
    })
    return pending ? bridges : []
  }

  updatePresentationBridges() {
    const previous = this.presentationBridges
    this.presentationBridges = this.presentationBridgeGoals()
    // Display can discover resident coarse goals after the resource clock has
    // parked. World-cut demand includes these goals; notify only semantic
    // changes, including removal, without depending on new I/O or a refund.
    if (previous.length !== this.presentationBridges.length || previous.some((tile, index) =>
      tileKey(tile) !== tileKey(this.presentationBridges[index]))) this.requestResources()
    if (this.presentationBridges.length) {
      const displayed = new Set(this.displaySurface.current.draws.map(draw => draw.geometryKey))
      this.partitionQueue = this.partitionQueue.filter(job => {
        if (displayed.has(job.geometry.key)) return true
        job.cells = job.cells.filter(cell => {
          const values = cell.key.split('/').map(Number)
          const tile = {level: values[0], matrix: values[1], row: values[2], column: values[3]}
          const obsolete = this.presentationBridges.some(goal => goal.level < tile.level && textureTileContains(goal, tile))
          if (obsolete) job.geometry.partitionPending.delete(cell.key)
          return !obsolete
        })
        return job.cells.length > 0
      })
    }
  }

  promoteCurrentSurfaceIfReady() {
    if (this.heldCandidate) return this.handoff.wait('model-replacement')
    if (this.current && !this.indices.ready(this.current.indices)) {
      return this.handoff.wait('index-upload')
    }
    this.updatePresentationBridges()
    if (!this.currentGeometryReady()) return this.handoff.wait(
      !this.currentGeometryCoverageReady() ? 'coverage-incomplete' :
        this.geometryBudgetLimited ? 'geometry-capacity' : 'geometry-upload',
      {missing: this.missingCurrentGeometryCount(), coverageMissing: this.missingCurrentCoverageGeometryCount()})
    if (this.presentationBridges.length && this.displaySurface &&
        this.displaySurface.current !== this.current) {
      // Fade on the already partitioned display mesh first. Reconstructing its
      // obsolete fine cells on a new coarse mesh can otherwise block both cuts.
      return this.handoff.wait('imagery-transition', {cells: this.presentationBridges.length})
    }
    const useGeometryCoverage = !this.currentTargetGeometryReady()
    // A complete GPU coarse cover can retire the old fine geometry pins. Do
    // not wait for fine uploads or rebuild their partitions once the current
    // measured coarsening view and its resident cover have passed the gates above.
    const renderDraws = useGeometryCoverage && this.pendingQualityStats.coarsening &&
      this.missingCurrentGeometryCount() > 0 ? this.coverageDraws : this.renderDraws
    this.partitionPublication.setHandoff([])
    if (this.mode==='texture'&&!useGeometryCoverage && this.displaySurface && this.displaySurface.current !== this.current &&
        this.presentedTextures.size) {
      let compatible = true
      const inherited=this.worldDisplay.compatible(this.renderDraws)
      const cells=inherited?[]:this.presentationDraws(this.renderDraws,false)
      if(!cells)return this.handoff.wait('display-cut-preparation')
      cells.forEach(draw => {
        if (!draw.imageryClipCell || draw.imageryDirectClip) return
        const geometry = this.geometry.get(draw.geometryKey), cell = this.partitionCell(draw)
        if (!geometry || !geometry.partitions.has(cell.key)) {
          compatible = false
          if (geometry) this.requestPartitionSet(geometry, [cell], 3)
        }
      })
      if (!compatible) {
        // No native receipt can be issued while the old cut still owns display.
        return this.handoff.wait(this.partitionBudgetLimited ? 'partition-capacity' : 'partition-build',
          {queued: this.partitionQueue.length, active: Boolean(this.partitionActive)})
      }
    }
    // Background preparation may start compatible UV work, but only the
    // display clock may replace the old surface and surrender its GPU pins.
    const unchanged = this.displaySurface &&
      this.displaySurface.current === this.current &&
      this.displaySurface.renderDraws === renderDraws &&
      this.displaySurface.coverageDraws === this.coverageDraws &&
      this.displaySurface.geometryCoverageDraws ===
        this.geometryCoverageDraws &&
      this.displaySurface.useGeometryCoverage === useGeometryCoverage
    if(!unchanged)this.renderRequested=true
    const samePrepared=this.preparedSurface&&this.preparedSurface.current===this.current&&
      this.preparedSurface.renderDraws===renderDraws&&this.preparedSurface.useGeometryCoverage===useGeometryCoverage
    if(!samePrepared)this.preparedSurface = {
      current: this.current,
      renderDraws,
      coverageDraws: this.coverageDraws,
      geometryCoverageDraws: this.geometryCoverageDraws,
      useGeometryCoverage,
      quality: this.pendingQualityStats
    }
    this.preparedSurfaceSource=this.current
    this.handoff.ready()
    this.notifyPresented()
    return true
  }

  clearReplacement() {
    this.replacement = null
    this.syncMeasurementLoans()
  }

  localReplacementSurface() {
    const displayed = this.displaySurface, current = this.current
    if (this.heldCandidate) return displayed
    if (!displayed || displayed.current === current ||
        current.frame.coverageComplete === false || displayed.useGeometryCoverage ||
        !current.meshResources || !displayed.current.meshResources ||
        current.indices !== displayed.current.indices ||
        (current.updateState && current.updateState.workerGeneration) !==
          (displayed.current.updateState && displayed.current.updateState.workerGeneration)) {
      this.clearReplacement()
      return displayed
    }
    if (!this.replacement || this.replacement.current !== current) {
      this.clearReplacement()
      this.replacement = {current, committed: new Set(),
        groups: bindReplacementPlan(current.replacementPlan, displayed.current, current)}
    }
    const plan = this.replacement
    if (!plan.groups) return displayed
    const blocked = new Set()
    const cells=this.mode==='texture'?this.presentationDraws(this.renderDraws,false):[]
    if(!cells)return displayed
    cells.forEach(draw => {
      const geometry = this.geometry.get(draw.geometryKey)
      if (!geometry) { blocked.add(draw.geometryKey); return }
      if (draw.imageryClipCell && !draw.imageryDirectClip) {
        const cell = this.partitionCell(draw)
        if (!geometry.partitions.has(cell.key)) {
          blocked.add(draw.geometryKey)
          this.requestPartitionSet(geometry, [cell], 3)
        }
      }
    })
    const selected = new Set(plan.committed)
    plan.groups.forEach((group, index) => {
      if (selected.has(index) || group.after.some(draw =>
        !this.geometry.has(draw.geometryKey) || blocked.has(draw.geometryKey))) return
      const fading = this.presentationBridges.length && group.before.some(draw => {
        const source = draw.sourceTexture || draw.texture
        return Array.from(this.presentation.cells.values()).some(state => {
          const goal = this.presentationBridges.find(tile => textureTileContains(tile, state.cell))
          return goal && (textureTileContains(source, state.cell) || textureTileContains(state.cell, source)) &&
            (tileKey(state.a) !== tileKey(goal) || tileKey(state.b) !== tileKey(goal))
        })
      })
      if (!fading) selected.add(index)
    })
    if (!selected.size) return displayed
    const afterKeys = new Set(), beforeKeys = new Set(), draws = []
    plan.groups.forEach((group, index) => {
      const next = selected.has(index), keys = next ? afterKeys : beforeKeys
      const items = next ? group.after : group.before
      items.forEach(draw => { keys.add(draw.geometryKey); draws.push(draw) })
    })
    const renderDraws = displayed.renderDraws.filter(draw => beforeKeys.has(draw.geometryKey))
      .concat(this.renderDraws.filter(draw => afterKeys.has(draw.geometryKey)))
    const coverage = displayed.geometryCoverageDraws || []
    if (!plan.mixed || !plan.proposed || selected.size !== plan.proposed.size ||
        Array.from(selected).some(index => !plan.proposed.has(index))) {
      const surfaceDraws = draws.concat(coverage)
      const resources = new Map(surfaceDraws.map(draw => [draw.resourceId,
        current.meshResources.get(draw.resourceId) || displayed.current.meshResources.get(draw.resourceId)]))
      plan.mixed = Object.assign({}, current, {draws: surfaceDraws, meshResources: resources})
      plan.renderDraws=renderDraws
      // A prepared local cut can outlive the current projection map before
      // its first display. Own its numeric snapshot at this publication edge.
      this.syncMeasurementLoans()
    }
    plan.proposed = selected
    return {current: plan.mixed, renderDraws:plan.renderDraws, coverageDraws: [], geometryCoverageDraws: coverage,
      useGeometryCoverage: false, quality: this.pendingQualityStats, replacement: plan}
  }

  notifyPresented() {
    if (this.heldCandidate || !this.current || !this.current.meshResources ||
        !this.displaySurface || this.displaySurface.current !== this.current ||
        this.submittedSequence !== this.current.frame.sequence ||
        !this.currentGeometryReady() ||
        this.presentedSequence === this.current.frame.sequence) return
    if (!this.handoff.submit(this.current.frame.sequence)) return
    this.presentedSequence = this.current.frame.sequence
    if (typeof this.options.onPresented === 'function') {
      this.options.onPresented(this.presentedSequence)
    }
  }

  imageryPlanningOptions() {
    return { descriptor: this.options.textureDescriptor,
      sourceUvScale: this.sourceUvScale(),
      targetPixelError: this.options.imageryPixelError || 1.25,
      maximumSubdivisionLevels: this.options.maximumImagerySubdivisionLevels,
      maximumDraws: this.options.maximumImageryDraws,
      maximumTextures: this.textures.targetCapacity(),
      visibility: this.visibility && this.visibility.snapshot(),
      maximumPartitionBytes: Math.floor((this.options.partitionCacheBytes ||
        this.options.geometryCacheBytes || 16 * 1024 * 1024) / 3),
      admissionRevision: this.partitionAdmissionRevision || 0,
      refineBounds: this.shouldRefineImageryBounds(),
      terrainBound: this.terrainBoundImagery,
      devicePixelRatio: this.options.devicePixelRatio || 1 }
  }

  terrainRefinementDemand() {
    if (this.mode !== 'texture') return {bytes: 0, keep: []}
    const quality = this.current && this.current.imageryPlan && this.current.imageryPlan.quality
    const planned = quality && (quality.planningComplete || quality.demandReady) && quality.cameraCurrent !== false &&
      this.plannedCameraVersion === this.cameraVersion
    // A complete fitted current cut can acquire rolling credit before its
    // precision job finishes. This quote is not a final-quality declaration.
    // An admitted complete spatial cut already funds a bounded continuation.
    // Its finer measurement job need not converge before the next terrain
    // window. A preview alone cannot supply this receipt, nor can another view,
    // source or surface reuse it. Reprice actual ownership on every advance.
    const admission = !planned && this.current && this.current.imageryAdmission
    if (!planned && (!admission || admission.cameraVersion !== this.cameraVersion ||
        admission.sequence !== this.current.frame.sequence || admission.sourceGeneration !== this.textures.generation)) return null
    const demand = planned ? this.textures.resourceDemand() : admission.quote()
    if (!demand) return null
    return Object.assign({sequence: this.current.frame.sequence, cameraVersion: this.cameraVersion,
      sourceGeneration: this.textures.generation,
      admission: admission || null, refinable: quality && quality.refinableMeasurementCount > 0}, demand)
  }

  refineImageryDemand() {
    if (!this.current || this.mode !== 'texture' || this.refineImageryCamera === this.cameraVersion) return false
    this.refineImageryCamera = this.cameraVersion
    if (this.options.onImageryPlanningChange) this.options.onImageryPlanningChange()
    this.requestRender()
    return true
  }

  reserveImageryDemand(demand) {
    if (this.mode !== 'texture') { this.textures.releaseDemand(); return true }
    if (!this.current || this.current.frame.sequence !== demand.sequence ||
        demand.cameraVersion !== this.cameraVersion || demand.sourceGeneration !== this.textures.generation) return false
    if (demand.admission) return this.current.imageryAdmission === demand.admission &&
      Boolean(demand.admission.quote()) && this.textures.reserveDemand(demand)
    const quality = this.current && this.current.imageryPlan && this.current.imageryPlan.quality
    if (!quality || !(quality.planningComplete || quality.demandReady) || quality.cameraCurrent === false ||
        this.plannedCameraVersion !== this.cameraVersion) return false
    return this.textures.reserveDemand(demand)
  }

  acceptCandidateImagery(frame, plan, outputs) {
    this.current.imageryAdmission = null
    if(outputs&&outputs.acceptSurface)outputs.acceptSurface()
    if (!outputs || !outputs.acceptImageryDemand) return
    outputs.acceptImageryDemand()
    if (plan && plan.quality.cameraCurrent !== false && outputs.imageryDemand) {
      this.current.imageryAdmission = {sequence: frame.sequence, cameraVersion: this.cameraVersion,
        sourceGeneration: this.textures.generation, quote: outputs.imageryDemand}
    }
  }

  setImageryPlan(sequence, plan, measurements) {
    if (!this.current || this.current.frame.sequence !== sequence) return false
    const targets = this.current.draws.filter(draw => !(draw.flags & DRAW_FLAG_COVERAGE))
    const previous = this.current.imageryPlan
    const sameView = this.plannedCameraVersion === this.cameraVersion
    const measurementsCurrent = this.current.measurementCameraVersion === this.cameraVersion
    const merged = mergeImageryDemand(targets, previous, plan,
      this.current.workerMeasurements || new Map(), measurements, {
        sameView, viewRevision:this.cameraVersion, measurementsCurrent, scheduledImagery: this.options.scheduledImagery,
        tileSize: (this.options.textureDescriptor || {}).tile_size || 256,
        hidden: id => Boolean(this.visibility && this.visibility.hidden(id)),
        rootDraw: draw => this.rootImageryDraw(draw),
        coverageDraw: draw => this.residentImageryDraw(draw)
      })
    this.current.imageryPlan = merged.plan
    this.current.workerMeasurements = merged.measurements
    this.syncMeasurementLoans()
    this.current.measurementCameraVersion = plan.quality.cameraCurrent !== false || measurementsCurrent
      ? this.cameraVersion : -1
    this.current.planningSignature = JSON.stringify(Object.assign({}, this.imageryPlanningOptions(), {admissionRevision: undefined}))
    this.rebuildImageryDraws()
    this.requestRender()
    return true
  }

  resetWorker() {
    this.cameraSubmissionPriority.clear()
    this.textures.releaseDemand()
    this.refineImageryCamera = null
    this.heldCandidate = null
    this.clearReplacement()
    this.handoff.clear()
    this.current = null
    this.presentedSequence = null
    this.clearGeometryUploads()
    this.partitionGeneration += 1
    this.clearPartitionWork()
    this.measurements.clear()
    this.syncMeasurementLoans()
    this.updateGeometryPins()
  }

  candidateCanYield(sequence) {
    const current = this.current, display = this.displaySurface, plan = this.replacement
    if (!current || current.frame.sequence !== sequence || !display ||
        this.lastSubmittedSurface !== display.current) return false
    if (display.current === current && !display.useGeometryCoverage) return true
    if (!plan || plan.current !== current || !plan.groups.length) return false
    const changed = group => group.before.length !== group.after.length || group.after.some(draw =>
      !group.before.some(old => old.resourceId === draw.resourceId &&
        old.geometryKey && old.geometryKey === draw.geometryKey))
    // A complete identity proof has no new geometry to present. Camera-local
    // UV preparation for that old cut must not block a newer terrain model.
    // The existing submitted surface still owns every display dependency.
    if (!plan.groups.some(changed)) return true
    // Changed cuts first publish one complete changed group, preventing input
    // churn from cancelling every candidate before it reaches the display.
    return Array.from(plan.committed).some(index => changed(plan.groups[index]))
  }

  holdCandidate(sequence) {
    const display = this.displaySurface
    if (this.heldCandidate || this.paused || this.contextLost || !this.current ||
        this.current.frame.sequence !== sequence || !display ||
        this.lastSubmittedSurface !== display.current) return null
    const token = {draws: display.current.draws, surface: display, discarded: false}
    this.heldCandidate = token
    this.clearReplacement()
    return token
  }

  discardCandidate(token) {
    if (this.heldCandidate !== token || token.discarded) return
    // CPU owners have acknowledged the mixed display and discarded the rest.
    // Surrender queued destinations BEFORE admitting its successor: a paused
    // upload must not reject a new reservation for the same immutable mesh.
    // Submitted work keeps its own input/credit until its completion callback.
    token.discarded = true
    const surface = token.surface
    this.current = Object.assign({}, surface.current, {frame: this.current.frame,
      updateState: null, selectionCurrent: false, imageryPlan: {
        draws: surface.renderDraws, levels: this.imageryLevels,
        quality: Object.assign({}, surface.quality, {planningComplete: false})}})
    this.handoff.clear()
    this.partitionGeneration += 1
    this.clearPartitionWork()
    this.clearGeometryUploads()
    this.updateGeometryPins()
    this.rebuildImageryDraws()
  }

  releaseCandidate(token) {
    if (this.heldCandidate !== token) return
    this.heldCandidate = null
    // A failed successor resumes only the acknowledged display. Retention
    // failure leaves the original candidate and all of its work unchanged.
    if (token.discarded) this.enqueueGeometry(this.current.draws)
    this.syncMeasurementLoans()
    this.requestRender()
  }

  setMeshFrame(frame, draws, meshResources, indices, updateState, imageryPlan, measurements, presentation) {
    invariant(frame && Array.isArray(draws) && meshResources instanceof Map && indices,
      'Renderer mesh frame is incomplete')
    const outputs = presentation && presentation.outputs
    // The awaited native/host handoff can outlive an image producer. Acquire
    // its current complete price before retiring any renderer state.
    if (outputs && outputs.prepareImageryDemand) outputs.prepareImageryDemand()
    if (outputs && !outputs.valid()) throw Object.assign(new Error('Candidate output generation changed'),
      {superseded: true, candidateAdmissionRejected: true})
    if (this.forecastOutputPlan) this.forecastOutputPlan.release()
    this.heldCandidate = null
    this.clearReplacement()
    this.handoff.prepare(frame.sequence)
    const selectionFrame = frame
    const selectionCurrent = !presentation || presentation.selectionCurrent
    const replacementPlan = presentation && presentation.replacementPlan
    this.indices.accept(indices, outputs)
    if (presentation) frame = Object.assign({}, frame, presentation.camera)
    const previous = this.current
    const sameCamera = previous && frame.projectionView.every((v, i) =>
      v === previous.frame.projectionView[i]) && frame.cameraPosition.every((v, i) =>
      v === previous.frame.cameraPosition[i])
    const sameWorker = previous && previous.updateState && updateState &&
      previous.updateState.workerGeneration === updateState.workerGeneration
    // CBDAM may update topology outside this cut. Immutable resource identity
    // determines geometry lifetime; the latest revision remains frame metadata.
    const sameGeometry = sameWorker &&
      previous.draws.length === draws.length &&
      previous.draws.every((draw, i) => draw.resourceId === draws[i].resourceId && draw.flags === draws[i].flags)
    const sameOwners = sameGeometry && draws.every(draw =>
      previous.meshResources.get(draw.resourceId) === meshResources.get(draw.resourceId))
    const sameCoverage = previous && ['coverageComplete', 'expectedDrawCount', 'omittedDrawCount', 'coverageDrawCount']
      .every(key => previous.frame[key] === frame[key])
    const planningSignature = JSON.stringify(Object.assign({}, this.imageryPlanningOptions(), {admissionRevision: undefined}))
    const retainPlan = sameWorker && previous.imageryPlan &&
      !previous.imageryPlan.quality.provisional &&
      previous.planningSignature === planningSignature
    if (sameCamera && sameOwners && sameCoverage && this.plannedCameraVersion === this.cameraVersion &&
        previous.planningSignature === planningSignature) {
      this.enqueueGeometry(draws, outputs)
      this.updateGeometryPins()
      previous.frame = frame
      previous.selectionFrame = selectionFrame
      previous.selectionCurrent = selectionCurrent
      previous.updateState = updateState
      previous.replacementPlan = replacementPlan
      this.acceptCandidateImagery(frame, imageryPlan, outputs)
      // Mesh identity does not imply imagery identity. A background planner can
      // finish refinement on this same cut while terrain I/O is stalled.
      const samePlan = imageryPlan === previous.imageryPlan || (imageryPlan &&
        previous.imageryPlan && imageryPlan.revision !== undefined &&
        imageryPlan.revision === previous.imageryPlan.revision)
      if (imageryPlan && !samePlan) {
        this.setImageryPlan(frame.sequence, imageryPlan, measurements || [])
      }
      this.geometryPublicationPending=true
      this.requestResources()
      this.requestRender()
      return
    }
    const measurementsCurrent = sameCamera && sameWorker && previous.measurementCameraVersion === this.cameraVersion
    const knownMeasurements = measurementsCurrent
      ? new Map(previous.workerMeasurements || []) : new Map()
    const currentMeasurementUpdates = !imageryPlan || imageryPlan.quality.cameraCurrent !== false
    if (currentMeasurementUpdates && !imageryPlan) (measurements || []).forEach(m => knownMeasurements.set(m.resourceId, m))
    const currentIds = new Set(draws.map(draw => draw.resourceId))
    for(const id of knownMeasurements.keys()) if(!currentIds.has(id)) knownMeasurements.delete(id)
    // Model identity owns geometry/visibility invalidation. Only a changed
    // projection or eye position invalidates the displayed camera epoch.
    if (!sameCamera) { this.textures.releaseDemand(); this.cameraVersion += 1 }
    this.current = { frame, selectionFrame, selectionCurrent, draws, meshResources, indices, updateState,
      imageryPlan: retainPlan ? previous.imageryPlan : undefined, planningSignature,
      replacementPlan, workerMeasurements: knownMeasurements,
      measurementCameraVersion: measurementsCurrent || !imageryPlan && currentMeasurementUpdates && measurements && measurements.length
        ? this.cameraVersion : -1 }
    this.syncMeasurementLoans()
    this.acceptCandidateImagery(frame, imageryPlan, outputs)
    let startedAt = monotonicNow()
    this.enqueueGeometry(draws, outputs)
    this.updateGeometryPins()
    recordTiming(this.performanceStats.geometryPrepare, monotonicNow() - startedAt)
    startedAt = monotonicNow()
    if (imageryPlan) this.setImageryPlan(frame.sequence, imageryPlan, measurements || [])
    else if (retainPlan) {
      // Reuse spatial demand on matching immutable meshes across camera epochs;
      // only measurements of the actual camera can prove its current quality.
      const cameraCurrent = sameCamera && this.plannedCameraVersion === this.cameraVersion
      this.setImageryPlan(frame.sequence, Object.assign({}, previous.imageryPlan, {
        quality: Object.assign({}, previous.imageryPlan.quality, {
          cameraCurrent, planningComplete: cameraCurrent && previous.imageryPlan.quality.planningComplete})
      }), Array.from(knownMeasurements.values()))
    } else this.rebuildImageryDraws()
    recordTiming(this.performanceStats.imageryRebuild, monotonicNow() - startedAt)
    const witness=submittedSurfaceWitness(this,previous,draws,meshResources,indices,sameWorker)
    if(witness){this.preparedSurface=witness;this.preparedSurfaceSource=this.current;this.handoff.ready()}
    this.requestRender()
  }

  setCameraFrame(snapshot) {
    if (this.forecastOutputPlan) this.forecastOutputPlan.release()
    invariant(this.current && snapshot && snapshot.cameraPosition &&
      snapshot.projectionView, 'Renderer camera snapshot is incomplete')
    this.textures.releaseDemand()
    this.cameraVersion += 1
    // Geometry and complete world cuts are independent of the camera. Keep
    // their prepared witness; the display applies the latest mask and SSE.
    this.current.selectionCurrent = false
    this.measurements.clear()
    this.syncMeasurementLoans()
    this.current.frame = Object.assign({}, this.current.frame, {
      cameraPosition: snapshot.cameraPosition.slice(),
      projectionView: new Float64Array(snapshot.projectionView)
    })
    this.projectionContext = surfacePlan.projectionContext(this.current.frame, {
      width: this.canvas.width, height: this.canvas.height,
      devicePixelRatio: this.options.devicePixelRatio || 1
    }, invertMatrix4(this.current.frame.projectionView))
    this.geometryPublicationPending=true
    this.requestResources()
    this.requestRender()
  }

  setOverlays(overlays) {
    const value = overlays || {}
    this.overlays = {
      points: Array.isArray(value.points) ? value.points.slice() : [],
      route: value.route || null
    }
    this.requestResources()
    this.requestRender()
  }

  requestRender() {
    this.renderRequested = true
    this.requestRenderCallback()
  }

  requestResources() {
    this.resourcesRequested = true
    this.wakeResources()
  }

  wakeResources(delay = 0) {
    if (!this.destroyed && !this.paused && !this.contextLost) this.requestResourcesCallback(delay)
  }

  // Both clocks may enter this non-reentrant JS code, but only render() draws.
  // The host calls advanceResources() from its independent background queue.
  prepareResources(publish = false) {
    if (!publish&&this.mode === 'texture') this.textures.growShare()
    if (!publish&&this.visibility && this.visibility.proofs) this.visibility.proofs.advance()
    if (!publish&&(this.resourceAdmissionDirty || this.resourceReceiptDirty)) {
      const advance = this.resourceReceiptDirty || this.textures.needsCapacityRetry()
      this.resourceAdmissionDirty = false
      this.resourceReceiptDirty = false
      if (advance) this.textures.advance()
    }
    // CPU preparation does not depend on a previous GPU receipt. Its own
    // active/ready slots and output credit bound work ahead of the upload lane.
    if (!publish&&this.resourcesRequested) {
      this.textures.prepareUploads()
      if (!this.heldCandidate) this.pumpPartitionRequests()
    }
    if (this.pendingSubmission) {
      try {
        this.submissions.poll(batch => {
          recordTiming(this.performanceStats[batch.drawn ? 'drawSubmissionWait' : 'resourceSubmissionWait'],
            monotonicNow() - batch.startedAt)
          if (!batch.drawn) {
            this.textures.dependenciesChanged()
            if (publish) {
              // The display consumes completed receipts, never a preparation
              // turn. Availability/frontier work resumes on the work clock.
              this.resourceReceiptDirty = true
              this.resourcesRequested = true
              this.wakeResources()
            } else {
              this.ensureCurrentGeometryQueued()
              this.textures.advance()
            }
          } else if (this.visibility && this.visibility.advance) this.resourcesRequested = true
        })
      } catch (error) {
        this.submissions.cancel(this.checkContextLoss())
        this.surfaceCommands.clear()
        this.onDiagnostic('webgl_allocation_failed', {message: error.message, error: error.glError})
        this.resourcesRequested=true
        this.wakeResources(16)
        return false
      }
    }
    // Uploaded geometry is preparation, not necessarily a changed display.
    // Evaluate complete boundary groups (and start their required partitions)
    // without putting another draw of the old cut ahead of every upload batch.
    // This CPU check also runs behind unrelated draw fences. Actual geometry
    // readiness still requires each upload's own receipt; ownership moves only
    // when the display submits the prepared surface.
    if (!publish&&this.geometryPublicationPending) {
      this.geometryPublicationPending = false
      const previous = this.displaySurface
      const ready = this.promoteCurrentSurfaceIfReady()
      const surface = this.localReplacementSurface()
      const geometryChanged = previous !== this.displaySurface || surface && surface.current !== this.lastSubmittedSurface ||
        ready && (!previous || previous.current !== this.current)
      if(!ready) {
        this.preparedSurface=surface
        this.preparedSurfaceSource=this.current
      }
      if (geometryChanged) this.renderRequested = true
      if (this.mode!=='texture'&&this.partitionPublication.advance()) this.renderRequested = true
    }
    if (this.pendingSubmission) {
      if(publish){this.wakeResources();return false}
      // An earlier display must not block an already admitted producer from
      // issuing its upload. One resource batch can follow it; another draw
      // still waits, so camera updates cannot create an unbounded GPU queue.
      if (this.resourcesRequested && !this.submissions.uploading) this.updateGpuResources()
      this.wakeResources(16)
      return false
    }
    if (!publish&&this.mode === 'texture') this.textures.resolveCapacityPressure()
    return true
  }

  advanceResources() {
    if (!this.gl || this.destroyed || this.paused || this.checkContextLoss() || !this.current) return
    const started=monotonicNow()
    this.partitionGroups.advanceSelection()
    const ready=this.prepareResources()
    this.coverageImages.advance(started+1)
    this.worldDisplay.advance(started+4)
    if (!ready) return
    if(this.asyncGpu&&this.resourcesRequested&&this.renderRequested&&this.renderedSurface&&this.needsPreparedDisplay()&&
        this.presentedCameraVersion===this.cameraVersion) {
      const now=monotonicNow()
      if(this.resourcePresentationDeadline===undefined)this.resourcePresentationDeadline=started+16
      if(now>=this.resourcePresentationDeadline) {
        if(this.resourceDisplayOfferUntil===undefined)this.resourceDisplayOfferUntil=now+32
        if(now<this.resourceDisplayOfferUntil) {
          this.requestRenderCallback();this.wakeResources(this.resourceDisplayOfferUntil-now);return
        }
      }
    }
    if (this.resourcesRequested) this.updateGpuResources()
    // An admitted producer can be waiting for a CPU/dependency receipt. When
    // it issued no upload, a ready display need not wait for the merge timer.
    if(!this.pendingSubmission&&this.renderRequested)this.resourcePresentationDeadline=0
    if (this.renderRequested) this.requestRenderCallback()
  }

  needsPreparedDisplay() {
    return this.preparedSurfaceSource===this.current&&this.preparedSurface&&
      this.displaySurface&&this.preparedSurface.current!==this.displaySurface.current ||
      this.submittedWorldRevision!==this.worldDisplay.publicationRevision ||
      this.submittedResourceRevision!==this.textures.cache.contentRevision ||this.presentation.active>0
  }

  render(force = true) {
    if (!this.gl || this.destroyed || this.paused || this.checkContextLoss() || !this.current) return null
    if (force) {this.renderRequested = true;this.explicitDisplayRequested=true}
    const startedAt = monotonicNow()
    if(this.asyncGpu&&this.renderedSurface&&this.pendingSubmission&&
        (this.explicitDisplayRequested||this.cameraVersion!==this.presentedCameraVersion))
      this.cameraSubmissionPriority.request()
    if (!this.prepareResources(true)) return null
    if (!this.renderRequested) {
      this.cameraSubmissionPriority.clear()
      if (this.resourcesRequested) this.requestResources()
      return null
    }
    // Coalesce resource-only changes for at most one display interval. Uploads
    // can complete several local groups without each group putting another
    // full terrain draw ahead of the remaining uploads. A waiting mesh handoff
    // and running fades share this bounded window: neither may block uploads
    // needed to finish that handoff or transition. Same-camera geometry groups
    // share this interval too; their readiness alone is not urgent input. A
    // real camera change or explicit redraw keeps priority. If uploads cannot
    // advance, submit the ready display now so its old owners can retire.
    if (!force&&!this.explicitDisplayRequested && this.asyncGpu && this.resourcesRequested &&this.needsPreparedDisplay()&&
        this.presentedCameraVersion === this.cameraVersion) {
      if (this.resourcePresentationDeadline === undefined) this.resourcePresentationDeadline = startedAt + 16
      if (monotonicNow() < this.resourcePresentationDeadline) {
        this.requestResources()
        return null
      }
    }
    this.resourcePresentationDeadline = undefined
    this.resourceDisplayOfferUntil = undefined
    this.explicitDisplayRequested=false
    this.cameraSubmissionPriority.clear()
    this.renderRequested = false
    try {
      const result = this.renderSurface(force)
      if(this.displaySurface&&!this.contextLost) {
        this.submittedWorldRevision=this.worldDisplay.publicationRevision
        this.submittedResourceRevision=this.textures.cache.contentRevision
      }
      if (this.asyncGpu && !this.contextLost) {
        if (this.surfaceDrawn) this.submitDisplay()
        else this.coverageImages.endFrame()
        if(this.resourcesRequested)this.requestResources()
      } else this.coverageImages.endFrame()
      return this.surfaceDrawn ? result : null
    } finally { this.recordRender(startedAt) }
  }

  submitDisplay() {
    const batch = new GlSubmission(this.gl)
    try {
      this.indices.hold(batch)
      this.coverageImages.submit(batch)
      if (this.visibility && this.visibility.target) this.visibility.target.submit(batch)
      this.submissions.submit(batch, true)
      this.wakeResources(16)
    } catch (error) {
      batch.cancel(this.checkContextLoss())
      this.surfaceCommands.clear()
      this.onDiagnostic('webgl_allocation_failed', {message: error.message, error: error.glError})
    }
  }

  updateGpuResources() {
    if (this.submissions.uploading) return
    if(!this.pendingSubmission&&this.cameraSubmissionPriority.requested) {
      if(!this.asyncGpu||!this.renderRequested||!this.renderedSurface||
          !this.explicitDisplayRequested&&this.cameraVersion===this.presentedCameraVersion)
        this.cameraSubmissionPriority.clear()
      else {
        const delay=this.cameraSubmissionPriority.delay(monotonicNow())
        if(delay>0){this.requestRenderCallback();this.wakeResources(delay);return}
      }
    }
    this.resourcesRequested = false
    const uploadDeadline = monotonicNow() + (this.options.uploadBudgetMs || 6)
    const batch = new GlSubmission(this.gl, elapsed =>
      recordTiming(this.performanceStats.allocationValidation, elapsed),
      new UploadBudget(this.options.uploadBudgetBytes, this.options.uploadBudgetObjects))
    this.uploadBatch = batch
    let uploaded = false
    try {
      const stages = [() => this.stageAuxiliaryResources(), () => !this.heldCandidate && this.processUploads(uploadDeadline),
        () => !this.heldCandidate && this.processPartitionUploads(uploadDeadline), () => this.textures.processUploads(uploadDeadline)]
      // Observation commands use the retained display receipt. Do not attach
      // another depth user while that display still owns its completion hold.
      // Optional observation must not place an empty resource fence ahead of
      // an already prepared display on every work turn. Necessary allocation
      // stages still run when the display clock is absent or delayed.
      const displayWaiting=this.renderRequested&&this.renderedSurface&&this.needsPreparedDisplay()
      if (!this.pendingSubmission && !displayWaiting && this.visibility && this.visibility.advance)
        stages.push(() => this.visibility.advance())
      const first = this.uploadPhase || 0
      this.uploadPhase = (first + 1) % stages.length
      for (let index = 0; index < stages.length && monotonicNow() < uploadDeadline; ++index) {
        stages[(first + index) % stages.length]()
      }
      uploaded = batch.items.length > 0
      this.lastUploadBudget = Object.assign({}, batch.budget)
      if (!this.pendingSubmission && this.visibility && this.visibility.target) this.visibility.target.submit(batch)
      if (this.asyncGpu) {
        this.submissions.submit(batch)
        if (this.submissions.uploading) { uploaded = false; this.wakeResources(16) }
      } else batch.commit()
    } catch (error) {
      batch.cancel()
      this.surfaceCommands.clear()
      uploaded = false
      // Failed allocations remain queued, never resident. Retain the display
      // cut; later resource/budget changes may retry the pending candidate.
      this.onDiagnostic('webgl_allocation_failed', {message: error.message, error: error.glError})
      this.resourcesRequested=true
      this.wakeResources(16)
    } finally { this.uploadBatch = null }
    this.ensureCurrentGeometryQueued()
    if (uploaded) this.textures.advance()
  }

  stageAuxiliaryResources() {
    const gl = this.gl
    if (this.visibility && this.visibility.target) this.visibility.target.prepare(this.visibility.needsDepth())
    this.indices.stage(this.current.indices)
    if (this.atmosphereProgram && this.uploadedAtmosphere !== this.atmosphere) {
      const value = this.atmosphere
      this.createAtmosphereTexture(value, texture => {
        if (value !== this.atmosphere) return false
        gl.deleteTexture(this.atmosphereTexture)
        this.atmosphereTexture = texture; this.uploadedAtmosphere = value
      })
    }
    this.prepareOverlays(this.current.frame.cameraPosition)
  }

  renderSurface(force = true) { return drawSurface(this, force) }

  submitDraws(surface) {
    if (this.renderedSurface === surface) return
    this.renderedSurface = surface
    this.updateMeshHolds()
    if (this.options.onDrawsSubmitted) this.options.onDrawsSubmitted(surface)
  }

  recordRender(startedAt) {
    const now = monotonicNow()
    recordTiming(this.performanceStats.render, now - startedAt)
    if (!this.surfaceDrawn) return
    if (this.performanceStats.lastFrameAt > 0) {
      const interval = now - this.performanceStats.lastFrameAt
      if (interval > 0 && interval <= 250) {
        const previous = this.performanceStats.frameIntervalMs
        this.performanceStats.frameIntervalMs = previous > 0
          ? previous * 0.85 + interval * 0.15 : interval
        this.performanceStats.framesPerSecond =
          1000 / this.performanceStats.frameIntervalMs
      } else if (interval > 250) {
        this.performanceStats.frameIntervalMs = 0
        this.performanceStats.framesPerSecond = 0
      }
    }
    this.performanceStats.lastFrameAt = now
  }

  renderAtmosphere(projectionView, cameraPosition) { return renderAtmosphere(this, projectionView, cameraPosition) }

  prepareOverlays(cameraPosition) {
    const gl = this.gl
    if (!this.overlays || (!this.overlays.points.length &&
      !(this.overlays.route && this.overlays.route.worlds.length))) {
      return
    }
    const route = this.overlays.route
    const routeCount = route && route.worlds.length >= 2 ? route.worlds.length : 0
    if (!this.overlayData || this.overlayData.source !== this.overlays ||
        cameraPosition.some((value, i) => value !== this.overlayData.camera[i])) {
      const worlds = (routeCount ? route.worlds : []).concat(this.overlays.points.map(point => point.world))
      const values = new Float32Array(worlds.length * 3)
      worlds.forEach((world, index) => {
        for (let axis = 0; axis < 3; ++axis) values[index * 3 + axis] = world[axis] - cameraPosition[axis]
      })
      const source = this.overlays, camera = Array.from(cameraPosition)
      try {
        this.stageResources('overlays', {bytes: values.byteLength, objects: 1}, resources => resources.buffer(gl.ARRAY_BUFFER, values), next => {
          if (this.overlays !== source) return false
          if (this.overlayBuffer) gl.deleteBuffer(this.overlayBuffer)
          this.overlayBuffer = next
          this.overlayData = {source, camera}
        })
      } catch (error) {
        this.onDiagnostic('webgl_allocation_failed', {message: error.message, error: error.glError})
      }
    }
  }

  renderOverlays(projectionView, cameraPosition) { return renderOverlays(this, projectionView, cameraPosition) }

  prepareMeshOutputs(packet) {
    if (!this.options.createMeshPartitionPlanTask || this.mode !== 'texture') return null
    if (!packet.imageryPlan) {
      if (!this.displaySurface || !this.presentation.cells.size) return null
      const shown = new Set(this.displaySurface.current.draws.map(geometryKey))
      if (packet.draws.every(draw => shown.has(geometryKey(draw)))) return null
    }
    if (this.meshOutputPlan) this.meshOutputPlan.release()
    return this.meshOutputPlan = new MeshOutputPlan(this, packet, geometryKey)
  }

  beginCandidateForecast() { this.textures.releaseDemand() }

  async admitCandidate(packet) {
    const imagery = this.textures.reserveCandidateDemand(packet.imageryPlan.draws)
    if (!imagery.valid) throw Object.assign(new Error('Candidate image destinations are not funded'),
      {status:9, capacityShortfallBytes:imagery.shortfallBytes})
    let plan, outputs
    try {
      plan = this.prepareMeshOutputs(packet)
      invariant(plan, 'Candidate UV admission is unavailable')
      outputs = await plan.admit(packet, 0)
      if (!outputs || !imagery.valid()) throw Object.assign(new Error('Candidate UV destinations are not funded'),
        {status:9, capacityShortfallBytes:plan.capacityShortfallBytes})
      const release = outputs.release
      const valid = outputs.valid
      outputs.valid = () => valid() && imagery.valid()
      outputs.release = () => { imagery.release(); release() }
      outputs.acceptImageryDemand = imagery.accept
      outputs.prepareImageryDemand = imagery.prepareAcceptance
      outputs.imageryDemand = () => plan.closed ? null : imagery.quote()
      return outputs
    } catch (error) {
      imagery.release()
      if (outputs) outputs.release()
      else if (plan) plan.release()
      throw error
    }
  }

  reserveMeshOutputs(packet, producerBytes) {
    if (this.destroyed || this.paused || this.contextLost) return null
    const generation = this.partitionGeneration
    const indexBytes = this.indices.quote(packet)
    const retiring = this.geometry.handoff(this.displaySurface ? this.displaySurface.current.draws : [], geometryKey)
    const outputs = this.geometry.reserveBatch(geometryRequests(packet.draws, geometryKey), producerBytes + indexBytes,
      'mesh-transfer', [], [], null, {retiring})
    if (!outputs) return null
    this.indices.fund(outputs, indexBytes)
    const valid = outputs.valid
    outputs.valid = () => !this.destroyed && !this.contextLost &&
      generation === this.partitionGeneration && valid()
    return outputs
  }

  enqueueGeometry(draws, outputs) {
    const wanted = new Set()
    const queued = new Map(this.uploadQueue.map(item => [item.key, item]))
    const additions = []
    const needed = (key, create) => {
      wanted.add(key)
      const reservation = outputs && outputs.take(key)
      if (queued.has(key) && reservation) queued.get(key).reservation = reservation
      if (this.geometry.has(key) || queued.has(key) || this.geometry.reservations.has(key) && !reservation) {
        if (reservation && !queued.has(key)) reservation.cancel()
        return
      }
      const item = Object.assign(create(), {key, reservation})
      additions.push(item); queued.set(key, item)
    }
    for (let index = 0; index < draws.length; ++index) {
      const draw = draws[index]
      const key = geometryKey(draw)
      draw.geometryKey = key
      const resource = this.current.meshResources.get(draw.resourceId)
      invariant(resource, 'Mesh resource is unavailable')
      const localPositions = resource.positions, localUv = resource.textureUv
      const uvKey = textureResourceKey(draw)
      needed(uvKey, () => ({kind: 'uv', resource: resource.uvResource || resource, uv: localUv}))
      needed(key, () => ({kind: 'mesh', uvKey, resourceId: draw.resourceId, resource,
        positions: localPositions, uv: localUv,
        model: resource.model || surfacePlan.prepareSurface(localPositions, localUv,
          this.current.indices, draw.firstIndex, draw.indexCount)}))
    }
    this.uploadQueue = this.uploadQueue.filter(item => {
      if (wanted.has(item.key)) return true
      if (item.reservation) item.reservation.cancel()
      item.releaseMesh()
      return false
    })
    additions.forEach(item => { item.releaseMesh = holdMeshes([item.resource]) })
    this.uploadQueue.push(...additions)
  }

  clearGeometryUploads() {
    this.uploadQueue.forEach(item => {
      if (item.reservation) item.reservation.cancel()
      item.releaseMesh()
    })
    this.uploadQueue = []
  }

  processUploads(uploadDeadline) {
    this.geometryBudgetLimited = false
    let waitingCoordinates = false
    const waiting = []
    const stagedCoordinates = new Map()
    let remaining = this.uploadQueue.length
    const deadline = uploadDeadline === undefined
      ? monotonicNow() + (this.options.uploadBudgetMs || 6) : uploadDeadline
    try { while (remaining-- > 0 && this.uploadQueue.length && monotonicNow() <= deadline) {
      const item = this.uploadQueue.shift()
      if (this.geometry.has(item.key)) {
        if (item.reservation) item.reservation.cancel()
        item.releaseMesh()
        continue
      }
      const coordinates = item.kind === 'uv'
      const residentUv = !coordinates && this.geometry.get(item.uvKey)
      const uv = coordinates ? null : residentUv || stagedCoordinates.get(item.uvKey)
      if (!coordinates && !uv) {
        waiting.push(item)
        waitingCoordinates = true
        continue // Stage bounded coordinate producers; resume these on receipt.
      }
      const bytes = coordinates ? item.uv.byteLength : item.positions.byteLength
      const work = this.uploadBatch && this.uploadBatch.budget
      if (work && !work.fits(bytes, 1)) {
        ++work.deferred
        this.uploadQueue.unshift(item)
        break
      }
      const reservation = item.reservation && item.reservation.valid() ? item.reservation
        : this.geometry.reserve(item.key, bytes)
      if (!reservation) {
        this.uploadQueue.unshift(item)
        this.geometryBudgetLimited = true
        break
      }
      item.reservation = reservation
      // A position upload may follow its UV in the same ordered submission.
      // Borrow the destination until that earlier upload actually publishes;
      // only then convert it to an owned resident dependency.
      let releaseUv = coordinates ? () => {} : residentUv
        ? this.geometry.holdCoordinates(item.uvKey, reservation.lease)
        : this.geometry.borrowReservation(item.uvKey, this.geometry.reservations.get(item.uvKey)).release
      invariant(releaseUv, 'Geometry upload lost its shared UV owner')
      const gl = this.gl
      const asset = {
        kind: coordinates ? 'uv' : 'mesh',
        key: item.key,
        resource: item.resource,
        releaseMesh: item.releaseMesh,
        releaseUv,
        positionBuffer: null,
        uvBuffer: uv && uv.uvBuffer,
        positions: item.positions,
        uv: item.uv,
        model: item.model,
        resourceId: item.resourceId || null,
        partitions: new Map()
      }
      const cancel = () => {
        asset.releaseUv()
        asset.releaseMesh.ownedBy(null)
        const wanted = coordinates ? this.current && this.current.draws.some(draw => textureResourceKey(draw) === item.key)
          : this.currentGeometryKeys().has(item.key)
        if (!this.contextLost && !this.destroyed && reservation.valid() && wanted) {
          this.uploadQueue.unshift(item)
        } else { reservation.cancel(); asset.releaseMesh() }
      }
      const accepted = this.stageResources('geometry', {bytes, objects: 1}, resources => {
        const buffers = coordinates ? {uvBuffer: resources.buffer(gl.ARRAY_BUFFER, item.uv)}
          : {positionBuffer: resources.buffer(gl.ARRAY_BUFFER, item.positions)}
        Object.assign(asset, buffers)
        return buffers
      }, () => {
        if (!coordinates && !residentUv) {
          if (this.geometry.get(item.uvKey) !== uv) { cancel(); return false }
          const owned = this.geometry.holdCoordinates(item.uvKey, reservation.lease)
          releaseUv(); asset.releaseUv = releaseUv = owned
        }
        asset.releaseMesh.ownedBy(reservation.lease)
        const committed = reservation.commit(asset)
        if (committed) {
          if (coordinates) this.geometry.ownCoordinates(item.key)
          this.geometryPublicationPending = true
          this.requestResources()
          this.resourceLedger.available()
        }
        if (!committed) { asset.releaseUv(); asset.releaseMesh() }
        return committed
      }, cancel, false)
      if (!accepted) break
      if (coordinates) stagedCoordinates.set(item.key, asset)
    } } finally { this.uploadQueue.unshift(...waiting) }
    if (!this.uploadBatch) this.ensureCurrentGeometryQueued()
    if (this.uploadQueue.length && !this.geometryBudgetLimited &&
        (!waitingCoordinates || this.uploadQueue.some(item => item.kind === 'uv'))) {
      this.requestResources()
    }
  }

  uploadIndexBuffer(indices) {
    if (this.gl) this.indices.activate(indices)
  }

  createFallbackTexture() {
    const gl = this.gl
    return this.allocateResources('fallback texture', resources => resources.texture(() => {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
        gl.UNSIGNED_BYTE, new Uint8Array([25, 68, 98, 255]))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }))
  }

  createAtmosphereTexture(atmosphere = this.atmosphere, publish) {
    const gl = this.gl
    const build = resources => resources.texture(() => {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA,
        atmosphere.width, atmosphere.height, 0, gl.RGBA,
        gl.UNSIGNED_BYTE, atmosphere.rgba)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }, atmosphere.rgba.byteLength)
    return publish ? this.stageResources('atmosphere texture', {bytes: atmosphere.rgba.byteLength, objects: 1}, build, publish) :
      this.allocateResources('atmosphere texture', build)
  }

  uploadTexture(image, width, height, publish, cancel) {
    const gl = this.gl
    return this.stageResources('imagery texture', {bytes: textureByteSize(width, height), objects: 1}, resources => resources.texture(() => {
      this.performanceStats.textureUploads += 1
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
    }, textureByteSize(width, height)), publish, cancel, false)
  }

  contextWasLost(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault()
    }
    if (this.contextLost) return
    this.contextLost = true
    this.coverageImages.clear()
    this.cameraSubmissionPriority.clear()
    this.textures.releaseDemand()
    this.cancelResourcesCallback()
    this.surfaceCommands.clear()
    if (this.visibility) this.visibility.destroy(true)
    this.visibility = null
    this.submitDraws(null)
    this.submissions.cancel(true)
    this.indices.clear(true)
    this.clearReplacement()
    this.partitionGeneration += 1
    this.clearPartitionWork()
    this.onContextChange({ lost: true })
  }

  contextWasRestored() {
    try {
      // The browser already destroyed these handles. Clearing CPU ownership
      // must not pass handles from the lost generation into the new context.
      this.geometry.clear()
      this.releaseRetiredGeometryBuffers()
      this.contextLost = false
      this.partitionBudgetLimited = false
      this.geometryBudgetLimited = false
      this.clearGeometryUploads()
      this.displaySurface = null
      this.syncMeasurementLoans()
      // GPU handles are lost, but the pinned image content and presentation
      // history are still valid. Release that history after uploads and the
      // corresponding partitions have been rebuilt and submitted.
      this.restoringPresentation = this.presentedTextures.size > 0
      this.presentedCameraVersion = -1
      this.initialize()
      this.textures.restoreContext()
      if (this.current) {
        this.enqueueGeometry(this.current.draws)
        this.updateGeometryPins()
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
    if (value && value.releaseUv) value.releaseUv()
    if (value && value.releaseMesh) value.releaseMesh()
    this.disposeGeometryBuffers(value)
  }

  releaseRetiredGeometryBuffers() {
    // Cancellation receipts may still borrow CPU geometry. Rendering and GPU
    // submissions have stopped; dispose these handles in their own context
    // generation, while leaving the reader's CPU lifetime intact.
    for (const entry of this.geometry.retained) this.disposeGeometryBuffers(entry.value)
  }

  disposeGeometryBuffers(value) {
    if (!value) return
    if (value.kind !== 'uv') this.releasePartitions(value)
    if (value.positionBuffer && this.gl && !this.contextLost) {
      this.gl.deleteBuffer(value.positionBuffer)
    }
    if (value.kind === 'uv' && value.uvBuffer && this.gl && !this.contextLost) {
      this.gl.deleteBuffer(value.uvBuffer)
    }
    value.positionBuffer = null
    if (value.kind === 'uv') value.uvBuffer = null
  }

  destroy() {
    this.coverageImages.clear()
    this.cameraSubmissionPriority.clear()
    this.cancelResourcesCallback()
    this.worldDisplay.clear()
    this.surfaceCommands.clear()
    if (this.visibility) this.visibility.destroy(this.contextLost)
    this.visibility = null
    this.heldCandidate = null
    this.destroyed = true
    this.measurements.clear()
    this.syncMeasurementLoans()
    if(this.measurementKernel)this.measurementKernel.close()
    if (this.releaseMemoryListener) this.releaseMemoryListener()
    this.submissions.cancel(this.contextLost)
    this.indices.clear(this.contextLost)
    this.clearReplacement()
    this.lastSubmittedSurface = null
    this.renderedSurface = null
    if (this.presentation) this.presentation.clear()
    this.partitionGeneration += 1
    this.clearPartitionWork()
    this.textures.destroy()
    this.geometry.clear()
    this.releaseRetiredGeometryBuffers()
    this.meshHolds.forEach(release => release())
    this.meshHolds.clear()
    this.clearGeometryUploads()
    if (this.canvas && typeof this.canvas.removeEventListener === 'function') {
      this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
      this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored)
    }
    if (this.gl) {
      if (this.overlayBuffer) {
        this.gl.deleteBuffer(this.overlayBuffer)
      }
      if (this.atmosphereBuffer) {
        this.gl.deleteBuffer(this.atmosphereBuffer)
      }
      if (this.atmosphereTexture) {
        this.gl.deleteTexture(this.atmosphereTexture)
      }
      if (this.atmosphereProgram) {
        this.gl.deleteProgram(this.atmosphereProgram)
      }
      if (this.fallbackTexture) {
        this.gl.deleteTexture(this.fallbackTexture)
      }
      for (const programs of this.surfacePrograms || []) {
        this.gl.deleteProgram(programs.program)
        if (programs.overlayProgram) this.gl.deleteProgram(programs.overlayProgram)
      }
    }
    this.gl = null
  }

  resetTimings() {
    for (const value of Object.values(this.performanceStats)) {
      if (value instanceof TimingSeries) value.reset()
    }
    this.performanceStats.lastFrameAt = 0
  }

  stats(exactTimings = false) { return rendererStats(this, exactTimings) }

}

module.exports = { TerraWebGlRenderer, geometryKey }
