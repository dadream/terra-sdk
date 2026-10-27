const {invariant} = require('../../sdk/js/core/terra_globe_common')
const {surfaceIds, selectReplacementGroups} = require('../../sdk/js/terrain/surface_replacement')
const {ImageryPreparation} = require('./imagery_preparation')
const {produceMeshCandidate} = require('./mesh_candidate_production')
const {createMeshTransferTask} = require('./mesh_transfer_preparation')
const {CooperativeTurn} = require('../../sdk/js/runtime/cooperative_turn')
const {Cleanup}=require('../../sdk/js/runtime/cleanup')
const {LocalMeasurementDelivery}=require('./measurement_delivery_local')
const {releaseNativeMeasurements}=require('./native_surface_measurement')
const {holdNativeSurface}=require('./borrowed_mesh')
const {imageryWorkKind}=require('../../sdk/js/resources/imagery_input_workspace')
const {runImageryGrants,finishImageryGrant}=require('./imagery_grants')
const {capacityCheckpoint,capacityRefusalRevision}=require('../../sdk/js/resources/capacity_refusal')
const {reclaimMeasurementInputs,measurementCacheRevision}=require('./completed_measurement_cache')

// In-process Wasm execution, including Mini Program environments without
// Worker/MessageChannel. Uses the same candidate transaction as the Worker.
class LocalTerrainExecution {
  constructor(abi, frames, manifest, view, turn = new CooperativeTurn()) {
    this.abi = abi
    this.frames = frames
    this.view = view
    this.turn = turn
    this.measurementDelivery=new LocalMeasurementDelivery(frames.ledger)
    const yieldWork=async () => {
      // Resolved promises alone never give the UI a turn. Match the Worker's
      // bounded slice boundary without requiring Worker or MessageChannel.
      await this.turn.wait()
      if (this.destroyed || this.planningRevision !== this.cancelRevision)
        throw Object.assign(new Error('Local imagery preparation was cancelled'), {superseded:true})
      return !(this.planningOperation && this.planningOperation.interrupted)
    }
    this.preparation = new ImageryPreparation({abi, manifest, quotedCredit:true,
      holdSurface:surface=>holdNativeSurface(abi,surface),beforeWork:yieldWork,yieldWork})
    this.unregisterMeasurementReclaimer=frames.ledger.reclamation.register({
      owner:'completed-measurement-inputs',
      revision:()=>measurementCacheRevision(this.preparation,this.measurementDelivery),
      reclaim:needed=>this.destroyed?0:this.reclaimMeasurementInputs(needed).released
    })
    this.tasks = new Set()
    this.cancelRevision = 0
    this.destroyed = false
  }

  observeView() { this.preparation.observeView(this.view()) }

  reclaimMeasurementInputs(needed) {
    return reclaimMeasurementInputs(this.preparation,this.measurementDelivery,needed)
  }

  preparedModel(planId, resourceId) {
    const surface = this.prepared && this.prepared.surface
    if (!surface || !surface.nativePlan || surface.nativePlan.id !== planId) return null
    const resource = surface.resources.get(resourceId)
    return resource && resource.model ? {model:resource.model, release:resource.ownership.hold()} : null
  }

  async runTask(task) {
    this.tasks.add(task)
    try {
      const result = await task.run(() => this.turn.wait())
      if (this.destroyed && result && result.release) result.release()
      invariant(!this.destroyed && result, 'Local terrain preparation was cancelled')
      return result
    } finally { this.tasks.delete(task); task.cancel() }
  }

