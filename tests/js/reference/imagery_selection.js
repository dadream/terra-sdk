const {textureTileAtDelta} = require('./texture_tile_delta')
// Frozen JavaScript selection oracle. Production selection belongs to the
// unified native imagery planner; renderer fixtures inject this explicitly.
const {drawUvBounds} = require('./draw_uv_bounds')
const common = require('../../../sdk/js/core/terra_globe_common')
const surfacePlan = require('../../../sdk/js/terrain/terra_surface_plan')
const {geometryKey} = require('../../../adapters/webgl/terra_webgl_renderer')
const tileKey = common.textureKeyString
const {textureTileContains, parentTextureTile, descendantTextureTile,
  textureCellTransform} = require('../../../sdk/js/imagery/terra_texture_tiles')
function projectedDrawDimensions(frame, draw, positions, viewport) {
  if (!frame || !frame.projectionView || !frame.cameraPosition ||
    !positions || !viewport) {
    return { width: 0, height: 0, unclippedWidth: 0, unclippedHeight: 0,
      centerDistance: Number.POSITIVE_INFINITY }
  }
  const matrix = frame.projectionView
  let minimumX = Number.POSITIVE_INFINITY
  let maximumX = Number.NEGATIVE_INFINITY
  let minimumY = Number.POSITIVE_INFINITY
  let maximumY = Number.NEGATIVE_INFINITY
  let projected = 0
  for (let vertex = 0; vertex < draw.vertexCount; ++vertex) {
    const offset = (draw.firstVertex + vertex) * 3
    const x = positions[offset] + draw.origin[0]
    const y = positions[offset + 1] + draw.origin[1]
    const z = positions[offset + 2] + draw.origin[2]
    const clipX = matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3]
    const clipY = matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7]
    const clipW = matrix[12] * x + matrix[13] * y + matrix[14] * z + matrix[15]
    if (!Number.isFinite(clipW) || clipW <= 0.000001) continue
    const nx = clipX / clipW
    const ny = clipY / clipW
    minimumX = Math.min(minimumX, nx)
    maximumX = Math.max(maximumX, nx)
    minimumY = Math.min(minimumY, ny)
    maximumY = Math.max(maximumY, ny)
    projected += 1
  }
  if (!projected || maximumX < -1 || minimumX > 1 || maximumY < -1 ||
    minimumY > 1) {
    return { width: 0, height: 0, unclippedWidth: 0, unclippedHeight: 0,
      centerDistance: Number.POSITIVE_INFINITY }
  }
  const dpr = Math.max(1, viewport.devicePixelRatio || 1)
  const width = Math.max(1, viewport.width || 1) / dpr
  const height = Math.max(1, viewport.height || 1) / dpr
  const clippedMinimumX = Math.max(-1, minimumX)
  const clippedMaximumX = Math.min(1, maximumX)
  const clippedMinimumY = Math.max(-1, minimumY)
  const clippedMaximumY = Math.min(1, maximumY)
  const centerX = (clippedMinimumX + clippedMaximumX) * 0.5
  const centerY = (clippedMinimumY + clippedMaximumY) * 0.5
  return {
    width: (clippedMaximumX - clippedMinimumX) * width * 0.5,
    height: (clippedMaximumY - clippedMinimumY) * height * 0.5,
    unclippedWidth: (maximumX - minimumX) * width * 0.5,
    unclippedHeight: (maximumY - minimumY) * height * 0.5,
    centerDistance: Math.sqrt(centerX * centerX + centerY * centerY)
  }
}

function projectedDrawExtent(frame, draw, positions, viewport) {
  const dimensions = projectedDrawDimensions(frame, draw, positions, viewport)
  return Math.max(dimensions.width, dimensions.height)
}

function childBounds(candidate, levelDelta) {
  const scale = Math.pow(2, levelDelta)
  const epsilon = 0.000000001
  return {
    minimumColumn: common.clamp(Math.floor(candidate.uv.minimumU * scale),
      0, scale - 1),
    maximumColumn: common.clamp(Math.floor(
      candidate.uv.maximumU * scale - epsilon), 0, scale - 1),
    minimumRow: common.clamp(Math.floor(candidate.uv.minimumV * scale),
      0, scale - 1),
    maximumRow: common.clamp(Math.floor(
      candidate.uv.maximumV * scale - epsilon), 0, scale - 1)
  }
}

function childCount(candidate, levelDelta) {
  if (levelDelta < 0) return 1
  const bounds = childBounds(candidate, levelDelta)
  return (bounds.maximumColumn - bounds.minimumColumn + 1) *
    (bounds.maximumRow - bounds.minimumRow + 1)
}

