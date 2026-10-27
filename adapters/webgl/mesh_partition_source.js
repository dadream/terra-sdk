const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {parentTextureTile, textureTileContains} = require('../../sdk/js/imagery/terra_texture_tiles')

// A source-UV index partition is a conservative triangle superset for each of
// its descendant cells. The existing centroid/highp shader clips the descendant
// without generating another index buffer. The whole immutable mesh is the
// final superset, including a new mesh whose base buffers are funded by the
// handoff transaction. Deep cells and WebGL1 retain geometric clipping.
function meshPartitionSource(renderer, geometry, draw) {
  if (!draw.imageryClipCell || draw.imageryCellScale > renderer.sourceUvScale()) return null
  const source = draw.sourceTexture || draw.texture
  for (let tile = draw.texture; tile && textureTileContains(source, tile); tile = parentTextureTile(tile)) {
    const part = geometry && geometry.partitions.get(key(tile))
    if (part && part.sourceUv) return {cell: key(tile), part}
  }
  return {cell: null, part: null}
}

module.exports = {meshPartitionSource}
