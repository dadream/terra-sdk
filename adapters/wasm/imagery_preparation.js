const {hiddenResources} = require('../../sdk/js/terrain/visibility_evidence')
const {projectedViewChange} = require('./imagery_view_change')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')
const common = require('../../sdk/js/core/terra_globe_common')
const {monotonicNow} = require('../../sdk/js/diagnostics/timing')
const surfacePlan = require('../../sdk/js/terrain/terra_surface_plan')
const {PartitionFitCache} = require('../../sdk/js/terrain/partition_fit_cache')
const {ImageryInputWorkspace, imageryWorkKind} = require('../../sdk/js/resources/imagery_input_workspace')
const {ImageryInputBatch}=require('../../sdk/js/resources/imagery_input_batch')
const {holdMeshes, ownMeshWork} = require('../../sdk/js/resources/mesh_ownership')
const {SurfaceMeasurementCache} = require('../../sdk/js/terrain/surface_measurement_cache')
const {NativeMeasurementProduction}=require('./native_measurement_production')
const {ownNativeMeasurements,releaseNativeMeasurements}=require('./native_surface_measurement')
const {parentTextureTile, textureCellTransform} = require('../../sdk/js/imagery/terra_texture_tiles')
const {TASK_WAIT} = require('../../sdk/js/runtime/cooperative_task')
const {Cleanup} = require('../../sdk/js/runtime/cleanup')
const {outsideFrustumBox}=require('../../sdk/js/terrain/frustum_bounds')
const {transform}=require('../../sdk/js/math/projection')

function measurementPriority(draw,model,context) {
  const origin=draw.origin||[0,0,0]
  let priority=Infinity
  for(const block of model.blocks||[]) {
    if(outsideFrustumBox(block.minimum,block.maximum,origin,context.planes))continue
    const point=block.minimum.map((v,i)=>(v+block.maximum[i])/2+origin[i])
    const p=transform(context.matrix,point)
    if(p[3]>0)priority=Math.min(priority,Math.hypot(p[0]/p[3],p[1]/p[3]))
  }
  return priority
}

function exportMeasurements(measured) {
  return Array.from(measured, ([resourceId, m]) => ({resourceId,
    pixelsPerUv: m.pixelsPerUv, visible: m.visible, centerDistance: m.centerDistance,
    regions: m.regions, bounds: m.bounds, hull: m.hull}))
}

function measurementPreview(draws, measured, options) {
  const tiles = new Set(), result = [], target = options.targetPixelError || 1.25
  draws.forEach(draw => {
    const m = measured.get(draw.resourceId)
    if (!m || !m.visible) return
    let tile = draw.texture
    const delta = Math.ceil(Math.log2(m.pixelsPerUv / ((options.descriptor.tile_size || 256) * target)))
    // A terrain sampling anchor may be deeper than the physical image source.
    // Preview requests must obey the same source limit as the final core cut.
    const level = Math.min(options.descriptor.maximum_level,
      Number.isFinite(delta) ? Math.max(0, tile.level + Math.min(0, delta)) : tile.level)
    while (tile.level > level) tile = parentTextureTile(tile)
    const key = common.textureKeyString(tile)
    if (!tiles.has(key) && tiles.size >= (options.maximumTextures || 214)) return
    tiles.add(key)
    const t = textureCellTransform(draw.texture, tile)
    result.push(Object.assign({}, draw, {texture: tile, sourceTexture: draw.texture,
      imageryCellScale: t.scale, imageryCellOffsetX: t.offsetX, imageryCellOffsetY: t.offsetY,
      imageryClipCell: false, imageryPriority: m.pixelsPerUv,
      imageryCapacityCoarsened: false}))
  })
  return {draws: result, levels: new Set(), quality: {targetPixelError: target,
    planningComplete: false, measurementPending: true, spatialCut: false,
    measuredMaxPixelError: Infinity, desiredDrawCount: result.length}}
}

// Shared bounded imagery preparation for local Wasm and Worker execution.
// The execution adapter supplies immutable surfaces and camera snapshots. Both
// runtime adapters return workspace quotes before allocating. Low-level
// ABI consumers can also execute directly against their own ledger.
class ImageryPreparation {
  constructor(options = {}) {
    this.abi = options.abi || null
    this.manifest = options.manifest || {}
    this.quotedCredit = Boolean(options.quotedCredit)
    this.yieldWork = options.yieldWork
    this.beforeWork = options.beforeWork
    this.holdSurface = options.holdSurface || (surface=>holdMeshes(surface.resources.values()))
    this.imageryLevels = new Set()
    this.latestViewRevision = 0
    this.admissionEpoch = 0
    this.imageryPlanRevision = 0
    this.measurementHistory = new SurfaceMeasurementCache()
    this.publishedMeasurements = new Map()
    this.partitionFitCache = new PartitionFitCache()
    this.workStats = {slices:0, cpuMs:0, stages:{}}
    this.measurementFactory=options.measurementFactory||((abi,workspace)=>new NativeMeasurementProduction(abi,workspace))
    this.initializeProduction()
  }

  initializeProduction() {
    if(this.measurementProduction)this.measurementProduction.destroy()
    if(this.measurementBatch)this.measurementBatch.close()
    this.measurementInputWorkspace=null
    this.measurementBatch=this.abi&&this.quotedCredit?new ImageryInputBatch(()=>{
      this.measurementInputWorkspace=new ImageryInputWorkspace(this.nextImageryInputId=(this.nextImageryInputId||0)+1)
      return this.measurementInputWorkspace
    }):null
    this.measurementProduction=this.abi?this.measurementFactory(this.abi,this.measurementBatch?()=>this.measurementBatch.stage():undefined):null
  }

