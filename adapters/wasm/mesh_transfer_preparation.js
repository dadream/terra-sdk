const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const {prepareSurfaceSteps} = require('../../sdk/js/terrain/surface_preparation')
const {surfaceIds} = require('../../sdk/js/terrain/surface_replacement')
const {invariant} = require('../../sdk/js/core/terra_globe_common')
const {indexPayloadBytes, ownIndices, holdIndices, bindMeshIndices} = require('../../sdk/js/resources/mesh_indices')

// Keep unfinished summaries private to this producer. Other Worker jobs can
// continue reading the last complete surface between preparation slices.
function* transferSteps(abi, frames, packet, message, residentTextureIds, sharedIndices) {
  const resident = new Set(message.residentIds), residentTextures = new Set(residentTextureIds)
  const resources = new Map(), loans = new Map(), holds = new Map(), additions = [], textureAdditions = []
  let indices, indexProducer = false, indexHold
  const layouts = new Map()
  for (const resource of frames.resources.values()) if (resource.model && resource.model.layout)
    layouts.set(resource.textureResourceId, resource.model.layout)
  let transferred = false, adopted = false, closed = false
  const release = () => {
    if (closed) return
    closed = true
    if (!adopted) loans.forEach(resource => resource.ownership.retire())
    holds.forEach(done => done()); holds.clear()
    if (indexHold) indexHold()
    if (indexProducer) indices.ownership.retire()
  }
  try {
    indices = frames.indices || sharedIndices
    if (!indices) {
      const bytes = indexPayloadBytes(packet.draws)
      invariant(message.maximumIndexBytes === bytes, 'Worker terrain indices are not credited')
      const credit = frames.ledger.reserve('terrain-index-worker', bytes)
      invariant(credit, 'Worker terrain index capacity is occupied')
      try { indices = ownIndices(bytes ? abi.getIndices(bytes / 2) : new Uint16Array(0), credit) }
      catch (error) { credit.release(); throw error }
      indexProducer = true
    }
    indexHold = holdIndices(indices)
    for (const draw of packet.draws) {
      draw.workerGeneration = message.generation || 0
      draw.geometryKey = `mesh:${message.generation || 0}:${draw.resourceId}`
      if (resources.has(draw.resourceId)) continue
      const resource = frames.resources.get(draw.resourceId) || abi.borrowMeshResource(draw)
      if (!frames.resources.has(draw.resourceId)) loans.set(draw.resourceId, resource)
      holds.set(draw.resourceId, holdMeshes([resource]))
      resources.set(draw.resourceId, resource)
      bindMeshIndices(resource, indices)
      if (!resource.model) {
        resource.model = yield* prepareSurfaceSteps({
          get positions() { return resource.positions },
          get uv() { return resource.textureUv }
        }, indices, draw.firstIndex, draw.indexCount, layouts.get(draw.textureResourceId))
      }
      layouts.set(draw.textureResourceId, resource.model.layout)
      if (!resident.has(draw.resourceId)) {
        if (!residentTextures.has(draw.textureResourceId)) {
          textureAdditions.push({textureResourceId: draw.textureResourceId,
            workerGeneration: message.generation || 0, textureUv: resource.textureUv.slice()})
          residentTextures.add(draw.textureResourceId)
        }
        additions.push({resourceId: draw.resourceId, textureResourceId: draw.textureResourceId,
          positions: resource.positions.slice(),
          model: {blocks: resource.model.blocks, bounds: resource.model.bounds, hull: resource.model.hull}})
      }
      yield
    }
    const transfer = {frame: Object.assign({}, packet.frame, {
      projectionView: packet.frame.projectionView.slice(), cameraPosition: packet.frame.cameraPosition.slice()}),
    draws: packet.draws, replacementPlan: packet.replacementPlan,
    selectionViewRevision: message.viewRevision, requests: abi.getRequests(), additions, textureAdditions,
    // Direct execution shares its admitted host allocation. A Worker keeps
    // its producer strip and transfers a separately prepaid receiver copy.
    indices: message.needsIndices ? sharedIndices ? indices : indices.slice() : null}
    transfer.updateState = packet.updateState
    let selected = packet
    let surface = Object.assign({}, packet, {indices, resources, meshIdentity: surfaceIds(packet.draws).join(',')})
    transferred = true
    return {transfer, get surface() {return surface}, release,
      reselect(next) {
        invariant(!closed, 'Mesh preparation was retired')
        const nextResources = new Map(next.draws.map(draw =>
          [draw.resourceId, surface.resources.get(draw.resourceId) || frames.resources.get(draw.resourceId)]))
        invariant(Array.from(nextResources.values()).every(resource => resource && resource.model),
          'Late selection requires an unprepared mesh')
        for (const [id, resource] of nextResources) if (!holds.has(id)) holds.set(id, holdMeshes([resource]))
        for (const [id, resource] of loans) if (!nextResources.has(id)) {
          resource.ownership.retire(); loans.delete(id)
        }
        for (const [id, done] of holds) if (!nextResources.has(id)) {done();holds.delete(id)}
        next.draws.forEach(draw => {
          draw.workerGeneration = message.generation || 0
          draw.geometryKey = `mesh:${message.generation || 0}:${draw.resourceId}`
        })
        selected = next
        surface = Object.assign({}, next, {indices, resources:nextResources, meshIdentity:surfaceIds(next.draws).join(',')})
      }, commit() {
        // Local execution adopts the credited host copies. Its temporary
        // native loans remain private, then retire after publication; an
        // unfinished imagery job can still own those immutable loans.
        invariant(!closed, 'Mesh preparation was retired')
        abi.commitMeshFrame(selected)
        release()
        return selected.updateState
      }, accept() {
      if (closed) throw new Error('Mesh preparation was retired')
      const result = frames.adopt(Object.assign({}, selected, {indices, additions: Array.from(loans.values()), copiedBytes: 0}),
        candidate => { abi.commitMeshFrame(candidate); selected.nativePlan = null })
      adopted = true
      release()
      return result.updateState
    }}
  } finally {
    if (!transferred) release()
  }
}

function createMeshTransferTask(abi, frames, packet, message, residentTextureIds, sharedIndices) {
  // A preparation yield now covers only 64 faces, not an entire mesh. Keep
  // the existing 4ms deadline while amortizing RPC receipts across these small
  // checkpoints; a turn still has an independent finite operation ceiling.
  return new CooperativeTask(transferSteps(abi, frames, packet, message, residentTextureIds, sharedIndices), 64)
}

module.exports = {createMeshTransferTask}
