const common = require('./terra_globe_common')

const DEGREES_TO_RADIANS = Math.PI / 180
const RADIANS_TO_DEGREES = 180 / Math.PI

function wrapDegrees(value) {
  let result = value % 360
  if (result > 180) result -= 360
  if (result <= -180) result += 360
  return result
}

function smoothstep(value) {
  const t = common.clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

function globeCoordinate(value, name) {
  common.invariant(Array.isArray(value) && value.length >= 2,
    `${name} must contain longitude and latitude`)
  const longitude = common.finiteNumber(value[0], `${name} longitude`)
  const latitude = common.finiteNumber(value[1], `${name} latitude`)
  const height = value.length > 2
    ? common.finiteNumber(value[2], `${name} height`) : 0
  common.invariant(longitude >= -180 && longitude <= 180 &&
    latitude >= -90 && latitude <= 90, `${name} is outside globe bounds`)
  return [longitude, latitude, height]
}

function cameraRange(value, radius, name) {
  const range = common.finiteNumber(value, name)
  common.invariant(range >= radius * 1.001 && range <= radius * 20,
    `${name} is outside globe limits`)
  return range
}

function cameraTilt(value, name) {
  const tilt = common.finiteNumber(value, name)
  common.invariant(tilt >= 0 && tilt <= 80,
    `${name} is outside [0, 80]`)
  return tilt
}

function unitFromCoordinate(value) {
  const longitude = value[0] * DEGREES_TO_RADIANS
  const latitude = value[1] * DEGREES_TO_RADIANS
  const cosineLatitude = Math.cos(latitude)
  return [
    Math.sin(longitude) * cosineLatitude,
    Math.sin(latitude),
    Math.cos(longitude) * cosineLatitude
  ]
}

function coordinateFromUnit(value, height) {
  const length = Math.hypot(value[0], value[1], value[2]) || 1
  return [
    Math.atan2(value[0], value[2]) * RADIANS_TO_DEGREES,
    Math.asin(common.clamp(value[1] / length, -1, 1)) *
      RADIANS_TO_DEGREES,
    height
  ]
}

function angularDistance(left, right) {
  const a = unitFromCoordinate(left)
  const b = unitFromCoordinate(right)
  return Math.acos(common.clamp(
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1))
}

function normalized(value) {
  const length = Math.hypot(value[0], value[1], value[2]) || 1
  return value.map((component) => component / length)
}

function interpolateCoordinate(left, right, value) {
  const t = common.clamp(value, 0, 1)
  const a = unitFromCoordinate(left)
  const b = unitFromCoordinate(right)
  const angle = angularDistance(left, right)
  let unit
  if (t === 0) return left.slice()
  if (t === 1) return right.slice()
  if (angle < 0.000001) {
    unit = a.map((component, index) =>
      component + (b[index] - component) * t)
  } else if (Math.abs(Math.sin(angle)) < 0.000001) {
    const reference = Math.abs(a[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]
    const perpendicular = normalized([
      a[1] * reference[2] - a[2] * reference[1],
      a[2] * reference[0] - a[0] * reference[2],
      a[0] * reference[1] - a[1] * reference[0]
    ])
    unit = a.map((component, index) =>
      component * Math.cos(Math.PI * t) +
      perpendicular[index] * Math.sin(Math.PI * t))
  } else {
    const denominator = Math.sin(angle)
    const first = Math.sin((1 - t) * angle) / denominator
    const second = Math.sin(t * angle) / denominator
    unit = a.map((component, index) =>
      component * first + b[index] * second)
  }
  return coordinateFromUnit(unit, left[2] + (right[2] - left[2]) * t)
}

function bearingDegrees(left, right) {
  const startLongitude = left[0] * DEGREES_TO_RADIANS
  const endLongitude = right[0] * DEGREES_TO_RADIANS
  const startLatitude = left[1] * DEGREES_TO_RADIANS
  const endLatitude = right[1] * DEGREES_TO_RADIANS
  const deltaLongitude = endLongitude - startLongitude
  const y = Math.sin(deltaLongitude) * Math.cos(endLatitude)
  const x = Math.cos(startLatitude) * Math.sin(endLatitude) -
    Math.sin(startLatitude) * Math.cos(endLatitude) *
      Math.cos(deltaLongitude)
  return wrapDegrees(Math.atan2(y, x) * RADIANS_TO_DEGREES)
}

function routeMetrics(values, radius) {
  const coordinates = values.map((value, index) =>
    globeCoordinate(value, `Route coordinate ${index}`))
  common.invariant(coordinates.length >= 2,
    'Camera route must contain at least two coordinates')
  const cumulative = [0]
  for (let index = 1; index < coordinates.length; ++index) {
    cumulative.push(cumulative[index - 1] +
      angularDistance(coordinates[index - 1], coordinates[index]) * radius)
  }
  common.invariant(cumulative[cumulative.length - 1] > 0,
    'Camera route must have positive length')
  return {
    coordinates,
    cumulative,
    totalDistanceMeters: cumulative[cumulative.length - 1]
  }
}

function coordinateAtDistance(route, distance) {
  const value = common.clamp(distance, 0, route.totalDistanceMeters)
  let index = 1
  while (index < route.cumulative.length && route.cumulative[index] < value) {
    index += 1
  }
  if (index >= route.coordinates.length) {
    return route.coordinates[route.coordinates.length - 1].slice()
  }
  const startDistance = route.cumulative[index - 1]
  const segmentLength = route.cumulative[index] - startDistance
  const t = segmentLength > 0 ? (value - startDistance) / segmentLength : 1
  return interpolateCoordinate(route.coordinates[index - 1],
    route.coordinates[index], t)
}

function defaultRequestFrame(callback) {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback)
  }
  return setTimeout(callback, 16)
}

