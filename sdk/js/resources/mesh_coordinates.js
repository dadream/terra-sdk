const {invariant} = require('../core/terra_globe_common')
const {ownPayload, ownMesh} = require('./mesh_ownership')
const {indexPayloadBytes, ownIndices, bindMeshIndices} = require('./mesh_indices')

function textureResourceKey(draw) {
  invariant(Number.isSafeInteger(draw.textureResourceId) && draw.textureResourceId > 0,
    'Immutable mesh UV identity is required')
  return `uv:${draw.workerGeneration || 0}:${draw.textureResourceId}`
}

// Physical selected-cut size, independent of what its previous display owns.
// Repeated coverage draws and shared UV layouts count once, just as in CBDAM
// mesh admission. A failed candidate must not report the old cut's footprint.
function meshCutBytes(draws) {
  const positions = new Map(), textures = new Map()
  for (const draw of draws) {
    invariant(Number.isSafeInteger(draw.vertexCount) && draw.vertexCount >= 0,
      'Invalid mesh footprint vertex count')
    positions.set(draw.resourceId, draw.vertexCount * 12)
    textures.set(textureResourceKey(draw), draw.vertexCount * 8)
  }
  return [...positions.values(), ...textures.values()].reduce((sum, bytes) => sum + bytes, 0)
}

// One admitted copy/transfer transaction. Existing UV is borrowed before quoting
// and stays owned through the asynchronous producer. Only missing allocations
// consume credit; a late cancellation keeps its credit until the reply arrives.
class MeshCopyPlan {
  constructor(frames, draws, indexBudget = null, producerIndexBytes = 0) {
    this.frames = frames
    this.pool = frames.textureResources
    this.meshes = new Map(frames.missing(draws).map(draw => [draw.resourceId, draw]))
    this.textures = new Map()
    this.missingTextures = new Map()
    this.holds = new Map()
    this.leases = new Map()
    this.owned = []
    this.producers = []
    this.indexBudget = indexBudget
    this.indexBytes = frames.indices ? 0 : indexPayloadBytes(draws)
    this.producerIndexBytes = producerIndexBytes
    invariant(Number.isSafeInteger(producerIndexBytes) && producerIndexBytes >= 0 &&
      (!producerIndexBytes || indexBudget && producerIndexBytes === indexPayloadBytes(draws)),
    'Terrain index producer quote is invalid')
    this.bytes = this.indexBytes + producerIndexBytes
    try {
      for (const draw of this.meshes.values()) {
        this.bytes += draw.vertexCount * 12
        const key = textureResourceKey(draw)
        if (this.textures.has(key) || this.missingTextures.has(key)) continue
        const texture = this.pool.get(key)
        if (texture) {
          invariant(texture.textureUv.length === draw.vertexCount * 2, 'Immutable UV size changed')
          this.holds.set(key, texture.ownership.hold())
          this.textures.set(key, texture)
        } else {
          this.missingTextures.set(key, draw)
          this.bytes += draw.vertexCount * 8
        }
      }
    } catch (error) { this.release(); throw error }
  }

  get residentTextureIds() { return Array.from(this.textures.values(), uv => uv.textureResourceId) }

  allocate(credit) {
    invariant(!this.allocated, 'Mesh copy credit was already consumed')
    this.allocated = true
    if (!this.frames.indices) this.leases.set('indices', credit.split(this.indexBytes, 'reserved', 'terrain-index-host'))
    if (this.producerIndexBytes) this.indexCredit = this.indexBudget.adopt(
      credit.split(this.producerIndexBytes, 'reserved', this.indexBudget.owner))
    for (const [id, draw] of this.meshes)
      this.leases.set(id, credit.split(draw.vertexCount * 12, 'reserved', this.frames.owner))
    for (const [key, draw] of this.missingTextures)
      this.leases.set(key, credit.split(draw.vertexCount * 8, 'reserved', 'mesh-uv-host'))
  }

  adoptIndices(indices) {
    if (this.frames.indices) return this.frames.indices
    invariant(indices instanceof Uint16Array && indices.byteLength === this.indexBytes,
      'Terrain index transfer differs from its reservation')
    if (this.indices) {
      invariant(indices === this.indices, 'Terrain index producer changed its allocation')
      return indices
    }
    const lease = this.leases.get('indices')
    invariant(lease, 'Terrain index transfer has no credit')
    this.indices = ownIndices(indices, lease)
    this.leases.delete('indices')
    return indices
  }

  readIndices(abi) {
    return this.frames.indices || this.indices || this.adoptIndices(
      this.indexBytes ? abi.getIndices(this.indexBytes / 2) : new Uint16Array(0))
  }

  finishIndices() {
    if (!this.indexCredit) return
    this.indexBudget.finish(this.indexCredit)
    this.indexCredit = null
  }

