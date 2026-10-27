const {imageryWorkKind} = require('../../sdk/js/resources/imagery_input_workspace')
const {finishImageryGrant}=require('./imagery_grants')
const {ImageryPreparation} = require('./imagery_preparation')
const loader = require('./terra_wasm')
const common = require('../../sdk/js/core/terra_globe_common')
const surfacePlan = require('../../sdk/js/terrain/terra_surface_plan')
const { surfaceIds, selectReplacementGroups } = require('../../sdk/js/terrain/surface_replacement')
const { MeshFrames } = require('../../sdk/js/terrain/terra_mesh_frames')
const { holdMeshes } = require('../../sdk/js/resources/mesh_ownership')
const { TerrainEpoch } = require('../../sdk/js/terrain/terra_terrain_epoch')
const { WORKER_PROTOCOL } = require('./worker_protocol')
const {MeasurementDeliveryHost} = require('./measurement_delivery_host')
const {createMeshTransferTask} = require('./mesh_transfer_preparation')
const { WorkerTurn } = require('./worker_turn')
const {createPreparedPartitionBatch} = require('./prepared_partitions')
const {residentPartitionPlan} = require('./resident_partition_plan')
const {Cleanup} = require('../../sdk/js/runtime/cleanup')
const {reclaimMeasurementInputs}=require('./completed_measurement_cache')
const {indexPayloadBytes} = require('../../sdk/js/resources/mesh_indices')

function partitionWork(type) { return ['partition', 'partition-plan', 'mesh-partition-plan', 'partition-group-plan'].includes(type) }

class TerrainWorkerHost extends ImageryPreparation {
  constructor(options) {
    super({quotedCredit:true,measurementFactory:options&&options.measurementFactory})
    this.options = options || {}
    this.frames = new MeshFrames(undefined, 'mesh-worker')
    this.terrainEpoch = new TerrainEpoch()
    this.nextTerrainWorkId = 1
    this.destroyed = false
    this.partitionJobs = new Map()
  }

  describePendingMesh() {
    const result = this.pendingMesh.result
    return {sequence: result.frame.sequence,
      modelRevision: result.updateState.modelRevision, updateState: result.updateState,
      selectionViewRevision: this.pendingMesh.message.viewRevision,
      frame: this.pendingMesh.prepared ? Object.assign({}, result.frame, {
        projectionView:result.frame.projectionView.slice(), cameraPosition:result.frame.cameraPosition.slice()}) :
        {coverageComplete: result.frame.coverageComplete, omittedDrawCount: result.frame.omittedDrawCount},
      nativePlan: result.nativePlan,
      indexProducerBytes: this.frames.indices ? 0 : indexPayloadBytes(result.draws),
      boundaryBytes: result.boundaryBytes, replacementPlan: result.replacementPlan,
      draws: result.draws, requests: this.abi.getRequests()}
  }

  terrainSlice(bytes) {
    const pending = this.pendingTerrain, message = pending.message
    const previousCandidate = this.frames.candidate
    try {
      this.abi.setViewport(message.viewport.width, message.viewport.height, message.viewport.fovRadians)
      if (message.camera.longitudeDegrees !== undefined) {
        this.abi.setGlobeTarget(message.camera.longitudeDegrees, message.camera.latitudeDegrees)
      } else this.abi.setPlanarTarget(message.camera.x, message.camera.y)
      this.abi.setCamera(message.camera)
      const value = this.abi.heightSlice(bytes, () => message.type === 'advance'
        ? this.abi.advanceTerrain(message.threshold, message.budget)
        : this.abi.prepareMeshFrame(message.threshold, message.budget))
      if (value.heightPending) return Object.assign({}, value, {workId: pending.id})
      this.pendingTerrain = null
      if (message.type === 'advance') {
        this.terrainEpoch.finish(value)
        return {progress: value, selectionViewRevision: message.viewRevision,
          requests: this.abi.getRequests()}
      }
      const result = this.frames.describePacket(this.abi, value)
      const displayed = this.frames.presented
      const beforeIds = displayed ? surfaceIds(displayed.draws) : []
      const boundaryBytes = result.replacementPlan && result.replacementPlan.atomic
        ? this.abi.replacementWorkBytes(result.nativePlan, beforeIds) : 0
      this.pendingMesh = {result, message, beforeIds, planId: result.nativePlan.id}
      result.boundaryBytes = boundaryBytes
      this.terrainEpoch.finish(result.updateState)
      return this.describePendingMesh()
    } catch (error) {
      this.pendingTerrain = null; this.terrainEpoch.clear(); this.abi.discardTerrainWork()
      if (message.type === 'step' && !previousCandidate) this.discardFailedStep()
      throw error
    }
  }