function defaultCancelFrame(id) {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(id)
  } else {
    clearTimeout(id)
  }
}

function defaultNow() {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function' ? performance.now() : Date.now()
}

class TerraCameraMotionController {
  constructor(camera, options) {
    const value = options || {}
    common.invariant(camera && typeof camera.getView === 'function' &&
      typeof camera.setView === 'function',
    'Camera motion controller requires getView and setView')
    this.camera = camera
    this.radius = common.finiteNumber(value.radius, 'Globe radius')
    common.invariant(this.radius > 0, 'Globe radius must be positive')
    this.verticalFovRadians = value.verticalFovRadians === undefined
      ? 45 * DEGREES_TO_RADIANS
      : common.finiteNumber(value.verticalFovRadians, 'Vertical field of view')
    common.invariant(this.verticalFovRadians > 0 &&
      this.verticalFovRadians < Math.PI,
    'Vertical field of view must be in (0, PI)')
    this.requestFrame = value.requestFrame || defaultRequestFrame
    this.cancelFrame = value.cancelFrame || defaultCancelFrame
    this.now = value.now || defaultNow
    this.onState = typeof value.onState === 'function' ? value.onState : null
    this.motion = null
    this.frameId = null
    this.destroyed = false
    this.lastState = {
      schema: 'terra.camera-motion-state.v1',
      mode: 'idle',
      progress: 0,
      paused: false,
      reason: 'initialized'
    }
  }

  state() {
    return Object.assign({}, this.lastState)
  }

  publish(mode, progress, paused, reason, detail) {
    this.lastState = Object.assign({
      schema: 'terra.camera-motion-state.v1',
      mode,
      progress: common.clamp(progress || 0, 0, 1),
      paused: Boolean(paused),
      reason: reason || ''
    }, detail || {})
    if (this.onState) this.onState(this.state())
  }

  schedule() {
    if (!this.motion || this.frameId !== null || this.motion.paused) return
    this.frameId = this.requestFrame(() => {
      this.frameId = null
      this.tick()
    })
  }

