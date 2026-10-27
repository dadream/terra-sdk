const {finiteResourceLimit} = require('./resource_ledger')
const {terrainCapacityPolicy} = require('./terrain_capacity_policy')

// Instance capacities are chosen once. Frame resolution and scheduling may
// change on resize; allocation still requires the shared ledger's admission.
function createResourcePolicy(options, initialBudget) {
  const limit = (name, fallback) => options[name] === undefined
    ? fallback : finiteResourceLimit(options[name])
  const maximumResourceBytes = limit('maximumResourceBytes', initialBudget.maximumResourceBytes)
  const maximumTerrainMeshBytes = limit('maximumTerrainMeshBytes', initialBudget.geometryCacheBytes / 2)
  const terrainCapacity = terrainCapacityPolicy(maximumTerrainMeshBytes)
  return Object.freeze({
    maximumResourceBytes,
    maximumImageryBytes: limit('maximumImageryBytes', maximumResourceBytes),
    maximumTerrainMeshBytes,
    terrainCapacity,
    geometryCacheBytes: 2 * maximumTerrainMeshBytes,
    partitionCacheBytes: limit('maximumPartitionBytes', initialBudget.partitionCacheBytes),
    textureCacheBytes: initialBudget.textureCacheBytes
  })
}

module.exports = {createResourcePolicy}