  finishMeasurementGrant(){if(this.measurementBatch)this.measurementBatch.finishGranted()}

  *heldMeasurements() {
    for(const values of [this.imageryMeasurements,this.measurementJob&&this.measurementJob.bounds,
      this.imageryJob&&this.imageryJob.precise])if(values)yield* values.values()
    if(this.lastMeasurements)yield* this.lastMeasurements
  }

  measurementResponse(value) {
    return value.measurements?Object.assign({},value,{measurements:ownNativeMeasurements(value.measurements.slice())}):value
  }

  inputWorkspace(id) {
    return [this.measurementInputWorkspace,this.imageryInputWorkspace].find(value=>value&&value.id===id)
  }

  inputReceipted(id) {
    const workspace=this.inputWorkspace(id)
    return !workspace||workspace.finished
  }

  observeView(message) {
    if (message.revision < this.latestViewRevision) return
    if (message.revision > this.latestViewRevision) this.latestViewAt = Date.now()
    this.latestViewRevision = message.revision
    this.latestView = message
  }

  async prepareImagery(result, message) {
    if(this.measurementProduction&&this.measurementProduction.closed) {
      this.closeMeasurements()
      this.initializeProduction()
    }
    if (message.outputGrant && !message.outputGranted) {
      if (!this.imageryOutputWorkspace || !this.imageryOutputWorkspace.grant(message.outputGrant)) return {superseded:true}
      message.outputGranted = true
    }
    if (message.referenceGrant && !message.referenceGranted) {
      if (!this.imageryReferenceWorkspace || !this.imageryReferenceWorkspace.grant(message.referenceGrant)) return {superseded:true}
      message.referenceGranted = true
    }
    if (message.inputGrant && !message.inputGranted) {
      const workspace=this.inputWorkspace(message.inputGrant.id)
      if (!workspace || !workspace.grant(message.inputGrant)) return {superseded:true}
      message.inputGranted = true
    }
    common.invariant(result && result.frame.sequence === message.sequence,
      `Stale imagery frame (requested ${message.sequence}, available ${result && result.frame.sequence || 0})`)
    if (!this.imageryJob) this.checkView(message)
    if (this.latestView && this.latestView.snapshot) message = Object.assign({}, message,
      this.latestView, {type: 'imagery', viewRevision: this.latestView.revision})
    if (this.imageryJob && ((this.imageryJob.planId || 0) !== (message.planId || 0) ||
        message.planId && (this.imageryJob.result.meshIdentity !== result.meshIdentity ||
        this.imageryJob.result.updateState.modelRevision !== result.updateState.modelRevision))) {
      this.adoptImageryCandidate(result, message)
    }
    if (this.imageryJob && !message.planId && !this.imageryJob.planId &&
        this.imageryJob.viewRevision === message.viewRevision &&
        result.frame.decisionsComplete === true &&
        !result.updateState.pendingMeshGroups && !result.updateState.pendingPriorityUpdateCount &&
        (this.imageryJob.result.frame.sequence !== result.frame.sequence ||
         this.imageryJob.result.meshIdentity !== result.meshIdentity)) {
      // Once terrain decisions settle, continue measurements of surviving
      // members on the published cut instead of fitting retired terrain first.
      // While topology is still changing, finish an immutable cut so repeated
      // publications cannot starve native fitting. Private candidates keep
      // their separate progress protection above and below.
      this.adoptImageryCandidate(result, message)
    }
    const range = Math.max(0.1, Number(message.camera.distance) || 0)
    const scale = range * Math.tan((message.viewport.fovRadians || Math.PI / 3) / 2) /
      Math.max(1, message.viewport.height)
    const previous = this.imageryJob
    const previousFrame = previous ? previous.result.frame : this.lastPlanningFrame
    if (!this.projectionChange || this.projectionChange.frame !== previousFrame ||
        this.projectionChange.revision !== message.viewRevision) {
      this.projectionChange = {frame:previousFrame, revision:message.viewRevision,
        value:projectedViewChange(result.draws,
          draw => result.resources.get(draw.resourceId) && result.resources.get(draw.resourceId).model,
          previousFrame, message.snapshot)}
    }
    const projectedChange = this.projectionChange.value
    if (this.observedScale !== scale) {
      this.observedScale = scale
      this.scaleChangedAt = Date.now()
    }
    const ratio = previous ? scale / previous.scale : 1
    const scaleChanged = ratio >= 4 || ratio <= 0.25 ||
      Date.now() - this.scaleChangedAt >= 160 && (ratio > 1.1 || ratio < 1 / 1.1)
    const before = previous && previous.message.camera
    const angle = (a,b) => Math.abs(Math.atan2(Math.sin((a||0)-(b||0)), Math.cos((a||0)-(b||0))))
    const orientationChanged = before && (angle(before.tiltRadians,message.camera.tiltRadians) > 0.08 ||
      angle(before.yawRadians,message.camera.yawRadians) > 0.15)
    const radians = Math.PI / 180
    const latitude = ((before && before.latitudeDegrees || 0) + (message.camera.latitudeDegrees || 0)) * radians / 2
    const displacement = before ? Math.hypot(
      angle((before.longitudeDegrees||0)*radians,(message.camera.longitudeDegrees||0)*radians) * Math.cos(latitude),
      ((before.latitudeDegrees||0)-(message.camera.latitudeDegrees||0))*radians) * (this.manifest.radius || 0) : 0
    const footprintChanged = displacement > Math.max(1, range * Math.tan(message.viewport.fovRadians / 2))
    // Small continuous moves keep the immutable snapshot progressing. Once
    // input is quiet, spending seconds finishing an older camera prevents
    // both current-view precision and reuse across later terrain publications.
    // Rebase once to that settled revision, never on same-view topology work.
    const settledView = previous && !previous.settlementRebased && this.latestView && this.latestView.snapshot &&
      this.latestView.revision === message.viewRevision && this.latestViewAt !== undefined &&
      Date.now() - this.latestViewAt >= 160
    let settlementRebased = false
    // Keep useful work through small movements, but do not finish a near-ground
    // snapshot after a scale jump. CPU models, partitions and native history
    // remain reusable; only the obsolete camera-dependent work is retired.
    // A private mesh candidate already owns a bounded production window.
    // Finish its first usable spatial cut before following another camera;
    // otherwise repeated horizon/scale changes can restart its projection or
    // native input forever while blocking all terrain publication. The reply
    // retains the measured view revision, and displayed imagery resumes the
    // latest camera after commit. Source/pixel-ratio changes still invalidate
    // incompatible measurements and every output keeps its actual admission.
    const producingCandidate = previous && message.planId && previous.planId === message.planId
    if (previous && (JSON.stringify(previous.message.imagery.descriptor) !== JSON.stringify(message.imagery.descriptor) ||
        (previous.message.imagery.devicePixelRatio || 1) !== (message.imagery.devicePixelRatio || 1) ||
        !producingCandidate && previous.viewRevision !== message.viewRevision &&
        (settledView || (projectedChange ? projectedChange.rebase : scaleChanged || orientationChanged || footprintChanged)))) {
      if (settledView && previous.viewRevision !== message.viewRevision) {
        settlementRebased = true
        this.imagerySettledRebases = (this.imagerySettledRebases || 0) + 1
      }
      this.clearPlanning('projection-changed')
    }
    if (this.imageryJob) {
      // Freeze projection, not admission policy. A resumed request may carry
      // newly granted or reduced capacity while this camera is still being
      // measured. The native/partition signatures invalidate only those
      // stages; shared exact measurements and suspended iterators survive.
      // Descriptor/pixel-ratio changes invalidate projection above instead.
      this.imageryJob.message.imagery = Object.assign({}, message.imagery)
    }
    if (!this.imageryJob) {
      this.checkView(message)
      this.workStats.jobs = (this.workStats.jobs || 0) + 1
      // Finish one bounded snapshot across pointer changes and terrain
      // publications. Its immutable resources live only until this job ends.
      this.imageryJob = {
        planId: message.planId || 0,
        result: Object.assign({}, result, {frame: Object.assign({}, result.frame, message.snapshot)}),
        releaseMeshes: this.holdSurface(result),
        message: Object.assign({}, message, {viewRevision: undefined}),
        viewRevision: message.viewRevision, scale, started: Date.now(), exact: new Set(), precise: new Map(),
        // Finish this replacement through intermittent small input as well.
        // Major projected changes still supersede an obsolete footprint.
        settlementRebased,
        coarsening: (projectedChange && projectedChange.coarsening !== null
          ? projectedChange.coarsening : scale > (this.imageryScale || scale) * 1.1) ||
          this.coarseningRevision != null && this.coarseningRevision === message.viewRevision
      }
      this.publishedMeasurements.clear()
      this.lastPlanningFrame = this.imageryJob.result.frame
      this.coarseningRevision = this.imageryJob.coarsening ? message.viewRevision : null
      this.imageryScale = scale
    }
    const job = this.imageryJob
    // Small camera changes retain the immutable projection. Settled same-view
    // terrain retains member work while replacing only the obsolete cut input.
    let plan
    try {
      // Direct execution needs a host turn after ownership, including across
      // cheap planning calls. Worker credit-dependent replies must not acquire
      // another host wait: its RPC scheduler already owns that turn boundary.
      if (this.beforeWork) {
        await this.beforeWork()
        if (this.imageryJob !== job) return {superseded:true}
      }
      let round = 0
      const started = Date.now()
      // Continue bounded background slices while the main thread is drawing.
      // Publish the first usable demand immediately; controls and queued work
      // can interrupt every slice, without a render/RPC round trip per slice.
      do {
        if(plan)releaseNativeMeasurements(plan.measurements)
        const sliceAt = monotonicNow()
        const stage = this.measurementJob ? 'measurement' : this.partitionFit ? 'partition' : 'native'
        plan = await this.planImagery(job.result, job.message)
        const duration = monotonicNow() - sliceAt
        ++this.workStats.slices
        this.workStats.cpuMs += duration
        this.workStats.stages[stage] = (this.workStats.stages[stage] || 0) + duration
        if (plan.imageryPlan && plan.imageryPlan.quality.planningComplete === false) plan.continuation = true
        // A remote grant can arrive only after this RPC returns. Preserve the
        // cursor and send its quote instead of spending the batch on waits.
        if (imageryWorkKind(plan) || plan.candidateReady || plan.imageryPlan && !job.published || !(plan.pending || plan.continuation) ||
            ++round >= 8 || Date.now() - started >= 32 || !this.yieldWork ||
            this.latestViewRevision > message.viewRevision) break
      } while (await this.yieldWork() !== false)
      if (plan.imageryPlan) job.published = true
      if (!plan.pending && !plan.continuation) {
        this.workStats.completedJobs = (this.workStats.completedJobs || 0) + 1
        this.clearImageryJob()
      }
      if (plan.imageryPlan) plan.imageryPlan.quality.coarsening = job.coarsening
      const m = this.measurementJob, bounds = m && m.boundsIndex < m.draws.length
      return Object.assign({sequence: message.sequence, viewRevision: job.viewRevision,
        measurementHistory: this.measurementHistory.stats(),
        cameraPlanAgeMs: Date.now() - job.started,
        preparationWork:{...this.workStats, stages:{...this.workStats.stages},
          nativeMeasurements:this.measurementProduction&&this.measurementProduction.stats()},
        settledRebases: this.imagerySettledRebases || 0,
        modelRevision: job.result.updateState.modelRevision, meshIdentity: job.result.meshIdentity}, plan, plan.pending ? {
        progress: m ? {stage: bounds ? 'coverage' : 'measurement',
          index: bounds ? m.boundsIndex : m.index, measured: m.measured.size}
          : {stage: this.imageryTask ? 'input' : this.partitionFit ? 'partition-budget' : 'refinement'}
      } : null)
    } catch (error) { if(plan)releaseNativeMeasurements(plan.measurements);this.clearPlanning();throw error }
  }

