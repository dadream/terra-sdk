const {textureTileAtDelta} = require('./texture_tile_delta')
// Test oracle; production uses the native unified imagery planner.
const common = require('../../../sdk/js/core/terra_globe_common')
const {drawUvBounds} = require('./draw_uv_bounds')
const surfacePlan = require('../../../sdk/js/terrain/terra_surface_plan')
const { textureCellTransform, descendantTextureTile } = require('../../../sdk/js/imagery/terra_texture_tiles')

function planImageryFrontier(frame, draws, positions, textureUv, viewport, descriptor, options) {
  const value = options || {}
  const target = value.targetPixelError || 1.25
  const tileSize = Number(descriptor && descriptor.tile_size) || 256
  const maxLevel = Number(descriptor && descriptor.maximum_level) || 0
  const maxTextures = value.maximumTextures || Number.MAX_SAFE_INTEGER
  const maxDraws = draws.length + (Number.isInteger(value.maximumDraws) ? value.maximumDraws : 512)
  const previous = value.previousLevels || new Set()
  const roots = new Map()
  const intersects = (a, b) => a.minimumU < b.maximumU && a.maximumU > b.minimumU &&
    a.minimumV < b.maximumV && a.maximumV > b.minimumV
  const cellBounds = (source, tile) => {
    const t = textureCellTransform(source, tile)
    return { minimumU: -t.offsetX / t.scale, maximumU: (1 - t.offsetX) / t.scale,
      minimumV: -t.offsetY / t.scale, maximumV: (1 - t.offsetY) / t.scale }
  }
  const candidates = []
  draws.forEach(draw => {
    const m = value.measureDraw(draw)
    if (!m.visible) return
    const candidate = { draw, hull: m.hull, regions: m.regions || [{ uv: m.bounds ||
      drawUvBounds(draw, textureUv), pixelsPerUv: m.pixelsPerUv }] }
    candidates.push(candidate)
    const tile = textureTileAtDelta(draw.texture, -draw.texture.level)
    const key = common.textureKeyString(tile)
    if (!roots.has(key)) roots.set(key, { tile, refs: [] })
    roots.get(key).refs.push({ candidate, regions: candidate.regions })
  })
  const makeNode = (tile, refs) => {
    let error = 0
    refs.forEach(ref => ref.regions.forEach(region => {
      error = Math.max(error, region.pixelsPerUv /
        (tileSize * Math.pow(2, tile.level - ref.candidate.draw.texture.level)))
    }))
    return { tile, refs, error, key: common.textureKeyString(tile), children: null }
  }
  const childrenOf = node => {
    if (node.children) return node.children
    const children = []
    for (let row = 0; row < 2; ++row) for (let column = 0; column < 2; ++column) {
      const tile = descendantTextureTile(node.tile, 1, row, column)
      const refs = []
      node.refs.forEach(ref => {
        const c = ref.candidate, bounds = cellBounds(c.draw.texture, tile)
        if (c.hull && !surfacePlan.intersectsCell(c.hull,
          bounds.minimumU, bounds.minimumV, bounds.maximumU, bounds.maximumV)) return
        const regions = ref.regions.filter(region => intersects(region.uv, bounds))
        if (regions.length) refs.push({ candidate: c, regions })
      })
      if (refs.length) children.push(makeNode(tile, refs))
    }
    node.children = children
    return children
  }
  const leaves = new Map(Array.from(roots.values(), r => {
    const node = makeNode(r.tile, r.refs)
    return [node.key, node]
  }))
  let drawCount = candidates.length
  const splits = new Set()
  let limitedByBudget = false, limitedByTextureBudget = false, limitedByLevel = false
  // Rebuild deterministically from roots. History is keyed by imagery region,
  // so changes to terrain topology cannot change the allocation order.
  while (true) {

    let selected = null
    leaves.forEach(node => {
      const threshold = previous.has(node.key) ? target * 0.8 : target
      if (node.error <= threshold || (!Number.isFinite(node.error) && !previous.has(node.key))) return
      if (node.tile.level >= maxLevel) { limitedByLevel = node.error > target; return }
      const children = childrenOf(node)
      if (!children.length) return
      const nextTextures = leaves.size - 1 + children.length
      const nextDraws = drawCount - node.refs.length + children.reduce((n, c) => n + c.refs.length, 0)
      if (nextTextures > maxTextures || nextDraws > maxDraws) {
        if (node.error > target) limitedByBudget = true
        if (nextTextures > maxTextures && node.error > target) limitedByTextureBudget = true
        return
      }
      if (!selected || node.error > selected.node.error ||
          (node.error === selected.node.error && node.key < selected.node.key)) {
        selected = { node, children, nextDraws }
      }
    })
    if (!selected) break
    leaves.delete(selected.node.key)
    selected.children.forEach(child => leaves.set(child.key, child))
    splits.add(selected.node.key)
    drawCount = selected.nextDraws
  }
  const result = []
  let measuredMaxPixelError = 0, minimumLevel = Infinity, maximumLevel = -Infinity
  Array.from(leaves.values()).sort((a, b) => a.key.localeCompare(b.key)).forEach(node => {
    measuredMaxPixelError = Math.max(measuredMaxPixelError, node.error)
    minimumLevel = Math.min(minimumLevel, node.tile.level)
    maximumLevel = Math.max(maximumLevel, node.tile.level)
    node.refs.forEach(ref => {
      const draw = ref.candidate.draw, t = textureCellTransform(draw.texture, node.tile)
      result.push(Object.assign({}, draw, { texture: node.tile, sourceTexture: draw.texture,
        imageryCellScale: t.scale, imageryCellOffsetX: t.offsetX, imageryCellOffsetY: t.offsetY,
        imageryClipCell: node.tile.level > draw.texture.level, imageryCoverageDraw: false,
        imageryPixelError: node.error, imageryPriority: node.error,
        imageryDesiredLevel: node.tile.level,
        imageryCapacityCoarsened: limitedByBudget && node.error > target }))
    })
  })
  return { draws: result, coverageDraws: [], levels: splits, quality: {
    targetPixelError: target, feasiblePixelError: Math.max(target, measuredMaxPixelError),
    measuredMaxPixelError, sourceDrawCount: candidates.length,
    renderedDrawCount: result.length, desiredDrawCount: result.length,
    selectedTextureCount: leaves.size, maximumTextureCount: maxTextures,
    desiredTextureCount: leaves.size, desiredTextureCountIsUpperBound: false,
    selectedLevelMinimum: Number.isFinite(minimumLevel) ? minimumLevel : null,
    selectedLevelMaximum: Number.isFinite(maximumLevel) ? maximumLevel : null,
    clippedDrawCount: result.filter(draw => draw.imageryClipCell).length,
    coarsenedDrawCount: result.filter(draw => draw.texture.level < draw.sourceTexture.level).length,
    coverageDrawCount: 0, coverageGuaranteed: true, limitedByBudget, limitedByTextureBudget,
    limitedByLevel, limitedByProjection: !Number.isFinite(measuredMaxPixelError),
    meetsTarget: measuredMaxPixelError <= target * 1.001, spatialCut: true
  } }
}


module.exports = { planImageryFrontier }
