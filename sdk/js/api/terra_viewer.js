const { ImageryAdapter, createTmsImagerySource, createWmtsImagerySource } = require('../imagery/terra_imagery_adapter')
const {
  clamp,
  finiteNumber,
  invariant,
  redactSensitiveText
} = require('../core/terra_globe_common')
const ground = require('../terrain/terra_ground')
const { TerraInteractionController } = require(
  '../interaction/terra_interaction_controller')
const { TerraCameraMotionController } = require('../camera/terra_camera_motion')

const MAXIMUM_POIS = 256
const MAXIMUM_ROUTE_POINTS = 2048
const DEGREES_TO_RADIANS = Math.PI / 180
const RADIANS_TO_DEGREES = 180 / Math.PI

class TerraViewerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TerraViewerError'
    this.code = code
  }
}

function viewerError(code, error) {
  if (error instanceof TerraViewerError) return error
  const message = redactSensitiveText(
    error && error.message ? error.message : String(error))
  return new TerraViewerError(code, message)
}

function viewerCall(code, callback) {
  try {
    return callback()
  } catch (error) {
    throw viewerError(code, error)
  }
}

function coordinate(value, name) {
  invariant(Array.isArray(value) && value.length >= 2 &&
    value.length <= 3, `${name} must contain two or three numbers`)
  return [
    finiteNumber(value[0], `${name} first coordinate`),
    finiteNumber(value[1], `${name} second coordinate`),
    value.length > 2 ? finiteNumber(value[2], `${name} height`) : 0
  ]
}

function globeWorld(value, radius) {
  const longitude = value[0] * DEGREES_TO_RADIANS
  const latitude = value[1] * DEGREES_TO_RADIANS
  const distance = radius + value[2]
  const cosineLatitude = Math.cos(latitude)
  return [
    distance * Math.sin(longitude) * cosineLatitude,
    distance * Math.sin(latitude),
    distance * Math.cos(longitude) * cosineLatitude
  ]
}

function planarWorld(value) {
  return [value[0], value[1], value[2]]
}

function worldForCoordinate(value, manifest) {
  return manifest.transform === 'cylindrical'
    ? globeWorld(value, manifest.radius)
    : planarWorld(value)
}

function projectWorld(world, frame, budget) {
  if (!frame || !frame.projectionView || !budget) {
    return { x: 0, y: 0, depth: 0, visible: false }
  }
  const matrix = frame.projectionView
  const clip = [0, 0, 0, 0]
  for (let row = 0; row < 4; ++row) {
    clip[row] = matrix[row * 4] * world[0] +
      matrix[row * 4 + 1] * world[1] +
      matrix[row * 4 + 2] * world[2] + matrix[row * 4 + 3]
  }
  if (!Number.isFinite(clip[3]) || clip[3] <= 0) {
    return { x: 0, y: 0, depth: 0, visible: false }
  }
  const x = clip[0] / clip[3]
  const y = clip[1] / clip[3]
  const z = clip[2] / clip[3]
  const dpr = Math.max(1, budget.devicePixelRatio || 1)
  const width = budget.physicalWidth / dpr
  const height = budget.physicalHeight / dpr
  return {
    x: (x + 1) * 0.5 * width,
    y: (1 - y) * 0.5 * height,
    depth: z,
    visible: x >= -1 && x <= 1 && y >= -1 && y <= 1 &&
      z >= -1 && z <= 1
  }
}

function globeFrontFacing(world, frame, radius) {
  const eye = frame && frame.cameraPosition
  return Boolean(eye) && world[0] * eye[0] + world[1] * eye[1] +
    world[2] * eye[2] > radius * radius
}

function stablePoiOrder(left, right) {
  return right.priority - left.priority || left.id.localeCompare(right.id)
}