  checkView(message) {
    if (message.viewRevision !== undefined && message.viewRevision < this.latestViewRevision) {
      const error = new Error('Superseded imagery view')
      error.superseded = true
      throw error
    }
  }

  adoptImageryCandidate(result, message) {
    const job = this.imageryJob
    const demand = value => JSON.stringify({...value,
      visibility:undefined, refineBounds:undefined, admissionRevision:undefined})
    if (job.viewRevision !== message.viewRevision ||
        demand(job.message.imagery) !== demand(message.imagery)) {
      this.clearPlanning(job.viewRevision !== message.viewRevision ? 'candidate-view' : 'candidate-policy')
      return
    }
    const changed = job.result.meshIdentity !== result.meshIdentity
    // Global topology revision is publication metadata. Only changed immutable
    // members invalidate this view's native input and fitted imagery cut.
    const release = this.holdSurface(result)
    try {
      if (changed) {
        // A cut is not the lifetime of its immutable member measurements. Keep
        // shared meshes and their unfinished projection/refinement iterators;
        // invalidate only the native cut input and UV fit built from old members.
        this.clearImageryCut()
        const measurement = this.measurementJob
        if (measurement) for (const [name, id] of [
          ['work', measurement.resourceId], ['boundsWork', measurement.boundsResourceId]]) {
          if (measurement[name] && !result.resources.has(id)) {
            measurement[name].return(); measurement[name] = null
          }
        }
        for (const values of [job.exact, job.precise]) {
          for (const id of values.keys()) if (!result.resources.has(id)) values.delete(id)
        }
      }
    } catch (error) { release(); this.clearPlanning(); throw error }
    const previous = job.releaseMeshes
    job.result = Object.assign({}, result, {frame:Object.assign({}, result.frame, job.message.snapshot)})
    job.releaseMeshes = release
    previous()
    job.planId = message.planId || 0
    job.message.planId = message.planId
  }

