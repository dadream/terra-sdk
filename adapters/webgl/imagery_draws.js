const {textureKeyString: tileKey} = require('../../sdk/js/core/terra_globe_common')
const {textureTileContains, parentTextureTile, descendantTextureTile, textureCellTransform} = require('../../sdk/js/imagery/terra_texture_tiles')
const surfacePlan = require('../../sdk/js/terrain/terra_surface_plan')
const {MeasurementRows} = require('../../sdk/js/terrain/measurement_rows')

// The canonical cell footprint used by both display and production planning.
// A prospective texture view changes readiness only; it owns no GPU resources
// and cannot publish presentation or queue UV production.
function finish(work) {
  let result
  do { result = work.next() } while (!result.done)
  return result.value
}

function imageryDraws(renderer, draws, textures, presentation, handover, prepare = true, members, footprintCache) {
  return finish(imageryDrawWork(renderer, draws, textures, presentation, handover,
    {prepare, members, footprintCache}))
}

// One canonical algorithm for immediate pricing and resumable display work.
// World output omits only projection filtering; the caller must filter with
// the live camera before drawing. It never supplies an old quality proof.
function* imageryDrawWork(renderer, draws, textures, presentation, handover, options = {}) {
  const {members, footprintCache} = options
  const world = Boolean(options.world), reserve = options.reserve || (() => {})
  const currentCamera = renderer.plannedCameraVersion === renderer.cameraVersion
  const quality = renderer.current.imageryPlan && renderer.current.imageryPlan.quality
  const coarsening = currentCamera && quality && quality.coarsening
  if (!currentCamera) handover.clear()
  function* finer(tile) {
    for (const child of renderer.presentedTextures.values()) {
      yield
      if (child.level > tile.level && textureTileContains(tile,child)) return true
    }
    return false
  }
  for (const [key, tile] of handover) {
    yield
    if (!textures.targetDesired.has(key) || !(yield* finer(tile))) handover.delete(key)
  }
  if (currentCamera && !handover.size && quality &&
      (textures.admissionBlocked.size || coarsening && textures.blockedByCapacity) &&
      (quality.planningComplete || coarsening)) {
    const groups = new Map()
    for (const draw of draws) {
      yield
      const key = tileKey(draw.texture)
      if (!textures.targetDesired.has(key) || !renderer.measureDraw(draw).visible || !(yield* finer(draw.texture))) continue
      const usable=textures.capacityView||textures
      const fallback = usable.presentationTileFor(draw.texture)
      if (!usable.gpuReady(tileKey(fallback))) continue
      const error = renderer.measureTextureDraw(draw,fallback.level)
      const previous = groups.get(key)
      if (!previous) reserve(128 + key.length * 2)
      groups.set(key,{tile:draw.texture,error:Math.max(error,previous ? previous.error : 0)})
    }
    let candidate
    for (const group of groups.values()) {
      yield
      if (Number.isFinite(group.error) && (!candidate || group.error < candidate.error)) candidate = group
    }
    // One local cell uses its ready ancestor to free slots for the demanded
    // cut. Keep the precision demand alive and pin old images until submission.
    if (candidate) handover.set(tileKey(candidate.tile),candidate.tile)
  }
  const branches = new Set()
  for (const tile of renderer.presentedTextures.values()) {
    yield
    if (!textures.cache.has(tileKey(tile))) continue
    let parent = parentTextureTile(tile)
    while (parent) {
      yield
      const id = tileKey(parent)
      if (branches.has(id)) break // An indexed parent already contributed its ancestors.
      reserve(64 + id.length * 2)
      branches.add(id)
      parent = parentTextureTile(parent)
    }
  }
  const result = []
  const branchView=textures.branchView||textures
  const read = (kind, arg, level) => {
    switch (kind) {
      case 'hull': return renderer.measureDraw(draws[arg]).hull
      case 'fallback': return textures.presentationTileFor(draws[arg].texture)
      case 'branch': return branches.has(arg)
      case 'handover': return handover.has(arg)
      case 'available': return branchView.availableKeys.has(arg)
      case 'cached': return branchView.cache.has(arg)
      case 'ready': return branchView.gpuReady(arg)
      case 'coarse-acceptable': return currentCamera && renderer.measureTextureDraw(draws[arg], level) <= target
      case 'preserve': return !(currentCamera && draws[arg].imageryCapacityCoarsened && level >= draws[arg].texture.level) &&
        renderer.measureTextureDraw(draws[arg], level) > target * 0.8
      default: throw new Error('Unknown imagery footprint dependency')
    }
  }
  const target = renderer.options.imageryPixelError || 1.25
  function* build(indices, probe) {
    const rows = [], visited = new Set(), hulls = new Map()
    let stackCapacity = 0
    const capacity = size => {
      if (size > stackCapacity) { reserve((size - stackCapacity) * 96); stackCapacity = size }
    }
    for (const index of indices) {
      yield
      const draw = draws[index]
      const source = draw.sourceTexture || draw.texture
      capacity(1)
      const stack = [probe('handover', tileKey(draw.texture)) ? draw.texture : probe('fallback', index)]
      while (stack.length) {
        yield
        const tile = stack.pop()
        const key = tileKey(tile), drawKey = `${draw.geometryKey}:${key}`
        if (visited.has(drawKey)) continue
        if (!textureTileContains(source, tile) && !textureTileContains(tile, source)) continue
        if (!hulls.has(index)) { reserve(64); hulls.set(index,probe('hull', index)) }
        const hull=hulls.get(index)
        const t = textureCellTransform(source, tile)
        if (hull && !surfacePlan.intersectsCell(hull, -t.offsetX / t.scale,
          -t.offsetY / t.scale, (1 - t.offsetX) / t.scale, (1 - t.offsetY) / t.scale)) continue
        // Only an accepted footprint suppresses later overlapping input rows.
        reserve(64 + drawKey.length * 2)
        visited.add(drawKey)
        if (probe('branch', key) && !probe('handover', key)) {
          const exact = probe('available', key) && probe('cached', key)
          const coarseReady = probe('ready', key) && probe('coarse-acceptable', index, tile.level)
          const preserve = probe('preserve', index, tile.level)
          if ((!exact || preserve) && !coarseReady) {
            capacity(stack.length + 4)
            for (let row = 1; row >= 0; --row) for (let column = 1; column >= 0; --column)
              stack.push(descendantTextureTile(tile, 1, row, column))
            continue
          }
        }
        reserve(8 * Float64Array.BYTES_PER_ELEMENT)
        rows.push(index, tile.level, tile.matrix, tile.row, tile.column, t.scale, t.offsetX, t.offsetY)
      }
    }
    return rows
  }
  const visible = (rows, offset, index) => {
    const measured = renderer.measureDraw(draws[index])
    if (measured.visible === false) return false
    if (!measured.regions) return true
    const scale=rows[offset+5],x=rows[offset+6],y=rows[offset+7]
    const loU=-x/scale,hiU=(1-x)/scale,loV=-y/scale,hiV=(1-y)/scale
    return measured.regions instanceof MeasurementRows ? measured.regions.intersects(loU,loV,hiU,hiV) :
      measured.regions.some(region => {
        const b=region.uv
        return b.maximumU>loU && b.minimumU<hiU && b.maximumV>loV && b.minimumV<hiV
      })
  }
  const peerGoals = new Map()
  const emit = (rows, offset, index) => {
    const draw = draws[index], source = draw.sourceTexture || draw.texture
    const tile = {level:rows[offset+1],matrix:rows[offset+2],row:rows[offset+3],column:rows[offset+4]}
    if (options.membersOnly && members && !members.has(draw.geometryKey)) {
      const goal = renderer.presentationBridges.find(value => textureTileContains(value, tile)) ||
        textures.get(tile, false).resolvedTile
      if (goal && !peerGoals.has(tileKey(goal))) {
        reserve(96)
        peerGoals.set(tileKey(goal), goal)
      }
      return
    }
    reserve(320)
    result.push(Object.assign({}, draw, {texture:tile, sourceTexture:source,
      imageryCellScale:rows[offset+5], imageryCellOffsetX:rows[offset+6], imageryCellOffsetY:rows[offset+7],
      imageryClipCell:tile.level > source.level}))
  }
  if (footprintCache) footprintCache.collect(draws,
    [world,!!renderer.terrainBoundImagery,target].join(':'), read,
    (indices, probe) => finish(build(indices, probe)), emit,
    world || renderer.terrainBoundImagery ? null : {measurement:index=>renderer.measureDraw(draws[index]),test:visible})
  else {
    const indices = []
    for (let index = 0; index < draws.length; ++index) { yield; reserve(8); indices.push(index) }
    const rows = yield* build(indices, read)
    for (let offset=0;offset<rows.length;offset+=8) {
      yield
      if (world || renderer.terrainBoundImagery || visible(rows,offset,rows[offset])) emit(rows,offset,rows[offset])
    }
  }
  if (options.prepare === false) return result
  const coverStore=textures.capacityView&&handover.size?Object.create(textures,{get:{value:tile=>
    handover.has(tileKey(tile))?textures.capacityView.get(tile,false):textures.get(tile,false)}}):textures
  return yield* imageryCoverWork(renderer, result, coverStore, presentation, members, reserve, peerGoals)
}