function candidateTextureTiles(candidate, allocation) {
  if (!candidate.tileCache) candidate.tileCache = new Map()
  if (candidate.tileCache.has(allocation)) return candidate.tileCache.get(allocation)
  if (allocation < 0) {
    return [textureTileAtDelta(candidate.draw.texture, allocation)]
  }
  const bounds = childBounds(candidate, allocation)
  const result = []
  for (let row = bounds.minimumRow; row <= bounds.maximumRow; ++row) {
    for (let column = bounds.minimumColumn;
      column <= bounds.maximumColumn; ++column) {
      const scale = Math.pow(2, allocation)
      if (candidate.hull && !surfacePlan.intersectsCell(candidate.hull,
        column / scale, row / scale, (column + 1) / scale, (row + 1) / scale)) continue
      result.push(descendantTextureTile(candidate.draw.texture, allocation, row, column))
    }
  }
  candidate.tileCache.set(allocation, result)
  return result
}

function replaceTextureRefs(refs, previous, next) {
  previous.forEach((tile) => {
    const key = tileKey(tile)
    const count = refs.get(key) || 0
    if (count <= 1) refs.delete(key)
    else refs.set(key, count - 1)
  })
  next.forEach((tile) => {
    const key = tileKey(tile)
    refs.set(key, (refs.get(key) || 0) + 1)
  })
}

function replacementTextureCount(refs, previous, next) {
  const deltas = new Map()
  previous.forEach((tile) => {
    const key = tileKey(tile)
    deltas.set(key, (deltas.get(key) || 0) - 1)
  })
  next.forEach((tile) => {
    const key = tileKey(tile)
    deltas.set(key, (deltas.get(key) || 0) + 1)
  })
  let count = refs.size
  deltas.forEach((delta, key) => {
    const before = refs.get(key) || 0
    const after = before + delta
    if (before > 0 && after <= 0) count -= 1
    if (before <= 0 && after > 0) count += 1
  })
  return count
}

function candidatePriority(candidate) {
  const error = candidate.pixelError / Math.pow(2, candidate.allocated)
  const distance = Number.isFinite(candidate.centerDistance)
    ? candidate.centerDistance : 4
  return error / (1 + distance * 0.5)
}

function maximumTerrainTextureLevel(draw, draws) {
  let result = draw.texture.level
  const candidates = draws || []
  candidates.forEach((candidate) => {
    if (!candidate.key || !candidate.texture ||
      !textureTileContains(draw.texture, candidate.texture)) {
      return
    }
    const geometryLevel = Math.max(0, Number(candidate.key.level) || 0)
    result = Math.max(result, Math.floor(geometryLevel / 2))
  })
  return result
}

function terrainTextureLevelIndex(draws) {
  const result = new Map()
  ;(draws || []).forEach((draw) => {
    if (!draw.key || !draw.texture) return
    const geometryLevel = Math.max(0, Number(draw.key.level) || 0)
    let tile = draw.texture
    while (tile) {
      const key = tileKey(tile)
      result.set(key, Math.max(result.get(key) || tile.level,
        Math.floor(geometryLevel / 2)))
      tile = parentTextureTile(tile)
    }
  })
  return result
}

