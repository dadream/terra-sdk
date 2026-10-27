(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraVerticalScaleProbe = factory()
})(typeof self === 'undefined' ? this : self, function () {
  'use strict'
  const unique = values => [...new Set(values)].sort()
  const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value && value[key]]))
  const histogram = keys => keys.reduce((result, key) => {
    const level = key.split('/')[0]; result[level] = (result[level] || 0) + 1; return result
  }, {})

  // All control uses the public camera/diagnostic API. This read-only probe is
  // the one isolated dependency on renderer internals, until public diagnostics
  // expose spatial membership. Never call cache.get(), which would touch LRU.
  function read(viewer) {
    const runtime = viewer.runtime, renderer = runtime.renderer, state = viewer.getState()
    if (!runtime.manifest || !renderer) throw new Error('Benchmark runtime is not initialized')
    const source = runtime.manifest.texture, offset = Math.log2(4 / source.level_zero_columns)
    if (source.kind !== 'global-geodetic' || !Number.isInteger(offset) || offset < 0 ||
      2 / source.level_zero_rows !== 2 ** offset) throw new Error('Benchmark requires the eight-root geodetic model')
    const limits = runtime.rangeLimits(), budget = state.budget
    const configuration = {
      datasetId:state.datasetId, imageryId:state.imageryId, radiusMeters:state.radiusMeters,
      source:pick(source, ['kind','tile_size','level_zero_columns','level_zero_rows','minimum_level',
        'maximum_level','matrix_level_offset','origin','bounds']),
      maximumInternalLevel:Math.max(0, source.maximum_level - offset),
      tileSize:source.tile_size / 2 ** Math.max(0, offset - source.maximum_level),
      fovRadians:runtime.fovRadians, terrainPixelError:runtime.terrainPixelError,
      imageryPixelError:runtime.imageryPixelError,
      cssHeight:budget.physicalHeight / budget.devicePixelRatio,
      viewport:pick(budget, ['cssWidth','cssHeight','physicalWidth','physicalHeight','devicePixelRatio']),
      initialBudgets:pick(budget, ['maximumResourceBytes','maximumTerrainMeshBytes','geometryCacheBytes','partitionCacheBytes','textureCacheBytes']),
      globalRangeMeters:4 * state.radiusMeters, minimumRangeMeters:limits.minimum,
      maximumRangeMeters:limits.maximum
    }
    const display = renderer.displaySurface
    const terrain = display ? display.current.draws.filter(draw => !(draw.flags & 1)) : []
    const imagery = display ? display.renderDraws : []
    const terrainKey = draw => {
      if (!draw.key) throw new Error('Missing spatial terrain identity')
      return [draw.key.level, draw.key.i, draw.key.j, draw.key.k, draw.fragment || 0].join('/')
    }
    const nodeKey = draw => {
      if (!draw.textureNode) throw new Error('Missing internal imagery identity')
      const node = draw.textureNode; return [node.level, node.root, node.row, node.column].join('/')
    }
    const sourceKey = tile => [tile.level, tile.matrix, tile.row, tile.column].join('/')
    const presentedImages = [...renderer.presentedTextures.values()]
    if (presentedImages.some(tile => !Number.isInteger(tile.level) || tile.level < 0 || tile.level > source.maximum_level))
      throw new Error('Presented imagery exceeds the declared source levels')
    const sets = {terrain:unique(terrain.map(terrainKey)), imagery:unique(imagery.map(nodeKey)),
      targetImages:unique(imagery.map(draw => sourceKey(draw.texture))),
      presentedImages:unique(presentedImages.map(sourceKey))}
    const textures = state.renderer.textures, memory = state.resourceMemory, resource = state.resources || {}
    const metrics = {terrainNodes:resource.topologyNodeCount, terrainMeshes:sets.terrain.length,
      imageryNodes:sets.imagery.length, targetImages:sets.targetImages.length, presentedImages:sets.presentedImages.length,
      terrainLevels:histogram(sets.terrain), imageryLevels:histogram(sets.imagery), sourceLevels:histogram(sets.targetImages),
      terrainError:resource.achievedLodError, terrainThreshold:resource.requestedLodThreshold,
      imageryError:state.renderer.quality.resolvedMaxPixelError, imageryThreshold:state.renderer.quality.targetPixelError,
      refinableMeasurements:state.renderer.quality.refinableMeasurementCount,
      workingMeshBytes:state.terrainSelection.capacity && state.terrainSelection.capacity.workingMeshBytes,
      preferredMeshBytes:state.terrainSelection.capacity && state.terrainSelection.capacity.preferredMeshBytes,
      capacityReductions:state.terrainSelection.capacity && state.terrainSelection.capacity.reductions,
      capacityRestorations:state.terrainSelection.capacity && state.terrainSelection.capacity.restorations,
      managedBytes:memory.bytes, maximumManagedBytes:memory.maximumBytes,
      lifetimeHighWaterBytes:memory.highWaterBytes, reservedBytes:memory.reservedBytes,
      residentBytes:memory.residentBytes, retiredBytes:memory.retiredBytes, owners:memory.owners,
      wasmBytes:state.performance.wasmMemoryBytes, nativeMeshBytes:resource.meshBytes,
      heightBytes:resource.heightBytes, decodedRecordBytes:resource.decodedRecordBytes,
      textureBytes:textures.bytes, textureEntries:textures.entries, textureCapacity:textures.capacity,
      textureGrantedBytes:textures.resourceShare ? textures.resourceShare.grantedBytes : state.renderer.performance.textureCapacityBytes,
      textureMaximumShareBytes:textures.resourceShare ? textures.resourceShare.maximumBytes : state.renderer.performance.textureCapacityBytes,
      partitionBytes:state.renderer.performance.partitionBytes,
      partitionCpuBytes:state.renderer.performance.partitionCpuBytes}
    // Keep only structured numeric/state diagnostics. Do not emit source URLs,
    // callback objects, tokens, raw diagnostic strings or mesh/image payloads.
    const safeState = {view:state.view, frame:state.frame, resources:resource,
      // Published frames often use zero topology credit after background work.
      // Preserve that work separately; its absence made active refinement look
      // like a sequence of zero-change, budget-exhausted selection calls.
      terrainProgress:state.terrainProgress,
      terrain:pick(state.terrain, ['active','queued','failedRequestCount']),
      terrainSelection:state.terrainSelection,
      performance:pick(state.performance, ['frameCoordinator','workerImageryPlanning',
        'workerMeasurementHistory','nativeImageryBytes']),
      renderer:{quality:state.renderer.quality, draws:state.renderer.draws,
        performance:state.renderer.performance,
        textures:pick(textures, ['active','queued','failed','blockedByFailure','state','targetMissing','stagedTiles','frontierTiles']),
        transition:pick(state.renderer.transition, ['gpuSubmission','handoff','partitions','meshPreparation','worldDisplay'])},
      error:state.error, contextLost:state.contextLost, paused:state.paused}
    return {configuration, sets, metrics, state:safeState}
  }
  return {read}
})