  async handle(message) {
    common.invariant(!this.destroyed, 'Terrain Worker is destroyed')
    if (message.type === 'initialize') {
      common.invariant(message.protocol === WORKER_PROTOCOL, 'Terrain Worker protocol mismatch')
      common.invariant(!this.abi, 'Terrain Worker is already initialized')
      const module = this.options.abi ? null : await loader.instantiateTerraWasmBytes(message.bytes)
      this.abi = this.options.abi || new (require('./terra_abi').TerraAbi)(module)
      this.initializeProduction()
      common.invariant(this.abi.incrementalLayout, 'Terrain Worker requires the incremental ABI')
      return { ready: true, protocol: WORKER_PROTOCOL }
    }
    common.invariant(this.abi, 'Terrain Worker is not initialized')
    if (message.type === 'advance' || message.type === 'step') {
      common.invariant(!this.pendingTerrain, 'Terrain production is already pending')
      if (message.type === 'step') common.invariant(!this.pendingMesh, 'A mesh transfer is awaiting admission')
      const selection = this.terrainEpoch.begin(message, this.latestView)
      this.pendingTerrain = {id: this.nextTerrainWorkId++, message: selection}
      return this.terrainSlice(0)
    }
    if (message.type === 'terrain-continue') {
      common.invariant(this.pendingTerrain && this.pendingTerrain.id === message.workId,
        'Stale terrain production continuation')
      common.invariant(Number.isSafeInteger(message.heightCreditBytes) && message.heightCreditBytes >= 0 &&
        message.heightCreditBytes <= 0xffffffff, 'Terrain continuation requires height credit')
      return this.terrainSlice(message.heightCreditBytes)
    }
    if (message.type === 'terrain-cancel') {
      if (!this.pendingTerrain || this.pendingTerrain.id !== message.workId) return false
      this.abi.discardTerrainWork(); this.pendingTerrain = null; this.terrainEpoch.clear()
      return true
    }
    if (message.type === 'trim-imagery-references') {
      common.invariant(Number.isSafeInteger(message.needed) && message.needed > 0 &&
        typeof message.restart === 'boolean', 'Imagery reference trim requires a byte deficit')
      return this.abi.reclaimImageryReferenceSlice(message.needed, message.restart)
    }
    if(message.type==='trim-native-measurements') {
      common.invariant(Number.isSafeInteger(message.needed)&&message.needed>0,'Native model trim requires a byte deficit')
      return reclaimMeasurementInputs(this,this.measurementDelivery,message.needed)
    }
    if (message.type === 'trim-heights') {
      common.invariant(Number.isSafeInteger(message.needed) && message.needed > 0,
        'Height cache trim requires a byte deficit')
      return this.abi.reclaimHeights(message.needed)
    }
    if (message.type === 'replacement') {
      const pending = this.pendingMesh
      common.invariant(pending && pending.result.nativePlan.id === message.planId &&
        message.maximumBytes >= pending.result.boundaryBytes, 'Stale or uncredited boundary plan')
      const task = this.abi.createReplacementTask(pending.result.nativePlan, pending.beforeIds, message.maximumBytes)
      try {
        const proof = await task.run(this.yieldWork)
        common.invariant(this.pendingMesh === pending && proof, 'Boundary planning was cancelled')
        pending.result.replacementPlan = proof
        return proof
      } finally { task.cancel() }
    }
    if (message.type === 'select-groups') {
      const pending = this.pendingMesh
      common.invariant(pending && pending.result.nativePlan.id === message.planId &&
        pending.result.replacementPlan && !pending.result.replacementPlan.atomic,
        'Stale mesh group selection')
      if (!pending.proof) pending.proof = pending.result.replacementPlan
      if (pending.prepared) {
        const groups = new Set(message.groups)
        const available = id => pending.prepared.surface.resources.has(id) || this.frames.resources.has(id)
        common.invariant(pending.proof.groups.every((group, index) =>
          (groups.has(index) ? group.after : group.before).every(available)),
        'Late selection requires an unprepared mesh')
      }
      const result = this.abi.selectMeshGroups(pending.result.nativePlan, message.groups)
      result.replacementPlan = selectReplacementGroups(pending.proof, message.groups)
      pending.result = result
      if (pending.prepared) {
        common.invariant(result.nativePlan.additionalBytes === 0,
          'Late selection requires new native allocation')
        const task = pending.productionTask = this.abi.createMeshTask(result, 0)
        try {
          const produced = await task.run(this.yieldWork)
          common.invariant(produced && this.pendingMesh === pending, 'Late mesh selection was cancelled')
          pending.prepared.reselect(result)
        } finally {
          if (pending.productionTask === task) pending.productionTask = null
          task.cancel()
        }
      }
      return this.describePendingMesh()
    }
    if (message.type === 'materialize') {
      common.invariant(Array.isArray(message.residentTextureIds) && message.residentTextureIds.every(id =>
        Number.isSafeInteger(id) && id > 0), 'Invalid resident UV identities')
      const pending = this.pendingMesh
      common.invariant(pending && pending.result.frame.sequence === message.sequence &&
        pending.planId === message.planId && !pending.prepared,
        'Stale mesh transfer')
      common.invariant(!pending.result.boundaryBytes || pending.result.replacementPlan,
        'A complete-cut or boundary proof must precede mesh production')
      common.invariant(Number.isSafeInteger(message.maximumNativeBytes) &&
        message.maximumNativeBytes >= (pending.result.nativePlan ? pending.result.nativePlan.additionalBytes : 0) &&
        message.maximumNativeBytes <= 0xffffffff, 'Native mesh production is not credited')
      try {
        if (!pending.transferTask) {
          if (!pending.productionTask) pending.productionTask = this.abi.createMeshTask(pending.result, message.maximumNativeBytes)
          const produced = pending.productionTask.step()
          if (!produced.done) return {pending: true}
          common.invariant(produced.value && this.pendingMesh === pending, 'Mesh production was cancelled')
          pending.productionTask = null
          pending.transferTask = createMeshTransferTask(this.abi, this.frames, pending.result,
            Object.assign({}, pending.message, {maximumIndexBytes:message.maximumIndexBytes}), message.residentTextureIds)
        }
        const prepared = pending.transferTask.step()
        if (!prepared.done) return {pending: true}
        common.invariant(prepared.value && this.pendingMesh === pending, 'Mesh preparation was cancelled')
        pending.prepared = prepared.value
        return prepared.value.transfer
      } catch (error) {
        this.discardFailedStep()
        throw error
      }
    }
    if (message.type === 'commit-mesh') {
      const pending = this.pendingMesh
      common.invariant(pending && pending.planId === message.planId && pending.prepared,
        'Stale mesh acceptance')
      const updateState = pending.prepared.accept()
      this.publishImageryCandidate(pending.planId)
      this.pendingMesh = null
      return {updateState}
    }
    if (message.type === 'imagery') {
      const result = message.planId ? this.pendingMesh && this.pendingMesh.planId === message.planId &&
        this.pendingMesh.prepared && this.pendingMesh.prepared.surface : this.frames.candidate || this.frames.presented
      return this.prepareImagery(result, message)
    }
    if (message.type === 'retain') {
      const prepared = this.frames.prepareRetention(message.sequence, message.draws)
      this.abi.retainMeshes(message.sequence, message.draws)
      this.frames.commitRetention(prepared)
      return true
    }
    if (message.type === 'present') {
      common.invariant(this.frames.candidate &&
        this.frames.candidate.frame.sequence === message.sequence, 'Stale Worker frame receipt')
      this.abi.presentFrame(message.sequence)
      this.frames.present(message.sequence)
      return true
    }
    if (partitionWork(message.type)) {
      if (message.type === 'partition') common.invariant(Number.isSafeInteger(message.maximumBytes) && message.maximumBytes >= 0,
        'Partition output credit is required')
      let job = this.partitionJobs.get(message.id)
      if (!job) {
        if (message.type === 'mesh-partition-plan') {
          const pending = this.pendingMesh
          common.invariant(pending && pending.result.nativePlan.id === message.planId && Array.isArray(message.rows),
            'Stale prepared partition batch')
          const draws = new Map(pending.result.draws.map(draw => [draw.resourceId, draw])), seen = new Set()
          const rows = message.rows.map(row => {
            common.invariant(draws.has(row.resourceId) && !seen.has(row.resourceId) && Array.isArray(row.cells),
              `Invalid prepared partition batch member (${row.resourceId}, selected=${draws.has(row.resourceId)}, duplicate=${seen.has(row.resourceId)})`)
            seen.add(row.resourceId)
            return {draw: draws.get(row.resourceId), cells: row.cells}
          })
          const indices = this.frames.indices || pending.prepared && pending.prepared.surface.indices
          job = createPreparedPartitionBatch(this.abi, message.planId, rows, indices,
            message.maximumBytes, row => {
              const resource = this.frames.resources.get(row.draw.resourceId) ||
                pending.prepared && pending.prepared.surface.resources.get(row.draw.resourceId)
              return resource && resource.model ? {model: resource.model, release: holdMeshes([resource])} : null
            })
          job.releaseMeshes = () => {} // Each child releases its own model/scratch.
        } else if (message.type === 'partition-group-plan') {
          job = residentPartitionPlan(message.rows, this.frames.resources)
        } else {
          const resource = this.frames.resources.get(message.resourceId)
          // A started job owns its immutable model across terrain publications.
          // A not-yet-started retired model can be prepared by its renderer owner.
          if (!resource || !resource.model) return null
          job = message.type === 'partition-plan' ? surfacePlan.createPartitionPlanTask(resource.model, message.cells)
            : surfacePlan.createPartitionTask(resource.model, message.cells, message.maximumBytes)
          job.releaseMeshes = holdMeshes([resource])
        }
        this.partitionJobs.set(message.id, job)
      }
      try {
        if (message.type === 'mesh-partition-plan') common.invariant(this.pendingMesh &&
          this.pendingMesh.result.nativePlan.id === message.planId, 'Stale prepared partition batch')
        const result = job.step()
        if (!result.done) return Object.assign({pending: true},
          ['mesh-partition-plan', 'partition-group-plan'].includes(message.type) ? result.value : null)
        this.partitionJobs.delete(message.id)
        job.releaseMeshes()
        return result.value
      } catch (error) { this.cancelPartition(message.id); throw error }
    }
    if (message.type === 'discard-plan') {
      if (!this.pendingMesh || this.pendingMesh.planId !== message.planId) return false
      this.discardPendingMesh()
      return true
    }
    if (message.type === 'trim-records') {
      common.invariant(Number.isSafeInteger(message.needed) && message.needed > 0,
        'Record cache trim requires a byte deficit')
      return this.abi.reclaimRecords(message.needed)
    }
    if (message.type === 'trim-native') {
      common.invariant(Number.isSafeInteger(message.needed) && message.needed > 0,
        'Native cache trim requires a byte deficit')
      return this.abi.reclaimNative(message.needed)
    }
    if (message.type === 'discard') {
      if (this.planSequence === message.sequence && !this.imageryJob) this.clearPlanning()
      return this.frames.discard(message.sequence)
    }
    if (message.type === 'call') {
      const allowed = ['loadManifest', 'setPlanarLevel', 'submitRecord', 'failRecord',
        'noDataRecord', 'retryRecord', 'computeAtmosphere', 'sampleTerrain',
        'getHeightQueryRegion', 'beginHeightQuery', 'stepHeightQuery', 'submitHeightQueryRecord', 'heightQueryUnavailable', 'endHeightQuery']
      common.invariant(allowed.includes(message.method), 'Unsupported Worker method')
      const recordProduction = ['loadManifest', 'submitRecord'].includes(message.method)
      if (recordProduction) common.invariant(Number.isSafeInteger(message.recordCreditBytes) && message.recordCreditBytes >= 0 &&
        message.recordCreditBytes <= 0xffffffff, 'Worker record production requires credit')
      if (message.method === 'loadManifest') {
        this.abi.discardTerrainWork(); this.pendingTerrain = null
        this.clearPartitions()
        this.discardPendingMesh()
        this.terrainEpoch.clear()
        this.imageryScale = null
        this.coarseningRevision = null
        this.frames.clear(); this.imageryLevels.clear(); this.clearPlanning()
        this.measurementHistory.clear(); this.lastPlanningFrame = null
        this.admissionSignature = null
      }
      if (recordProduction) {
        const result = await this.abi[message.method](...message.args, message.recordCreditBytes)
        if (message.method === 'loadManifest') {this.manifest=message.args[0];this.initializeProduction()}
        return result
      }
      return this.abi[message.method](...message.args)
    }
    if (message.type === 'destroy') {
      this.destroyed = true
      this.pendingTerrain = null
      const cleanup=new Cleanup()
      cleanup.run(()=>this.abi.discardTerrainWork())
      cleanup.run(()=>this.discardPendingMesh())
      cleanup.run(()=>this.clearPartitions())
      cleanup.run(()=>this.terrainEpoch.clear())
      cleanup.run(()=>this.frames.clear())
      cleanup.run(()=>this.closeMeasurements())
      cleanup.run(()=>this.abi.destroy())
      cleanup.finish()
      return true
    }
    throw new Error('Unsupported terrain Worker message')
  }

