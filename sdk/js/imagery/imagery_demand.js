// Merge spatial demand separately from the camera epoch of its measurements.
// An immutable surface can keep useful image work while its new view is being
// measured. That does not make an old error estimate valid for the new view.
function mergeImageryDemand(targets, previous, plan, previousMeasurements, updates, options) {
  const resources = new Map(targets.map(draw => [draw.geometryKey, draw]))
  const ids = new Set(targets.map(draw => draw.resourceId))
  const current = plan.quality.cameraCurrent !== false
  const sameView = current && options.sameView
  const preview = plan.quality.measurementPending === true
  const measured = options.measurementsCurrent ? new Map(previousMeasurements) : new Map()
  if (current) updates.forEach(m => measured.set(m.resourceId, m))
  for (const id of measured.keys()) if (!ids.has(id)) measured.delete(id)
  const hidden = id => measured.has(id) && measured.get(id).visible === false || options.hidden(id)
  const requested = plan.quality.targetPixelError || 1.25
  const meetsTarget = draws => draws.every(draw => {
    const m = measured.get(draw.resourceId), source = draw.sourceTexture || resources.get(draw.geometryKey).texture
    // Whole-surface upper bounds are sufficient proofs. Unknown or infinite
    // bounds are not permission to discard useful detail.
    return m && m.visible && Number.isFinite(m.pixelsPerUv) && m.pixelsPerUv /
      (options.tileSize * Math.pow(2, draw.texture.level - source.level)) <= requested
  })
  const incoming = new Map(), retained = new Map()
  plan.draws.forEach(draw => {
    if (!resources.has(draw.geometryKey)) return
    if (!incoming.has(draw.geometryKey)) incoming.set(draw.geometryKey, [])
    // Measurement previews propose coverage while the core is working. A
    // fitted core cut or the whole-mesh proof below can establish demand.
    incoming.get(draw.geometryKey).push(Object.assign({},draw,{imageryDemandView:
      current&&!preview&&plan.quality.spatialCut===true&&Number.isInteger(options.viewRevision)
        ?options.viewRevision:undefined}))
  })
  if (preview && current) incoming.forEach((draws, key) => {
    if (meetsTarget(draws)) incoming.set(key, draws.map(draw => Object.assign({}, draw,
      {imageryCoverageBound: true, imageryDemandView:Number.isInteger(options.viewRevision)
        ?options.viewRevision:undefined})))
  })
  if (previous && !previous.quality.provisional) previous.draws.forEach(draw => {
    if (!resources.has(draw.geometryKey) ||
        draw.imageryPixelError === undefined && !draw.imageryCoverageBound && draw.texture.level === 0) return
    // Partial camera measurements are not replacement demand for untouched
    // meshes. Preserve their useful pending coverage as well as fitted rows;
    // its missing precision proof still prevents final/demandReady admission.
    if (!retained.has(draw.geometryKey)) retained.set(draw.geometryKey, [])
    retained.get(draw.geometryKey).push(draw)
  })
  const retainedIds = new Set()
  retained.forEach((draws, key) => {
    if (hidden(draws[0].resourceId)) return
    const candidates = incoming.get(key)
    let keep = !candidates
    if (preview && candidates) {
      const finer = candidates.every(d => draws.every(old => d.texture.level >= old.texture.level))
      const proved = sameView&&Number.isInteger(options.viewRevision)&&draws.every(draw=>
        draw.imageryDemandView===options.viewRevision&&(draw.imageryPixelError!==undefined||draw.imageryCoverageBound))
      // A fitted cut may still use loose bounds. Keep it against speculative
      // finer previews, but let a current whole-mesh SSE proof retire excess
      // demand immediately. Unrelated measurements need not finish first.
      const coarseProof=current&&!finer&&meetsTarget(candidates)
      keep = proved ? !coarseProof : !current || !finer &&
        !((!sameView || plan.quality.coarsening) && coarseProof)
    } else if (!current && candidates) {
      // A late fitted result can advance an unfulfilled region, but must not
      // resurrect oversampling after current-view coverage already meets SSE.
      keep = meetsTarget(draws)
    }
    if (!keep) return
    incoming.set(key, draws)
    draws.forEach(draw => retainedIds.add(draw.resourceId))
    if (sameView && preview && !previous.quality.measurementPending &&
        previousMeasurements.has(draws[0].resourceId)) {
      measured.set(draws[0].resourceId, previousMeasurements.get(draws[0].resourceId))
    }
  })
  // A partial measurement's arrival order is not a new spatial topology.
  // Preserve terrain order between meshes and the core's row order within one.
  const planned = new Set(incoming.keys()), draws = [], emitted = new Set()
  targets.forEach(draw => {
    if(!planned.has(draw.geometryKey))draws.push(!hidden(draw.resourceId)&&options.coverageDraw
      ?options.coverageDraw(draw):options.rootDraw(draw))
    else if(!emitted.has(draw.geometryKey)) {
      emitted.add(draw.geometryKey)
      for(const row of incoming.get(draw.geometryKey))draws.push(row)
    }
  })
  const covered = current && !retainedIds.size &&
    targets.every(draw => options.scheduledImagery
      ? measured.has(draw.resourceId) && (planned.has(draw.geometryKey) || hidden(draw.resourceId))
      : planned.has(draw.geometryKey) || measured.has(draw.resourceId))
  return {plan: Object.assign({}, plan, {draws, quality: Object.assign({}, plan.quality, {
    // A complete fitted cut can price one continuation before its tighter
    // measurement/precision job finishes. Missing meshes, retained old demand
    // and previews cannot acquire that permission by inheriting a flag.
    demandReady: covered && plan.quality.demandReady === true && plan.quality.spatialCut === true &&
      plan.quality.coverageGuaranteed === true && !plan.quality.measurementPending && !plan.quality.rebuilding,
    planningComplete: covered && plan.quality.planningComplete !== false})}), measurements: measured}
}

module.exports = {mergeImageryDemand}
