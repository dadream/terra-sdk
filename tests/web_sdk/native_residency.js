(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraNativeResidency = factory()
})(typeof self === 'undefined' ? this : self, function () {
  // Price the physical resources described by a complete presentation. Root
  // coverage and visible draws can alias XYZ; different meshes can share UV.
  return function requiredPayload(draws) {
    if (!Array.isArray(draws) || !draws.length) throw new Error('Missing resident draw descriptors')
    const positions = new Map(), uv = new Map()
    const add = (values, id, bytes) => {
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(bytes) || bytes <= 0)
        throw new Error('Invalid resident mesh descriptor')
      if (values.has(id) && values.get(id) !== bytes) throw new Error('Conflicting resident mesh descriptor')
      values.set(id, bytes)
    }
    for (const draw of draws) {
      if (!Number.isSafeInteger(draw.vertexCount) || draw.vertexCount <= 0 ||
          draw.positionFloatCount !== 3 * draw.vertexCount || draw.textureFloatCount !== 2 * draw.vertexCount)
        throw new Error('Invalid resident mesh dimensions')
      add(positions, draw.resourceId, draw.positionFloatCount * 4)
      add(uv, draw.textureResourceId, draw.textureFloatCount * 4)
    }
    return {drawCount:draws.length, meshCount:positions.size, uvCount:uv.size,
      positionBytes:Array.from(positions.values()).reduce((a,b)=>a+b,0),
      uvBytes:Array.from(uv.values()).reduce((a,b)=>a+b,0)}
  }
})