  tick() {
    if (!this.motion || this.motion.paused) return
    const current = this.now()
    if (this.motion.startedAt === null) {
      this.motion.startedAt = current
      this.motion.previousAt = current
    }
    const elapsed = Math.max(0, current - this.motion.startedAt)
    const delta = Math.max(0, current - this.motion.previousAt)
    this.motion.previousAt = current
    const result = this.motion.step(elapsed, delta) || {}
    this.publish(this.motion.mode, result.progress || 0, false, '',
      Object.assign({}, this.motion.detail, result.detail || {}))
    if (result.complete) {
      const mode = this.motion.mode
      this.motion = null
      this.publish('idle', 1, false, `${mode}_complete`,
        Object.assign({}, this.lastState, { mode: 'idle', progress: 1,
          paused: false, reason: `${mode}_complete`, phase: '' }))
      return
    }
    this.schedule()
  }

  start(mode, step, detail) {
    common.invariant(!this.destroyed,
      'Camera motion controller is destroyed')
    this.stop('replaced')
    this.motion = {
      mode,
      step,
      startedAt: null,
      previousAt: null,
      paused: false,
      pausedAt: null,
      detail: detail || {}
    }
    this.publish(mode, 0, false, 'started', detail)
    this.schedule()
  }

  flyTo(value, options) {
    const coordinate = globeCoordinate(value, 'Fly-to target')
    const settings = options || {}
    const start = this.camera.getView()
    const startCoordinate = [
      start.target.longitudeDegrees,
      start.target.latitudeDegrees,
      start.target.heightMeters || 0
    ]
    const minimumHeight = this.radius * 0.001
    const focusHeight = Math.max(minimumHeight,
      settings.heightAboveTargetMeters === undefined
        ? 12000 : common.finiteNumber(settings.heightAboveTargetMeters,
          'Fly-to focus height'))
    const targetRange = settings.rangeMeters === undefined
      ? this.radius + focusHeight
      : cameraRange(settings.rangeMeters, this.radius, 'Fly-to range')
    const targetTilt = settings.tiltDegrees === undefined
      ? 45 : cameraTilt(settings.tiltDegrees, 'Fly-to tilt')
    const targetHeading = settings.headingDegrees === undefined
      ? 0 : common.finiteNumber(settings.headingDegrees, 'Fly-to heading')
    const surfaceDistance = angularDistance(startCoordinate, coordinate) *
      this.radius
    const startHeight = Math.max(0, start.rangeMeters - this.radius)
    const targetHeight = Math.max(0, targetRange - this.radius)
    const requestedPath = settings.path || 'auto'
    common.invariant(['auto', 'direct', 'arc', 'staged'].indexOf(
      requestedPath) >= 0, 'Fly-to path is unsupported')
    const nearDistance = settings.nearDistanceMeters === undefined
      ? 50000 : Math.max(0, common.finiteNumber(
        settings.nearDistanceMeters, 'Fly-to near distance'))
    const farDistance = settings.farDistanceMeters === undefined
      ? 300000 : Math.max(nearDistance, common.finiteNumber(
        settings.farDistanceMeters, 'Fly-to far distance'))
    const path = requestedPath === 'auto'
      ? (surfaceDistance >= farDistance ? 'staged'
        : (surfaceDistance <= nearDistance ? 'direct' : 'arc'))
      : requestedPath
    const defaultDuration = path === 'staged'
      ? common.clamp(4500 + surfaceDistance / 250000 * 1000, 4500, 9000)
      : (path === 'arc'
        ? common.clamp(2000 + surfaceDistance / 150000 * 1000, 2000, 5000)
        : common.clamp(800 + surfaceDistance / 50000 * 1000, 800, 2500))
    const duration = settings.durationMs === undefined
      ? defaultDuration
      : common.clamp(common.finiteNumber(settings.durationMs,
        'Fly-to duration'), 0, 60000)
    const angle = surfaceDistance / this.radius
    const fitHeight = this.radius * Math.sin(Math.min(Math.PI, angle) / 2) /
      Math.tan(this.verticalFovRadians / 2) * 1.25
    const apexHeight = Math.max(startHeight, targetHeight,
      path === 'staged'
        ? Math.min(this.radius * 4, Math.max(120000, fitHeight))
        : Math.min(500000, Math.max(3000, surfaceDistance * 0.45)))
    const headingDelta = wrapDegrees(targetHeading - start.headingDegrees)
    const detail = {
      path,
      phase: path === 'staged' ? 'ascend' : path,
      surfaceDistanceMeters: surfaceDistance,
      cruiseHeightMeters: apexHeight
    }

    if (duration === 0) {
      this.stop('replaced')
      this.camera.setView(Object.assign({}, start, {
        target: {
          longitudeDegrees: coordinate[0],
          latitudeDegrees: coordinate[1],
          heightMeters: coordinate[2]
        },
        rangeMeters: targetRange,
        headingDegrees: targetHeading,
        tiltDegrees: targetTilt
      }))
      this.publish('idle', 1, false, 'flying_complete',
        Object.assign({}, detail, { phase: 'complete' }))
      return
    }

    let stagedProgress = 0
    this.start('flying', (elapsed) => {
      const requestedProgress = common.clamp(elapsed / duration, 0, 1)
      const linear = path === 'staged'
        ? Math.min(requestedProgress, stagedProgress + 0.2)
        : requestedProgress
      if (path === 'staged') stagedProgress = linear
      let target
      let height
      let heading
      let tilt
      let phase = path
      if (path === 'staged') {
        if (linear < 0.25) {
          const phaseProgress = smoothstep(linear / 0.25)
          target = startCoordinate
          height = startHeight + (apexHeight - startHeight) * phaseProgress
          heading = start.headingDegrees
          tilt = start.tiltDegrees * (1 - phaseProgress)
          phase = 'ascend'
        } else if (linear < 0.75) {
          const phaseProgress = smoothstep((linear - 0.25) / 0.5)
          target = interpolateCoordinate(startCoordinate, coordinate,
            phaseProgress)
          height = apexHeight
          heading = start.headingDegrees + headingDelta * phaseProgress
          tilt = 0
          phase = 'cruise'
        } else {
          const phaseProgress = smoothstep((linear - 0.75) / 0.25)
          target = coordinate
          height = apexHeight + (targetHeight - apexHeight) * phaseProgress
          heading = start.headingDegrees + headingDelta
          tilt = targetTilt * phaseProgress
          phase = 'descend'
        }
      } else {
        const t = smoothstep(linear)
        target = interpolateCoordinate(startCoordinate, coordinate, t)
        height = path === 'arc'
          ? (t < 0.5
            ? startHeight + (apexHeight - startHeight) * smoothstep(t * 2)
            : apexHeight + (targetHeight - apexHeight) *
              smoothstep((t - 0.5) * 2))
          : startHeight + (targetHeight - startHeight) * t
        heading = start.headingDegrees + headingDelta * t
        tilt = start.tiltDegrees + (targetTilt - start.tiltDegrees) * t
      }
      this.camera.setView(Object.assign({}, start, {
        target: {
          longitudeDegrees: target[0],
          latitudeDegrees: target[1],
          heightMeters: target[2]
        },
        rangeMeters: this.radius + height,
        headingDegrees: heading,
        tiltDegrees: tilt
      }))
      return {
        progress: linear,
        complete: linear >= 1,
        detail: { phase }
      }
    }, detail)
  }

