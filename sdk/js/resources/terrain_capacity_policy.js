const {finiteResourceLimit} = require('./resource_ledger')

const defaultTerrainMeshBytes = 64 * 1024 * 1024

// Selection/cache ceilings, not reservations. Every allocation still needs
// the shared ledger's grant. Native derives the same record/height ceilings
// from this one immutable instance input, including after a manifest reset.
function terrainCapacityPolicy(meshBytes = defaultTerrainMeshBytes) {
  finiteResourceLimit(meshBytes)
  if (meshBytes > 0x7fffffff) throw new Error('Terrain capacity exceeds the uint32 height payload range')
  return Object.freeze({meshBytes, recordBytes: meshBytes, heightBytes: 2 * meshBytes,
    publicationBytes: Math.min(0xffffffff, 4 * meshBytes)})
}

module.exports = {terrainCapacityPolicy, defaultTerrainMeshBytes}
