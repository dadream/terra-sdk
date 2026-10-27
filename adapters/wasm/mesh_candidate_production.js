const common = require('../../sdk/js/core/terra_globe_common')
const surfacePlan = require('../../sdk/js/terrain/terra_surface_plan')
const {MeshCopyPlan, meshCutBytes} = require('../../sdk/js/resources/mesh_coordinates')
const {changedReplacementGroups} = require('../../sdk/js/terrain/surface_replacement')
const {releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')
const {capacityCheckpoint,capacityRefusalRevision}=require('../../sdk/js/resources/capacity_refusal')

// One candidate transaction for local and Worker execution. Adapters perform
// native operations or RPC; ownership, admission and nested group selection
// have the same ordering in either execution environment.
async function produceMeshCandidate(adapter, frames, imagery) {
  const before=capacityCheckpoint(frames.ledger)
  try{return await produceCandidate(adapter,frames,imagery)}
  catch(error) {
    if(error.status===9)error.capacityRevision=capacityRefusalRevision(frames.ledger,before)
    throw error
  }
}

async function produceCandidate(adapter, frames, imagery) {
  let selected = await adapter.describe()
  if (selected.superseded) return selected
  try { if (frames.onPreparation) frames.onPreparation(selected) }
  catch (error) { if (!adapter.destroyed) await adapter.discardPlan(selected.nativePlan.id); throw error }
  const target = selected
  let selectedGroups
  let native = selected.nativePlan
  const forecastRequired = frames.evaluateCandidate && imagery && !imagery.terrainBound
  const previous = frames.presented
  const unchangedSurface = forecastRequired && previous && previous.updateState &&
    previous.updateState.workerGeneration === adapter.generation &&
    previous.frame.coverageComplete && target.frame.coverageComplete &&
    !target.frame.omittedDrawCount && previous.draws.length === selected.draws.length &&
    selected.draws.every((draw, i) => ['resourceId', 'textureResourceId', 'flags', 'firstIndex', 'indexCount']
      .every(key => draw[key] === previous.draws[i][key]))
  // A metadata-only selection creates no new surface to map. Keep the owned
  // display footprint and let ordinary imagery planning follow the camera;
  // waiting for another private forecast would postpone the changed model
  // already progressing behind this identical cut. Output admission below
  // still protects existing geometry/UV and any actual destination work.
  const candidateImagery = forecastRequired && !unchangedSurface
  let boundaryBytes = candidateImagery && frames.presented &&
    frames.presented.frame.coverageComplete !== false && target.frame.coverageComplete &&
    !target.frame.omittedDrawCount && target.replacementPlan && target.replacementPlan.atomic
    ? target.boundaryBytes : 0
  const refine = async stageCredit => {
    let scratch
    try {
      const calculate = credit => adapter.replacement(native.id, credit.bytes)
      if (stageCredit) {
        const proof = await calculate(stageCredit)
        boundaryBytes = 0
        return proof
      }
      const refusal = {}
      scratch = await adapter.reserveNativeWork('terrain-boundary-work', selected.boundaryBytes,
        () => frames.ledger.reserve('terrain-boundary-work', selected.boundaryBytes, [], [], [], refusal))
      if (!scratch) throw Object.assign(new Error('Boundary planning capacity is occupied'),
        {status: 9, requests: selected.requests, modelRevision: selected.modelRevision,
          capacityShortfallBytes: refusal.shortfallBytes})
      const proof = await calculate(scratch)
      boundaryBytes = 0
      return proof
    } finally { if (scratch) scratch.release() }
  }
  selected.draws.forEach(draw => { draw.workerGeneration = adapter.generation })
  const boundaryStage = {
    get bytes() { return boundaryBytes },
    async run(credit) {
      target.replacementPlan = await refine(credit)
      common.invariant(target.replacementPlan && !target.replacementPlan.atomic,
        'Candidate production requires a complete boundary proof')
    }
  }
  let reservation, outputs, copies
  try {
    const admitted = await frames.admitProduction(selected, value => {
      value.draws.forEach(draw => { draw.workerGeneration = adapter.generation })
      const next = new MeshCopyPlan(frames, value.draws, adapter.indexBudget, value.indexProducerBytes)
      if (copies) copies.release()
      copies = next
      return copies.bytes
    }, (bytes, acquire) => adapter.reserveNativeWork('mesh-transfer', bytes, acquire),
    groups => {
      selectedGroups = groups
      return adapter.select(native.id, groups)
    }, refine, boundaryStage)
    selected = admitted.packet; reservation = admitted.credit; outputs = admitted.outputs; native = selected.nativePlan
  }
  catch (error) {
    if (copies) copies.release()
    if (!adapter.destroyed) await adapter.discardPlan(native.id)
    if (error.status === 9) { error.requests = selected.requests; error.modelRevision = selected.modelRevision }
    throw error
  }
  let result
  let failure
  const shrinkPreparedSelection = async () => {
    if (!frames.presented || frames.presented.frame.coverageComplete === false ||
        !target.frame.coverageComplete || target.frame.omittedDrawCount || !target.replacementPlan) return false
    if (target.replacementPlan.atomic) target.replacementPlan = await refine()
    common.invariant(target.replacementPlan && !target.replacementPlan.atomic,
      'Late selection requires a native boundary proof')
    const allowed = selectedGroups && new Set(selectedGroups)
    const groups = changedReplacementGroups(target.replacementPlan, frames.presented.draws, target.draws)
      .filter(item => !allowed || allowed.has(item.index))
    if (groups.length <= 1) return false
    // Nested subsets retain complete native seam groups and only discard
    // already produced members. No trial recreates an array released above.
    selectedGroups = groups.slice(0, Math.floor(groups.length / 2)).map(item => item.index).sort((a,b) => a-b)
    const next = await adapter.select(native.id, selectedGroups)
    next.draws.forEach(draw => {draw.workerGeneration = adapter.generation})
    result = copies.reselect(result, next)
    selected = next; native = next.nativePlan
    return true
  }
  try {
    if (outputs && !outputs.valid()) throw Object.assign(new Error('Mesh destination was invalidated'), {status: 9})
    adapter.nativeBudget.begin(reservation.split(native.additionalBytes, 'reserved', 'mesh-native'))
    copies.allocate(reservation)
    result = await adapter.materialize(selected, copies.residentTextureIds, copies)
    copies.finishIndices()
    adapter.nativeBudget.finish()
    // Inherited display images and their complete new-mesh UV footprint can
    // already be owned by the initial output transaction. That coverage
    // receipt allows geometry handoff; it makes no current-view SSE claim.
    // Missing images/destinations still require the private forecast below.
    const residentCoverage = outputs && outputs.hasResidentCoverage && outputs.hasResidentCoverage()
    if (candidateImagery && !residentCoverage) {
      if (outputs) { outputs.release(); outputs = null }
      if (frames.beginForecast) frames.beginForecast()
      for (;;) {
        let forecast
        try {
          if(result.measurements){releaseMeasurements(result.measurements);result.measurements=null}
          do {
            if(forecast)releaseMeasurements(forecast.measurements)
            forecast = await adapter.forecast(selected.sequence, imagery, native.id)
            if (forecast.superseded) throw Object.assign(new Error('Candidate forecast was superseded'), {superseded:true})
          } while (!forecast.candidateReady)
          common.invariant(forecast.imageryPlan && forecast.imageryPlan.quality.coverageGuaranteed &&
            !forecast.imageryPlan.quality.rebuilding,
          'Candidate imagery has no complete admitted cut')
          const members = new Set(selected.draws.map(draw => draw.resourceId))
          common.invariant(forecast.imageryPlan.draws.every(draw => members.has(draw.resourceId)),
            'Candidate imagery references another terrain selection')
          result.imageryPlan = forecast.imageryPlan
          result.measurements = forecast.measurements
          result.imageryViewRevision = forecast.viewRevision
          outputs = await frames.evaluateCandidate(Object.assign({}, selected, result, {nativePlan: native}), forecast)
          if (!outputs) throw Object.assign(new Error('Candidate imagery capacity is occupied'),
            {status:9, requests:selected.requests, modelRevision:selected.modelRevision})
          break
        } catch (error) {
          if (error.status !== 9 || !await shrinkPreparedSelection()) throw error
        } finally {
          if(forecast&&forecast.measurements!==result.measurements)releaseMeasurements(forecast.measurements)
        }
      }
    }
    if (outputs && !outputs.valid()) throw Object.assign(new Error('Candidate outputs were invalidated'), {status:9})
    const indices = result.indices || frames.indices
    // Consumer arrays, models and frame membership must validate before the
    // native producer commits. A malformed transfer remains a private failure.
    const candidate = copies.prepare(Object.assign({}, result, {outputs}), (resource, draw) => {
      resource.model = surfacePlan.attachSurface(resource.model, resource.positions,
        resource.textureUv, indices, draw.firstIndex, draw.indexCount)
    })
    const accepted = await adapter.commit(native.id,candidate)
    candidate.updateState = accepted.updateState
    candidate.updateState.workerGeneration = adapter.generation
    const frame = copies.commit()
    outputs = null
    return frame
  } catch (error) {
    failure = error
    if (error.status === 9) {
      error.requests = selected.requests
      error.modelRevision = selected.modelRevision
      error.capacitySelectedBytes = meshCutBytes(selected.draws)
    }
    if (!adapter.destroyed) {
      await adapter.discardPlan(native.id)
      await adapter.discardFrame(selected.sequence)
    }
    throw error
  } finally {
    if(failure&&result)releaseMeasurements(result.measurements)
    adapter.nativeBudget.finish()
    reservation.release()
    if (outputs) outputs.release()
    copies.release()
  }
}

module.exports = {produceMeshCandidate}
