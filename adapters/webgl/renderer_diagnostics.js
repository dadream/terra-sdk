const {TimingSeries, monotonicNow} = require('../../sdk/js/diagnostics/timing')

// Observed display, quality and work state; this reporter owns no scheduling.
function rendererStats(renderer, exactTimings) {
  const {current, qualityStats, performanceStats, displaySurface, pendingSubmission, replacement} = renderer
  const textureStats = renderer.textures.stats()
  const targetCoverage = textureStats.targetDesired > 0
    ? textureStats.cachedTarget / textureStats.targetDesired : 1
  const resolvedError = qualityStats.resolvedMaxPixelError
  const hasResolvedError = typeof resolvedError === 'number'
  const withinTransitionTolerance = !hasResolvedError ||
    (Number.isFinite(resolvedError) && resolvedError <=
      qualityStats.targetPixelError * 2)
  const displayingCurrent = Boolean(displaySurface &&
    displaySurface.current === current)
  const geometryCoverageReady = renderer.currentGeometryCoverageReady()
  const geometryWorkComplete = renderer.omittedCurrentGeometryCount() === 0 &&
    renderer.currentSelectionReady() && current.frame.decisionsComplete !== false &&
    !(current.frame.requestCount > 0)
  const geometryTargetComplete = geometryWorkComplete &&
    !(current.updateState && current.updateState.limitedByCapacity)
  const transitionCoverageSubmitted =
    (qualityStats.coverageSubmitted || 0) > 0
  const covered = !renderer.contextLost && renderer.lastSubmittedSurface === current &&
    textureStats.missingRatio === 0 && displayingCurrent &&
    renderer.currentGeometryReady()
  const visibilityProofsPending = renderer.visibility && renderer.visibility.proofs ? renderer.visibility.proofs.pending.size : 0
  const measurementPending = renderer.mode === 'texture' && !renderer.terrainBoundImagery &&
    !renderer.interactionActive && qualityStats.refinableMeasurementCount > 0
  const resourceStable = !renderer.presentation.active && textureStats.targetMissing === 0 &&
    textureStats.stagedTiles === 0 && textureStats.frontierTiles === 0 &&
    geometryWorkComplete && qualityStats.planningComplete !== false && !visibilityProofsPending && !measurementPending
  const requestIdle = textureStats.active === 0 && textureStats.queued === 0
  const cameraCurrent = renderer.presentedCameraVersion === renderer.cameraVersion &&
    renderer.plannedCameraVersion === renderer.cameraVersion
  const targetMet = cameraCurrent && hasResolvedError && Number.isFinite(resolvedError) &&
    resolvedError <= qualityStats.targetPixelError * 1.001
  const ready = renderer.currentSelectionReady() && !renderer.interactionActive && !renderer.presentation.active && !visibilityProofsPending && !measurementPending && qualityStats.planningComplete !== false &&
    covered &&
    geometryTargetComplete &&
    renderer.currentTargetGeometryReady() &&
    !transitionCoverageSubmitted &&
    targetMet &&
    !textureStats.blockedByFailure &&
    textureStats.state !== 'blocked-capacity' &&
    !textureStats.limitedByCapacity &&
    targetCoverage >= 0.95 &&
    textureStats.fallbackRatio <= 0.05 &&
    (!hasResolvedError || Number.isFinite(resolvedError)) &&
    textureStats.failed === 0
  const settled = ready && resourceStable &&
    textureStats.fallbackRatio === 0
  const state = textureStats.blockedByFailure ? 'degraded'
    : (renderer.interactionActive ? 'interacting'
      : (textureStats.state === 'blocked-capacity' ? 'blocked-capacity'
        : (ready ? 'ready' : (!covered ? 'loading'
          : (!resourceStable || !cameraCurrent ? 'refining' : 'limited')))))
  const limitationReasons = []
  if (current && current.updateState && current.updateState.limitedByCapacity) limitationReasons.push('terrain-budget')
  if (!targetMet) {
    if (qualityStats.limitedByProjection) limitationReasons.push('projection')
    if (qualityStats.limitedByTextureBudget) limitationReasons.push('texture-budget')
    if (textureStats.sharedCapacityBlocked || textureStats.resourceShare &&
        textureStats.resourceShare.pressured && textureStats.resourceShare.retractions) limitationReasons.push('resource-budget')
    if (qualityStats.limitedByPartitionBudget || renderer.partitionBudgetLimited) limitationReasons.push('partition-budget')
    if (qualityStats.limitedByLevel) limitationReasons.push('source-level')
  }
  const quality = Object.assign({}, qualityStats, {
    limitationReasons,
    cameraCurrent,
    cameraVersion: renderer.cameraVersion,
    presentedCameraVersion: renderer.presentedCameraVersion,
    plannedCameraVersion: renderer.plannedCameraVersion,
    interactionActive: renderer.interactionActive,
    textureState: textureStats.state,
    coverageReady: textureStats.coverageReady,
    coarseCoverageReady: textureStats.coarseCoverageReady,
    limitedByCache: textureStats.limitedByCapacity,
    withinTransitionTolerance,
    targetCoverage,
    geometryCoverageReady,
    geometryTargetComplete,
    terrainSelectionCurrent: renderer.currentSelectionReady(),
    terrainLimitedByCapacity: Boolean(current && current.updateState && current.updateState.limitedByCapacity),
    terrainRequestedError: current && current.updateState && current.updateState.requestedLodThreshold,
    terrainNodeCount: current && current.updateState && current.updateState.topologyNodeCount,
    transitionCoverageSubmitted,
    covered,
    visibilityProofsPending,
    measurementPending,
    resourceStable,
    requestIdle,
    quiescent: resourceStable && requestIdle && cameraCurrent && !renderer.interactionActive,
    targetMet,
    state,
    ready,
    settled
  })
  const performance = {
    textureUploads: performanceStats.textureUploads,
    partitionBuilds: performanceStats.partitionBuilds,
    partitionBytes: renderer.partitionBytes,
    partitionReservedBytes: renderer.partitionReservedBytes,
    partitionCpuBytes: renderer.partitionCpuBytes,
    partitionCapacityBytes: renderer.partitionCapacityBytes,
    geometryCapacityBytes: renderer.geometry.maximumBytes,
    textureCapacityBytes: renderer.textures.cache.maximumBytes,
    frameIntervalMs: performanceStats.frameIntervalMs,
    framesPerSecond: performanceStats.framesPerSecond
  }
  for (const [name, value] of Object.entries(performanceStats)) {
    if (value instanceof TimingSeries) performance[name] = value.snapshot(undefined, exactTimings)
  }
  return {
    depth: renderer.depthState ? Object.assign({}, renderer.depthState) : null,
    geometry: renderer.geometry.stats(),
    textures: textureStats,
    quality,
    draws: renderer.drawStats,
    overlays: {
      points: renderer.overlays.points.length,
      routeVertices: renderer.overlays.route ?
        renderer.overlays.route.worlds.length : 0
    },
    atmosphere: {
      capable: renderer.atmosphereCapable,
      enabled: renderer.atmosphereEnabled,
      sunVisible: renderer.atmosphere.sunVisible,
      fogEnabled: renderer.atmosphere.fogEnabled,
      source: renderer.atmosphere.width > 2 ? 'terra-core' : 'fallback'
    },
    performance,
    transition: {
      memory: renderer.resourceLedger.stats(),
      displayTarget: renderer.visibility && renderer.visibility.target ? renderer.visibility.target.stats() : null,
      gpuSubmission: {
        asynchronous: renderer.asyncGpu,
        budget: renderer.lastUploadBudget || null,
        pending: Boolean(pendingSubmission),
        batches: renderer.submissions.batches.length,
        uploading: renderer.submissions.uploading,
        kind: pendingSubmission ? (pendingSubmission.drawn ? 'draw' : 'resource') : null,
        bytes: renderer.submissions.batches.reduce((sum, batch) =>
          sum + batch.items.reduce((n, item) => n + item.prepared.bytes, 0), 0),
        waitMs: pendingSubmission ? monotonicNow() - pendingSubmission.startedAt : 0
      },
      handoff: renderer.handoff.snapshot(),
      worldDisplay: renderer.worldDisplay.snapshot(),
      meshPreparation: renderer.meshPreparationStats ? Object.assign({}, renderer.meshPreparationStats,
        {active: Boolean(renderer.meshOutputPlan), last: Object.assign({}, renderer.meshPreparationStats.last)}) : null,
      localReplacement: replacement ? {
        preparing: Boolean(replacement.task),
        groups: replacement.groups ? replacement.groups.length : 0,
        submitted: replacement.committed.size
      } : null,
      partitions: {
        pricing: Object.assign({}, renderer.partitionGroups.pricing),
        preparedGroups: renderer.partitionGroups.prepared.size,
        quotedGroups: renderer.partitionGroups.quotes.size,
        queuedCells: renderer.partitionQueue.reduce((n, job) => n + job.cells.length, 0),
        oldestQueuedMs: renderer.partitionQueue.reduce((n, job) => job.cells.reduce((age, cell) =>
          Math.max(age, monotonicNow() - cell.queuedAt), n), 0),
        activeMs: renderer.partitionActive ? monotonicNow() - renderer.partitionActive.startedAt : 0,
        uploading: renderer.partitionUploads.length,
        uploadHighWaterJobs: renderer.partitionUploadHighWaterJobs || 0,
        uploadHighWaterBytes: renderer.partitionUploadHighWaterBytes || 0,
        group: renderer.partitionGroups.current ? {
          planning: !!renderer.partitionGroups.current.task,
          imageryPreparation: !!renderer.partitionGroups.current.future,
          imageCount: renderer.partitionGroups.current.future ? renderer.partitionGroups.current.future.size : 0,
          meshes: renderer.partitionGroups.current.rows.size,
          remainingCells: renderer.partitionGroups.current.pending.size,
          borrowedCells: renderer.partitionGroups.current.borrowedOutputs
            ? renderer.partitionGroups.current.borrowedOutputs.size : 0,
          missingCells: Array.from(renderer.partitionGroups.current.rows.values()).reduce((n, row) =>
            n + row.cells.filter(cell => !row.geometry.partitions.has(cell.key)).length, 0)
        } : null
      },
      displayingPreviousFrame: Boolean(displaySurface &&
        displaySurface.current !== current),
      pendingGeometry: renderer.missingCurrentGeometryCount(),
      pendingCoverageGeometry: renderer.missingCurrentCoverageGeometryCount(),
      omittedGeometry: renderer.omittedCurrentGeometryCount(),
      expectedGeometry: current && current.frame
        ? Number(current.frame.expectedDrawCount) || 0 : 0,
      coverageGeometry: current && current.frame
        ? Number(current.frame.coverageDrawCount) || 0 : 0,
      coverageComplete: renderer.currentGeometryCoverageReady(),
      queuedGeometry: renderer.queuedGeometryCount,
      pinnedGeometry: Array.from(renderer.geometryPinnedKeys).filter(key => !key.startsWith('uv:')).length
    },
    mode: renderer.mode
  }
}

module.exports = {rendererStats}