function* imageryCoverWork(renderer, result, textures, presentation, members, reserve = () => {}, peerGoals = new Map()) {
  const cells = []
  const goals = new Map()
  for (const draw of result) {
    yield
    reserve(64)
    goals.set(draw, renderer.presentationBridges.find(goal =>
      textureTileContains(goal, draw.texture)) || textures.get(draw.texture, false).resolvedTile)
  }
  function* allGoals() {
    yield* goals.values()
    yield* peerGoals.values()
    // A ready bridge may lie inside an old mesh's coarse fallback footprint.
    // Install it as a world goal before coverWork descends that footprint;
    // marking the eventual child rows as handover cannot retarget them.
    yield* renderer.presentationBridges
  }
  yield* presentation.setGoalsWork(allGoals(), reserve)
  const footprints = new Map()
  for (const draw of result) {
    yield
    if (!goals.get(draw)) continue
    reserve(64)
    if (!footprints.has(draw.geometryKey)) footprints.set(draw.geometryKey, new Set())
    footprints.get(draw.geometryKey).add(tileKey(draw.texture))
  }
  for (const draw of result) {
    yield
    // Local production uses the global goals above, including goals contributed
    // by other meshes, but only prepares the participating mesh footprints.
    if (members && !members.has(draw.geometryKey)) continue
    // Ready fallbacks can overlap even though requested cells form a cut.
    // Expand each mesh's outer footprint once. Keep every goal above: cover()
    // still splits around finer ready images and unfinished old transitions.
    const footprint = footprints.get(draw.geometryKey)
    let nested = false
    for (let tile = parentTextureTile(draw.texture); tile; tile = parentTextureTile(tile)) {
      yield
      if (footprint && footprint.has(tileKey(tile))) { nested = true; break }
    }
    if (nested) continue
    const goal = goals.get(draw)
    if (!goal) { cells.push(draw); continue }
    const source = draw.sourceTexture || draw.texture
    const geometry = renderer.geometry.get(draw.geometryKey)
    const intersects = tile => {
      if (!geometry) return true
      const t = textureCellTransform(source, tile)
      return surfacePlan.intersectsCell(geometry.model.hull,
        -t.offsetX / t.scale, -t.offsetY / t.scale,
        (1 - t.offsetX) / t.scale, (1 - t.offsetY) / t.scale)
    }
    yield* presentation.coverWork(draw.texture, goal, (tile, target) => {
      const t = textureCellTransform(source, tile)
      const bridge = renderer.presentationBridges.find(goal => textureTileContains(goal, tile))
      reserve(320)
      cells.push(Object.assign({}, draw, {texture: tile, imageryTarget: target,
        imageryHandover: Boolean(bridge),
        imageryCellScale: t.scale, imageryCellOffsetX: t.offsetX,
        imageryCellOffsetY: t.offsetY, imageryClipCell: tile.level > source.level}))
    }, intersects)
  }
  return cells
}

module.exports = {imageryDraws, imageryDrawWork, imageryCoverWork}
