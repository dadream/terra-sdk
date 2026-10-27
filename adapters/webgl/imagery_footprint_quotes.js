const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')

// Completed prices are numerical memos. Live geometry/image loans are removed
// before parking and reattached only after the same metadata has been claimed.
class ImageryFootprintQuotes {
  constructor(renderer, callbacks) {
    this.renderer = renderer
    this.matches = callbacks.matches; this.stamp = callbacks.stamp; this.parked = callbacks.parked
    this.entries = new Map(); this.ids = new WeakMap(); this.serial = 0
  }
  id(object) { if (!this.ids.has(object)) this.ids.set(object, ++this.serial); return this.ids.get(object) }
  get size() { return this.entries.size }
  get(name) { return this.entries.get(name) }
  delete(name) { return this.entries.delete(name) }
  values() { return this.entries.values() }
  clear() { for (const group of this.entries.values()) this.discard(group) }

  valid(group) {
    const r = this.renderer
    return !group.closed && group.generation === r.partitionGeneration && group.source === r.textures.generation &&
      this.matches(group) && Array.from(group.future.keys()).every(id => r.textures.desired.has(id) && !r.textures.failed.has(id)) &&
      Array.from(group.rows).every(([id, row]) => {
        const owner = r.geometry.entries.get(id)
        return owner && this.id(owner) === row.ownerId && this.id(owner.value.partitions) === row.partitionsId
      }) && group.images.every(([id, token]) => {
        const entry = r.textures.cache.entries.get(id)
        return entry && this.id(entry) === token
      })
  }

  park(group) {
    // Parking keeps fixed cell prices, never the payloads used to compute them.
    // Otherwise a rejected quote could pin an entire retired model or image cut.
    for (const row of group.rows.values()) {
      row.ownerId = this.id(row.owner); row.partitionsId = this.id(row.partitions)
      delete row.owner; delete row.geometry; delete row.partitions
    }
    for (const image of group.images) image[1] = this.id(image[1])
    group.borrowedOutputs = null
    group.releases.splice(0).forEach(release => release())
    if (group.selectionReleases) group.selectionReleases.splice(0).forEach(release => release())
    group.inputs = null; group.reserve = null
    group.drawsId = this.id(group.draws); group.draws = null
    group.metadata = this.renderer.resourceLedger.memoize(group.metadata, 'imagery-footprint-quotes', () => this.discard(group))
    group.refusedAt = this.stamp()
    this.entries.set(group.futureName, group)
    this.parked(group, group.refusedAt)
  }

  restore(group, reserve) {
    const r = this.renderer
    group.draws = r.renderDraws; group.drawsId = this.id(group.draws)
    for (const [id, row] of group.rows) {
      row.owner = r.geometry.entries.get(id); row.geometry = row.owner.value; row.partitions = row.geometry.partitions
      group.releases.push(r.geometry.retain(id), holdMeshes([row.geometry.resource]))
    }
    for (const image of group.images) {
      image[1] = r.textures.cache.entries.get(image[0]); group.releases.push(r.textures.cache.retain(image[0]))
    }
    group.reserve = reserve; group.closed = false
  }

  discard(group) {
    this.entries.delete(group.futureName)
    group.closed = true
    if (group.metadata) { group.metadata.release(); group.metadata = null }
    group.inputs = null
    group.draws = null; group.borrowedOutputs = null
    group.rows.clear(); group.images.length = 0; group.allPrices.clear()
  }

}

module.exports = {ImageryFootprintQuotes}
