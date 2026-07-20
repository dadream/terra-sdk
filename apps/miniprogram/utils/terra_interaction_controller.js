const DEFAULT_OPTIONS = {
  mode: 'move',
  rotateEnabled: true,
  tiltEnabled: true,
  inertiaEnabled: true,
  deadZonePixels: 4,
  maximumPanPixelsPerFrame: 96,
  maximumOrbitDegreesPerFrame: 15,
  inertiaMinimumPixelsPerMs: 0.08,
  inertiaMaximumDurationMs: 320,
  inertiaDecayPerFrame: 0.84
}

function finite(value, name) {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`)
  }
  return value
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function normalizePointers(pointers) {
  if (!Array.isArray(pointers) || pointers.length > 2) {
    throw new Error('Interaction pointers must contain zero to two entries')
  }
  return pointers.map((pointer, index) => ({
    id: pointer.id === undefined ? index : String(pointer.id),
    x: finite(pointer.x, 'Pointer X'),
    y: finite(pointer.y, 'Pointer Y')
  })).sort((left, right) => left.id.localeCompare(right.id))
}

function samePointerIds(left, right) {
  return left.length === right.length && left.every(
    (pointer, index) => pointer.id === right[index].id)
}

function centroid(pointers) {
  const sum = pointers.reduce((value, pointer) => ({
    x: value.x + pointer.x,
    y: value.y + pointer.y
  }), { x: 0, y: 0 })
  return { x: sum.x / pointers.length, y: sum.y / pointers.length }
}

function distance(pointers) {
  if (pointers.length < 2) {
    return 0
  }
  return Math.hypot(pointers[1].x - pointers[0].x,
    pointers[1].y - pointers[0].y)
}

function angleDegrees(pointers) {
  if (pointers.length < 2) {
    return 0
  }
  return Math.atan2(pointers[1].y - pointers[0].y,
    pointers[1].x - pointers[0].x) * 180 / Math.PI
}

function wrapDegrees(value) {
  return ((value + 180) % 360 + 360) % 360 - 180
}

class TerraInteractionController {
  constructor(camera, options) {
    if (!camera || typeof camera.panBy !== 'function' ||
      typeof camera.zoomBy !== 'function' ||
      typeof camera.orbitBy !== 'function') {
      throw new Error('Interaction camera is incomplete')
    }
    this.camera = camera
    this.options = Object.assign({}, DEFAULT_OPTIONS)
    this.active = null
    this.pending = null
    this.frameHandle = null
    this.inertia = null
    this.destroyed = false
    this.setOptions(options || {})
    this.requestFrame = this.options.requestFrame ||
      ((callback) => setTimeout(() => callback(this.now()), 16))
    this.cancelFrame = this.options.cancelFrame || clearTimeout
    this.now = this.options.now || Date.now
  }

  setOptions(options) {
    const value = options || {}
    if (value.mode !== undefined && value.mode !== 'move' &&
      value.mode !== 'look') {
      throw new Error('Interaction mode must be move or look')
    }
    const numeric = ['deadZonePixels', 'maximumPanPixelsPerFrame',
      'maximumOrbitDegreesPerFrame', 'inertiaMinimumPixelsPerMs',
      'inertiaMaximumDurationMs', 'inertiaDecayPerFrame']
    numeric.forEach((name) => {
      if (value[name] !== undefined) {
        finite(value[name], name)
      }
    })
    Object.assign(this.options, value)
    this.options.deadZonePixels = Math.max(0, this.options.deadZonePixels)
    this.options.maximumPanPixelsPerFrame = Math.max(1,
      this.options.maximumPanPixelsPerFrame)
    this.options.maximumOrbitDegreesPerFrame = Math.max(1,
      this.options.maximumOrbitDegreesPerFrame)
    this.options.inertiaMaximumDurationMs = clamp(
      this.options.inertiaMaximumDurationMs, 0, 1000)
    this.options.inertiaDecayPerFrame = clamp(
      this.options.inertiaDecayPerFrame, 0, 0.99)
  }

  begin(packet) {
    this.requireActiveRuntime()
    const pointers = normalizePointers(packet && packet.pointers)
    const timeMs = finite(packet && packet.timeMs, 'Interaction time')
    if (!pointers.length) {
      throw new Error('Interaction begin requires at least one pointer')
    }
    this.cancelMotion()
    this.pending = null
    this.cancelScheduledFrame()
    if (typeof this.camera.cancelAnimation === 'function') {
      this.camera.cancelAnimation()
    }
    this.active = {
      ids: pointers.map((pointer) => pointer.id),
      semantic: pointers.length === 2 ? 'pinch' : this.options.mode,
      startPointers: pointers,
      lastPointers: pointers,
      startedAt: timeMs,
      lastTime: timeMs,
      moved: false,
      velocityX: 0,
      velocityY: 0
    }
    this.emit('interactionstart', { semantic: this.active.semantic })
  }

  update(packet) {
    this.requireActiveRuntime()
    const pointers = normalizePointers(packet && packet.pointers)
    const timeMs = finite(packet && packet.timeMs, 'Interaction time')
    if (!pointers.length) {
      this.end({ pointers, timeMs })
      return
    }
    if (!this.active || !samePointerIds(
      pointers, this.active.lastPointers)) {
      this.finishActive(false)
      this.begin({ pointers, timeMs })
      return
    }
    const elapsed = Math.max(1, timeMs - this.active.lastTime)
    if (this.active.semantic === 'pinch') {
      this.updatePinch(pointers)
    } else {
      this.updateSingle(pointers, elapsed)
    }
    this.active.lastPointers = pointers
    this.active.lastTime = timeMs
  }

  updateSingle(pointers, elapsed) {
    const previous = this.active.lastPointers[0]
    const current = pointers[0]
    const dx = current.x - previous.x
    const dy = current.y - previous.y
    const start = this.active.startPointers[0]
    const travel = Math.hypot(current.x - start.x, current.y - start.y)
    if (!this.active.moved && travel < this.options.deadZonePixels) {
      return
    }
    this.active.moved = true
    this.active.velocityX = dx / elapsed
    this.active.velocityY = dy / elapsed
    if (this.active.semantic === 'look') {
      this.queue({
        headingDegrees: this.options.rotateEnabled ? dx * 0.25 : 0,
        tiltDegrees: this.options.tiltEnabled ? -dy * 0.2 : 0
      })
    } else {
      this.queue({ xPixels: dx, yPixels: dy })
    }
  }

  updatePinch(pointers) {
    const previous = this.active.lastPointers
    const previousDistance = distance(previous)
    const currentDistance = distance(pointers)
    const previousCenter = centroid(previous)
    const currentCenter = centroid(pointers)
    const centerTravel = Math.hypot(
      currentCenter.x - centroid(this.active.startPointers).x,
      currentCenter.y - centroid(this.active.startPointers).y)
    const distanceTravel = Math.abs(
      currentDistance - distance(this.active.startPointers))
    if (!this.active.moved && Math.max(centerTravel, distanceTravel) <
      this.options.deadZonePixels) {
      return
    }
    this.active.moved = true
    const zoomScale = previousDistance > 0 && currentDistance > 0
      ? previousDistance / currentDistance
      : 1
    const headingDegrees = this.options.rotateEnabled
      ? wrapDegrees(angleDegrees(pointers) - angleDegrees(previous))
      : 0
    this.queue({
      xPixels: currentCenter.x - previousCenter.x,
      yPixels: currentCenter.y - previousCenter.y,
      zoomScale,
      anchor: currentCenter,
      headingDegrees,
      tiltDegrees: 0
    })
  }

  end(packet) {
    this.requireActiveRuntime()
    const pointers = normalizePointers(packet && packet.pointers)
    finite(packet && packet.timeMs, 'Interaction time')
    if (!this.active) {
      return
    }
    if (pointers.length && samePointerIds(pointers, this.active.lastPointers)) {
      return
    }
    this.flush()
    const completed = this.active
    this.finishActive(true)
    if (!completed.moved) {
      const point = completed.lastPointers[0]
      this.emit('tap', { x: point.x, y: point.y })
      if (typeof this.options.onTap === 'function') {
        this.options.onTap({ x: point.x, y: point.y })
      }
      this.emit('camerasettle', {})
      return
    }
    if (completed.semantic === 'move' && this.options.inertiaEnabled) {
      this.startInertia(completed.velocityX, completed.velocityY)
    } else {
      this.emit('camerasettle', {})
    }
  }

  cancel() {
    if (this.destroyed) {
      return
    }
    this.pending = null
    this.cancelScheduledFrame()
    this.cancelMotion()
    this.finishActive(false)
    this.emit('camerasettle', {})
  }

  queue(change) {
    if (!this.pending) {
      this.pending = {
        xPixels: 0,
        yPixels: 0,
        zoomScale: 1,
        anchor: null,
        headingDegrees: 0,
        tiltDegrees: 0
      }
    }
    this.pending.xPixels += change.xPixels || 0
    this.pending.yPixels += change.yPixels || 0
    this.pending.zoomScale *= change.zoomScale || 1
    this.pending.anchor = change.anchor || this.pending.anchor
    this.pending.headingDegrees += change.headingDegrees || 0
    this.pending.tiltDegrees += change.tiltDegrees || 0
    if (this.frameHandle === null) {
      this.frameHandle = this.requestFrame(() => {
        this.frameHandle = null
        this.flush()
      })
    }
  }

  flush() {
    if (!this.pending) {
      return false
    }
    const change = this.pending
    this.pending = null
    change.xPixels = clamp(change.xPixels,
      -this.options.maximumPanPixelsPerFrame,
      this.options.maximumPanPixelsPerFrame)
    change.yPixels = clamp(change.yPixels,
      -this.options.maximumPanPixelsPerFrame,
      this.options.maximumPanPixelsPerFrame)
    change.headingDegrees = clamp(change.headingDegrees,
      -this.options.maximumOrbitDegreesPerFrame,
      this.options.maximumOrbitDegreesPerFrame)
    change.tiltDegrees = clamp(change.tiltDegrees,
      -this.options.maximumOrbitDegreesPerFrame,
      this.options.maximumOrbitDegreesPerFrame)
    if (typeof this.camera.applyInteraction === 'function') {
      this.camera.applyInteraction(change)
    } else {
      if (change.xPixels || change.yPixels) {
        this.camera.panBy(change)
      }
      if (change.zoomScale !== 1) {
        this.camera.zoomBy(change.zoomScale, { anchor: change.anchor })
      }
      if (change.headingDegrees || change.tiltDegrees) {
        this.camera.orbitBy(change)
      }
    }
    this.emit('camerachange', {})
    return true
  }

  startInertia(velocityX, velocityY) {
    const speed = Math.hypot(velocityX, velocityY)
    if (speed < this.options.inertiaMinimumPixelsPerMs ||
      this.options.inertiaMaximumDurationMs === 0) {
      this.emit('camerasettle', {})
      return
    }
    const startedAt = this.now()
    let previousTime = startedAt
    this.inertia = { velocityX, velocityY, frame: null }
    const step = (timestamp) => {
      if (!this.inertia) {
        return
      }
      const now = Number.isFinite(timestamp) ? timestamp : this.now()
      const elapsed = Math.max(1, Math.min(32, now - previousTime))
      previousTime = now
      const age = now - startedAt
      if (age >= this.options.inertiaMaximumDurationMs ||
        Math.hypot(this.inertia.velocityX, this.inertia.velocityY) <
          this.options.inertiaMinimumPixelsPerMs) {
        this.inertia = null
        this.emit('camerasettle', {})
        return
      }
      this.queue({
        xPixels: this.inertia.velocityX * elapsed,
        yPixels: this.inertia.velocityY * elapsed
      })
      this.inertia.velocityX *= this.options.inertiaDecayPerFrame
      this.inertia.velocityY *= this.options.inertiaDecayPerFrame
      this.inertia.frame = this.requestFrame(step)
    }
    this.inertia.frame = this.requestFrame(step)
  }

  cancelMotion() {
    if (this.inertia) {
      this.cancelFrame(this.inertia.frame)
      this.inertia = null
      this.emit('animationcancel', {})
    }
  }

  cancelScheduledFrame() {
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle)
      this.frameHandle = null
    }
  }

  finishActive(allowInertia) {
    if (!this.active) {
      return
    }
    const semantic = this.active.semantic
    this.active = null
    this.emit('interactionend', { semantic, allowInertia })
  }

  emit(type, detail) {
    if (typeof this.options.onEvent === 'function') {
      this.options.onEvent(type, detail || {})
    }
  }

  requireActiveRuntime() {
    if (this.destroyed) {
      throw new Error('Interaction controller is destroyed')
    }
  }

  destroy() {
    if (this.destroyed) {
      return
    }
    this.cancel()
    this.destroyed = true
  }
}

module.exports = {
  DEFAULT_OPTIONS,
  TerraInteractionController,
  normalizePointers
}
