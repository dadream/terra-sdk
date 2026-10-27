const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')

// Dependencies of one display cut, without mesh ownership or GL handles.
// Mesh keys include their immutable generation. The renderer reuses these
// groups when preparing each atomic mesh footprint.
class PartitionPublication {
  constructor(geometry, imageReady, groupFor) {
    this.geometry = geometry
    this.imageReady = imageReady
    this.groupFor = groupFor
    this.clear()
  }

  clear(keepHandoff = false) {
    this.meshes = new Map(); this.pending = new Map(); this.required = new Set()
    this.groupRows = new Map(); this.states = new Map()
    this.waiting = new Map()
    if (!keepHandoff) this.handoff = new Set()
  }

  setHandoff(draws) {
    this.handoff = new Set(draws.filter(draw => draw.imageryClipCell && !draw.imageryDirectClip)
      .map(draw => draw.geometryKey + ':' + key(draw.texture)))
    return draws
  }

  wanted(mesh, cell) {
    const id = mesh + ':' + cell
    return this.required.has(id) || this.handoff.has(id)
  }

  prepare(draws) {
    for(const step of this.prepareWork(draws)) { /* immediate caller */ }
    return this.meshes
  }

  *prepareWork(draws) {
    this.clear(true)
    for (const draw of draws) {
      yield
      const id = draw.geometryKey
      if (!this.meshes.has(id)) this.meshes.set(id, [])
      this.meshes.get(id).push(draw)
      if (draw.imageryClipCell && !draw.imageryDirectClip) this.required.add(id + ':' + key(draw.texture))
      const group = draw.imageryTarget ? this.groupFor(draw) : id
      if (!this.pending.has(group)) {
        this.pending.set(group, new Set());this.groupRows.set(group,[])
        this.states.set(group,{ready:false})
      }
      this.pending.get(group).add(id)
      this.groupRows.get(group).push(draw)
    }
    yield* this.advanceWork()
    return this.meshes
  }

  adopt(publication) {
    this.meshes=publication.meshes;this.pending=publication.pending;this.required=publication.required
    this.groupRows=publication.groupRows;this.states=publication.states
    this.waiting=publication.waiting
  }

  ready(group) { return !this.pending.has(group) }

  advance() {
    const work=this.advanceWork();let result
    do {result=work.next()}while(!result.done)
    return result.value
  }

  dependencyReady(wait) {
    if (!wait) return true // New or interrupted group has not been checked yet.
    if (wait.image !== undefined) return this.imageReady(wait.image)
    const geometry = this.geometry(wait.mesh)
    return !!geometry && (wait.cell === null || geometry.partitions.has(wait.cell))
  }

  needsAdvance() {
    // A receipt for an unrelated group cannot satisfy this group's first
    // missing dependency. Keep that wait until it really becomes available.
    for (const group of this.pending.keys())
      if (this.dependencyReady(this.waiting.get(group))) return true
    return false
  }

  *advanceWork() {
    if (!this.pending.size) return false
    // Only recovered/new groups need their full immutable mesh footprint
    // checked. A single image receipt must not rescan every pending mesh.
    // This task-local memo shares work among those groups, never across
    // receipts: UVs may have been evicted while a group waited for its image.
    const checked = new Map()
    let changed = false
    for (const [group, meshes] of this.pending) {
      yield
      if (!this.dependencyReady(this.waiting.get(group))) continue
      let wait = null
      for (const id of meshes) {
        yield
        if (!checked.has(id)) {
          const geometry = this.geometry(id)
          let missing = geometry ? null : {mesh:id, cell:null}
          if (geometry) for (const draw of this.meshes.get(id)) {
            yield
            if (!draw.imageryClipCell || draw.imageryDirectClip) continue
            const cell = draw.imageryIndexCell || key(draw.texture)
            if (!geometry.partitions.has(cell)) { missing = {mesh:id, cell}; break }
          }
          checked.set(id, missing)
        }
        wait = checked.get(id)
        if (wait) break
      }
      // UV remains atomic per mesh. Images belong to their own world group:
      // an unrelated future image cannot block an already funded coarsening.
      if (!wait) for (const draw of this.groupRows.get(group)) {
        yield
        if (draw.imageryTarget) {
          const image = key(draw.imageryTarget)
          if (!this.imageReady(image)) { wait = {image}; break }
        }
      }
      if (wait) this.waiting.set(group, wait)
      else {
        this.pending.delete(group);this.waiting.delete(group)
        this.states.get(group).ready=true;changed=true
      }
    }
    return changed
  }

}

module.exports = {PartitionPublication}