function validatePoi(value, mode, ids) {
  invariant(value && typeof value === 'object', 'POI is required')
  invariant(typeof value.id === 'string' &&
    /^[A-Za-z0-9_.:-]{1,96}$/.test(value.id), 'POI ID is invalid')
  invariant(!ids.has(value.id), 'POI IDs must be unique')
  ids.add(value.id)
  const result = {
    id: value.id,
    coordinate: coordinate(value.coordinate, `POI ${value.id}`),
    altitudeMode: value.altitudeMode || 'absolute',
    icon: typeof value.icon === 'string' ? value.icon : 'default',
    priority: Number.isFinite(value.priority) ? value.priority : 0
  }
  invariant(result.altitudeMode === 'absolute' ||
    result.altitudeMode === 'surface', 'POI altitude mode is unsupported')
  if (mode === 'globe') {
    invariant(result.coordinate[0] >= -180 &&
      result.coordinate[0] <= 180 && result.coordinate[1] >= -90 &&
      result.coordinate[1] <= 90, 'POI coordinate is outside globe bounds')
  }
  return result
}

function validateRoute(value, mode) {
  invariant(value && typeof value === 'object', 'Route is required')
  invariant(typeof value.id === 'string' && value.id.length > 0,
    'Route ID is required')
  invariant(Array.isArray(value.coordinates) &&
    value.coordinates.length >= 2 &&
    value.coordinates.length <= MAXIMUM_ROUTE_POINTS,
  'Route must contain 2 to 2048 coordinates')
  const result = {
    id: value.id,
    coordinates: value.coordinates.map((item, index) =>
      coordinate(item, `Route coordinate ${index}`)),
    altitudeMode: value.altitudeMode || 'absolute',
    color: typeof value.color === 'string' ? value.color : '#2f7de1',
    widthPixels: clamp(Number(value.widthPixels) || 3, 1, 12),
    opacity: clamp(value.opacity === undefined ? 1 :
      finiteNumber(value.opacity, 'Route opacity'), 0, 1)
  }
  invariant(result.altitudeMode === 'absolute' ||
    result.altitudeMode === 'surface', 'Route altitude mode is unsupported')
  if (mode === 'globe') {
    result.coordinates.forEach((item) => invariant(
      item[0] >= -180 && item[0] <= 180 && item[1] >= -90 && item[1] <= 90,
      'Route coordinate is outside globe bounds'))
  }
  return result
}

function unitFromLonLat(value) {
  const world = globeWorld([value[0], value[1], 0], 1)
  return world
}

function lonLatFromUnit(value) {
  const length = Math.hypot(value[0], value[1], value[2]) || 1
  return [
    Math.atan2(value[0], value[2]) * RADIANS_TO_DEGREES,
    Math.asin(clamp(value[1] / length, -1, 1)) * RADIANS_TO_DEGREES
  ]
}

function subdivideGlobeRoute(coordinates) {
  const result = [coordinates[0]]
  for (let index = 1; index < coordinates.length; ++index) {
    const start = coordinates[index - 1]
    const end = coordinates[index]
    const left = unitFromLonLat(start)
    const right = unitFromLonLat(end)
    const dot = clamp(left[0] * right[0] + left[1] * right[1] +
      left[2] * right[2], -1, 1)
    const angle = Math.acos(dot)
    const pieces = Math.max(1, Math.ceil(angle / (2 * DEGREES_TO_RADIANS)))
    for (let part = 1; part <= pieces; ++part) {
      const t = part / pieces
      let unit
      if (angle < 0.000001) {
        unit = left.map((value, axis) => value + (right[axis] - value) * t)
      } else {
        const denominator = Math.sin(angle)
        const a = Math.sin((1 - t) * angle) / denominator
        const b = Math.sin(t * angle) / denominator
        unit = left.map((value, axis) => value * a + right[axis] * b)
      }
      const horizontal = lonLatFromUnit(unit)
      result.push([horizontal[0], horizontal[1],
        start[2] + (end[2] - start[2]) * t])
    }
  }
  return result
}

class EventHub {
  constructor() {
    this.listeners = new Map()
  }

  on(type, listener) {
    invariant(typeof listener === 'function', 'Event listener is required')
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
    return listener
  }

  off(type, listener) {
    const listeners = this.listeners.get(type)
    return listeners ? listeners.delete(listener) : false
  }

  emit(type, detail) {
    const listeners = this.listeners.get(type)
    if (listeners) listeners.forEach((listener) => listener(detail))
  }

