const {ResourceCache} = require('../../sdk/js/resources/resource_cache')
const {textureResourceKey} = require('../../sdk/js/resources/mesh_coordinates')

function geometryRequests(draws, geometryKey) {
  const result = new Map()
  for (const draw of draws) {
    result.set(geometryKey(draw), draw.vertexCount * 12)
    result.set(textureResourceKey(draw), draw.vertexCount * 8)
  }
  return result
}

// Positions and shared UV have one aggregate cache budget. Coordinate buffers
// are dependencies, not a second cache with an independent memory allowance.
class GeometryCache extends ResourceCache {
  values() { return super.values().filter(value => value.kind !== 'uv') }

  handoff(draws, geometryKey) {
    return new Map(Array.from(geometryRequests(draws, geometryKey).keys(), key => [key, this.entries.get(key)])
      .filter(([, entry]) => entry))
  }

  planBatch(requests, producerBytes, keep = [], admission = {}) {
    // Only this complete predecessor can overlap its successor outside the
    // steady cache limit. These bytes remain live in the shared ledger and
    // cannot fund production or become eviction victims before presentation.
    const retiring = new Map(Array.from(admission.retiring || []).filter(([key, entry]) =>
      !requests.has(key) && this.entries.get(key) === entry))
    return super.planBatch(requests, producerBytes, keep.concat(Array.from(retiring.values(), entry => entry.lease)),
      Object.assign({}, admission, {retiring}))
  }

  stats() {
    const stats = super.stats()
    const coordinateEntries = Array.from(this.entries.values()).filter(entry => entry.value.kind === 'uv').length
    return Object.assign(stats, {entries: stats.entries - coordinateEntries, coordinateEntries})
  }

  holdCoordinates(key, owner) {
    const entry = this.entries.get(key)
    if (!entry || entry.value.kind !== 'uv') return null
    const release = this.retain(key), reference = {owner}
    entry.value.owners.add(reference)
    let held = true
    return () => {
      if (!held) return
      held = false
      entry.value.owners.delete(reference)
      release()
      if (this.entries.get(key) === entry && !entry.holds && this.canEvict(key, entry.value)) this.delete(key)
    }
  }

  ownCoordinates(key) {
    const entry = this.entries.get(key)
    entry.value.owners = new Set()
    entry.lease.reclaimWith = () => {
      const owners = entry.value.owners
      return owners.size && entry.holds === owners.size && this.canEvict(key, entry.value)
        ? Array.from(owners, reference => reference.owner) : null
    }
  }

  reserveBatch(requests, ...args) {
    // Existing UV must survive eviction of its previous meshes while a new
    // replacement group takes ownership. Borrow before the atomic admission.
    const held = []
    for (const key of requests.keys()) {
      const entry = this.entries.get(key)
      if (entry && entry.value.kind === 'uv') held.push(this.retain(key))
    }
    try { return super.reserveBatch(requests, ...args) }
    finally { held.forEach(release => release()) }
  }

  makeRoom(key, bytes, entries, protectedKeys = new Set(), admission = {}) {
    const retiring = admission.retiring || new Map()
    for (const entry of retiring.values()) { bytes -= entry.byteSize; --entries }
    const owners = new Map(), dependencies = new Map(), values = new Map()
    for (const [id, entry] of this.entries) {
      values.set(entry.lease, entry)
      if (id === key || protectedKeys.has(id) || entry.value.kind !== 'uv') continue
      const parents = entry.lease.reclaimWith && entry.lease.reclaimWith()
      if (!parents || !parents.length) continue
      const unique = new Set(parents)
      owners.set(entry.lease, unique.size)
      for (const parent of unique) {
        if (!dependencies.has(parent)) dependencies.set(parent, [])
        dependencies.get(parent).push(entry.lease)
      }
    }
    const released = new Set(Array.from(retiring.values(), entry => entry.lease)), victims = []
    const release = lease => {
      if (released.has(lease)) return
      released.add(lease)
      const entry = values.get(lease)
      bytes -= entry.byteSize; --entries
      for (const dependent of dependencies.get(lease) || []) {
        const left = owners.get(dependent) - 1
        owners.set(dependent, left)
        if (!left) release(dependent)
      }
    }
    for (const [id, entry] of this.entries) {
      if (this.within(bytes, entries, true, admission.maximumBytes)) break
      if (released.has(entry.lease) || id === key || protectedKeys.has(id) || entry.holds ||
          !this.canEvict(id, entry.value)) continue
      victims.push(entry.lease)
      release(entry.lease)
    }
    return this.within(bytes, entries, true, admission.maximumBytes) ? victims
      : this.roomFailure(bytes, entries, admission.refusal, admission.maximumBytes)
  }
}

module.exports = {GeometryCache, geometryRequests}
