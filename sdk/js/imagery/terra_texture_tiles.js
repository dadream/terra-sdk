function parentTextureTile(tile) {
  if (!tile || tile.level <= 0 || tile.matrix <= 0) {
    return null
  }
  return {
    level: tile.level - 1,
    matrix: tile.matrix - 1,
    row: Math.floor(tile.row / 2),
    column: Math.floor(tile.column / 2)
  }
}

function ancestorTextureTiles(tile) {
  const result = []
  let current = parentTextureTile(tile)
  while (current) {
    result.push(current)
    current = parentTextureTile(current)
  }
  return result
}

function globalCoverageTextureTiles(texture) {
  if (!texture || texture.kind !== 'global-geodetic') {
    return []
  }

  const matrixOffset = texture.matrix_level_offset
  const levelZeroColumns = texture.level_zero_columns
  const levelZeroRows = texture.level_zero_rows
  if (!Number.isInteger(matrixOffset) || matrixOffset < 0 ||
    !Number.isInteger(levelZeroColumns) || levelZeroColumns <= 0 ||
    !Number.isInteger(levelZeroRows) || levelZeroRows <= 0 ||
    !Number.isInteger(texture.maximum_level) || texture.maximum_level < 0) {
    return []
  }
  const result = []
  // Reserve only the physical source roots needed for complete global fallback.
  // Finer levels follow visible demand and may remain cached when unreferenced;
  // making a whole extra level mandatory competes with the target cut forever.
  // Source matrix dimensions do not change the eight internal texture roots.
  for (let row = 0; row < levelZeroRows; ++row) {
    for (let column = 0; column < levelZeroColumns; ++column) {
      result.push({ level: 0, matrix: matrixOffset, row, column })
    }
  }
  return result
}

function descendantTextureTile(tile, levelDelta, row, column) {
  const scale = Math.pow(2, levelDelta)
  return {
    level: tile.level + levelDelta,
    matrix: tile.matrix + levelDelta,
    row: tile.row * scale + row,
    column: tile.column * scale + column
  }
}

function textureCellTransform(source, target) {
  const delta = target.level - source.level
  if (delta >= 0) {
    const scale = Math.pow(2, delta)
    return {
      scale,
      offsetX: source.column * scale - target.column,
      offsetY: source.row * scale - target.row
    }
  }
  return ancestorUvTransform(source, target)
}

function ancestorUvTransform(tile, ancestor) {
  const delta = tile.level - ancestor.level
  const divisor = Math.pow(2, delta)
  return {
    scale: 1 / divisor,
    offsetX: (tile.column - ancestor.column * divisor) / divisor,
    offsetY: (tile.row - ancestor.row * divisor) / divisor
  }
}

function textureTileContains(ancestor, descendant) {
  if (!ancestor || !descendant || ancestor.level > descendant.level) {
    return false
  }
  const delta = descendant.level - ancestor.level
  const scale = Math.pow(2, delta)
  return Math.floor(descendant.row / scale) === ancestor.row &&
    Math.floor(descendant.column / scale) === ancestor.column
}

module.exports = {
  textureTileContains, parentTextureTile, ancestorTextureTiles, globalCoverageTextureTiles, descendantTextureTile, textureCellTransform, ancestorUvTransform }