  clear() {
    this.listeners.clear()
  }
}

class TerraViewer {
  constructor(runtime, options) {
    this.runtime = runtime
    this.options = options || {}
    this.mode = runtime.manifest.transform === 'planar' ? 'planar' : 'globe'
    this.events = new EventHub()
    this.pois = []
    this.route = null
    const imagery = this.options.imagery || null
    this.imagerySource = imagery ? {
      id: imagery.id || imagery.textureId || runtime.manifest.texture.id,
      attribution: typeof imagery.attribution === 'string'
        ? imagery.attribution : ''
    } : null
    this.projectedPois = []
    this.surfaceCache = null
    this.surfaceRevision = 0
    this.lastFeaturePositions = new Map()
    this.overlaySignature = ''
    this.paused = false
    this.destroyed = false
    this.qualityActivity = { interaction: false, motion: false }
    this.motionController = this.mode === 'globe'
      ? new TerraCameraMotionController({
        getView: () => this.runtime.getView(),
        setView: (view) => this.runtime.setView(view)
      }, Object.assign({}, this.options.cameraMotion, {
        requestFrame: callback => this.runtime.frameClock.request('animation', callback),
        cancelFrame: handle => this.runtime.frameClock.cancel(handle),
        now: () => this.runtime.frameClock.now(),
        radius: this.runtime.manifest.radius,
        verticalFovRadians: this.runtime.fovRadians,
        onState: (state) => {
          this.setQualityActivity('motion', state.mode !== 'idle')
          this.events.emit('cameramotion', state)
        }
      }))
      : null
    this.camera = this.createCameraFacade()
    const interactionOptions = Object.assign({}, this.options.interaction, {
      requestFrame: callback => this.runtime.frameClock.request('input', callback),
      cancelFrame: handle => this.runtime.frameClock.cancel(handle),
      now: () => this.runtime.frameClock.now()
    })
    this.interactionController = new TerraInteractionController(this.camera,
      Object.assign(interactionOptions, {
      rotateEnabled: !this.options.interaction ||
        this.options.interaction.rotateEnabled !== false,
      tiltEnabled: !this.options.interaction ||
        this.options.interaction.tiltEnabled !== false,
      inertiaEnabled: !this.options.interaction ||
        this.options.interaction.inertiaEnabled !== false,
      onEvent: (type, detail) => {
        if (type === 'interactionstart') {
          this.setQualityActivity('interaction', true)
        } else if (type === 'camerasettle') {
          this.setQualityActivity('interaction', false)
        }
        this.events.emit(type, Object.assign({
          view: this.camera.getView()
        }, detail))
      },
      onTap: (point) => this.handleTap(point)
      }))
    this.interaction = {
      begin: (packet) => viewerCall('invalid_interaction', () =>
        this.interactionController.begin(packet)),
      update: (packet) => viewerCall('invalid_interaction', () =>
        this.interactionController.update(packet)),
      end: (packet) => viewerCall('invalid_interaction', () =>
        this.interactionController.end(packet)),
      cancel: () => this.interactionController.cancel(),
      setOptions: (value) => viewerCall('invalid_interaction', () =>
        this.interactionController.setOptions(value))
    }
    this.imagery = {
      setSource: (source) => this.setImagerySource(source)
    }
    this.environment = {
      getAtmosphere: () => this.runtime.getAtmosphere(),
      setAtmosphere: (options) => viewerCall(
        'invalid_atmosphere_options', () =>
          this.runtime.setAtmosphere(options))
    }
    this.diagnostics = {
      snapshot: () => this.runtime.diagnosticsSnapshot(),
      reset: () => this.runtime.resetDiagnostics()
    }
    this.debug = {
      setRendering: (options) => viewerCall('invalid_debug_options', () =>
        this.runtime.setDebugRendering(options))
    }
  }

  static async create(options) {
    try {
      return await this.createUnchecked(options)
    } catch (error) {
      throw viewerError('initialization_failed', error)
    }
  }

