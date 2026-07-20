const { TerraInteractionController } = require(
  './terra_interaction_controller')

function pointerFromTouch(touch, index) {
  return {
    id: touch.identifier === undefined ? index : touch.identifier,
    x: Number(touch.clientX),
    y: Number(touch.clientY)
  }
}

class TerraMiniProgramInteractionAdapter {
  constructor(target, options) {
    const value = options || {}
    this.lastTimeMs = 0
    this.ownsController = !(target && typeof target.begin === 'function' &&
      typeof target.update === 'function' && typeof target.end === 'function')
    const canvas = value.canvas
    const controllerOptions = Object.assign({}, value)
    delete controllerOptions.canvas
    if (!controllerOptions.requestFrame && canvas &&
      typeof canvas.requestAnimationFrame === 'function') {
      controllerOptions.requestFrame = (callback) =>
        canvas.requestAnimationFrame(() => callback(Date.now()))
    }
    if (!controllerOptions.cancelFrame && canvas &&
      typeof canvas.cancelAnimationFrame === 'function') {
      controllerOptions.cancelFrame = (handle) =>
        canvas.cancelAnimationFrame(handle)
    }
    this.controller = this.ownsController
      ? new TerraInteractionController(target, controllerOptions)
      : target
  }

  packet(event) {
    const touches = event && Array.isArray(event.touches)
      ? event.touches : []
    const sourceTime = Number(event && event.timeStamp)
    const candidate = Number.isFinite(sourceTime) && sourceTime >= 0
      ? sourceTime : Date.now()
    this.lastTimeMs = Math.max(this.lastTimeMs, candidate)
    return {
      pointers: touches.map(pointerFromTouch),
      timeMs: this.lastTimeMs
    }
  }

  begin(event) {
    this.controller.begin(this.packet(event))
  }

  update(event) {
    this.controller.update(this.packet(event))
  }

  end(event) {
    this.controller.end(this.packet(event))
  }

  cancel() {
    this.controller.cancel()
  }

  setOptions(options) {
    this.controller.setOptions(options)
  }

  destroy() {
    if (this.ownsController) {
      this.controller.destroy()
    } else {
      this.controller.cancel()
    }
  }
}

module.exports = {
  TerraMiniProgramInteractionAdapter,
  pointerFromTouch
}
