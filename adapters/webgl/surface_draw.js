const {renderedSurface} = require('../../sdk/js/terrain/rendered_surface')
const {monotonicNow} = require('../../sdk/js/diagnostics/timing')
const {rowMajorToWebGlMatrix, relativeProjectionView, textureKeyString: tileKey} = require('../../sdk/js/core/terra_globe_common')
const {textureTileContains} = require('../../sdk/js/imagery/terra_texture_tiles')
const DRAW_FLAG_COVERAGE = 1
const coverage=d=>Boolean(d.flags&DRAW_FLAG_COVERAGE)||d.imagerySourceCoverage
const {selectDepthPrograms} = require('./surface_programs')

function drawSurface(renderer, force = true) {
  renderer.surfaceDrawn = false
  renderer.coverageImages.endFrame()
  if (renderer.checkContextLoss()) return renderer.drawStats
  selectDepthPrograms(renderer, renderer.current.frame)
  const {gl, uniforms, attributes, textures, presentation} = renderer
  const current = renderer.current
  // Retention acknowledges this exact submitted cut. A prepared successor may
  // already exist when the hold begins, and the display clock can run before
  // background preparation observes the hold. Keep that successor private.
  const surface = renderer.heldCandidate ? renderer.heldCandidate.surface :
    renderer.preparedSurfaceSource===current?renderer.preparedSurface:renderer.displaySurface
  const viewFrame = current.frame
  const relative = rowMajorToWebGlMatrix(
    relativeProjectionView(viewFrame.projectionView,
      viewFrame.cameraPosition))
  const stencil = typeof gl.stencilFunc === 'function'
  if (!surface) {
    renderer.surfaceCommands.clear()
    renderer.surfaceDrawn = true
    if (stencil) { gl.stencilMask(255); gl.clearStencil(0) }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | (stencil ? gl.STENCIL_BUFFER_BIT : 0))
    renderer.renderAtmosphere(relative, viewFrame.cameraPosition)
    renderer.submitDraws(null)
    renderer.drawStats = {submitted: 0, queued: renderer.queuedGeometryCount}
    return renderer.drawStats
  }
  renderer.uploadIndexBuffer(surface.current.indices)
  textures.beginFrame()
  presentation.beginSubmission(renderer.options.textureClock ? renderer.options.textureClock() : monotonicNow())
  const textureStatsBeforeRender = textures.stats()
  const targetTexturesReady = surface.current === current &&
    textureStatsBeforeRender.targetMissing === 0
  const targetTerrainDraws = renderer.mode === 'texture'
    ? renderer.worldDisplay.read(surface.renderDraws)
    : surface.current.draws.filter((draw) =>
      (draw.flags & DRAW_FLAG_COVERAGE) === 0)
  const previewCoverage = surface.useGeometryCoverage || targetTerrainDraws.coveragePending ||
    renderer.options.scheduledImagery && !renderer.terrainBoundImagery &&
      (!current.imageryPlan || current.imageryPlan.quality.planningComplete === false) ||
    !renderer.currentSelectionReady() || (!surface.useGeometryCoverage &&
    (renderer.plannedCameraVersion !== renderer.cameraVersion || surface.current !== current))
  const geometryCoverageDraws = renderer.coverageImages.read(surface.useGeometryCoverage || previewCoverage
    ? surface.geometryCoverageDraws || [] : [])
  const imageryCoverageDraws = renderer.mode === 'texture' &&
    !targetTexturesReady ? (surface.coverageDraws || []) : []
  let submitted = 0
  const submittedDraws = []
  const terrainDraws = targetTerrainDraws.filter(draw=>!coverage(draw))
    .concat(targetTerrainDraws.filter(coverage),geometryCoverageDraws)
    .filter(draw => renderer.terrainBoundImagery || renderer.measureDraw(draw).visible)
  let geometryCoverageDrawCount = 0
  let imageryCoverageDrawCount = imageryCoverageDraws.length
  const nextPresentedTextures = new Map()
  let maximumResolvedError = 0
  let fallbackCount = 0
  let missingCount = 0
  let minimumResolvedLevel = Number.POSITIVE_INFINITY
  let maximumResolvedLevel = Number.NEGATIVE_INFINITY
  const commands = []
  for (let index = 0; index < terrainDraws.length; ++index) {
    const draw = terrainDraws[index]
    const geometry = renderer.geometry.get(draw.geometryKey)
    if (!geometry || !geometry.positionBuffer || !geometry.uvBuffer) {
      continue
    }
    const scissor=typeof gl.scissor==='function'&&draw.imageryResidentCoverage
      ?renderer.coverageImages.scissor(draw,viewFrame):null
    if(scissor&&(!scissor[2]||!scissor[3]))continue
    const part = renderer.mode === 'texture' && draw.imageryClipCell && (!draw.imageryDirectClip || draw.imageryIndexCell)
      ? renderer.partitionForDraw(geometry, draw) : null
    if (part && part.vertexCount === 0 && part.indexCount === 0) continue
    const candidate = draw.imageryHandover && textures.binding(draw.texture, draw.imageryTarget) ||
      textures.get(draw.imageryTarget &&
      textureTileContains(draw.imageryTarget, draw.texture) ? draw.imageryTarget : draw.texture, false)
    let binding = candidate.resolvedTile ? textures.binding(draw.texture, candidate.resolvedTile) : candidate
    let oldBinding = binding, alpha = 1
    if (binding.resolvedTile && !(draw.flags & DRAW_FLAG_COVERAGE) && !draw.imageryResidentCoverage) {
      const prior=presentation.previous(draw.texture)
      // World cuts retain the publication receipt, not a per-frame copy of
      // its boolean. A missing receipt on a prepared row stays unready;
      // ordinary coverage descriptors have no publication dependency.
      const ready=!('imageryPublicationState' in draw)||
        Boolean(draw.imageryPublicationState&&draw.imageryPublicationState.ready)
      let target=binding.resolvedTile
      if(!ready&&!prior) {
        const source=draw.sourceTexture||draw.texture
        target=renderer.rootImageryDraw(Object.assign({},draw,{texture:source})).texture
      }
      if(prior&&renderer.plannedCameraVersion!==renderer.cameraVersion&&prior.a.level!==prior.b.level) {
        const finer=prior.a.level>prior.b.level?prior.a:prior.b
        if(finer.level>target.level&&textureTileContains(finer,draw.texture)&&textures.gpuReady(tileKey(finer))&&
            renderer.measureTextureDraw(draw,target.level)>(renderer.options.imageryPixelError||1.25))target=finer
      }
      const state = presentation.resolve(draw.texture, target,
        tile => textures.gpuReady(tileKey(tile)),
        ready)
      binding = textures.binding(draw.texture, state.b)
      oldBinding = textures.binding(draw.texture, state.a)
      alpha = state.alpha
      // Pin both ends even at alpha=0; the next upload pass may evict others.
      nextPresentedTextures.set(tileKey(state.a), state.a)
      nextPresentedTextures.set(tileKey(state.b), state.b)
    }
    const requested = draw.imageryTarget || draw.texture
    const usage = binding.resolvedLevel < 0 ? 'missing' :
      Math.min(binding.resolvedLevel, oldBinding.resolvedLevel) < requested.level ? 'fallback' : 'exact'
    textures.frameUsage[usage] += 1
    if (binding.kind === 'fallback') fallbackCount += 1
    if (binding.kind === 'missing') missingCount += 1
    if (binding.resolvedLevel >= 0) {
      minimumResolvedLevel = Math.min(minimumResolvedLevel,
        Math.min(binding.resolvedLevel, oldBinding.resolvedLevel))
      maximumResolvedLevel = Math.max(maximumResolvedLevel,
        binding.resolvedLevel, oldBinding.resolvedLevel)
      maximumResolvedError = Math.max(maximumResolvedError,
        renderer.measureTextureDraw(draw, Math.min(binding.resolvedLevel, oldBinding.resolvedLevel)))
      if (binding.resolvedTile) {
        if(draw.imageryResidentCoverage)renderer.coverageImages.use(binding.resolvedTile)
        else nextPresentedTextures.set(tileKey(binding.resolvedTile), binding.resolvedTile)
      }
    } else {
      maximumResolvedError = Number.POSITIVE_INFINITY
    }
    commands.push({draw, geometry, part, binding, oldBinding, alpha, scissor})
    submitted += 1
    submittedDraws.push([draw, Boolean(part || draw.imageryDirectClip)])
    if (draw.flags & DRAW_FLAG_COVERAGE) geometryCoverageDrawCount += 1
    if(draw.imagerySourceCoverage)++imageryCoverageDrawCount
  }
  const terrainSubmitted = submitted
  const plan = {relative, viewFrame, stencil, previewCoverage, commands}
  const observer = renderer.visibility
  const needsVisibility = observer && (!observer.needsDraw || observer.needsDraw(surface))
  const redraw = force || renderer.debugOptions.webglErrors || needsVisibility ||
    !renderer.surfaceCommands.matches(renderer, plan)
  if (redraw) {
    renderer.surfaceDrawn = true
    const target = observer && observer.target
    const retained = target && target.begin()
    if (stencil) { gl.stencilMask(255); gl.clearStencil(0) }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | (stencil ? gl.STENCIL_BUFFER_BIT : 0))
    renderer.renderAtmosphere(relative, viewFrame.cameraPosition)
    // CBDAM exterior triangles are clockwise in both coordinate transforms.
    // UV partitions preserve that order. Cull before fragment shading, as the
    // desktop renderer does; atmosphere and overlays keep separate GL state.
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.BACK)
    gl.frontFace(gl.CW)
    gl.useProgram(renderer.program)
    if (renderer.depthState.factor) gl.uniform1f(uniforms.logDepth, renderer.depthState.factor)
    gl.uniformMatrix4fv(uniforms.projectionView, false, relative)
    gl.uniform1i(uniforms.texture, 0)
    gl.uniform1i(uniforms.oldTexture, 1)
    gl.uniform1f(uniforms.renderMode, renderer.mode === 'height' ? 1 : 0)
    gl.uniform2f(uniforms.heightRange,
      renderer.heightRange[0], renderer.heightRange[1])
    const altitude = Math.max(0,
      Math.hypot.apply(null, viewFrame.cameraPosition) - renderer.planetRadius)
    const fogDensity = renderer.atmosphereEnabled && renderer.atmosphere.fogEnabled
      ? renderer.atmosphere.seaLevelFogDensity *
        renderer.atmosphere.fogDensityMultiplier * Math.exp(-altitude / 8000)
      : 0
    gl.uniform1f(uniforms.fogDensity, fogDensity)
    gl.uniform3f(uniforms.fogColor,
      renderer.atmosphere.fogColor[0], renderer.atmosphere.fogColor[1],
      renderer.atmosphere.fogColor[2])
    gl.activeTexture(gl.TEXTURE0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.indexBuffer)
    if ((previewCoverage || retained) && stencil) {
      gl.enable(gl.STENCIL_TEST)
      gl.stencilFunc(gl.ALWAYS, 1, 255)
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
    }
    let visibilityObserved = false
    const observedDraws = []
    for (const {draw, geometry, part, binding, oldBinding, alpha, scissor} of commands) {
      if (!visibilityObserved && draw.flags & DRAW_FLAG_COVERAGE) {
        visibilityObserved = true
        if (observer) observer.observe(surface, (previewCoverage || retained) && stencil, observedDraws)
      }
      if (previewCoverage && stencil && coverage(draw)) {
        // Fill only newly exposed pixels. A coarse root must never overwrite
        // detailed terrain or create z-fighting during camera-only motion.
        gl.stencilFunc(gl.EQUAL, 0, 255)
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR)
      } else if (retained && (draw.flags & DRAW_FLAG_COVERAGE)) {
        gl.stencilFunc(gl.ALWAYS, 0, 255)
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, geometry.positionBuffer)
      if(scissor){gl.enable(gl.SCISSOR_TEST);gl.scissor(...scissor)}
      gl.enableVertexAttribArray(attributes.position)
      gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, geometry.uvBuffer)
      gl.enableVertexAttribArray(attributes.uv)
      gl.vertexAttribPointer(attributes.uv, 2, gl.FLOAT, false, 0, 0)
      gl.uniform3f(uniforms.origin,
        draw.origin[0] - viewFrame.cameraPosition[0],
        draw.origin[1] - viewFrame.cameraPosition[1],
        draw.origin[2] - viewFrame.cameraPosition[2])
      gl.uniform1f(uniforms.heightOrigin, draw.origin[2])
      if (renderer.sourceUvPartitions) gl.uniform1i(uniforms.clipCell, draw.imageryDirectClip || part && part.sourceUv ? 1 : 0)
      gl.uniform2f(uniforms.cellUvScale,
        draw.imageryCellScale || 1, draw.imageryCellScale || 1)
      gl.uniform2f(uniforms.cellUvOffset,
        draw.imageryCellOffsetX || 0, draw.imageryCellOffsetY || 0)
      gl.uniform2f(uniforms.oldUvScale, oldBinding.scale, oldBinding.scale)
      gl.uniform2f(uniforms.oldUvOffset, oldBinding.offsetX, oldBinding.offsetY)
      gl.uniform1f(uniforms.textureMix, alpha)
      gl.uniform2f(uniforms.uvScale, binding.scale, binding.scale)
      gl.uniform2f(uniforms.uvOffset,
        binding.offsetX, binding.offsetY)
      gl.uniform1f(uniforms.debugMode,
        renderer.debugOptions.textureState ? 1 : 0)
      gl.uniform1f(uniforms.textureState,
        binding.kind === 'exact' ? 0 : (binding.kind === 'fallback' ? 1 : 2))
      gl.activeTexture(gl.TEXTURE0 + 1)
      gl.bindTexture(gl.TEXTURE_2D, oldBinding.texture)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, binding.texture)
      if (part) {
        if (part.indexCount) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.indexBuffer)
          gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0)
        }
        if (part.vertexCount) {
          gl.bindBuffer(gl.ARRAY_BUFFER, part.positionBuffer)
          gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ARRAY_BUFFER, part.uvBuffer)
          gl.vertexAttribPointer(attributes.uv, 2, gl.FLOAT, false, 0, 0)
          gl.drawArrays(gl.TRIANGLES, 0, part.vertexCount)
        }
      } else {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.indexBuffer)
        gl.drawElements(gl.TRIANGLE_STRIP, draw.indexCount, gl.UNSIGNED_SHORT, draw.firstIndex * 2)
      }
      observedDraws.push([draw, Boolean(part || draw.imageryDirectClip)])
      if(scissor)gl.disable(gl.SCISSOR_TEST)
    }
    if (!visibilityObserved && observer) observer.observe(surface, (previewCoverage || retained) && stencil, submittedDraws)
    if (retained) {
      // Overlay samples cannot prove terrain occlusion. Preserve their usual
      // color/depth behavior while marking them unknown for future queries.
      gl.stencilFunc(gl.ALWAYS, 0, 255)
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
    } else if (previewCoverage && stencil) gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.CULL_FACE)
    submitted += renderer.renderOverlays(relative, viewFrame.cameraPosition)
    if (retained) target.present(surface)
  } else {
    if (observer && observer.resume) observer.resume(surface, submittedDraws)
    submitted = renderer.drawStats.submitted
  }
  // A submission receipt records issued commands, not GPU completion. WebGL
  // retains resources referenced by queued commands after delete*. Context
  // loss and explicit debug validation must not publish the proposed cut.
  const lost = renderer.checkContextLoss()
  const error = !lost && renderer.debugOptions.webglErrors ? gl.getError() : gl.NO_ERROR
  if (lost || error !== gl.NO_ERROR) {
    renderer.surfaceCommands.clear()
    if (!lost) renderer.onDiagnostic('webgl_error', { error })
    renderer.drawStats = { submitted: 0, queued: renderer.queuedGeometryCount }
    return renderer.drawStats
  }
  renderer.surfaceCommands.retain(renderer, plan)
  renderer.worldDisplay.commit(targetTerrainDraws.chosen)
  renderer.partitionGroups.publish()
  if(renderer.displaySurface!==surface) {
    renderer.displaySurface=surface
    renderer.syncMeasurementLoans()
    renderer.updateGeometryPins()
  }
  renderer.submitDraws(renderedSurface(renderer.renderedSurface, surface.current, submittedDraws,
    Boolean(previewCoverage && stencil)))
  renderer.presentedCameraVersion = renderer.cameraVersion
  const changedPresentation = nextPresentedTextures.size !== renderer.presentedTextures.size ||
    Array.from(nextPresentedTextures.keys()).some(key => !renderer.presentedTextures.has(key))
  if (renderer.restoringPresentation) {
    // GPU images can finish before the resumable world footprint creates any
    // UV jobs. Coverage draws are not a receipt for that restored fine cut.
    const restored = !targetTerrainDraws.coveragePending &&
      Array.from(renderer.presentedTextures.keys()).every(key => textures.gpuReady(key)) &&
      !renderer.partitionActive && !renderer.partitionQueue.length && !renderer.partitionUploads.length
    if (restored) renderer.restoringPresentation = false
    else renderer.presentedTextures.forEach((tile, key) => nextPresentedTextures.set(key, tile))
  }
  const wasTransitioning = presentation.active > 0
  const cutRevision=presentation.cutRevision
  presentation.endFrame()
  if(presentation.cutRevision!==cutRevision) {
    renderer.geometryPublicationPending=true
    renderer.requestResources()
  }
  // Promotion was checked before this frame advanced the last blend. Revisit
  // it once after completion; resident imagery may produce no further event.
  if (presentation.active || wasTransitioning && surface.current !== current) renderer.requestRender()
  renderer.presentedTextures = nextPresentedTextures
  if (changedPresentation) {
    textures.sync(renderer.geometryCoverageDraws.concat(renderer.renderDraws),
      Array.from(nextPresentedTextures.values()).map(texture => ({ texture })),
      Boolean(renderer.plannedCameraVersion === renderer.cameraVersion &&
        renderer.current.imageryPlan && renderer.current.imageryPlan.quality.coarsening))
  }
  const coverageSubmitted = geometryCoverageDrawCount+imageryCoverageDrawCount
  if (coverageSubmitted > 0 || renderer.visibility && renderer.visibility.invalidated) {
    maximumResolvedError = Number.POSITIVE_INFINITY
  }
  renderer.drawStats = { submitted, queued: renderer.queuedGeometryCount }
  renderer.qualityStats = Object.assign({}, surface.quality, {
    transitioningCells: presentation.active,
    resolvedMaxPixelError: maximumResolvedError,
    renderedDrawCount: terrainSubmitted,
    meetsTarget: Number.isFinite(maximumResolvedError) && maximumResolvedError <=
      surface.quality.targetPixelError * 1.001,
    limitedByGeometryBudget: renderer.partitionBudgetLimited,
    coverageSubmitted,
    geometryCoverageSubmitted: geometryCoverageDrawCount,
    imageryCoverageSubmitted: imageryCoverageDrawCount,
    fallbackCount,
    missingCount,
    resolvedLevelMinimum: Number.isFinite(minimumResolvedLevel)
      ? minimumResolvedLevel : null,
    resolvedLevelMaximum: Number.isFinite(maximumResolvedLevel)
      ? maximumResolvedLevel : null
  })
  if (terrainSubmitted > 0) {
    if (surface.replacement) {
      surface.replacement.committed = surface.replacement.proposed
      // The mixed cut now owns display. Retire the replaced GPU pins and
      // report its retained resources to the CPU/native owners. This frees
      // admission for the next independent group without increasing capacity.
      renderer.displaySurface = surface
      renderer.syncMeasurementLoans()
      renderer.updateGeometryPins()
    }
    if (renderer.lastSubmittedSurface !== surface.current) {
      renderer.lastSubmittedSurface = surface.current
      if (renderer.options.onSurfaceSubmitted) {
        renderer.options.onSurfaceSubmitted(surface.current, Boolean(surface.replacement))
      }
    }
    if (!surface.replacement) {
      renderer.submittedSequence = surface.current.frame.sequence
      if(surface.current===current&&renderer.replacement)renderer.clearReplacement()
    }
    renderer.notifyPresented()
  }
  return renderer.drawStats
}

module.exports = {drawSurface}