  static async createUnchecked(options) {
    const value = options || {}
    invariant(value.mode === 'globe' || value.mode === 'planar',
      'Viewer mode must be globe or planar')
    let viewer = null
    invariant(typeof value.createRuntime === 'function', 'Viewer runtime factory is required')
    const runtimeOptions = Object.assign({}, value, {
      manifest: value.dataset || value.manifest,
      onState(state) {
        if (viewer) viewer.handleRuntimeState(state)
        if (typeof value.onState === 'function') value.onState(state)
      },
      onCameraEvent(type, detail) {
        if (viewer) viewer.events.emit(type, detail)
      }
    })
    const runtime = await value.createRuntime(runtimeOptions)
    viewer = new this(runtime, value)
    if (value.initialView) viewer.camera.setView(value.initialView)
    viewer.handleRuntimeState(runtime.state())
    return viewer
  }

  setQualityActivity(source, active) {
    this.qualityActivity[source] = Boolean(active)
    if (typeof this.runtime.setInteractionActive === 'function') {
      this.runtime.setInteractionActive(
        this.qualityActivity.interaction || this.qualityActivity.motion)
    }
  }

  createCameraFacade() {
    const cancelMotion = () => {
      if (this.motionController) this.motionController.stop('interaction')
    }
    const startMotion = (callback) => {
      invariant(this.motionController,
        'Camera motion is only available in globe mode')
      this.runtime.cancelAnimation()
      invariant(this.runtime.getView().schema !== 'terra.eye-view.v1',
        'Orbit motions require an orbit view; use camera.setView to select it')
      return callback()
    }
    return {
      getView: () => viewerCall('camera_failed', () => this.runtime.getView()),
      getTerrainState: () => viewerCall('camera_failed', () => this.runtime.getTerrainState()),
      retryTerrain: () => viewerCall('camera_failed', () => this.runtime.retryTerrain()),
      walkBy: async change => {
        try {
          cancelMotion(); this.runtime.cancelAnimation()
          return await this.runtime.walkController.start(change)
        } catch (cause) { throw viewerError(cause.code || 'camera_walk_failed', cause) }
      },
      stopWalking: () => this.runtime.walkController.cancel(),
      getWalkState: () => this.runtime.walkController.state(),
      setView: (view, options) => viewerCall('invalid_view', () => {
        cancelMotion()
        return this.runtime.setView(view, options)
      }),
      panBy: (change) => viewerCall('invalid_camera_change', () => {
        cancelMotion()
        return this.runtime.panBy(change)
      }),
      zoomBy: (scale, options) => viewerCall('invalid_camera_change', () => {
        cancelMotion()
        return this.runtime.zoomBy(scale, options)
      }),
      orbitBy: (change) => viewerCall('invalid_camera_change', () => {
        cancelMotion()
        return this.runtime.orbitBy(change)
      }),
      setTilt: (value) => viewerCall('invalid_camera_change', () => {
        cancelMotion()
        return this.runtime.setTilt(value)
      }),
      topDown: () => viewerCall('camera_failed', () => {
        cancelMotion()
        return this.runtime.topDown()
      }),
      northUp: () => viewerCall('camera_failed', () => {
        cancelMotion()
        return this.runtime.northUp()
      }),
      reset: () => viewerCall('camera_failed', () => {
        cancelMotion()
        return this.runtime.reset()
      }),
      showGlobe: (options) => viewerCall('invalid_camera_motion', () =>
        startMotion(() => {
          const target = this.runtime.options.initialTarget || {
            longitudeDegrees: 0,
            latitudeDegrees: 0
          }
          return this.motionController.flyTo([
            target.longitudeDegrees,
            target.latitudeDegrees,
            0
          ], Object.assign({
            rangeMeters: this.runtime.manifest.radius * 1.5,
            tiltDegrees: 0,
            headingDegrees: 0,
            path: 'auto'
          }, options || {}))
        })),
      cancelAnimation: () => {
        cancelMotion()
        if (this.runtime.walkController) this.runtime.walkController.cancel()
        return this.runtime.cancelAnimation()
      },
      applyInteraction: (change) => viewerCall('invalid_interaction', () => {
        cancelMotion()
        return this.runtime.applyInteraction(change)
      }),
      flyTo: (coordinate, options) => viewerCall('invalid_camera_motion', () =>
        startMotion(() => this.motionController.flyTo(coordinate, options))),
      startOrbit: (coordinate, options) => viewerCall(
        'invalid_camera_motion', () => startMotion(() =>
          this.motionController.startOrbit(coordinate, options))),
      playRoute: (coordinates, options) => viewerCall(
        'invalid_camera_motion', () => startMotion(() =>
          this.motionController.playRoute(coordinates, options))),
      pauseMotion: () => this.motionController
        ? this.motionController.pause() : false,
      resumeMotion: () => this.motionController
        ? this.motionController.resume() : false,
      stopMotion: () => this.motionController
        ? this.motionController.stop('stopped') : false,
      getMotionState: () => this.motionController
        ? this.motionController.state() : null
    }
  }