  startOrbit(value, options) {
    const coordinate = globeCoordinate(value, 'Orbit center')
    const settings = options || {}
    const directionName = settings.direction || 'clockwise'
    common.invariant(directionName === 'clockwise' ||
      directionName === 'counterclockwise', 'Orbit direction is unsupported')
    const direction = directionName === 'counterclockwise' ? -1 : 1
    const speed = settings.speedDegreesPerSecond === undefined
      ? 12 : common.finiteNumber(settings.speedDegreesPerSecond,
        'Orbit speed')
    common.invariant(speed > 0, 'Orbit speed must be positive')
    const start = this.camera.getView()
    const focusHeight = Math.max(this.radius * 0.001,
      settings.heightAboveTargetMeters === undefined
        ? 12000 : common.finiteNumber(settings.heightAboveTargetMeters,
          'Orbit focus height'))
    const targetRange = settings.rangeMeters === undefined
      ? this.radius + focusHeight
      : cameraRange(settings.rangeMeters, this.radius, 'Orbit range')
    const targetTilt = settings.tiltDegrees === undefined
      ? 45 : cameraTilt(settings.tiltDegrees, 'Orbit tilt')
    let heading = start.headingDegrees
    this.start('orbiting', (elapsed, delta) => {
      heading = wrapDegrees(heading + direction * speed * delta / 1000)
      this.camera.setView(Object.assign({}, start, {
        target: {
          longitudeDegrees: coordinate[0],
          latitudeDegrees: coordinate[1],
          heightMeters: coordinate[2]
        },
        rangeMeters: targetRange,
        headingDegrees: heading,
        tiltDegrees: targetTilt
      }))
      return { progress: (elapsed * speed / 360000) % 1, complete: false }
    })
  }

