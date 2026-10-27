const {MeshCopyPlan} = require('../../../sdk/js/resources/mesh_coordinates')
const {meshDraw} = require('./native_mesh_fixture')

// Fixture arrays describe external input; enter the new copy contract explicitly
// so ownership, validation and rollback use the same path as a Worker reply.
module.exports = function adoptPacket(frames, packet) {
  const draws = packet.draws.map(draw => meshDraw(Object.assign({firstIndex: 0, indexCount: packet.indices.length}, draw))), copies = new MeshCopyPlan(frames, draws)
  const credit = frames.reserve(copies.bytes)
  try {
    copies.allocate(credit)
    const additions = packet.additions.map(resource => Object.assign({}, resource, {
      textureResourceId: resource.textureResourceId || 4294967296 + resource.resourceId}))
    const textures = new Map()
    additions.forEach(resource => textures.set(resource.textureResourceId, {
      textureResourceId: resource.textureResourceId, textureUv: resource.textureUv}))
    return copies.adopt(Object.assign({}, packet, {draws, indices: frames.indices || (draws.length ? packet.indices.slice() : new Uint16Array(0)), additions, textureAdditions: Array.from(textures.values())}))
  } finally { copies.release(); credit.release() }
}
