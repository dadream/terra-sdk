// Previous numeric memo retained as a test oracle; production uses WorldDisplayPlan.
const {textureKeyString: key} = require('../../../sdk/js/core/terra_globe_common')

// World footprints and their last projection mask contain canonical numbers
// only. Camera changes replace the mask, not the world topology. Readiness and
// actual branch decisions still invalidate that topology. Neither cache owns
// geometry, images or measurement rows; real producers may reclaim it.
class ImageryFootprintCache {
  constructor(ledger) {
    this.ledger = ledger
    this.entries = new Map()
    this.ids = new WeakMap()
    this.serial = 0
    this.bytes = 0
    this.maximumBytes = 1024 * 1024
    this.reusedMeshes = this.builtMeshes = this.reclaims = this.fundingRefusals = 0
  }

  id(object) {
    if (!this.ids.has(object)) this.ids.set(object, ++this.serial)
    return this.ids.get(object)
  }

  stamp(kind, value) {
    return kind === 'hull' ? value ? this.id(value) : 0 : kind === 'fallback' ? key(value) : value
  }

  fund(entry, bytes) {
    const total = this.bytes + bytes
    // A disposable optimization must not reclaim terrain, images or producer
    // credit. Real owners may reclaim this cache at any later admission.
    if (total > this.maximumBytes || this.ledger.maximumBytes &&
        this.ledger.bytes + bytes > this.ledger.maximumBytes) { ++this.fundingRefusals; return false }
    if (this.lease) {
      if (!this.lease.resize(total)) return false
    } else {
      const lease = this.ledger.reserveDisposable('imagery-footprints', total,
        () => { ++this.reclaims; this.clear() })
      if (!lease) return false
      this.lease = lease
    }
    this.bytes = total
    entry.bytes += bytes
    return true
  }

  release(entry) {
    this.bytes -= entry.bytes
    entry.bytes = 0
    if (!this.bytes) {
      if (this.lease) this.lease.release()
      this.lease = null
    } else this.lease.resize(this.bytes)
  }

  clear() {
    this.entries.clear()
    this.bytes = 0
    if (this.lease) this.lease.release()
    this.lease = null
    this.scope = null
  }

  stats() {
    return {reusedMeshes:this.reusedMeshes, builtMeshes:this.builtMeshes,
      reclaims:this.reclaims, fundingRefusals:this.fundingRefusals,
      accountedBytes:this.bytes, maximumBytes:this.maximumBytes, meshes:this.entries.size}
  }

  collect(draws, context, read, build, emit, projection) {
    // Container copies and other meshes changing membership do not alter this
    // mesh. Validate its source/target cells, immutable hull and branch decisions.
    const scope = context
    if (scope !== this.scope) { this.clear(); this.scope = scope }
    const groups = new Map(), plans = new Map()
    draws.forEach((draw, index) => {
      if (!groups.has(draw.geometryKey)) groups.set(draw.geometryKey, [])
      groups.get(draw.geometryKey).push(index)
    })
    for (const [id, entry] of this.entries) if (!groups.has(id)) {
      this.entries.delete(id); this.release(entry)
    }
    for (const [id, indices] of groups) {
      const signature = indices.map(index => {
        const draw = draws[index]
        return [key(draw.sourceTexture || draw.texture),
          key(draw.texture), !!draw.imageryCapacityCoarsened].join(':')
      }).join('|')
      let entry = this.entries.get(id)
      if (entry && (entry.signature !== signature || entry.dependencies.some(d =>
          !Object.is(d.stamp, this.stamp(d.kind, read(d.kind,
            typeof d.arg === 'number' ? indices[d.arg] : d.arg, d.level)))))) {
        this.entries.delete(id); this.release(entry); entry = null
      }
      if (entry) { ++this.reusedMeshes; plans.set(id, {rows:entry.rows, entry, cursor:0, input:0}); continue }
      ++this.builtMeshes
      entry = {signature, dependencies:[], bytes:0}
      const localIndices = new Map(indices.map((index, local) => [index, local]))
      let caching = this.fund(entry, 64 + signature.length * 2 + String(id).length * 2)
      const probe = (kind, arg, level) => {
        const value = read(kind, arg, level)
        if (caching) {
          const stamp = this.stamp(kind, value)
          const bytes = 64 + (typeof arg === 'string' ? arg.length * 2 : 0) +
            (typeof stamp === 'string' ? stamp.length * 2 : 0)
          if (this.fund(entry, bytes)) entry.dependencies.push({kind,
            arg:typeof arg === 'number' ? localIndices.get(arg) : arg, level, stamp})
          else { this.release(entry); entry.dependencies = []; caching = false }
        }
        return value
      }
      try {
        const rows = build(indices, probe)
        for (let offset=0;offset<rows.length;offset+=8) rows[offset]=localIndices.get(rows[offset])
        if (caching && this.fund(entry, rows.length * Float64Array.BYTES_PER_ELEMENT)) {
          entry.rows = new Float64Array(rows)
          // Include conservative headers for both backing stores and views.
          const maskBytes = 256 + indices.length * Float64Array.BYTES_PER_ELEMENT + rows.length / 8
          if (projection && this.fund(entry, maskBytes)) {
            entry.projections = new Float64Array(indices.length)
            entry.mask = new Uint8Array(rows.length / 8)
          }
          this.entries.set(id, entry)
          plans.set(id, {rows:entry.rows, entry, cursor:0, input:0})
        } else {
          if (caching) this.release(entry)
          plans.set(id, {rows, cursor:0, input:0})
        }
      } catch (error) { if (entry.bytes) this.release(entry); throw error }
    }
    // Indices belong to each immutable mesh footprint. Rebind to this call's
    // descriptors so another mesh's insertion/order cannot invalidate reuse.
    // The projection ID is weak; a mask never keeps its source rows alive.
    draws.forEach((draw, index) => {
      const plan = plans.get(draw.geometryKey)
      const local = plan.input++, entry = plan.entry
      const projected = projection && entry && entry.mask ? this.id(projection.measurement(index)) : 0
      const reuse = projected && entry.projections[local] === projected
      while (plan.cursor < plan.rows.length && plan.rows[plan.cursor] === local) {
        const visible = !projection || (reuse ? entry.mask[plan.cursor / 8] : projection.test(plan.rows, plan.cursor, index))
        if (projected && !reuse) entry.mask[plan.cursor / 8] = visible ? 1 : 0
        if (visible) emit(plan.rows, plan.cursor, index)
        plan.cursor += 8
      }
      if (projected) entry.projections[local] = projected
    })
  }
}

module.exports = {ImageryFootprintCache}