  setImagerySource(source) {
    return viewerCall('invalid_imagery_source', () =>
      this.applyImagerySource(source))
  }

  applyImagerySource(source) {
    invariant(source && typeof source.id === 'string' &&
      source.id.length > 0 && typeof source.resolveTile === 'function',
    'Imagery source ID and resolver are required')
    const expectedSchemes = this.mode === 'globe'
      ? ['global-geodetic'] : ['planar-tms', 'planar-single']
    invariant(!source.tileScheme ||
      expectedSchemes.indexOf(source.tileScheme) >= 0,
    'Imagery tile scheme is incompatible with viewer mode')
    const maximumLevel = source.maximumLevel === undefined
      ? this.runtime.manifest.texture.maximum_level : source.maximumLevel
    const minimumLevel = source.minimumLevel === undefined
      ? 0 : source.minimumLevel
    const matrixLevelOffset = source.matrixLevelOffset === undefined
      ? 0 : source.matrixLevelOffset
    invariant(Number.isInteger(minimumLevel) && minimumLevel >= 0 &&
      Number.isInteger(maximumLevel) && maximumLevel >= minimumLevel &&
      maximumLevel <= 28, 'Imagery level range is invalid')
    invariant(minimumLevel === 0,
      'Imagery minimum level must be zero')
    invariant(Number.isInteger(matrixLevelOffset) &&
      matrixLevelOffset >= 0 && matrixLevelOffset <= 28,
    'Imagery matrix level offset is invalid')
    if (this.mode === 'planar' && source.tileScheme === 'planar-single') {
      invariant(minimumLevel === 0 && maximumLevel === 0,
        'Planar single imagery only supports level zero')
    }
    const nextTexture = Object.assign({}, this.runtime.manifest.texture, source.texture || {}, {
      id: source.id, matrix_level_offset: matrixLevelOffset, maximum_level: maximumLevel})
    invariant(expectedSchemes.includes(nextTexture.kind), 'Imagery coordinate model does not match terrain')
    const terrain = this.runtime.manifest
    invariant(this.mode === 'globe' || JSON.stringify(nextTexture.bounds) ===
      JSON.stringify([[terrain.minimumU, terrain.minimumV], [terrain.maximumU, terrain.maximumV]]),
    'Planar imagery must align with the terrain extent')
    new ImageryAdapter(nextTexture)
    this.imagerySource = {id: source.id, attribution: source.attribution || ''}
    this.runtime.manifest.texture = nextTexture
    this.runtime.textureUrlResolver = source.resolveTile
    this.runtime.manifest.texture.id = source.id
    this.runtime.manifest.texture.matrix_level_offset = matrixLevelOffset
    if (source.tileScheme) {
      this.runtime.manifest.texture.kind = source.tileScheme
    }
    this.runtime.manifest.texture.maximum_level = maximumLevel
    this.runtime.imageryRevision = (this.runtime.imageryRevision || 0) + 1
    if (this.runtime.synchronizeCameraRevision) this.runtime.synchronizeCameraRevision()
    if (this.runtime.renderer &&
      typeof this.runtime.renderer.setImagerySource === 'function') {
      this.runtime.renderer.setImagerySource(
        this.runtime.manifest.texture, tile => this.runtime.textureUrl(tile))
    } else if (this.runtime.renderer && this.runtime.renderer.textures) {
      this.runtime.renderer.textures.clear()
    }
    this.runtime.refresh()
  }