  async step(threshold, budget, selection) {
    const abi = this.abi, frames = this.frames, execution = this
    const imagery = selection.imagery
    let packet, beforeIds, proof
    const describe = value => Object.assign({}, value, {sequence:value.frame.sequence,
      modelRevision:value.updateState.modelRevision, selectionViewRevision:selection.viewRevision,
      requests:abi.getRequests()})
    const nativeBudget = abi.setResourceLedger(frames.ledger)
    const before=capacityCheckpoint(frames.ledger)
    try {
      return await produceMeshCandidate({
        generation:0, nativeBudget,
        get destroyed() {return execution.destroyed},
        describe:async () => {
          packet = await frames.describe(abi, threshold, budget)
          beforeIds = frames.presented ? surfaceIds(frames.presented.draws) : []
          packet.boundaryBytes = packet.replacementPlan && packet.replacementPlan.atomic
            ? abi.replacementWorkBytes(packet.nativePlan, beforeIds) : 0
          return describe(packet)
        },
        reserveNativeWork:(...args) => frames.reserveNativeWork(...args),
        replacement:async (planId, bytes) => {
          invariant(packet.nativePlan.id === planId, 'Stale local boundary plan')
          proof = await this.runTask(abi.createReplacementTask(packet.nativePlan, beforeIds, bytes))
          packet.replacementPlan = proof
          return proof
        },
        select:async (planId, groups) => {
          invariant(packet.nativePlan.id === planId, 'Stale local group selection')
          if (!proof) proof = packet.replacementPlan
          if (this.prepared) {
            const chosen = new Set(groups), surface = this.prepared.surface
            invariant(proof.groups.every((group, i) => (chosen.has(i) ? group.after : group.before)
              .every(id => surface.resources.has(id) || frames.resources.has(id))),
            'Late selection requires an unprepared mesh')
          }
          packet = abi.selectMeshGroups(packet.nativePlan, groups)
          packet.replacementPlan = selectReplacementGroups(proof, groups)
          if (this.prepared) {
            invariant(packet.nativePlan.additionalBytes === 0, 'Late selection requires new native allocation')
            nativeBudget.begin(frames.ledger.reserve('mesh-native', 0))
            try { await this.runTask(abi.createMeshTask(packet, 0)) }
            finally { nativeBudget.finish() }
            this.prepared.reselect(packet)
          }
          return describe(packet)
        },
        materialize:async (selected, residentTextureIds, copies) => {
          // Admission selected a packet carrying the same native plan. Keep
          // that complete cut for later boundary/refusal work.
          packet = selected
          await this.runTask(abi.createMeshTask(packet))
          this.prepared = await this.runTask(createMeshTransferTask(abi, frames, packet,
            {residentIds:Array.from(frames.resources.keys()), needsIndices:!frames.indices,
              generation:0, viewRevision:selection.viewRevision}, residentTextureIds, copies.readIndices(abi)))
          return this.prepared.transfer
        },
        forecast:(sequence, options, planId) => this.planImagery(sequence, options, null, planId),
        commit:(planId,candidate) => {
          invariant(this.prepared && this.prepared.surface.nativePlan.id === planId, 'Stale local acceptance')
          // A manifest reset can retire the derived cache before a geometry-
          // only update. The next imagery job initializes its new producer.
          const models=this.preparation.measurementProduction
          if(!models.closed)models.shareModels(this.prepared.surface.resources,candidate.resources)
          const updateState = this.prepared.commit()
          this.preparation.publishImageryCandidate(planId)
          this.prepared = null
          return {updateState}
        },
        discardPlan:planId => {
          this.preparation.discardImageryCandidate(planId)
          if (this.prepared) this.prepared.release()
          this.prepared = null
          abi.discardMeshPlan(packet && packet.nativePlan)
        },
        discardFrame:sequence => frames.discard(sequence)
      }, frames, imagery)
    } catch (error) {
      if (packet && packet.nativePlan) {
        this.preparation.discardImageryCandidate(packet.nativePlan.id)
        if (this.prepared) this.prepared.release()
        this.prepared = null
        abi.discardMeshPlan(packet.nativePlan)
      }
      if (error.status === 9) error.capacityRevision = capacityRefusalRevision(frames.ledger,before)
      throw error
    }
  }

