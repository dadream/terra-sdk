const {invariant} = require('../core/terra_globe_common')
const {ownPayload} = require('./mesh_ownership')

// CBDAM draws use the complete immutable strip, including degenerate joins.
// Quote the transmitted allocation, not the number of visible triangles.
function indexPayloadBytes(draws) {
  const bytes = draws.reduce((count, draw) => {
    invariant(Number.isSafeInteger(draw.firstIndex) && draw.firstIndex >= 0 &&
      Number.isSafeInteger(draw.indexCount) && draw.indexCount >= 0,
    'Invalid terrain index range')
    return Math.max(count, draw.firstIndex + draw.indexCount)
  }, 0) * 2
  invariant(Number.isSafeInteger(bytes), 'Invalid terrain index byte size')
  return bytes
}

function ownIndices(indices, credit) {
  invariant(indices instanceof Uint16Array && indices.byteOffset === 0 &&
    indices.byteLength === indices.buffer.byteLength && !indices.ownership,
  'Terrain indices must own their complete allocation')
  return ownPayload(indices, credit, indices.byteLength)
}

function holdIndices(indices) {
  // An empty bootstrap has no physical strip. It may outlive its zero-byte
  // producer while the first real terrain is prepared; no data loan is needed.
  return indices && indices.byteLength && indices.ownership ? indices.ownership.hold() : () => {}
}

function bindMeshIndices(resource, indices, owner) {
  if (!indices.ownership || resource.indexSource === indices) return
  invariant(!resource.indexSource, 'Immutable mesh index source changed')
  const release = holdIndices(indices)
  if (owner && release.ownedBy) release.ownedBy(owner)
  try {
    resource.ownership.addRelease(release)
    resource.indexSource = indices
  } catch (error) { release(); throw error }
}

module.exports = {indexPayloadBytes, ownIndices, holdIndices, bindMeshIndices}