  setPois(values) {
    return viewerCall('invalid_pois', () => {
      invariant(Array.isArray(values) && values.length <= MAXIMUM_POIS,
        'POIs must contain at most 256 entries')
      const ids = new Set()
      const next = values.map((value) => validatePoi(value, this.mode, ids))
        .sort(stablePoiOrder)
      this.resetFeaturePositions(new Set(next.map((poi) => poi.id)))
      this.pois = next
      this.updateFeatures()
    })
  }

  clearPois() {
    this.resetFeaturePositions(new Set())
    this.pois = []
    this.projectedPois = []
    this.updateRendererOverlays()
  }

  setRoute(value) {
    return viewerCall('invalid_route', () => {
      this.route = validateRoute(value, this.mode)
      this.updateFeatures()
    })
  }

  clearRoute() {
    this.route = null
    this.updateRendererOverlays()
  }

  async queryTerrain(value, options) {
    const input = viewerCall('invalid_coordinate', () => coordinate(value, 'Terrain coordinate'))
    try {
      invariant(!this.destroyed, 'Viewer is destroyed')
      return await this.runtime.queryTerrain(input[0], input[1], options)
    } catch (error) { throw viewerError(error.code || 'terrain_query_failed', error) }
  }

  async sampleTerrain(value) {
    const input = viewerCall('invalid_coordinate', () => coordinate(value, 'Terrain coordinate'))
    try {
      invariant(!this.destroyed, 'Viewer is destroyed')
      return await this.runtime.sampleTerrain(input[0], input[1])
    } catch (error) { throw viewerError('terrain_query_failed', error) }
  }

  sampleRenderedSurface(value) {
    if (this.destroyed) throw new TerraViewerError('surface_query_failed', 'Viewer is destroyed')
    return viewerCall('invalid_coordinate', () => {
      const input = coordinate(value, 'Surface coordinate')
      if (this.mode === 'globe') invariant(input[0] >= -180 && input[0] <= 180 &&
        input[1] >= -90 && input[1] <= 90, 'Surface coordinate is outside globe bounds')
      const surface = this.runtime.renderedSurface
      if (!this.surfaceCache || this.surfaceCache.surface !== surface) {
        this.surfaceCache = {surface, samples: new Map()}
      }
      const key = `${input[0]},${input[1]}`
      let height = this.surfaceCache.samples.get(key)
      if (height === undefined) {
        height = ground.surfaceHeight(surface, input,
          this.mode === 'globe' ? this.runtime.manifest.radius : 0)
        if (this.surfaceCache.samples.size >= MAXIMUM_ROUTE_POINTS + MAXIMUM_POIS) {
          this.surfaceCache.samples.clear()
        }
        this.surfaceCache.samples.set(key, height)
      }
      return {status: height === null ? 'unavailable' : 'approximate',
        heightMeters: height, revision: this.runtime.renderedSurfaceRevision}
    })
  }

  resolvedCoordinate(value, altitudeMode) {
    const result = value.slice()
    if (altitudeMode === 'surface') {
      const sample = this.sampleRenderedSurface(result)
      if (sample.status === 'unavailable') return { coordinate: result, sample }
      result[2] = sample.heightMeters + result[2]
      return { coordinate: result, sample }
    }
    return {
      coordinate: result,
      sample: { status: 'ready', heightMeters: result[2], revision: 0 }
    }
  }

  project(value) {
    return viewerCall('invalid_coordinate', () => this.projectUnchecked(value))
  }

  projectUnchecked(value) {
    const input = coordinate(value, 'Projected coordinate')
    const world = worldForCoordinate(input, this.runtime.manifest)
    const projected = projectWorld(world, this.runtime.lastFrame,
      this.runtime.budget)
    if (this.mode === 'globe' && projected.visible) {
      projected.visible = globeFrontFacing(world, this.runtime.lastFrame,
        this.runtime.manifest.radius)
    }
    return projected
  }

