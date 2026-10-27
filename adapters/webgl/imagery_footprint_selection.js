const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const {invariant, textureKeyString:key} = require('../../sdk/js/core/terra_globe_common')
const {imageryCandidateWork} = require('./imagery_candidate')

// Height/headless preparation has no texture world cut to borrow.
function* coldFootprint(r, group, children, account) {
  const store = r.textures, geometry = new Map(), inputs = group.draws
  // Only numeric/immutable model inputs enter the selector. Acquire actual
  // geometry/mesh loans before yielding with a model, and borrow images until
  // the complete destination set has been transferred to the pricing stage.
  for (const draw of inputs) {
    if (geometry.has(draw.geometryKey)) continue
    account(192)
    const owner = r.geometry.entries.get(draw.geometryKey)
    if (owner) {
      const value = owner.value
      geometry.set(draw.geometryKey, value)
      group.inputs.set(draw.geometryKey, {geometry:value, owner, partitions:value.partitions})
      group.selectionReleases.push(r.geometry.retain(draw.geometryKey), holdMeshes([value.resource]))
    } else if (group.members.has(draw.geometryKey)) return null
    yield
  }
  const resident = new Set(), ready = new Set()
  account(store.cache.entries.size * 8)
  const keys = Array.from(store.cache.entries.keys())
  for (const id of keys) {
    account(128 + id.length * 2)
    const entry = store.cache.entries.get(id), release = entry && store.cache.retain(id)
    if (release) {
      group.selectionReleases.push(release); resident.add(id)
      if (store.gpuReady(id)) ready.add(id)
    }
    yield
  }
  account(512 + store.targetDesired.size * 160 + 128 * (store.retainedTargets.size + store.coverageKeys.size +
    store.currentRoots.size * 2 + store.availableKeys.size + store.failed.size + store.admissionBlocked.size + r.presentedTextures.size))
  const required = new Set([...store.targetDesired.keys(), ...store.retainedTargets.keys(), ...store.coverageKeys,
    ...store.currentRoots.keys()])
  const bridges = r.presentationBridges
  account(64 + bridges.length * 8)
  const snapshot = Object.create(r, {presentationBridges:{value:Array.from(bridges)}})
  snapshot.geometry = {get:id=>geometry.get(id)}
  snapshot.presentedTextures = new Map(r.presentedTextures)
  snapshot.presentation = {duration:r.presentation.duration, cells:r.presentation.cells}
  snapshot.textures = {targetDesired:new Map(store.targetDesired), admissionBlocked:new Set(store.admissionBlocked),
    blockedByCapacity:store.blockedByCapacity, availableKeys:new Set(store.availableKeys),
    currentRoots:new Map(store.currentRoots), failed:new Set(store.failed), directTargets:store.directTargets,
    resourceGroups:()=>groups, requiresResident:id=>required.has(id),
    cache:{has:id=>resident.has(id)}, gpuReady:id=>ready.has(id)}
  const groups = []
  for (const [id, cells] of store.resourceGroups()) { account(64 + cells.size * 64); groups.push([id,new Map(cells)]); yield }
  return yield* imageryCandidateWork(snapshot, children, {draws:inputs, reserve:account})
}

// The broker owns the iterator, numeric-cut loans and credited workspace.
// A prepared world already contains the complete canonical mesh footprint:
// image groups borrow it instead of repeating topology for every download.
function* selectImageryFootprints(r, group, children, account) {
  if (!group.sources.size) return true
  const store=r.textures,prepared=r.mode==='texture'&&r.worldDisplay
  const draws=prepared?yield* r.worldDisplay.imageGroupRows(group.members,children,account,group.selectionReleases):
    yield* coldFootprint(r,group,children,account)
  if(!draws)return false
  const imageIds = new Set()
  for (const draw of draws) {
    account(256)
    const id = draw.geometryKey
    if (!group.rows.has(id)) {
      const owner = r.geometry.entries.get(id)
      if(!owner)return false
      group.rows.set(id, {geometry: owner.value, owner, partitions: owner.value.partitions, cells: []})
      group.releases.push(r.geometry.retain(id), holdMeshes([owner.value.resource]))
    }
    if (draw.imageryClipCell && !draw.imageryDirectClip) {
      const cell = r.partitionCell(draw), label = id + ':' + cell.key
      if (!group.required.has(label)) group.rows.get(id).cells.push(cell)
      group.required.add(label)
    }
    if (draw.imageryTarget && !children.has(key(draw.imageryTarget))) imageIds.add(key(draw.imageryTarget))
    yield
  }
  for (const id of imageIds) {
    const entry = store.cache.entries.get(id)
    if(!entry||!store.gpuReady(id)) {
      // These other future images do not belong to this production group.
      // Their UV destinations are priced now; actual image readiness remains
      // in the world publication gate and submitted endpoints stay protected.
      if(prepared)continue
      return false
    }
    const release=store.cache.retain(id)
    if(!release)return false
    group.images.push([id, entry]); group.releases.push(release)
    yield
  }
  group.selectionReleases.splice(0).forEach(release => release())
  group.inputs = null
  const bytes = 512 + Array.from(group.sources).reduce((sum, [id, value]) => sum + 128 + String(id).length * 2 + value.length * 2, 0) +
    group.rows.size * 192 + group.images.length * 96 +
    Array.from(group.rows.values()).reduce((sum, row) => sum + row.cells.reduce((n, cell) =>
      n + 320 + cell.key.length * 2 + (row.geometry.key + ':' + cell.key).length * 2, 0), 0)
  if (bytes > group.metadataUsed) account(bytes - group.metadataUsed)
  invariant(group.metadata.resize(bytes), 'Completed imagery footprint metadata lost its credit')
  group.metadataUsed = bytes
  group.metadata.mark('resident')
  return true
}

module.exports = {selectImageryFootprints}