function refineImageryDraws(frame, draws, positions, textureUv, viewport,
  descriptor, options) {
  const value = options || {}
  const targetPixelError = value.targetPixelError || 1.25
  const maximumSubdivisionLevels = Number.isInteger(
    value.maximumSubdivisionLevels) ? value.maximumSubdivisionLevels : 6
  const additionalDraws = Number.isInteger(value.maximumDraws)
    ? Math.max(0, value.maximumDraws) : 512
  const maximumDraws = draws.length + additionalDraws
  const maximumTextures = Number.isInteger(value.maximumTextures)
    ? Math.max(1, value.maximumTextures) : Number.MAX_SAFE_INTEGER
  const tileSize = Number(descriptor && descriptor.tile_size) || 256
  const maximumLevel = Number.isInteger(descriptor && descriptor.maximum_level)
    ? descriptor.maximum_level : 0
  const terrainLevels = value.terrainBound
    ? terrainTextureLevelIndex(draws) : null
  const candidates = draws.map((draw, index) => {
    const measurement = value.measureDraw ? value.measureDraw(draw) : null
    const dimensions = measurement ? null : projectedDrawDimensions(frame, draw, positions, viewport)
    const uv = measurement && measurement.bounds || drawUvBounds(draw, textureUv)
    const uvWidth = Math.max(1 / tileSize, uv.maximumU - uv.minimumU)
    const uvHeight = Math.max(1 / tileSize, uv.maximumV - uv.minimumV)
    const pixelError = measurement ? measurement.pixelsPerUv / tileSize : Math.max(
      dimensions.unclippedWidth / (tileSize * uvWidth),
      dimensions.unclippedHeight / (tileSize * uvHeight))
    const available = Math.max(0, maximumLevel - draw.texture.level)
    const minimumAllocation = -draw.texture.level
    const terrainAvailable = value.terrainBound
      ? Math.max(0, Math.max(draw.texture.level,
        terrainLevels.get(tileKey(draw.texture)) || 0) -
        draw.texture.level)
      : available
    const maximumAllocation = Math.min(maximumSubdivisionLevels, available,
      terrainAvailable)
    const required = pixelError > 0
      ? Math.ceil(Math.log(pixelError / targetPixelError) / Math.log(2))
      : minimumAllocation
    let desired = common.clamp(required, minimumAllocation, maximumAllocation)
    const previous = value.previousLevels && value.previousLevels.get(geometryKey(draw))
    const previousDelta = previous === undefined ? minimumAllocation : previous - draw.texture.level
    // Coarsening has a separate threshold; actual quality is never relaxed.
    if (previousDelta > desired && pixelError > 0) {
      desired = Math.min(previousDelta, maximumAllocation, Math.max(desired,
        Math.ceil(Math.log(pixelError / (targetPixelError * 0.7)) / Math.LN2)))
    }
    const allocated = common.clamp(previous === undefined ? Math.min(0, desired)
      : previousDelta, minimumAllocation, desired)
    const candidate = {
      draw,
      index,
      uv,
      hull: measurement && measurement.hull,
      pixelError,
      centerDistance: measurement ? measurement.centerDistance : dimensions.centerDistance,
      required,
      desired,
      allocated
    }
    candidate.tiles = candidateTextureTiles(candidate, allocated)
    return candidate
  })
  const textureRefs = new Map()
  candidates.forEach((candidate) =>
    replaceTextureRefs(textureRefs, [], candidate.tiles))
  let drawCost = candidates.reduce((sum, candidate) =>
    sum + candidate.tiles.length, 0)

  while (textureRefs.size > maximumTextures || drawCost > maximumDraws) {
    let selected = null
    candidates.forEach((candidate) => {
      if (candidate.allocated <= -candidate.draw.texture.level) return
      const allocation = candidate.allocated - 1
      const tiles = candidateTextureTiles(candidate, allocation)
      const textureCount = replacementTextureCount(textureRefs,
        candidate.tiles, tiles)
      const priority = candidatePriority(candidate)
      const reduction = textureRefs.size - textureCount
      if (!selected || priority < selected.priority ||
        (priority === selected.priority && reduction > selected.reduction) ||
        (priority === selected.priority && reduction === selected.reduction &&
          candidate.index > selected.candidate.index)) {
        selected = { candidate, allocation, tiles, textureCount,
          priority, reduction }
      }
    })
    if (!selected) break
    drawCost += selected.tiles.length - selected.candidate.tiles.length
    replaceTextureRefs(textureRefs, selected.candidate.tiles, selected.tiles)
    selected.candidate.allocated = selected.allocation
    selected.candidate.tiles = selected.tiles
  }

  while (drawCost < maximumDraws) {
    let selected = null
    candidates.forEach((candidate) => {
      if (candidate.allocated >= candidate.desired) return
      const allocation = candidate.allocated + 1
      const tiles = candidateTextureTiles(candidate, allocation)
      const textureCount = replacementTextureCount(textureRefs,
        candidate.tiles, tiles)
      const nextDrawCost = drawCost + tiles.length - candidate.tiles.length
      if (textureCount > maximumTextures || nextDrawCost > maximumDraws) return
      const priority = candidatePriority(candidate)
      if (!selected || priority > selected.priority ||
        (priority === selected.priority &&
          candidate.centerDistance < selected.candidate.centerDistance) ||
        (priority === selected.priority &&
          candidate.centerDistance === selected.candidate.centerDistance &&
          candidate.index < selected.candidate.index)) {
        selected = { candidate, allocation, tiles, textureCount,
          nextDrawCost, priority }
      }
    })
    if (!selected) break
    replaceTextureRefs(textureRefs, selected.candidate.tiles, selected.tiles)
    selected.candidate.allocated = selected.allocation
    selected.candidate.tiles = selected.tiles
    drawCost = selected.nextDrawCost
  }

  const idealTextures = new Set()
  const desiredCountBound = candidates.reduce((sum, candidate) =>
    sum + childCount(candidate, candidate.desired), 0)
  const countIsUpperBound = desiredCountBound > Math.max(4096, Math.min(16384, maximumTextures * 4))
  if (!countIsUpperBound) candidates.forEach((candidate) => {
    candidateTextureTiles(candidate, candidate.desired).forEach((tile) =>
      idealTextures.add(tileKey(tile)))
  })
  const textureBudgetLimited = candidates.some(candidate => candidate.allocated < candidate.desired &&
    replacementTextureCount(textureRefs, candidate.tiles,
      candidateTextureTiles(candidate, candidate.allocated + 1)) > maximumTextures)
  const result = []
  const coverageDraws = []
  let maximumMeasuredError = 0
  let limitedByBudget = false
  let coarsenedDrawCount = 0
  let minimumSelectedLevel = Number.POSITIVE_INFINITY
  let maximumSelectedLevel = Number.NEGATIVE_INFINITY
  candidates.forEach((candidate) => {
    const measuredError = candidate.pixelError /
      Math.pow(2, candidate.allocated)
    maximumMeasuredError = Math.max(maximumMeasuredError, measuredError)
    limitedByBudget = limitedByBudget || candidate.allocated < candidate.desired
    if (candidate.allocated < 0) coarsenedDrawCount += 1
    if (candidate.allocated > 0) {
      const coverageTile = textureTileAtDelta(candidate.draw.texture,
        -candidate.draw.texture.level)
      const coverageTransform = textureCellTransform(candidate.draw.texture,
        coverageTile)
      coverageDraws.push(Object.assign({}, candidate.draw, {
        texture: coverageTile,
        imageryCellScale: coverageTransform.scale,
        imageryCellOffsetX: coverageTransform.offsetX,
        imageryCellOffsetY: coverageTransform.offsetY,
        imageryClipCell: false,
        imageryCoverageDraw: true,
        imageryPixelError: measuredError,
        imageryPriority: 1000000,
        imageryDesiredLevel: candidate.draw.texture.level + candidate.desired
      }))
    }
    candidate.tiles.forEach((tile) => {
      const transform = textureCellTransform(candidate.draw.texture, tile)
      minimumSelectedLevel = Math.min(minimumSelectedLevel, tile.level)
      maximumSelectedLevel = Math.max(maximumSelectedLevel, tile.level)
      result.push(Object.assign({}, candidate.draw, {
        texture: tile,
        sourceTexture: candidate.draw.texture,
        imageryCellScale: transform.scale,
        imageryCellOffsetX: transform.offsetX,
        imageryCellOffsetY: transform.offsetY,
        imageryClipCell: candidate.allocated > 0,
        imageryCoverageDraw: false,
        imageryPixelError: measuredError,
        imageryPriority: candidatePriority(candidate),
        imageryDesiredLevel: candidate.draw.texture.level + candidate.desired
      }))
    })
  })
  return {
    draws: result,
    coverageDraws,
    levels: new Map(candidates.map(c => [geometryKey(c.draw), c.draw.texture.level + c.allocated])),
    quality: {
      targetPixelError,
      measuredMaxPixelError: maximumMeasuredError,
      desiredDrawCount: candidates.reduce((sum, candidate) =>
        sum + childCount(candidate, candidate.desired), 0),
      sourceDrawCount: candidates.length,
      renderedDrawCount: result.length,
      coverageDrawCount: coverageDraws.length,
      clippedDrawCount: result.reduce((count, draw) =>
        count + (draw.imageryClipCell ? 1 : 0), 0),
      coverageGuaranteed: coverageDraws.length === candidates.filter(
        (candidate) => candidate.allocated > 0).length,
      desiredTextureCount: countIsUpperBound ? desiredCountBound : idealTextures.size,
      desiredTextureCountIsUpperBound: countIsUpperBound,
      selectedTextureCount: textureRefs.size,
      maximumTextureCount: maximumTextures,
      coarsenedDrawCount,
      selectedLevelMinimum: Number.isFinite(minimumSelectedLevel)
        ? minimumSelectedLevel : null,
      selectedLevelMaximum: Number.isFinite(maximumSelectedLevel)
        ? maximumSelectedLevel : null,
      limitedByTextureBudget: textureBudgetLimited,
      limitedByBudget,
      limitedByProjection: candidates.some(candidate => !Number.isFinite(candidate.pixelError)),
      limitedByLevel: candidates.some((candidate) =>
        candidate.required > candidate.desired),
      meetsTarget: maximumMeasuredError <= targetPixelError * 1.001
    }
  }
}


module.exports = {refineImageryDraws, maximumTerrainTextureLevel, projectedDrawExtent}
