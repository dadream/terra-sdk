// Test-only canonical 4b960e4 display footprint algorithm.
// Keep projection pruning here independent of the persistent world implementation.
const {textureKeyString: tileKey} = require('../../../sdk/js/core/terra_globe_common')
const {textureTileContains, parentTextureTile, descendantTextureTile, textureCellTransform} = require('../../../sdk/js/imagery/terra_texture_tiles')
const surfacePlan = require('../../../sdk/js/terrain/terra_surface_plan')
const {MeasurementRows} = require('../../../sdk/js/terrain/measurement_rows')

// The canonical cell footprint used by both display and production planning.
// A prospective texture view changes readiness only; it owns no GPU resources
// and cannot publish presentation or queue UV production.
function imageryDraws(renderer, draws, textures, presentation, handover, prepare = true, members, footprintCache) {
  const currentCamera = renderer.plannedCameraVersion === renderer.cameraVersion
  const quality = renderer.current.imageryPlan && renderer.current.imageryPlan.quality
  const coarsening = currentCamera && quality && quality.coarsening
  if (!currentCamera) handover.clear()
  const finer = tile => Array.from(renderer.presentedTextures.values()).filter(child =>
    child.level > tile.level && textureTileContains(tile,child))
  handover.forEach((tile,key) => {
    if (!textures.targetDesired.has(key) || !finer(tile).length) handover.delete(key)
  })
  if (currentCamera && !handover.size && quality &&
      (textures.admissionBlocked.size || coarsening && textures.blockedByCapacity) &&
      (quality.planningComplete || coarsening)) {
    const groups = new Map()
    draws.forEach(draw => {
      const key = tileKey(draw.texture)
      if (!textures.targetDesired.has(key) || !renderer.measureDraw(draw).visible || !finer(draw.texture).length) return
      const fallback = textures.presentationTileFor(draw.texture)
      if (!textures.gpuReady(tileKey(fallback))) return
      const error = renderer.measureTextureDraw(draw,fallback.level)
      const previous = groups.get(key)
      groups.set(key,{tile:draw.texture,error:Math.max(error,previous ? previous.error : 0)})
    })
    const candidate = Array.from(groups.values()).filter(group => Number.isFinite(group.error))
      .sort((a,b)=>a.error-b.error)[0]
    // One local cell uses its ready ancestor to free slots for the demanded
    // cut. Keep the precision demand alive and pin old images until submission.
    if (candidate) handover.set(tileKey(candidate.tile),candidate.tile)
  }
  const branches = new Set()
  renderer.presentedTextures.forEach(tile => {
    if (!textures.cache.has(tileKey(tile))) return
    let parent = parentTextureTile(tile)
    while (parent) {
      const id = tileKey(parent)
      if (branches.has(id)) break // An indexed parent already contributed its ancestors.
      branches.add(id)
      parent = parentTextureTile(parent)
    }
  })
  const result = []
  const read = (kind, arg, level) => {
    switch (kind) {
      case 'measurement': return renderer.measureDraw(draws[arg])
      case 'fallback': return textures.presentationTileFor(draws[arg].texture)
      case 'branch': return branches.has(arg)
      case 'handover': return handover.has(arg)
      case 'available': return textures.availableKeys.has(arg)
      case 'cached': return textures.cache.has(arg)
      case 'ready': return textures.gpuReady(arg)
      case 'error': return renderer.measureTextureDraw(draws[arg], level)
      default: throw new Error('Unknown imagery footprint dependency')
    }
  }
  const target = renderer.options.imageryPixelError || 1.25
  const build = (indices, probe) => {
    const rows = [], visited = new Set()
    for (const index of indices) {
      const draw = draws[index], measured = probe('measurement', index)
      if (!renderer.terrainBoundImagery && measured.visible === false) continue
      const source = draw.sourceTexture || draw.texture
      const visit = tile => {
        const key = tileKey(tile), drawKey = `${draw.geometryKey}:${key}`
        if (visited.has(drawKey)) return
        if (!textureTileContains(source, tile) && !textureTileContains(tile, source)) return
        const t = textureCellTransform(source, tile)
        if (measured.hull && !surfacePlan.intersectsCell(measured.hull, -t.offsetX / t.scale,
          -t.offsetY / t.scale, (1 - t.offsetX) / t.scale, (1 - t.offsetY) / t.scale)) return
        const loU=-t.offsetX/t.scale,hiU=(1-t.offsetX)/t.scale
        const loV=-t.offsetY/t.scale,hiV=(1-t.offsetY)/t.scale
        if (!renderer.terrainBoundImagery && measured.regions && !(measured.regions instanceof MeasurementRows
          ? measured.regions.intersects(loU,loV,hiU,hiV) : measured.regions.some(region => {
          const b=region.uv
          return b.maximumU>loU && b.minimumU<hiU && b.maximumV>loV && b.minimumV<hiV
        }))) return
        // Only an accepted footprint suppresses later overlapping input rows.
        visited.add(drawKey)
        if (probe('branch', key) && !probe('handover', key)) {
          const exact = probe('available', key) && probe('cached', key)
          const coarseReady = currentCamera && probe('ready', key) && probe('error', index, tile.level) <= target
          const preserve = !(currentCamera && draw.imageryCapacityCoarsened && tile.level >= draw.texture.level) &&
            probe('error', index, tile.level) > target * 0.8
          if ((!exact || preserve) && !coarseReady) {
            for (let row = 0; row < 2; ++row) for (let column = 0; column < 2; ++column)
              visit(descendantTextureTile(tile, 1, row, column))
            return
          }
        }
        rows.push(index, tile.level, tile.matrix, tile.row, tile.column, t.scale, t.offsetX, t.offsetY)
      }
      visit(probe('handover', tileKey(draw.texture)) ? draw.texture : probe('fallback', index))
    }
    return rows
  }
  const emit = (rows, offset) => {
    const draw = draws[rows[offset]], source = draw.sourceTexture || draw.texture
    const tile = {level:rows[offset+1],matrix:rows[offset+2],row:rows[offset+3],column:rows[offset+4]}
    result.push(Object.assign({}, draw, {texture:tile, sourceTexture:source,
      imageryCellScale:rows[offset+5], imageryCellOffsetX:rows[offset+6], imageryCellOffsetY:rows[offset+7],
      imageryClipCell:tile.level > source.level}))
  }
  if (footprintCache) footprintCache.collect(draws,
    [currentCamera,!!renderer.terrainBoundImagery,target].join(':'), read, build, emit)
  else {
    const rows = build(draws.map((_,index)=>index), read)
    for (let offset=0;offset<rows.length;offset+=8) emit(rows,offset)
  }
  if (!prepare) return result
  const cells = []
  const goals = new Map(result.map(draw => [draw, renderer.presentationBridges.find(goal =>
    textureTileContains(goal, draw.texture)) || textures.get(draw.texture, false).resolvedTile]))
  presentation.setGoals(Array.from(goals.values()).filter(Boolean))
  const footprints = new Map()
  for (const draw of result) {
    if (!goals.get(draw)) continue
    if (!footprints.has(draw.geometryKey)) footprints.set(draw.geometryKey, new Set())
    footprints.get(draw.geometryKey).add(tileKey(draw.texture))
  }
  result.forEach(draw => {
    // Local production uses the global goals above, including goals contributed
    // by other meshes, but only prepares the participating mesh footprints.
    if (members && !members.has(draw.geometryKey)) return
    // Ready fallbacks can overlap even though requested cells form a cut.
    // Expand each mesh's outer footprint once. Keep every goal above: cover()
    // still splits around finer ready images and unfinished old transitions.
    const footprint = footprints.get(draw.geometryKey)
    for (let tile = parentTextureTile(draw.texture); tile; tile = parentTextureTile(tile))
      if (footprint && footprint.has(tileKey(tile))) return
    const goal = goals.get(draw)
    if (!goal) { cells.push(draw); return }
    const source = draw.sourceTexture || draw.texture
    const geometry = renderer.geometry.get(draw.geometryKey)
    const intersects = tile => {
      if (!geometry) return true
      const t = textureCellTransform(source, tile)
      return surfacePlan.intersectsCell(geometry.model.hull,
        -t.offsetX / t.scale, -t.offsetY / t.scale,
        (1 - t.offsetX) / t.scale, (1 - t.offsetY) / t.scale)
    }
    presentation.cover(draw.texture, goal, (tile, target) => {
      const t = textureCellTransform(source, tile)
      const bridge = renderer.presentationBridges.find(goal => textureTileContains(goal, tile))
      cells.push(Object.assign({}, draw, {texture: tile, imageryTarget: target,
        imageryHandover: Boolean(bridge),
        imageryCellScale: t.scale, imageryCellOffsetX: t.offsetX,
        imageryCellOffsetY: t.offsetY, imageryClipCell: tile.level > source.level}))
    }, intersects)
  })
  return cells
}

module.exports = {imageryDraws}