  publishImageryCandidate(planId) {
    // Publication changes the owner, not the immutable projection job. Both
    // execution adapters continue the admitted cut without restarting it.
    if (this.imageryJob && this.imageryJob.planId === planId) {
      this.imageryJob.planId = 0
      this.imageryJob.message.planId = undefined
    }
  }

  discardImageryCandidate(planId) {
    if (this.imageryJob && this.imageryJob.planId === planId) this.clearPlanning()
  }

  createImageryWorkspaces() {
    this.imageryInputWorkspace = this.imageryReferenceWorkspace = this.imageryOutputWorkspace = null
    if (!this.quotedCredit) return {}
    const create = () => new ImageryInputWorkspace(this.nextImageryInputId = (this.nextImageryInputId || 0) + 1)
    this.imageryInputWorkspace = create()
    return {inputWorkspace:this.imageryInputWorkspace,
      referenceWorkspace:() => this.imageryReferenceWorkspace = create(),
      outputWorkspace:() => this.imageryOutputWorkspace = create()}
  }

  async planImagery(result,message) {
    if(!this.measurementProduction||this.measurementProduction.closed)this.initializeProduction()
    const cleanup=new Cleanup();let value
    try {value=await this.planImageryStep(result,message)}catch(error){cleanup.capture(error)}
    cleanup.run(()=>this.measurementProduction.settle(this.heldMeasurements()))
    if(cleanup.failed&&value)cleanup.run(()=>releaseNativeMeasurements(value.measurements))
    cleanup.finish();return value
  }

