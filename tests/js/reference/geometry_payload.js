const assert = require('assert')
const {geometryRequests} = require('../../../adapters/webgl/geometry_cache')
const {textureResourceKey} = require('../../../sdk/js/resources/mesh_coordinates')

// Install an independently admitted position/UV pair without issuing GL calls.
// Rendering tests use real uploads; admission tests only need their lifetimes.
module.exports = function installGeometry(renderer, draw, geometry, outputs) {
  const cache = renderer.geometry, key = geometry.key, uvKey = textureResourceKey(draw)
  const owned = !outputs
  if (owned) outputs = cache.reserveBatch(geometryRequests([draw], () => key), 0, 'fixture')
  assert(outputs)
  try {
    const uv = outputs.take(uvKey)
    if (uv) {
      assert(uv.commit({kind: 'uv', key: uvKey}))
      cache.ownCoordinates(uvKey)
    }
    const positions = outputs.take(key)
    assert(positions)
    geometry.kind = 'mesh'
    geometry.releaseUv = cache.holdCoordinates(uvKey, positions.lease)
    assert(geometry.releaseUv)
    assert(positions.commit(geometry))
    return geometry
  } finally { if (owned) {outputs.release(); outputs.credit.release()} }
}