  cancelPartition(id) {
    const job = this.partitionJobs.get(id)
    this.partitionJobs.delete(id)
    if (job) {
      const cleanup=new Cleanup()
      cleanup.run(()=>job.cancel());cleanup.run(()=>job.releaseMeshes());cleanup.finish()
    }
  }

  clearPartitions() {
    const cleanup=new Cleanup()
    for (const id of Array.from(this.partitionJobs.keys())) cleanup.run(()=>this.cancelPartition(id))
    cleanup.finish()
  }

  discardPendingMesh() {
    const pending = this.pendingMesh
    this.pendingMesh = null
    const cleanup=new Cleanup()
    if (pending && pending.productionTask) cleanup.run(()=>pending.productionTask.cancel())
    if (pending && pending.transferTask) cleanup.run(()=>pending.transferTask.cancel())
    if (pending && pending.prepared) {
      cleanup.run(()=>this.discardImageryCandidate(pending.planId))
      cleanup.run(()=>pending.prepared.release())
    }
    if (pending) cleanup.run(()=>this.abi.discardMeshPlan(pending.result.nativePlan))
    cleanup.finish()
  }

  discardFailedStep() {
    this.discardPendingMesh()
    if (this.frames.candidate) this.frames.discard(this.frames.candidate.frame.sequence)
    // A cancelled terrain publication does not invalidate immutable resources
    // already owned by the independent imagery snapshot.
  }


}