  playRoute(values, options) {
    const settings = options || {}
    const route = routeMetrics(values, this.radius)
    const duration = settings.durationMs === undefined
      ? common.clamp(route.totalDistanceMeters / 500 * 1000, 8000, 15000)
      : common.clamp(common.finiteNumber(settings.durationMs,
        'Route duration'), 1, 3600000)
    const lookAhead = settings.lookAheadMeters === undefined
      ? 50 : Math.max(1, common.finiteNumber(settings.lookAheadMeters,
        'Route look-ahead distance'))
    const focusHeight = Math.max(this.radius * 0.001,
      settings.heightAboveTargetMeters === undefined
        ? 10000 : common.finiteNumber(settings.heightAboveTargetMeters,
          'Route focus height'))
    const targetRange = settings.rangeMeters === undefined
      ? this.radius + focusHeight
      : cameraRange(settings.rangeMeters, this.radius, 'Route range')
    const targetTilt = settings.tiltDegrees === undefined
      ? 55 : cameraTilt(settings.tiltDegrees, 'Route tilt')
    const start = this.camera.getView()
    let heading = start.headingDegrees
    this.start('route-playing', (elapsed, delta) => {
      const progress = common.clamp(elapsed / duration, 0, 1)
      const distance = route.totalDistanceMeters * progress
      const target = coordinateAtDistance(route, distance)
      const ahead = coordinateAtDistance(route,
        Math.min(route.totalDistanceMeters, distance + lookAhead))
      const desiredHeading = bearingDegrees(target, ahead)
      const smoothing = 1 - Math.exp(-Math.max(delta, 1) / 250)
      heading = wrapDegrees(heading +
        wrapDegrees(desiredHeading - heading) * smoothing)
      this.camera.setView(Object.assign({}, start, {
        target: {
          longitudeDegrees: target[0],
          latitudeDegrees: target[1],
          heightMeters: target[2]
        },
        rangeMeters: targetRange,
        headingDegrees: heading,
        tiltDegrees: targetTilt
      }))
      return { progress, complete: progress >= 1 }
    })
  }

  pause() {
    if (!this.motion || this.motion.mode !== 'route-playing' ||
      this.motion.paused) return false
    this.motion.paused = true
    this.motion.pausedAt = this.now()
    if (this.frameId !== null) this.cancelFrame(this.frameId)
    this.frameId = null
    this.publish('route-paused', this.lastState.progress, true, 'paused',
      this.motion.detail)
    return true
  }

  resume() {
    if (!this.motion || !this.motion.paused) return false
    const current = this.now()
    if (this.motion.startedAt !== null) {
      const pauseDuration = current - this.motion.pausedAt
      this.motion.startedAt += pauseDuration
      this.motion.previousAt = current
    }
    this.motion.paused = false
    this.motion.pausedAt = null
    this.motion.mode = 'route-playing'
    this.publish('route-playing', this.lastState.progress, false, 'resumed',
      this.motion.detail)
    this.schedule()
    return true
  }

  stop(reason) {
    if (!this.motion) return false
    if (this.frameId !== null) this.cancelFrame(this.frameId)
    this.frameId = null
    const progress = this.lastState.progress
    this.motion = null
    this.publish('idle', progress, false, reason || 'stopped')
    return true
  }

  destroy() {
    if (this.destroyed) return
    this.stop('destroyed')
    this.destroyed = true
  }
}

module.exports = {
  TerraCameraMotionController,
  angularDistance,
  bearingDegrees,
  coordinateAtDistance,
  interpolateCoordinate,
  routeMetrics,
  wrapDegrees
}
