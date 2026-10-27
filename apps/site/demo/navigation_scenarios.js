(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraNavigationScenarios = factory()
})(typeof self === 'undefined' ? this : self, function () {
  'use strict'
  const active = new WeakSet()
  const names = ['flight', 'oblique', 'roam']

  function conditionSnapshot(state) {
    const renderer = state.renderer || {}, transition = renderer.transition || {}
    return { view: state.view, frame: state.frame, quality: renderer.quality,
      draws: renderer.draws, terrain: state.terrain, selection: state.terrainSelection,
      resources: state.resources, memory: state.resourceMemory,
      ground: state.cameraGround && state.cameraGround.demand,
      groundConstraintRevision: state.cameraGround && state.cameraGround.appliedDemandRevision,
      measurementTransport: state.performance && state.performance.workerMeasurementTransport,
      imageryPlanning: state.performance && state.performance.workerImageryPlanning,
      textures: renderer.textures, handoff: transition.handoff,
      meshPreparation: transition.meshPreparation,
      worldDisplay: transition.worldDisplay,
      gpu: transition.gpuSubmission, partitions: transition.partitions,
      work: state.performance && state.performance.frameCoordinator }
  }

  function pendingReasons(state) {
    const s = conditionSnapshot(state), q = s.quality || {}, reasons = []
    if (state.error) throw new Error(state.error)
    if (state.paused || state.contextLost) reasons.push('inactive-viewer')
    if (!q.covered || !s.draws || !s.draws.submitted) reasons.push('coverage')
    if (!q.targetMet) reasons.push('imagery-target')
    if (!q.quiescent || !q.terrainSelectionCurrent) reasons.push('quality-work')
    if (!s.selection || s.selection.desiredViewRevision !== s.selection.presentedViewRevision ||
        s.selection.preparedViewRevision !== s.selection.presentedViewRevision) reasons.push('terrain-view')
    if (!s.resources || s.resources.budgetExhausted || s.resources.pendingMeshGroups ||
        s.resources.pendingPriorityUpdateCount) reasons.push('terrain-work')
    if (!s.terrain || s.terrain.active || s.terrain.queued) reasons.push('terrain-requests')
    if (s.ground && s.ground.active && (s.ground.pending || s.groundConstraintRevision !== s.ground.revision ||
        ['eye', 'front'].some(role => s.ground[role] && s.ground[role].status === 'pending'))) reasons.push('ground-demand')
    if (!s.gpu || s.gpu.pending) reasons.push('gpu-completion')
    if (!s.handoff || s.handoff.phase !== 'presented') reasons.push('handoff')
    if (!s.partitions || s.partitions.queuedCells || s.partitions.uploading || s.partitions.activeMs) reasons.push('partitions')
    if (!s.work || s.work.pendingAnimations || s.work.pendingInputs || s.work.pendingWork || s.work.pendingRender) reasons.push('frame-work')
    return reasons
  }

  async function run(viewer, name, options) {
    const value = options || {}
    if (!names.includes(name)) throw new Error('Unknown navigation scenario: ' + name)
    if (active.has(viewer)) throw new Error('A navigation scenario is already running')
    if (viewer.camera.getView().mode !== 'globe') throw new Error('Navigation scenarios require globe mode')
    const duration = value.durationMs === undefined ? 8000 : value.durationMs
    if (!Number.isFinite(duration) || duration < 500 || duration > 60000) throw new Error('Scenario duration must be 500..60000ms')
    const conditioningTimeout = value.conditioningTimeoutMs === undefined ? 30000 : value.conditioningTimeoutMs
    if (!Number.isFinite(conditioningTimeout) || conditioningTimeout < 500 || conditioningTimeout > 60000) throw new Error('Conditioning timeout must be 500..60000ms')
    const now = value.now || (() => performance.now())
    const requestFrame = value.requestFrame || (callback => requestAnimationFrame(callback))
    const cancelFrame = value.cancelFrame || (id => cancelAnimationFrame(id))
    const setTimer = value.setTimer || setTimeout, clearTimer = value.clearTimer || clearTimeout
    const original = viewer.camera.getView(), initial = viewer.getState()
    const configuration = state => JSON.stringify([state.datasetId, state.imageryId, state.budget])
    const initialConfiguration = configuration(initial)
    const readState = () => {
      const state = viewer.getState()
      if (configuration(state) !== initialConfiguration) throw new Error('Navigation source or viewport changed')
      return state
    }
    const radius = initial.radiusMeters
    const signal = value.signal
    if (signal && signal.aborted) throw new Error('Navigation scenario cancelled')
    active.add(viewer)
    let frame = null, timeout = null, abort = null
    const report = { schema: 'terra.navigation-evidence.v4', scenario: name, status: 'running',
      comparison: { environment: 'live-network', cache: 'retained',
        scope: 'conditioned-endpoints; motion workload and network are not fixed' },
      timingScope: 'bounded recent samples; metric count and windowCount disclose truncation', phaseTimeline: [],
      datasetId: initial.datasetId, imageryId: initial.imageryId,
      viewport: initial.budget, durationMs: 0, samples: [], blankSamples: 0,
      missingSamples: 0, maximumWasmBytes: 0, maximumTextureBytes: 0,
      maximumTextureReservedBytes: 0, maximumTexturePipelineBytes: 0,
      maximumTextureAccountedBytes: 0, maximumHandoffWaitMs: 0,
      targetMetSamples: 0, limitedSamples: 0,
      terrainPublicationCount: 0, terrainPartialPublicationCount: 0, terrainFullPublicationCount: 0,
      terrainMeshChangeCount: 0,
      // This baseline deliberately records the currently supported orbit view.
      // It must not be presented as acceptance of a pedestrian-height camera.
      cameraModel: 'orbit', requestedDurationMs: duration }
    const base = { schema: 'terra.view-state.v2', mode: 'globe',
      target: { longitudeDegrees: 116.5623, latitudeDegrees: 40.74863, heightMeters: 0 },
      rangeMeters: name === 'roam' ? 12000 : radius * (name === 'flight' ? 0.08 : 0.0015),
      headingDegrees: 14.5, tiltDegrees: name === 'oblique' ? 76.3 : 30 }
    let presentedSequence = initial.terrainSelection && initial.terrainSelection.presentedSequence
    let submission = initial.terrainSelection && initial.terrainSelection.submitted
    const phase = name => {
      report.phase = name
      report.phaseTimeline.push({phase: name, atMs: now()})
      if (value.onPhase) value.onPhase(name)
    }
    const observe = (limit, check) => new Promise((resolve, reject) => {
      const started = now()
      let finished = false
      const finish = error => {
        if (finished) return
        finished = true
        if (frame !== null) cancelFrame(frame)
        frame = null; clearTimer(timeout)
        if (signal && abort) signal.removeEventListener('abort', abort)
        abort = null
        if (error) reject(error)
        else resolve()
      }
      abort = () => finish(new Error('Navigation scenario cancelled'))
      if (signal && signal.aborted) { abort(); return }
      if (signal) signal.addEventListener('abort', abort, { once: true })
      timeout = setTimer(() => finish(new Error('Navigation scenario display clock stalled')), limit + 1000)
      const step = () => {
        if (finished) return
        frame = null
        try {
          if (check(now() - started)) { finish(); return }
          frame = requestFrame(step)
        } catch (error) { finish(error) }
      }
      frame = requestFrame(step)
    })
    const condition = async name => {
      const result = { timeoutMs: conditioningTimeout, stableWindowMs: 250, samples: [], status: 'waiting' }
      report[name] = result; phase(name)
      let stableAt = null, identity = null, sampledAt = -Infinity
      await observe(conditioningTimeout, elapsed => {
        const state = readState(), reasons = pendingReasons(state)
        result.durationMs = elapsed
        result.pendingReasons = reasons
        result.final = conditionSnapshot(state)
        const selected = state.terrainSelection || {}
        const key = JSON.stringify([state.view, selected.presentedSequence, selected.presentedModelRevision,
          selected.desiredViewRevision, selected.preparedViewRevision, selected.presentedViewRevision])
        if (reasons.length || key !== identity) stableAt = null
        identity = key
        if (!reasons.length && stableAt === null) stableAt = elapsed
        if (elapsed - sampledAt >= Math.max(250, conditioningTimeout / 128)) {
          result.samples.push({timeMs: elapsed, pendingReasons: reasons, state: result.final}); sampledAt = elapsed
        }
        if (stableAt !== null && elapsed - stableAt >= result.stableWindowMs) {
          result.status = 'stable'
          // Capacity-limited terrain can be idle but must never become a pass
          // for requested terrain precision just because the camera is stable.
          result.targetReady = state.renderer.quality.ready === true
          result.limitationReasons = state.renderer.quality.limitationReasons || []
          return true
        }
        if (elapsed >= conditioningTimeout) {
          result.status = 'timeout'
          throw new Error('Navigation ' + name + ' did not stabilize: ' + reasons.join(', '))
        }
        return false
      })
    }
    const sample = elapsed => {
      const state = readState(), renderer = state.renderer || {}, quality = renderer.quality || {}
      if (state.error) throw new Error(state.error)
      const textures = renderer.textures || {}, drawn = renderer.draws && renderer.draws.submitted || 0
      const selection = state.terrainSelection || {}
      const handoff = renderer.transition && renderer.transition.handoff
      if (selection.presentedSequence !== undefined && selection.presentedSequence !== presentedSequence) {
        ++report.terrainFullPublicationCount; presentedSequence = selection.presentedSequence
      }
      if (selection.submitted && submission) {
        report.terrainPublicationCount += selection.submitted.submissions - submission.submissions
        report.terrainPartialPublicationCount += selection.submitted.partialSubmissions - submission.partialSubmissions
        report.terrainMeshChangeCount += selection.submitted.meshRevision - submission.meshRevision
      }
      submission = selection.submitted
      if (!drawn) ++report.blankSamples
      if (quality.missingCount > 0) ++report.missingSamples
      if (quality.targetMet) ++report.targetMetSamples
      if (quality.limitedByBudget || (quality.limitationReasons || []).length) ++report.limitedSamples
      report.maximumWasmBytes = Math.max(report.maximumWasmBytes, state.performance && state.performance.wasmMemoryBytes || 0)
      report.maximumTextureBytes = Math.max(report.maximumTextureBytes, textures.bytes || 0)
      report.maximumTextureReservedBytes = Math.max(report.maximumTextureReservedBytes, textures.reservedBytes || 0)
      report.maximumTexturePipelineBytes = Math.max(report.maximumTexturePipelineBytes, textures.pipelineBytes || 0)
      report.maximumTextureAccountedBytes = Math.max(report.maximumTextureAccountedBytes,
        (textures.bytes || 0) + (textures.reservedBytes || 0) + (textures.pipelineBytes || 0))
      report.maximumHandoffWaitMs = Math.max(report.maximumHandoffWaitMs, handoff && handoff.waitMs || 0)
      report.samples.push({ timeMs: elapsed, view: state.view, draws: drawn,
        errorPx: Number.isFinite(quality.resolvedMaxPixelError) ? quality.resolvedMaxPixelError : null,
        state: quality.state, active: textures.active, queued: textures.queued,
        terrainSelection: selection, terrainProgress: state.terrainProgress,
        terrainRecords: state.frame && state.frame.loadedRecordCount,
        handoff, partitions: renderer.transition && renderer.transition.partitions,
        meshPreparation: renderer.transition && renderer.transition.meshPreparation,
        worldDisplay: renderer.transition && renderer.transition.worldDisplay,
        localReplacement: renderer.transition && renderer.transition.localReplacement,
        gpuSubmission: renderer.transition && renderer.transition.gpuSubmission,
        resourceMemory: state.resourceMemory,
        measurementHistory: state.performance && state.performance.workerMeasurementHistory,
        textureReservedBytes: textures.reservedBytes || 0,
        missing: quality.missingCount, transitioning: quality.transitioningCells,
        eyeHeightMeters: state.cameraGround && state.cameraGround.eyeHeightMeters })
    }
    try {
      viewer.camera.cancelAnimation()
      viewer.camera.setView(base)
      report.requestedStartView = base
      await condition('preparation')
      const prepared = readState()
      presentedSequence = prepared.terrainSelection.presentedSequence
      submission = prepared.terrainSelection.submitted
      viewer.diagnostics.reset()
      phase('motion')
      if (name === 'flight') viewer.camera.flyTo([2.35, 48.86, 0], {
        path: 'staged', durationMs: duration * 0.8, rangeMeters: radius * 0.015, tiltDegrees: 45 })
      if (name === 'oblique') viewer.camera.startOrbit([116.5623, 40.74863, 0], {
        rangeMeters: base.rangeMeters, tiltDegrees: 76.3, speedDegreesPerSecond: 18 })
      let lastSample = -Infinity
      await observe(duration, elapsed => {
        const progress = Math.min(1, elapsed / duration)
        if (name === 'roam') viewer.camera.setView(Object.assign({}, base, {
          target: { longitudeDegrees: 116.5623 + Math.sin(progress * Math.PI * 2) * 0.5,
            latitudeDegrees: 40.74863 + Math.sin(progress * Math.PI) * 0.3, heightMeters: 0 },
          rangeMeters: 12000 * Math.pow(32, Math.sin(progress * Math.PI)),
          headingDegrees: 14.5 + 40 * Math.sin(progress * Math.PI * 2),
          tiltDegrees: 30 + 20 * Math.sin(progress * Math.PI) }))
        if (elapsed - lastSample >= Math.max(100, duration / 200) || progress >= 1) {
          sample(elapsed); lastSample = elapsed
        }
        if (progress >= 1) { report.durationMs = elapsed; return true }
        return false
      })
      report.performance = viewer.diagnostics.snapshot()
      viewer.camera.cancelAnimation()
      report.motionEndView = viewer.camera.getView()
      // Observe the actual trajectory endpoint before optional restoration.
      await condition('settlement')
      report.finalView = viewer.camera.getView()
      report.performanceAfterSettlement = viewer.diagnostics.snapshot()
      report.status = 'complete'
      phase('complete')
      return report
    } catch (error) {
      report.status = signal && signal.aborted ? 'cancelled' : 'failed'
      report.error = error.message
      report.failedPhase = report.phase
      error.report = report
      try { phase(report.status) } catch (_) { /* Preserve the original failure. */ }
      throw error
    } finally {
      if (frame !== null) cancelFrame(frame)
      clearTimer(timeout)
      if (signal && abort) signal.removeEventListener('abort', abort)
      active.delete(viewer)
      viewer.camera.cancelAnimation()
      if (value.restore !== false && !(signal && signal.aborted)) viewer.camera.setView(original)
    }
  }
  return { names, run }
})