  async planImageryStep(result, message) {
    const sliceStarted = Date.now()
    const expired = () => Date.now() - sliceStarted >= 4
    let plan = null, measurements = [], admissionPending = false
    this.checkView(message)
    const yieldWork = async () => {
      if (this.yieldWork) await this.yieldWork()
      else await new Promise(resolve => setTimeout(resolve, 0))
      this.checkView(message)
    }
    const { imagery, camera, viewport } = message, { frame, resources } = result
    const meshIdentity = result.meshIdentity
    const modelFor = draw => resources.get(draw.resourceId).model
    const epoch = this.imageryJob, coarse = epoch.coarsening, abi = this.abi
    const signature = JSON.stringify([meshIdentity, camera, viewport,
      imagery && [imagery.descriptor, imagery.devicePixelRatio, imagery.maximumTextures,
        imagery.maximumDraws, imagery.targetPixelError, imagery.resetHistory, imagery.terrainBound,
        imagery.visibility, imagery.refineBounds]])
    if (imagery && !imagery.terrainBound) {
      let same = signature === this.planningSignature
      const admission = JSON.stringify([signature, imagery])
      const workSignature = JSON.stringify([signature, {...imagery, admissionRevision:undefined}])
      const admissionChanged = admission !== this.admissionSignature
      if (same && !admissionChanged && this.lastImageryPlan && this.lastImageryPlan.quality.planningComplete !== false) {
        this.planSequence = frame.sequence
        return this.measurementResponse({ imageryPlan: this.lastImageryPlan, measurements: this.lastMeasurements,
          candidateReady: Boolean(epoch.planId) })
      }
      const descriptor = imagery.descriptor
      let sourceDraws = this.imagerySourceDraws, measured = this.imageryMeasurements
      // Planar streaming retains its established normalization order. Global
      // cuts first price conservative spatial coverage, then continue exact
      // measurement through the fitted-cut refinement path below. A whole-view
      // barrier otherwise postpones image production until every visible mesh
      // has finished exact measurement.
      // A continuing old-camera snapshot only needs its first safe fitted cut.
      // Tightening already-passing bounds for that obsolete view can occupy
      // the whole interval between rapid zoom rebases. The latest view still
      // normalizes fully; unmet-error refinements remain mandatory below.
      const currentProjection=!this.latestView||epoch.viewRevision===undefined||epoch.viewRevision===this.latestViewRevision
      const normalizeBounds=Boolean(imagery.refineBounds&&
        (descriptor.kind!=='global-geodetic'||epoch.coverageFitIdentity===meshIdentity)&&
        !epoch.planId&&currentProjection)
      const measurementSignature = JSON.stringify([camera,frame.projectionView,
        viewport, descriptor, imagery.devicePixelRatio])
      if (this.measurementJob || measurementSignature !== this.measurementSignature ||
          meshIdentity !== this.measurementMeshIdentity || normalizeBounds&&measured&&
          Array.from(measured.values()).some(value=>value.refinable)) {
        if(normalizeBounds&&same) {
          // A private fitted cut may publish before Native refinement finishes.
          // Tightening its measurements changes input, even with the same view
          // and mesh. A continuation would silently resume the old loose input.
          this.planningSignature=null;same=false
          const task=this.imageryTask,fit=this.partitionFit
          this.imageryTask=this.partitionFit=null
          const cleanup=new Cleanup()
          if(task)cleanup.run(()=>task.task.cancel())
          if(fit)cleanup.run(()=>fit.work.return())
          cleanup.finish()
        }
        if (!this.measurementJob || this.measurementJob.signature !== measurementSignature) {
          this.workStats.measurementPasses = (this.workStats.measurementPasses || 0) + 1
          if (this.measurementJob) for (const key of ['work', 'boundsWork']) {
            if (this.measurementJob[key]) this.measurementJob[key].return()
          }
          if(measurementSignature!==this.measurementSignature||!measured) {
            const cached=this.measurementHistory.acquire(measurementSignature)
            measured=cached?cached.values:new Map()
            if(cached)this.measurementProduction.defer(cached.release)
          }
          const seed=measured.size?measured.values().next().value.sourceRevision:undefined
          // Removing every loose row for tightening does not create a new
          // projection. Its identity outlives the temporarily empty active map.
          const sourceRevision=measurementSignature===this.measurementSignature&&this.measurementSourceRevision!==undefined
            ?this.measurementSourceRevision:seed!==undefined?seed:
              (this.nextMeasurementSourceRevision=(this.nextMeasurementSourceRevision||0)+1)
          this.measurementJob = { signature: measurementSignature, index: 0, measured,
            bounds: new Map(measured), boundsIndex: 0,
            sourceRevision,
            context: surfacePlan.projectionContext(frame,
              Object.assign({}, viewport, { devicePixelRatio: imagery.devicePixelRatio }),
              require('../../sdk/js/math/matrix').invertMatrix4(frame.projectionView)) }
          this.imageryMeasurements = measured
          this.measurementSignature = measurementSignature
          this.measurementSourceRevision=sourceRevision
          this.publishedMeasurements.clear()
        }
        const job = this.measurementJob
        measured = job.measured
        // Immutable content IDs keep their measured surface when another patch
        // refines. Retain only resources still owned by the two display cuts.
        for (const values of [measured, job.bounds]) {
          for (const id of values.keys()) if (!resources.has(id)) values.delete(id)
        }
        if (!job.draws || job.meshIdentity !== meshIdentity) {
          job.index = 0
          job.boundsIndex = 0
          job.meshIdentity = meshIdentity
          const adapter = new ImageryAdapter(descriptor)
          job.draws = result.draws.filter(draw => !(draw.flags & 1)).map(draw => adapter.prepareDraw(draw))
          for (const name of ['work', 'boundsWork']) {
            const id = name === 'work' ? job.resourceId : job.boundsResourceId
            if (job[name] && !job.draws.some(draw => draw.resourceId === id)) {job[name].return(); job[name] = null}
          }
          // Bounds/preview work follows the camera, but Native fitting retains
          // the canonical terrain order. A scheduling priority must not reorder
          // the persistent pyramid input or change its continuation history.
          if(descriptor.kind!=='global-geodetic'&&job.work)
            job.draws.sort((a,b)=>Number(b.resourceId===job.resourceId)-Number(a.resourceId===job.resourceId))
          const order=new Map(job.draws.map((draw,index)=>[draw.resourceId,{index,
            // Global navigation benefits from central coverage first. Keep
            // the planar producer's established streaming order, including
            // its small-budget model/measurement reuse contract.
            score:descriptor.kind==='global-geodetic'?measurementPriority(draw,modelFor(draw),job.context):0}]))
          const priority=active=>job.draws.slice().sort((a,b)=>
            Number(b.resourceId===active)-Number(a.resourceId===active)||
              order.get(a.resourceId).score-order.get(b.resourceId).score||
              order.get(a.resourceId).index-order.get(b.resourceId).index)
          job.boundsDraws=descriptor.kind==='global-geodetic'
            ?priority(job.boundsWork&&job.boundsResourceId):job.draws
          job.workDraws=descriptor.kind==='global-geodetic'
            ?priority(job.work&&job.resourceId):job.draws
        }
        sourceDraws = job.draws
        // The box/derivative bound never scans triangles. It can safely release
        // oversampled imagery and start coverage I/O before exact measurement.
        while (job.boundsIndex < sourceDraws.length) {
          const draw = job.boundsDraws[job.boundsIndex], id = draw.resourceId
          // Exact work already owns this immutable projection's next result.
          // Its preceding bound cannot affect selection again; remeasuring it
          // on each loose/tight continuation only repeats native production.
          if (job.bounds.has(id) || epoch.exact.has(id)) { ++job.boundsIndex; continue }
          const model = modelFor(draw)
          if (job.boundsWork && job.boundsResourceId !== id) {
            job.boundsWork.return(); job.boundsWork = null
          }
          if (!job.boundsWork) {
            job.boundsResourceId = id
            job.boundsWork = ownMeshWork(this.measurementProduction.measure(draw,resources.get(id),job.context,
              {boundsOnly:true,get planId(){return epoch.planId},viewRevision:epoch.viewRevision,sourceRevision:job.sourceRevision}),
              [resources.get(id)])
          }
          const next = job.boundsWork.next()
          if(next.value===TASK_WAIT)return {pending:true,inputWork:this.measurementInputWorkspace.quote()}
          if (next.done) {
            job.bounds.set(id, Object.assign(next.value, {bounds: model.bounds, hull: model.hull,
              conservative: next.value.visible}))
            job.boundsWork = null; ++job.boundsIndex; job.boundsDirty = true
          }
          if (expired()) break
        }
        if (job.boundsDirty && (job.boundsIndex === sourceDraws.length ||
            job.bounds.size >= (job.boundsPublished || 0) + 4)) {
          job.boundsDirty = false; job.boundsPublished = job.bounds.size
          const bounded = new Map([...job.bounds, ...measured])
          const preview = measurementPreview(job.boundsDraws, bounded, imagery)
          return this.partialImagery(preview, bounded)
        }
        if (job.boundsIndex < sourceDraws.length || expired()) return {pending: true}
        while (job.index < sourceDraws.length) {
          const draw = job.workDraws[job.index], id = draw.resourceId
          const existing=measured.get(id)
          if(normalizeBounds&&existing&&existing.refinable) {
            if(!existing.conservative)epoch.precise.set(id,existing)
            epoch.exact.add(id);measured.delete(id)
          }
          if (measured.has(id)) { ++job.index; continue }
          // A finite upper bound can drive the Native SSE pyramid directly.
          // Infinite near-plane bounds still need exact clipping.
          const bound = job.bounds.get(id)
          if(normalizeBounds&&bound&&bound.refinable)epoch.exact.add(id)
          if (!epoch.exact.has(id) && Number.isFinite(bound.pixelsPerUv)) {
            measured.set(id, bound); ++job.index
            if (expired()) return {pending: true}
            continue
          }
          const model = modelFor(draw)
          if (!job.work) {
            if (coarse) epoch.exact.add(id)
            job.resourceId = id
            const previous = epoch.precise.get(id)
            job.work = ownMeshWork(this.measurementProduction.measure(draw,resources.get(id),job.context,
              {tight:epoch.precise.has(id),previous,get planId(){return epoch.planId},viewRevision:epoch.viewRevision,
                sourceRevision:job.sourceRevision}),[resources.get(id)])
          }
          const next = job.work.next()
          if (next.value === TASK_WAIT) {
            return {pending:true,inputWork:this.measurementInputWorkspace.quote()}
          }
          if (next.done) {
            const value=Object.assign(next.value,{bounds:model.bounds,hull:model.hull})
            measured.set(id,value)
            job.work=null
            if(normalizeBounds&&value.refinable) {
              epoch.exact.add(id);epoch.precise.set(id,value)
            } else {
              if(epoch.precise.has(id))epoch.precise.set(id,null)
              ++job.index
            }
          }
          if (expired()) {
            if (measured.size >= (job.publishedCount || 0) + 4) {
              const preview = measurementPreview(job.workDraws, measured, imagery)
              job.publishedCount = measured.size
              if (preview.draws.length) {
                return this.partialImagery(preview, measured)
              }
            }
            return {pending: true}
          }
        }
        this.measurementJob = null
        this.imagerySourceDraws = sourceDraws
        this.measurementMeshIdentity = meshIdentity
        this.rememberMeasurements(measurementSignature, measured, resources)
      }
      if (this.partitionFit && this.partitionFit.signature !== workSignature) {
        this.partitionFit.work.return(); this.partitionFit = null
      }
      if (this.imageryTask && this.imageryTask.signature !== workSignature) {
        this.imageryTask.task.cancel(); this.imageryTask = null
      }
      // Retirement receipts can make a blocked cut affordable without changing
      // its input or policy. Finish the funded native/UV work before reopening
      // admission; otherwise every released partition cancels the next slice.
      // Real policy changes cancel incompatible work above immediately.
      if (admissionChanged && !this.imageryTask && !this.partitionFit) {
        if (abi.acceptImagery) abi.acceptImagery(null, ++this.admissionEpoch)
        this.admissionSignature = admission
      }
      admissionPending = admission !== this.admissionSignature
      const hidden = hiddenResources(imagery.visibility, frame, result.draws, viewport)
      const invisible = {visible: false, pixelsPerUv: 0, centerDistance: 0, regions: []}
      const measure = draw => hidden.has(draw.resourceId) ? invisible : measured.get(draw.resourceId)
      if (this.partitionFit) plan = this.partitionFit.plan
      else {
        if (!this.imageryTask) {
          const workspaces = this.createImageryWorkspaces()
          this.imageryTask = {signature: workSignature,
            task: abi.createImageryTask(sourceDraws, measure,
              Object.assign({}, imagery, {maximumRounds:1, continuation:same, detached:true, yieldWork}, workspaces))}
        }
        const next = await this.imageryTask.task.step()
        if (!next.done) return {pending: true, inputWork:this.imageryInputWorkspace && this.imageryInputWorkspace.quote(),
          referenceWork:this.imageryReferenceWorkspace && this.imageryReferenceWorkspace.quote(),
          outputWork:this.imageryOutputWorkspace && this.imageryOutputWorkspace.quote()}
        plan = next.value
        this.imageryTask = null
      }
      if (plan.quality.rebuilding) {
        // Native's temporary roots are coverage, not replacement demand. Keep
        // useful preview/fine requests alive and resume the measured cut before
        // fitting partitions. Do not confuse this with usable partial refinement.
        this.planningSignature = signature
        this.lastImageryPlan = plan
        return {pending: true}
      }
      if (!this.partitionFit) {
        this.partitionFit = { signature: workSignature, plan: plan,
          work: ownMeshWork(this.partitionFitCache.fit(plan, imagery,
            modelFor), resources.values()) }
        // A candidate is not request demand until its complete UV footprint has
        // been priced. Publishing here starts I/O for a cut this same fit may
        // replace, revoking useful requests even without a camera/model change.
        // Keep previous demand while the bounded fit yields. Fitted incremental
        // cuts can still publish below; they need not reach final SSE first.
      }
      if (expired()) return { pending: true }
      for (;;) {
        const next = this.partitionFit.work.next()
        if (next.done) { plan = next.value; this.partitionFit = null; break }
        if (expired()) return { pending: true }
      }
      this.checkView(message)
      // Spatial/UV planning has produced a whole fitted cut. Its rolling
      // production cost can now be admitted independently of final SSE and
      // tighter measurements, for published surfaces as well as candidates.
      plan.quality.demandReady = plan.quality.spatialCut === true &&
        plan.quality.coverageGuaranteed === true && !plan.quality.rebuilding
      if(plan.quality.demandReady)epoch.coverageFitIdentity=meshIdentity
      plan.quality.refinableMeasurementCount = new Set(plan.draws
        .filter(draw => (measure(draw) || {}).refinable).map(draw => draw.resourceId)).size
      // Tighten blocking regions first, in every navigation mode. If they still
      // fail, measurementRefinements also checks passing bounds: their excess
      // demand can occupy shared quota. A safe cut needs no whole-view scan.
      const refinements=surfacePlan.measurementRefinements(plan,measure,imagery.refineBounds&&currentProjection)
      if(refinements.length) {
        // This complete, fitted native cut already has safe coverage. A
        // terrain continuation may admit it now, while tighter projection
        // measurements keep progressing. Partial measurement previews above
        // never carry this milestone or authorize another topology window.
        const admitted = epoch.planId || plan.quality.demandReady ? this.measurementResponse({candidateReady:Boolean(epoch.planId), continuation:true,
          imageryPlan:Object.assign({},plan,{revision:++this.imageryPlanRevision,
            quality:Object.assign({},plan.quality,{planningComplete:false})}),
          measurements:exportMeasurements(measured)}) : null
        for(const draw of refinements) {
          if (!measured.has(draw.resourceId)) continue
          if (!measured.get(draw.resourceId).conservative) epoch.precise.set(draw.resourceId, measured.get(draw.resourceId))
          epoch.exact.add(draw.resourceId)
          measured.delete(draw.resourceId)
        }
        this.measurementMeshIdentity=this.planningSignature=null
        return admitted || {pending:true}
      }
      if (plan.quality.planningComplete !== false && abi.acceptImagery) {
        abi.acceptImagery(plan, this.admissionEpoch)
      }
      plan.quality.occludedMeshCount = hidden.size
      plan.quality.visibilityRevision = hidden.size ? imagery.visibility.revision : 0
      this.imageryLevels = plan.levels
      measurements = this.exportMeasurements(measured)
      plan.quality.measurementRegionCount = Array.from(measured.values()).reduce((n,m)=>n+(m.regions || []).length,0)
    }
    this.planningSignature = signature
    this.planSequence = frame.sequence
    this.lastImageryPlan = plan
    if (plan) plan.revision = ++this.imageryPlanRevision
    this.lastMeasurements = this.imageryMeasurements ? exportMeasurements(this.imageryMeasurements) : measurements
    if (!epoch.planId && coarse && plan && plan.quality.planningComplete === false &&
        plan.quality.meetsTarget === false && !plan.quality.demandReady) return {pending: true}
    // Preview deltas are not consumer receipts: the renderer can retain an old
    // cut and its measurements instead. Publish completed demand with its full
    // supporting snapshot, including revisions of already-known resource IDs.
    return this.measurementResponse({ imageryPlan: plan, candidateReady:Boolean(epoch.planId), continuation:admissionPending,
      measurements: epoch.planId || plan && plan.quality.planningComplete !== false
        ? this.lastMeasurements : measurements })
  }

