// Exact visible command inputs. A zero-weight blend endpoint cannot change
// color; its resource ownership still belongs to the presentation cut. Object
// identities are weak and numeric comparison storage has a reclaimable charge.
class SurfaceCommands {
  constructor(ledger) {
    this.ledger = ledger
    this.ids = new WeakMap()
    this.serial = 0
  }

  id(object) {
    if (!object) return 0
    if (!this.ids.has(object)) this.ids.set(object, ++this.serial)
    return this.ids.get(object)
  }

  visit(r, plan, emit) {
    const id = object => this.id(object)
    const {relative, viewFrame, stencil, previewCoverage, commands} = plan
    ;[...relative, ...viewFrame.cameraPosition, r.cameraVersion,
      r.canvas.width, r.canvas.height, id(r.program), id(r.indexBuffer),
      Number(stencil), Number(Boolean(previewCoverage)), Number(r.mode === 'height'),
      ...r.heightRange, Number(r.debugOptions.textureState), Number(r.atmosphereEnabled),
      id(r.atmosphere), id(r.atmosphereProgram), id(r.atmosphereBuffer), id(r.atmosphereTexture),
      r.planetRadius, id(r.overlays), id(r.overlayBuffer), id(r.overlayProgram)].forEach(emit)
    for (const {draw, geometry, part, binding, oldBinding, alpha, scissor} of commands) {
      // Match the shader at the two exact endpoints only. Keep both samplers
      // for every intermediate blend, and keep the new binding's debug state:
      // diagnostic colors can change even while its image has zero weight.
      const color = alpha === 0 ? oldBinding : binding
      const oldColor = alpha === 0 || alpha === 1 ? color : oldBinding
      ;[id(geometry.positionBuffer), id(geometry.uvBuffer),
        id(part && part.positionBuffer), id(part && part.uvBuffer), id(part && part.indexBuffer),
        part ? part.vertexCount || 0 : -1, part ? part.indexCount || 0 : -1,
        draw.firstIndex, draw.indexCount, draw.flags || 0, Number(Boolean(draw.imageryDirectClip)), ...draw.origin,
        draw.imageryCellScale || 1, draw.imageryCellOffsetX || 0, draw.imageryCellOffsetY || 0,
        id(color.texture), color.scale, color.offsetX, color.offsetY,
        id(oldColor.texture), oldColor.scale, oldColor.offsetX, oldColor.offsetY,
        alpha === 0 ? 1 : alpha,
        binding.kind === 'exact' ? 0 : binding.kind === 'fallback' ? 1 : 2].forEach(emit)
      ;(scissor||[-1,-1,-1,-1]).forEach(emit)
    }
  }

  matches(renderer, plan) {
    if (!this.values) return false
    let index = 0, equal = true
    this.visit(renderer, plan, value => { if (value !== this.values[index++]) equal = false })
    return equal && index === this.values.length
  }

  retain(renderer, plan) {
    if (this.matches(renderer, plan)) return
    this.clear()
    let count = 0
    this.visit(renderer, plan, () => ++count)
    const bytes = count * Float64Array.BYTES_PER_ELEMENT
    // An optional display cache must never evict a terrain/image asset to fit.
    if (this.ledger.maximumBytes && this.ledger.bytes + bytes > this.ledger.maximumBytes) return
    const lease = this.ledger.reserveDisposable('display-commands', bytes, () => this.clear())
    if (!lease) return
    try {
      this.values = new Float64Array(count)
      let index = 0
      this.visit(renderer, plan, value => { this.values[index++] = value })
      this.lease = lease
    } catch (_) { this.values = null; this.lease = null; lease.release() }
  }

  clear() {
    this.values = null
    if (this.lease) this.lease.release()
    this.lease = null
  }
}

module.exports = {SurfaceCommands}