  read(abi, packet, publish = () => {}) {
    return this.adopt(Object.assign({}, packet, {
      indices: this.readIndices(abi),
      textureAdditions: Array.from(this.missingTextures.values(), draw => ({
        textureResourceId: draw.textureResourceId, workerGeneration: draw.workerGeneration,
        textureUv: abi.copyMeshUv(draw)})),
      additions: Array.from(this.meshes.values(), draw => ({resourceId: draw.resourceId,
        textureResourceId: draw.textureResourceId, positions: abi.copyMeshPositions(draw)}))
    }), () => {}, publish)
  }

  reselect(packet, selected) {
    invariant(this.allocated && !this.prepared && !this.committed && !this.closed,
      'Mesh copy selection is no longer private')
    const meshes = new Map(this.frames.missing(selected.draws).map(draw => [draw.resourceId, draw]))
    invariant(Array.from(meshes.keys()).every(id => this.meshes.has(id)),
      'Late selection requires an unproduced mesh copy')
    const textures = new Set(Array.from(meshes.values(), textureResourceKey))
    for (const id of this.meshes.keys()) if (!meshes.has(id)) {
      this.leases.get(id).release(); this.leases.delete(id)
    }
    for (const key of this.missingTextures.keys()) if (!textures.has(key)) {
      this.leases.get(key).release(); this.leases.delete(key); this.missingTextures.delete(key)
    }
    for (const [key, release] of this.holds) if (!textures.has(key)) {
      release(); this.holds.delete(key); this.textures.delete(key)
    }
    this.meshes = meshes
    this.bytes = Array.from(this.leases.values()).reduce((sum, lease) => sum + lease.bytes, 0)
    // The already transferred arrays keep their original lease and identity.
    // Dropped members leave no live copy in the replacement packet.
    return Object.assign({}, packet, selected, {frame:Object.assign({}, packet.frame, selected.frame),
      additions:packet.additions.filter(resource => meshes.has(resource.resourceId)),
      textureAdditions:packet.textureAdditions.filter(texture => this.missingTextures.has(textureResourceKey(texture)))})
  }

  prepare(packet, prepare = () => {}) {
    invariant(this.allocated && !this.prepared && !this.closed && !this.committed && this.pool === this.frames.textureResources,
      'Mesh copy owner was invalidated')
    invariant(Array.isArray(packet.textureAdditions) && packet.textureAdditions.length === this.missingTextures.size &&
      packet.additions.length === this.meshes.size, 'Mesh transfer allocation count differs from credit')
    const indices = this.frames.indices || this.adoptIndices(packet.indices)
    for (const texture of packet.textureAdditions) {
      const key = textureResourceKey(texture), draw = this.missingTextures.get(key), lease = this.leases.get(key)
      invariant(draw && lease && !this.textures.has(key) && texture.textureUv instanceof Float32Array &&
        texture.textureUv.length === draw.vertexCount * 2, 'UV transfer differs from its reservation')
      const pool = this.pool
      ownPayload(texture, lease, texture.textureUv.byteLength, () => {
        if (pool.get(key) === texture) pool.delete(key)
      })
      this.leases.delete(key)
      this.pool.set(key, texture)
      this.textures.set(key, texture)
      this.producers.push(texture)
    }
    for (const resource of packet.additions) {
      const draw = this.meshes.get(resource.resourceId), lease = this.leases.get(resource.resourceId)
      invariant(draw && lease && resource.textureResourceId === draw.textureResourceId &&
        resource.positions instanceof Float32Array && resource.positions.length === draw.vertexCount * 3,
      'Mesh transfer differs from its reservation')
      resource.uvResource = this.textures.get(textureResourceKey(draw))
      invariant(resource.uvResource, 'Mesh transfer references missing UV')
      resource.textureUv = resource.uvResource.textureUv
      ownMesh(resource, lease)
      this.leases.delete(resource.resourceId)
      this.owned.push(resource)
      bindMeshIndices(resource, indices, lease)
      prepare(resource, draw)
    }
    this.prepared = this.frames.prepare(Object.assign({}, packet, {indices, copiedBytes: this.bytes}))
    return this.prepared
  }

  commit(publish = () => {}) {
    invariant(this.prepared && !this.closed && !this.committed && this.pool === this.frames.textureResources,
      'Mesh copy owner was invalidated')
    const result = this.frames.publish(this.prepared, publish)
    this.committed = true
    return result
  }

  adopt(packet, prepare = () => {}, publish = () => {}) {
    this.prepare(packet, prepare)
    return this.commit(publish)
  }

  release() {
    if (this.closed) return
    this.closed = true
    if (!this.committed) this.owned.forEach(resource => resource.ownership.retire())
    if (this.indices) this.indices.ownership.retire()
    this.finishIndices()
    this.producers.forEach(resource => resource.ownership.retire())
    this.holds.forEach(release => release()); this.holds.clear()
    this.leases.forEach(lease => lease.release()); this.leases.clear()
    this.owned.length = 0; this.producers.length = 0
    this.textures.clear(); this.missingTextures.clear(); this.meshes.clear()
  }
}

module.exports = {MeshCopyPlan, textureResourceKey, meshCutBytes}