  async planImagery(sequence, imagery, onProgress, planId) {
    invariant(!this.planning, 'Local imagery preparation is already running')
    if (this.destroyed) return {superseded:true}
    this.observeView()
    const view = this.view(), revision = this.cancelRevision
    const surface = planId ? this.prepared && this.prepared.surface : this.frames.candidate || this.frames.presented
    const operation=this.planningOperation={interrupted:false}
    this.planning = true
    this.planningRevision = revision
    try {
      // Preparation takes its source loan before yielding. Its owned checkpoint
      // carries the same host deadline across repeated cheap planning batches.
      const message=Object.assign({},view,{sequence,imagery,planId,viewRevision:view.revision})
      const interrupted=()=>this.destroyed||revision!==this.cancelRevision||operation.interrupted
      const result=await runImageryGrants(this.abi,message,
        next=>this.imageryTurn(surface,next,interrupted),interrupted,releaseNativeMeasurements)
      if(result.superseded)return result
      this.measurementHistory = result.measurementHistory
      this.imageryPlanning = {
        viewRevision:result.viewRevision, modelRevision:result.modelRevision,
        ageMs:result.cameraPlanAgeMs, settledRebases:result.settledRebases,
        stage:result.progress ? result.progress.stage :
          result.imageryPlan && result.imageryPlan.quality.planningComplete ? 'complete' : 'planning',
        index:result.progress && result.progress.index,
        measured:result.progress && result.progress.measured,
        work:result.preparationWork, yieldCount:this.turn.count, yieldMs:this.turn.waitMs
      }
      if(this.destroyed||revision!==this.cancelRevision){releaseNativeMeasurements(result.measurements);return {superseded:true}}
      return await this.measurementDelivery.publish(result,new Set([...this.frames.resources.keys(),
        ...(this.prepared?this.prepared.surface.resources.keys():[])]),this.turn,
      interrupted)
    } catch (error) {
      if(!this.destroyed)this.preparation.clearPlanning()
      if (error.superseded) return {superseded:true}
      if(error.status===9)error.capacityRevision=this.frames.ledger.availabilityRevision
      throw error
    } finally {
      this.planning = false
      if(this.planningOperation===operation)this.planningOperation=null
      if (revision !== this.cancelRevision) this.preparation.clearPlanning()
    }
  }

  async imageryTurn(surface,message,interrupted) {
    let result
    try {
      for(;;) {
        if(result){releaseNativeMeasurements(result.measurements);result=null}
        const grant=message.inputGrant||message.referenceGrant||message.outputGrant
        if(interrupted()) {
          if(!this.destroyed) {
            if(grant)this.preparation.cancelImageryInputGrant(grant.id)
            finishImageryGrant(this.preparation,message)
            this.abi.observeImageryInput()
          }
          return {superseded:true}
        }
        const cleanup=new Cleanup();let receipt
        if (!message.planId) {
          // Match the Worker's stream pump: the shared preparation retains
          // member progress and decides whether this published cut can adopt
          // the latest surface under its measured view.
          surface=this.frames.candidate||this.frames.presented||surface
          message.sequence=surface.frame.sequence
        }
        try{result=await this.preparation.prepareImagery(surface,message)}catch(error){cleanup.capture(error)}
        if(interrupted()&&!this.destroyed&&grant)
          cleanup.run(()=>this.preparation.cancelImageryInputGrant(grant.id))
        cleanup.run(()=>{receipt=finishImageryGrant(this.preparation,message,result)})
        cleanup.run(()=>this.abi.observeImageryInput())
        cleanup.finish()
        if(result&&result.preparationWork&&this.preparation.measurementBatch)
          result.preparationWork.measurementCredits=this.preparation.measurementBatch.stats()
        const granted=message.inputGrant||message.referenceGrant||message.outputGrant
        if(!granted||receipt||!result||result.candidateReady||imageryWorkKind(result)||
            !(result.pending||result.continuation))return result
        // An allocated but unfinished stage retains its credit and source
        // cursor across host turns, exactly as the Worker's response pump.
        await this.turn.wait()
      }
    }catch(error){if(result)releaseNativeMeasurements(result.measurements);throw error}
  }

  // Like the Worker RPC boundary, end this call at a bounded producer slice.
  // Close its issued permission before returning, but retain compatible jobs
  // and measurements for the next surface. Hard cancellation clears them.
  suspendImagery() { if(this.planningOperation)this.planningOperation.interrupted=true }

  cancelImagery() {
    ++this.cancelRevision
    if (!this.planning) this.preparation.clearPlanning()
  }

  destroy() {
    const cleanup=new Cleanup()
    this.destroyed = true
    ++this.cancelRevision
    cleanup.run(()=>this.unregisterMeasurementReclaimer())
    cleanup.run(()=>this.turn.close())
    cleanup.run(()=>this.measurementDelivery.close())
    const tasks=Array.from(this.tasks),prepared=this.prepared
    this.tasks.clear()
    this.prepared = null
    for (const task of tasks) cleanup.run(()=>task.cancel())
    cleanup.run(()=>this.preparation.closeMeasurements())
    if(prepared)cleanup.run(()=>prepared.release())
    cleanup.finish()
  }
}

module.exports = {LocalTerrainExecution}