  updateFeatures() {
    if (this.destroyed) return
    this.projectedPois = this.pois.map((poi) => {
      const resolved = this.resolvedCoordinate(poi.coordinate, poi.altitudeMode)
      const screen = this.project(resolved.coordinate)
      return Object.assign({}, poi, {
        resolvedCoordinate: resolved.coordinate,
        surfaceStatus: resolved.sample.status,
        screenPoint: { x: screen.x, y: screen.y },
        visible: screen.visible,
        world: worldForCoordinate(resolved.coordinate, this.runtime.manifest)
      })
    })
    this.emitFeaturePositions()
    this.updateRendererOverlays()
  }

  emitFeaturePositions() {
    this.projectedPois.forEach((poi) => {
      const current = {
        featureId: poi.id,
        screenPoint: poi.screenPoint,
        visible: poi.visible
      }
      const previous = this.lastFeaturePositions.get(poi.id)
      if (!previous || previous.visible !== current.visible ||
        Math.abs(previous.screenPoint.x - current.screenPoint.x) > 0.5 ||
        Math.abs(previous.screenPoint.y - current.screenPoint.y) > 0.5) {
        this.events.emit('featureposition', current)
        this.lastFeaturePositions.set(poi.id, current)
      }
    })
  }

  resetFeaturePositions(nextIds) {
    this.lastFeaturePositions.forEach((previous, id) => {
      if (!nextIds.has(id)) {
        this.events.emit('featureposition', {
          featureId: id,
          screenPoint: previous.screenPoint,
          visible: false
        })
      }
    })
    this.lastFeaturePositions.clear()
  }

  routeCoordinates() {
    if (!this.route) return []
    const source = this.mode === 'globe'
      ? subdivideGlobeRoute(this.route.coordinates)
      : this.route.coordinates
    return source.map((value) =>
      this.resolvedCoordinate(value, this.route.altitudeMode).coordinate)
  }

  updateRendererOverlays() {
    const renderer = this.runtime.renderer
    if (!renderer || typeof renderer.setOverlays !== 'function') return
    const overlays = {
      points: this.projectedPois.filter((poi) => poi.visible).map((poi) => ({
        id: poi.id,
        world: poi.world,
        priority: poi.priority,
        icon: poi.icon
      })),
      route: this.route && {
        worlds: this.routeCoordinates().map((value) =>
          worldForCoordinate(value, this.runtime.manifest)),
        color: this.route.color,
        opacity: this.route.opacity,
        widthPixels: this.route.widthPixels
      }
    }
    const signature = JSON.stringify(overlays)
    if (signature !== this.overlaySignature) {
      this.overlaySignature = signature
      renderer.setOverlays(overlays)
    }
  }

  pickPoi(point) {
    return viewerCall('invalid_screen_point', () =>
      this.pickPoiUnchecked(point))
  }

  pickPoiUnchecked(point) {
    invariant(point && Number.isFinite(point.x) &&
      Number.isFinite(point.y), 'Pick point is invalid')
    const radius = 24
    return this.projectedPois.filter((poi) => poi.visible).map((poi) => ({
      poi,
      distance: Math.hypot(poi.screenPoint.x - point.x,
        poi.screenPoint.y - point.y)
    })).filter((item) => item.distance <= radius).sort((left, right) =>
      left.distance - right.distance || stablePoiOrder(left.poi, right.poi))
      .map((item) => ({
        featureId: item.poi.id,
        coordinate: item.poi.resolvedCoordinate.slice(),
        screenPoint: Object.assign({}, item.poi.screenPoint)
      }))[0] || null
  }

  handleTap(point) {
    const feature = this.pickPoi(point)
    if (feature) this.events.emit('featureclick', feature)
  }

  getRouteView(options) {
    return viewerCall('route_unavailable', () =>
      this.getRouteViewUnchecked(options))
  }