  partialImagery(plan, measured) {
    plan.revision = ++this.imageryPlanRevision
    return this.measurementResponse({continuation: true, imageryPlan: plan, measurements: this.exportMeasurements(measured)})
  }

  exportMeasurements(measured) {
    const changed = new Map()
    measured.forEach((value,id) => {
      if(this.publishedMeasurements.get(id) !== value) changed.set(id,value)
      this.publishedMeasurements.set(id,value)
    })
    return exportMeasurements(changed)
  }

  rememberMeasurements(signature, measured, resources) {
    this.measurementHistory.remember(signature, measured, resources)
  }

  clearImageryJob() {
    const cleanup=new Cleanup(),job=this.imageryJob
    this.imageryJob = null
    if(job)cleanup.run(()=>job.releaseMeshes())
    cleanup.finish()
  }

  cancelImageryInputGrant(id) {
    const workspace = [this.measurementInputWorkspace,this.imageryInputWorkspace, this.imageryReferenceWorkspace, this.imageryOutputWorkspace].find(value => value && value.id === id)
    if (!workspace || workspace.finished) return
    if(workspace===this.measurementInputWorkspace) {
      const job=this.measurementJob,cleanup=new Cleanup()
      if(job)for(const key of ['work','boundsWork'])if(job[key]) {
        const work=job[key];job[key]=null;cleanup.run(()=>work.return())
      }
      this.measurementInputWorkspace=null
      cleanup.run(()=>this.measurementProduction.settle(this.heldMeasurements()));cleanup.finish();return
    }
    if (this.imageryTask) this.imageryTask.task.cancel()
    this.imageryTask = null
    this.imageryInputWorkspace = this.imageryReferenceWorkspace = this.imageryOutputWorkspace = null
  }

