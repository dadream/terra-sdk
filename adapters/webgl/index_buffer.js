const {invariant} = require('../../sdk/js/core/terra_globe_common')
const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')
const {holdIndices} = require('../../sdk/js/resources/mesh_indices')

// The shared terrain strip is a physical GPU allocation, independent of mesh
// positions and UV. Upload, prepared display and submitted draws own it until
// their receipts; replacing a frame is not permission to refund an old buffer.
class IndexBuffer {
  constructor(renderer) {
    this.renderer = renderer
    this.assets = new Set()
    this.grants = new Set()
    this.generation = 0
  }

  ready(source) { return !source.byteLength || [this.current, this.prepared].some(asset => asset && asset.source === source) }

  quote(packet) {
    // A new host index array needs a new destination even while the old source
    // remains displayed. Context restoration reuses the retained host array.
    if (packet.indexBytes) return packet.indexBytes
    return this.current || this.prepared || this.pending || this.credit ? 0 :
      this.renderer.current ? this.renderer.current.indices.byteLength : 0
  }

  fund(outputs, bytes) {
    if (!bytes) return outputs
    let credit = outputs.credit.split(bytes, 'reserved', 'terrain-index-gpu')
    this.grants.add(credit)
    const release = outputs.release
    outputs.takeIndices = () => { const value = credit; this.grants.delete(value); credit = null; return value }
    outputs.release = () => {
      if (credit) { this.grants.delete(credit); credit.release() }
      credit = null; release()
    }
    return outputs
  }

  accept(source, outputs) {
    if (this.source !== source) {
      const release = this.sourceHold
      this.sourceHold = holdIndices(source)
      this.source = source
      if (release) release()
    }
    // Prepared output has never been submitted. Superseding it needs no draw
    // receipt and must not require room for old + obsolete + next buffers.
    if (this.prepared && this.prepared.source !== source) {
      this.prepared.ownership.retire(); this.prepared = null
    }
    if (this.credit && this.credit.source !== source) { this.credit.lease.release(); this.credit = null }
    const credit = outputs && outputs.takeIndices && outputs.takeIndices()
    if (!credit) return
    if (credit.bytes !== source.byteLength) {
      credit.release()
      throw new Error('Terrain index output differs from its reservation')
    }
    if (this.ready(source) || this.pending && this.pending.source === source) { credit.release(); return }
    if (this.credit) this.credit.lease.release()
    this.credit = {source, lease: credit}
  }

  stage(source) {
    if (this.ready(source) || this.pending) return
    const r = this.renderer, gl = r.gl, generation = this.generation
    // A command slice ending does not cancel the promised destination. Check
    // before handing its credit to a submission whose refusal would refund it.
    if (r.uploadBatch && r.uploadBatch.budget && !r.uploadBatch.budget.fits(source.byteLength, 1)) {
      r.requestResources(); return
    }
    const credit = this.credit && this.credit.source === source ? this.credit.lease :
      r.resourceLedger.reserve('terrain-index-gpu', source.byteLength)
    if (!credit) return // Real availability receipts wake the resource queue.
    if (this.credit && this.credit.lease === credit) this.credit = null
    let sourceHold
    try {
      sourceHold = holdIndices(source)
      if (sourceHold.ownedBy) sourceHold.ownedBy(credit)
    } catch (error) { credit.release(); throw error }
    const work = this.pending = {source, bytes: credit.bytes}
    const cancel = () => { if (this.pending === work) this.pending = null; sourceHold(); credit.release() }
    try {
      r.stageResources('indices', {bytes: source.byteLength, objects: 1},
        resources => resources.buffer(gl.ELEMENT_ARRAY_BUFFER, source), buffer => {
          if (generation !== this.generation || r.destroyed || r.contextLost || !r.current || r.current.indices !== source) {
            cancel(); return false
          }
          this.pending = null
          const asset = {source, buffer, bytes: source.byteLength, generation}
          ownPayload(asset, credit, asset.bytes, () => {
            this.assets.delete(asset)
            if (generation === this.generation && !r.contextLost) gl.deleteBuffer(buffer)
            sourceHold()
          })
          this.assets.add(asset)
          if (this.prepared) this.prepared.ownership.retire()
          this.prepared = asset
        }, cancel)
    } catch (error) { cancel(); throw error }
  }

  activate(source) {
    if (!source.byteLength) return
    if (this.current && this.current.source === source) return
    invariant(this.prepared && this.prepared.source === source, 'Terrain index upload has not completed')
    if (this.current) this.current.ownership.retire()
    this.current = this.prepared
    this.prepared = null
  }

  hold(batch) { if (this.current) batch.hold(this.current.ownership.hold()) }

  clear(lost = false) {
    if (lost) ++this.generation
    if (this.credit) this.credit.lease.release()
    this.credit = null
    for (const asset of this.assets) asset.ownership.retire()
    this.current = this.prepared = null
    if (this.sourceHold) this.sourceHold()
    this.sourceHold = this.source = null
  }

  get bytes() {
    return (this.credit ? this.credit.lease.bytes : 0) + (this.pending ? this.pending.bytes : 0) +
      Array.from(this.grants, credit => credit.bytes).reduce((n, bytes) => n + bytes, 0) +
      Array.from(this.assets, asset => asset.bytes).reduce((n, bytes) => n + bytes, 0)
  }
}

module.exports = {IndexBuffer}
