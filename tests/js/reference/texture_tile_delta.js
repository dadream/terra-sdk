const {descendantTextureTile} = require('../../../sdk/js/imagery/terra_texture_tiles')

function textureTileAtDelta(tile, levelDelta, row, column) {
  if (levelDelta >= 0) {
    return descendantTextureTile(tile, levelDelta, row || 0, column || 0)
  }
  const amount = Math.min(tile.level, -levelDelta)
  const divisor = Math.pow(2, amount)
  return {
    level: tile.level - amount,
    matrix: tile.matrix - amount,
    row: Math.floor(tile.row / divisor),
    column: Math.floor(tile.column / divisor)
  }
}

module.exports = {textureTileAtDelta}