  clearImageryCut() {
    const cleanup=new Cleanup(),task=this.imageryTask,fit=this.partitionFit
    this.imageryTask = null
    this.imageryInputWorkspace = this.imageryReferenceWorkspace = this.imageryOutputWorkspace = null
    this.partitionFit = null
    this.planSequence = null
    this.planningSignature = null
    this.lastImageryPlan = null
    this.lastMeasurements = null
    if(task)cleanup.run(()=>task.task.cancel())
    if(fit)cleanup.run(()=>fit.work.return())
    cleanup.run(()=>this.partitionFitCache.clear())
    cleanup.finish()
  }

  clearPlanning(reason = 'cancelled') {
    if(this.clearingPlanning)return
    this.clearingPlanning=true
    if(this.imageryJob) {
      this.workStats.resets = (this.workStats.resets || 0) + 1
      this.workStats.lastReset = {reason, viewRevision:this.imageryJob.viewRevision,
        modelRevision:this.imageryJob.result&&this.imageryJob.result.updateState&&this.imageryJob.result.updateState.modelRevision}
    }
    const cleanup=new Cleanup(),measurement=this.measurementJob
    this.measurementJob = null
    this.imagerySourceDraws = null
    this.imageryMeasurements = null
    this.measurementSignature = null
    this.measurementSourceRevision=undefined
    try {
      cleanup.run(()=>this.clearImageryJob())
      cleanup.run(()=>this.clearImageryCut())
      if(measurement&&measurement.work)cleanup.run(()=>measurement.work.return())
      if(measurement&&measurement.boundsWork)cleanup.run(()=>measurement.boundsWork.return())
      if(this.measurementBatch)cleanup.run(()=>this.measurementBatch.close())
      this.measurementInputWorkspace=null
      cleanup.run(()=>this.publishedMeasurements.clear())
      if(this.measurementProduction)cleanup.run(()=>this.measurementProduction.settle(this.heldMeasurements()))
      cleanup.finish()
    }finally{this.clearingPlanning=false}
  }

  closeMeasurements() {
    const cleanup=new Cleanup()
    cleanup.run(()=>this.clearPlanning());cleanup.run(()=>this.measurementHistory.clear())
    if(this.measurementProduction)cleanup.run(()=>this.measurementProduction.destroy())
    cleanup.finish()
  }
}

module.exports = {ImageryPreparation}