  getRouteViewUnchecked(options) {
    invariant(this.route, 'Route is not set')
    const padding = options && options.paddingPixels !== undefined
      ? finiteNumber(options.paddingPixels, 'Route padding') : 24
    invariant(padding >= 0, 'Route padding must be non-negative')
    const current = this.camera.getView()
    if (this.mode === 'planar') {
      const xs = this.route.coordinates.map((item) => item[0])
      const ys = this.route.coordinates.map((item) => item[1])
      const width = Math.max(1, Math.max.apply(null, xs) - Math.min.apply(null, xs))
      const height = Math.max(1, Math.max.apply(null, ys) - Math.min.apply(null, ys))
      const distance = 0.7 * Math.max(width, height) /
        Math.tan(this.runtime.fovRadians / 2)
      current.target = {
        x: 0.5 * (Math.min.apply(null, xs) + Math.max.apply(null, xs)),
        y: 0.5 * (Math.min.apply(null, ys) + Math.max.apply(null, ys)),
        heightMeters: 0
      }
      const limits = this.runtime.rangeLimits()
      current.rangeMeters = clamp(distance * (1 + padding / 100),
        limits.minimum, limits.maximum)
    } else {
      const units = this.route.coordinates.map(unitFromLonLat)
      const sum = units.reduce((result, value) => [
        result[0] + value[0], result[1] + value[1], result[2] + value[2]
      ], [0, 0, 0])
      const center = lonLatFromUnit(sum)
      const centerUnit = unitFromLonLat(center)
      let maximumAngle = 0
      units.forEach((value) => {
        maximumAngle = Math.max(maximumAngle, Math.acos(clamp(
          centerUnit[0] * value[0] + centerUnit[1] * value[1] +
          centerUnit[2] * value[2], -1, 1)))
      })
      current.target = {
        longitudeDegrees: center[0], latitudeDegrees: center[1], heightMeters: 0
      }
      const limits = this.runtime.rangeLimits()
      const altitude = this.runtime.manifest.radius * maximumAngle /
        Math.tan(this.runtime.fovRadians / 2)
      current.rangeMeters = clamp(altitude * (1 + padding / 100), limits.minimum, limits.maximum)
    }
    current.headingDegrees = 0
    current.tiltDegrees = 0
    return this.runtime.normalizeView(current)
  }

  handleRuntimeState(state) {
    const previousRevision = this.surfaceRevision
    const nextRevision = this.runtime.renderedSurfaceRevision
    if (nextRevision === previousRevision) {
      return
    }
    this.surfaceRevision = nextRevision
    this.surfaceCache = null
    this.updateFeatures()
    if (previousRevision && previousRevision !== this.surfaceRevision &&
      (this.pois.some((poi) => poi.altitudeMode === 'surface') ||
       (this.route && this.route.altitudeMode === 'surface'))) {
      this.events.emit('surfacechange', { revision: this.surfaceRevision })
    }
  }

  getState() {
    return Object.assign({}, this.runtime.state(), {
      schema: 'terra.viewer-state.v1',
      mode: this.mode,
      featureCount: this.pois.length,
      routeId: this.route && this.route.id,
      imageryAttribution: this.imagerySource
        ? this.imagerySource.attribution : '',
      cameraMotion: this.motionController
        ? this.motionController.state() : null,
      paused: this.paused
    })
  }

  on(type, listener) {
    return viewerCall('invalid_listener', () => this.events.on(type, listener))
  }
  off(type, listener) {
    return viewerCall('invalid_listener', () => this.events.off(type, listener))
  }
  resize(viewport) {
    return viewerCall('invalid_viewport', () => {
      this.interaction.cancel()
      this.runtime.resize(viewport)
    })
  }
  pause() {
    this.paused = true
    this.interaction.cancel()
    this.camera.cancelAnimation()
    if (typeof this.runtime.pause === 'function') this.runtime.pause()
  }
  resume() {
    this.paused = false
    if (typeof this.runtime.resume === 'function') {
      this.runtime.resume()
    } else {
      this.runtime.scheduleRender()
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.surfaceCache = null
    this.interactionController.destroy()
    if (this.motionController) this.motionController.destroy()
    this.events.clear()
    this.runtime.destroy()
  }
}

module.exports = {
  createTmsImagerySource,
  createWmtsImagerySource,
  MAXIMUM_POIS,
  MAXIMUM_ROUTE_POINTS,
  TerraViewer,
  TerraViewerError,
  globeFrontFacing,
  globeWorld,
  projectWorld,
  subdivideGlobeRoute,
  validatePoi,
  validateRoute,
  worldForCoordinate
}