function transferList(value) {
  const result = [], seen = new Set(), buffers = new Set()
  const visit = item => {
    if (!item || typeof item !== 'object' || seen.has(item)) return
    seen.add(item)
    if (ArrayBuffer.isView(item)) {
      if (!buffers.has(item.buffer)) {buffers.add(item.buffer); result.push(item.buffer)}
    } else if (Array.isArray(item)) item.forEach(visit)
    else if (typeof item === 'object') Object.keys(item).forEach(key => visit(item[key]))
  }
  visit(value)
  return result
}

function install(scope, options) {
  const host = new TerrainWorkerHost(options), controls = [], work = []
  const turn = new WorkerTurn(scope)
  let deliveries
  let running = false, draining = false
  const nativeBytes = () => host.abi && !host.destroyed ? host.abi.meshPayloadBytes() : 0
  const nativeRevision = () => host.abi ? host.abi.nativeRevision : 0
  const heightBytes = () => host.abi && !host.destroyed ? host.abi.heightPayloadBytes() : 0
  const imageryBytes = () => host.abi && !host.destroyed ? host.abi.imageryPayloadBytes() : 0
  const imageryOutputBytes = () => host.abi && !host.destroyed ? host.abi.imageryOutputPayloadBytes() : 0
  const imageryReferenceRevision = () => host.abi ? host.abi.imageryReferenceRevision || 0 : 0
  const imageryReferenceBytes = () => host.abi && !host.destroyed ? host.abi.imageryReferencePayloadBytes() : 0
  const imageryInputBytes = () => host.abi && !host.destroyed ? host.abi.imageryInputPayloadBytes() : 0
  const recordBytes = () => host.abi && !host.destroyed ? host.abi.recordPayloadBytes() : 0
  const indexBytes = () => {
    const owner = host.frames.ledger.ownerTotals['terrain-index-worker']
    return owner ? owner.reserved + owner.resident + owner.retired : 0
  }
  const streams = new Map(), partitions = new Map()
  let failed=false
  const fatal=error=>{
    if(failed)return
    failed=true
    work.length=controls.length=0
    streams.clear();partitions.clear();if(deliveries)deliveries.close();turn.close()
    scope.onmessage=()=>{}
    scope.postMessage({type:'fatal',measurementStopped:true,error:common.redactSensitiveText(error&&error.message||String(error))})
  }
  const ownership=extra=>Object.assign({memoryBytes:host.abi?host.abi.memoryBytes():0,
    nativeBytes:nativeBytes(),nativeRevision:nativeRevision(),recordBytes:recordBytes(),indexBytes:indexBytes(),
    heightBytes:heightBytes(),imageryBytes:imageryBytes(),imageryOutputBytes:imageryOutputBytes(),
    imageryInputBytes:imageryInputBytes(),imageryReferenceBytes:imageryReferenceBytes(),
    imageryReferenceRevision:imageryReferenceRevision()},extra)
  const finishResponse=(message,progress)=>{
    if(progress)work.push(message)
    else {streams.delete(message.id);partitions.delete(message.id)}
  }
  let publishedInput
  deliveries=new MeasurementDeliveryHost({
    quote:(message,mirrorWork)=>scope.postMessage(ownership({id:message.id,mirrorWork})),
    publish:(message,value,progress,mirrorReceipt)=>{
      // A streamed CPU reply may wait in the mirror queue before cancellation
      // turns it into a terminal reply. End its producer permission here too,
      // before the client can refund the input credit from this receipt.
      if(!progress) {
        const grant=message.inputGrant||message.referenceGrant||message.outputGrant
        if(value.superseded&&grant)host.cancelImageryInputGrant(grant.id)
        if(finishImageryGrant(host,message,value))value.inputReceipt=true
      }
      const packet=ownership({id:message.id,value,progress,mirrorReceipt})
      scope.postMessage(packet,transferList(value));publishedInput=packet.imageryInputBytes
    },
    finished:(message,progress)=>{
      // Transfer commits can retire the Sender's previous native input after
      // the data reply was serialized. Publish that actual ownership receipt.
      if(publishedInput!==imageryInputBytes())scope.postMessage(ownership({type:'native-ownership'}))
      finishResponse(message,progress)
    },
    cancel:message=>{
      if(partitionWork(message.type))host.cancelPartition(message.id)
      else if(!message.rebase)host.clearPlanning()
    },fatal
  })
  host.measurementDelivery=deliveries
  const respond = async message => {
    const previousCandidate = host.frames.candidate
    const measurementReset = message.type === 'destroy' || message.type === 'call' && message.method === 'loadManifest'
    try {
      if(message.type==='measurement-grant'){deliveries.grant(message.workId,message.bytes);return}
      if(message.type==='measurement-resend'){deliveries.resend(message.workId,message.missing);return}
      if(message.type==='measurement-forget'){deliveries.forget(message.items);return}
      if(message.type==='measurement-cancel'){deliveries.cancel(message.workId);return}
      if(message.type==='measurement-stop') {
        deliveries.stopped=true;deliveries.reset()
        scope.postMessage(ownership({type:'native-ownership',measurementStopped:true}));return
      }
      if(measurementReset)deliveries.reset()
      if (message.type === 'cancel-imagery') {
        host.clearPlanning()
        deliveries.reset()
        scope.postMessage(ownership({type: 'native-ownership', measurementReset: true}))
        return
      }
      if (message.type === 'destroy' || message.type === 'call' && message.method === 'loadManifest') {
        partitions.forEach(job => { job.cancelled = true })
      }
      if (message.stream && message.type === 'imagery' && !message.planId) {
        const surface = host.frames.candidate || host.frames.presented
        if (surface) message.sequence = surface.frame.sequence
      }
      let value
      if (!message.cancelled) value = await host.handle(message)
      if (message.cancelled) {
        if (partitionWork(message.type)) host.cancelPartition(message.id)
        else if (!message.rebase) host.clearPlanning()
        else if (message.inputGrant || message.referenceGrant || message.outputGrant)
          host.cancelImageryInputGrant((message.inputGrant || message.referenceGrant || message.outputGrant).id)
        value = {superseded: true}
      }
      // Bounded CPU continuations keep their stream's credit. A terminal
      // reply closes permission before its native ownership is serialized.
      const allocationReceipt=finishImageryGrant(host,message,value)
      if(value&&value.preparationWork&&host.measurementBatch)
        value.preparationWork.measurementCredits=host.measurementBatch.stats()
      if (allocationReceipt && value) value.inputReceipt = true
      const progress = Boolean(!message.cancelled && value &&
        !value.candidateReady && !imageryWorkKind(value) && !allocationReceipt &&
        (partitionWork(message.type) || message.type === 'materialize' ? value.pending
          : message.stream && (value.pending || value.continuation)))
      // The consumer still receives the complete supporting snapshot. Unchanged
      // immutable regions use references to successfully transmitted versions.
      if(value&&value.measurements) {
        deliveries.enqueue(message,value,progress,new Set([...host.frames.resources.keys(),
          ...(host.pendingMesh&&host.pendingMesh.prepared?host.pendingMesh.prepared.surface.resources.keys():[])]))
        return
      }
      scope.postMessage(ownership({id:message.id,value,progress,measurementReset}),transferList(value))
      finishResponse(message,progress)
    } catch (error) {
      if(host.abi&&host.abi.destroyed){fatal(error);return}
      const cleanup=new Cleanup()
      cleanup.capture(error)
      cleanup.run(()=>host.finishMeasurementGrant())
      if (partitionWork(message.type)) cleanup.run(()=>host.cancelPartition(message.id))
      if (['step', 'replacement', 'materialize'].includes(message.type) && !previousCandidate) cleanup.run(()=>host.discardFailedStep())
      if(host.abi&&host.abi.destroyed){fatal(error);return}
      streams.delete(message.id)
      partitions.delete(message.id)
      scope.postMessage(ownership(error.superseded
        ? {id:message.id,measurementReset,value:{superseded:true}}
        : { id: message.id, measurementReset, error: common.redactSensitiveText(error.message || String(error)),
          status:error.status,requests:error.requests}))
    }
  }
  const drainControls = async () => {
    if (draining) return
    draining = true
    try {
      const started = Date.now()
      while (controls.length) {
        const urgent = controls.findIndex(m => ['retain', 'present', 'discard', 'discard-plan'].includes(m.type))
        await respond(controls.splice(urgent < 0 ? 0 : urgent, 1)[0])
        if (Date.now() - started >= 4) break
      }
    } finally { draining = false }
  }
  host.yieldWork = async () => {
    await turn.wait()
    await drainControls()
    // Coarsening owns a bounded turn even with same-view work queued. New
    // camera notifications still interrupt it at the next slice boundary.
    return !work.length || host.coarseningRevision === host.latestViewRevision
  }
  const pump = async () => {
    if (running) return
    running = true
    try {
      while (!failed&&(work.length || controls.length || deliveries.hasWork())) {
        await drainControls()
        if (work.length) {
          const isTerrain = m => m.type === 'step' || m.type === 'advance' || m.type === 'terrain-continue' || m.type === 'replacement' || m.type === 'materialize'
          const terrain = work.findIndex(isTerrain)
          const background = work.findIndex(m => !isTerrain(m))
          const index = terrain >= 0 && (!host.backgroundTurn || background < 0) ? terrain :
            background >= 0 ? background : 0
          host.backgroundTurn = isTerrain(work[index])
          await respond(work.splice(index, 1)[0])
          // A stream owns no timer when idle. Between bounded batches allow
          // view notifications, receipts and new work to enter the queue.
        }
        if(deliveries.hasWork())await deliveries.tick()
        if(work.length||controls.length||deliveries.hasWork())await turn.wait()
      }
    } finally { running = false; turn.close() }
  }
  scope.onmessage = event => {
    if(failed)return
    const message = event.data
    if (message.type === 'cancel-imagery') {
      if (message.all) {
        streams.forEach(stream => { stream.cancelled = true; stream.rebase = false })
        // A compatible rebase may be idle between RPCs while still owning a
        // projection iterator. Release it at a task boundary, never mid-slice.
        work.push({type: 'cancel-imagery'})
        pump()
        return
      }
      const stream = streams.get(message.id)
      if (stream) {
        stream.cancelled = true
        stream.rebase = message.rebase === true
      }
      pump()
      return
    }
    if (message.type === 'cancel-partition') {
      const job = partitions.get(message.id)
      if (job) { job.cancelled = true; host.cancelPartition(message.id) }
      return
    }
    if (partitionWork(message.type)) partitions.set(message.id, message)
    if (message.stream) streams.set(message.id, message)
    if (message.type === 'view') {
      host.observeView(message)
      return
    }
    const control = message.type.startsWith('measurement-') || ['retain', 'present', 'discard', 'discard-plan', 'terrain-cancel', 'trim-heights', 'trim-imagery-references', 'trim-native-measurements'].includes(message.type) ||
      message.type === 'call' && ['submitRecord', 'failRecord', 'noDataRecord', 'retryRecord', 'computeAtmosphere',
        'submitHeightQueryRecord', 'heightQueryUnavailable', 'endHeightQuery'].includes(message.method)
    ;(control ? controls : work).push(message)
    pump()
  }
}

module.exports = { TerrainWorkerHost, transferList, install }
