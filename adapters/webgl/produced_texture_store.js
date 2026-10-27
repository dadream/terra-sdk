const { TextureStore, textureByteSize } = require('./texture_store')
const { ImageryGroupAdmission } = require('../../sdk/js/imagery/imagery_group_admission')
const { ResourceWorkspace } = require('../../sdk/js/resources/resource_workspace')

function resourceSubmissionPending(renderer) {
  const pending = renderer.pendingSubmission
  // A draw only retains its display receipt; it cannot promise progress for
  // an unfunded image group. An upload behind that draw still owns a real
  // producer, and must finish before pressure is escalated or share retracted.
  return pending && (!pending.drawn || renderer.submissions && renderer.submissions.uploading)
}

// Source adapters provide bounded inputs. Fixed-size image producers share
// complete image/UV admission, input ownership and GPU-only recovery lifecycle.
class ProducedTextureStore extends TextureStore {
  constructor(renderer, options) {
    super(renderer, options)
    this.resourceBytes = textureByteSize
    this.cache.owner = 'imagery-gpu'
    this.preparations = new Map()
    this.maximumPreparationTasks = 1
    this.inputBytes = 0
    this.inputJobs = 0
    this.inputHighWaterBytes = 0
    this.inputBlocked = new Set()
    this.preparationWaiting = new Set()
    this.groupCapacityBlocked = new Set()
    this.requestGroups = new Map()
    this.groupAdmission = new ImageryGroupAdmission(this.cache)
    this.workspaces = new Set()
    this.workspace = null
    this.configureDimensions()
  }

  setSource(urlForTile, coverageTiles) {
    super.setSource(urlForTile, coverageTiles)
    this.configureDimensions()
  }

  requestBytes() {
    return textureByteSize(this.tileSize, this.tileSize)
  }

  minimumWorkspaceBytes() { return this.inputEnvelopeBytes }
  initialInputBytes() { return this.inputEnvelopeBytes }
  inputCapacityChanged() {}

  // Steady targets retain a serial workspace inside their local budget. Only
  // complete production groups may borrow this bounded replacement peak from
  // the existing shared envelope; it is not added to the ledger's limit.
  replacementHeadroomBytes() { return this.replacementEntries() * this.estimatedTileBytes }

  // Production shares a workspace, so the old per-tile staging fraction is
  // not its capacity. Physical destinations and bytes still require admission.
  transitionCapacity() { return this.cacheCapacity() }

  pipelineBytes() {
    let bytes = 0
    this.workspaces.forEach(workspace => { bytes += workspace.bytes })
    return bytes
  }

  updatePipelineLimit() {
    this.workspaces.forEach(workspace => {
      if (workspace.retired && !workspace.bytes) this.workspaces.delete(workspace)
    })
    this.cache.maximumBytes = Math.max(1, this.requestedMaximumBytes - this.pipelineBytes())
  }

  applyShareLimit() {
    if (this.resourceShare) this.requestedMaximumBytes = this.resourceShare.bytes
    this.updatePipelineLimit()
    this.cache.evict()
  }

  releaseIdleWorkspace() {
    if (!this.admitting && this.workspace && !this.inputJobs && !this.cache.reservations.size) this.workspace.trim()
  }

  groupCapacity(workspaceBytes) {
    const workspace = this.workspace
    const growth = Math.max(0, workspaceBytes - (workspace ? workspace.bytes : 0))
    // A completed download can still need a bitmap before its upload receipt.
    // Keep that decoder lane as well as the requested serial input envelope;
    // only genuinely idle credit may fund the next group's GPU/UV outputs.
    const retained = Math.max(workspaceBytes, (workspace ? workspace.bytes - workspace.availableBytes : 0) +
      (this.inputJobs ? this.decodeOverlapBytes : 0))
    const surplus = workspace ? workspace.surplus(retained) : 0
    const peakBytes = this.requestedMaximumBytes + this.replacementHeadroomBytes()
    const pipeline = this.pipelineBytes()
    if (growth && pipeline + growth >= peakBytes) return null
    return {retained, maximumBytes: Math.max(1, peakBytes - pipeline - growth + surplus)}
  }

  admitGroup(children, workspaceBytes = this.minimumWorkspaceBytes(), outputs = null) {
    if (!this.workspace) {
      this.workspace = new ResourceWorkspace('imagery-production', () => {
        this.updatePipelineLimit()
        this.inputCapacityChanged()
      })
      this.workspaces.add(this.workspace)
    }
    const capacity = this.groupCapacity(workspaceBytes)
    if (!capacity) return false
    // All groups share one peak ceiling, not another allowance per group.
    // reserveBatch funds destinations, input workspace and prepared UV outputs
    // atomically. Until the display receipt, old images remain protected/owned.
    this.cache.maximumBytes = capacity.maximumBytes
    this.admitting = true
    try {
      const admitted = this.fundShare(grants => this.groupAdmission.admit(children, this.requestBytes(), this.failed,
        this.workspace, workspaceBytes, outputs, capacity.retained, grants))
      const refusal = this.groupAdmission.refusal
      if (!admitted && refusal.reason === 'shared-budget') {
        this.capacityPressure = {shortfallBytes: refusal.shortfallBytes, keys: Array.from(children.keys()),
          ownedBytes: this.cache.ledger.bytes, maximumBytes: this.requestedMaximumBytes,
          camera: this.renderer.cameraVersion, generation: this.generation,
          sequence: this.renderer.current && this.renderer.current.frame && this.renderer.current.frame.sequence}
        this.scheduleTerrainPressure()
      }
      return admitted
    } finally {
      this.admitting = false
      this.updatePipelineLimit()
    }
  }

  scheduleTerrainPressure() {
    const r = this.renderer
    if (!r.options.onResourcePressure || this.terrainPressurePending) return
    this.terrainPressurePending = true
    Promise.resolve(this.cache.ledger.reclamation.pending).then(() => {
      this.terrainPressurePending = false
      const pressure = this.capacityPressure
      const quality = r.current && r.current.imageryPlan && r.current.imageryPlan.quality
      // A live decoder, resource upload or mesh producer owns a way forward.
      // Escalate only a current unfunded group after real cache reclamation.
      // Scheduler slots also include failed admission until its resolved task
      // drains. Only input jobs/reservations prove funded image production;
      // counting the rejecting slot here suppresses its own recovery callback.
      if (!pressure || pressure.generation !== this.generation ||
          pressure.camera !== r.cameraVersion || r.plannedCameraVersion !== r.cameraVersion ||
          this.cache.ledger.reclamation.pending || !quality || !quality.planningComplete || this.inputJobs || this.cache.reservations.size ||
          resourceSubmissionPending(r) || r.meshOutputPlan || r.heldCandidate ||
          r.geometryPublicationPending || r.partitionActive || r.partitionUploads && r.partitionUploads.length ||
          r.presentation && r.presentation.active ||
          !pressure.keys.some(id => this.targetDesired.has(id) && !this.gpuReady(id))) return
      const shortfallBytes = pressure.shortfallBytes + this.cache.ledger.bytes - pressure.ownedBytes
      if (r.current && r.current.frame && pressure.sequence !== r.current.frame.sequence || shortfallBytes <= 0) {
        // Price the new footprint (or retry now-affordable demand) once. An old
        // blocked signature must not park forever after its owner has changed.
        this.capacityPressure = null
        this.admissionSignature = null; this.admissionBlocked.clear()
        this.scheduleAdvance()
      } else if (r.options.onResourcePressure({...pressure, shortfallBytes})) this.capacityPressure = null
    }).catch(error => { this.terrainPressurePending = false; this.lastError = error.message })
  }

  resolveCapacityPressure() {
    if (this.capacityPressure) this.scheduleTerrainPressure()
    const r = this.renderer, pressure = this.capacityPressure, share = this.resourceShare
    const quality = r.current && r.current.imageryPlan && r.current.imageryPlan.quality
    // A pending producer/receipt has a funded continuation; waiting for it is
    // backpressure. Only an idle, still-current refusal can reduce planning.
    if (!pressure || !share || !share.extraBytes || !quality || !quality.planningComplete ||
        quality.refinableMeasurementCount > 0 && r.refineImageryCamera === r.cameraVersion ||
        quality.cameraCurrent === false || quality.maximumTextureCount !== this.targetCapacity() ||
        pressure.maximumBytes !== this.requestedMaximumBytes || pressure.generation !== this.generation ||
        pressure.camera !== r.cameraVersion || r.plannedCameraVersion !== r.cameraVersion ||
        pressure.ownedBytes !== this.cache.ledger.bytes || this.cache.ledger.reclamation.pending ||
        this.inputJobs || this.cache.reservations.size || this.preparations.size ||
        resourceSubmissionPending(r) || r.meshOutputPlan || r.heldCandidate || r.geometryPublicationPending ||
        r.partitionActive || r.partitionUploads && r.partitionUploads.length ||
        r.partitionQueue && r.partitionQueue.length || r.partitionGroups && r.partitionGroups.current ||
        r.presentation && r.presentation.active || !r.options.onImageryPlanningChange ||
        !pressure.keys.some(id => this.targetDesired.has(id) && this.admissionBlocked.has(id) && !this.gpuReady(id))) return false
    // Retraction changes only the expanded planning allowance. Quantize the
    // actual shared shortfall by one physical image, preserving the preferred
    // share and all submitted endpoints. The coarser plan uses existing safe
    // handover/receipt rules; no speculative refund funds this replacement.
    const imageBytes = Math.ceil(this.estimatedTileBytes)
    const bytes = Math.ceil(pressure.shortfallBytes / imageBytes) * imageBytes
    if (!share.retract(bytes)) return false
    this.capacityPressure = null
    this.applyShareLimit()
    r.options.onImageryPlanningChange()
    r.requestRender()
    return true
  }

  releasePreparedGroup(children) {
    for (const id of children.keys()) {
      const pending = this.groupAdmission.take(id)
      if (pending) pending.cancel()
    }
    this.releaseIdleWorkspace()
  }

  reserveRequest(key) {
    const size = this.initialInputBytes()
    if (this.inputBytes + size > this.maximumInputBytes) {
      this.inputBlocked.add(key)
      return null
    }
    if (!this.groupAdmission.pending.has(key) && this.cache.reservations.has(key)) {
      this.inputBlocked.add(key) // An older source still owns this physical key.
      return null
    }
    if (this.cache.has(key) || this.failed.has(key)) return null
    // Payload-producing requests need room for decoder progress. Header-only
    // requests retain one shared serial continuation before their body stage.
    const needed = size ? Math.max(this.minimumWorkspaceBytes(),
      (this.workspace ? this.workspace.bytes - this.workspace.availableBytes : 0) + size +
      (this.inputJobs ? this.decodeOverlapBytes : 0)) : this.minimumWorkspaceBytes()
    if (needed > this.maximumPipelineBytes) {
      this.inputBlocked.add(key)
      return null
    }
    // Queueing demand owns no destinations. Before starting the network job,
    // reserve its complete sibling group and shared workspace together.
    const group = this.requestGroups.get(key) || new Map([[key, null]])
    // Roots and recovery restore an existing coverage contract. New detail
    // must fund its complete display footprint before the first network byte.
    if (this.renderer.partitionGroups && !this.recovering && !this.currentRoots.has(key) &&
        !this.groupAdmission.pending.has(key)) {
      // A known image-only shortage cannot be solved by rebuilding the whole
      // terrain mapping. Use the actual replacement envelope without changing
      // cache policy or owning any credit; a fit still needs the full UV price.
      const capacity = this.groupCapacity(this.minimumWorkspaceBytes())
      if (!capacity || !this.groupAdmission.canFitImages(group, this.requestBytes(), this.failed,
        capacity.maximumBytes)) return null
      const result = this.renderer.partitionGroups.prepareImagery(group,
        outputs => this.admitGroup(group, this.minimumWorkspaceBytes(), outputs))
      if (result !== 'ready') {
        if (result === 'waiting') this.preparationWaiting.add(key)
        return null
      }
    }
    // A changed viewport may add a sibling to the demand group while this
    // input already owns its destination. Grow only this input's workspace;
    // newly demanded siblings still need their own complete footprint price.
    const admitted = this.groupAdmission.pending.has(key) ? new Map([[key, group.get(key)]]) : group
    if (!this.admitGroup(admitted, needed)) {
      if (this.inputJobs) this.inputBlocked.add(key)
      return null
    }
    group.forEach((tile, id) => {
      this.protectedKeys.add(id)
      this.groupCapacityBlocked.delete(id)
      this.admissionBlocked.delete(id)
    })
    const workspace = this.workspace, credit = workspace.take(size)
    const reservation = this.groupAdmission.take(key)
    if (!reservation) { credit.release(); return null }
    ++this.inputJobs
    this.groupCapacityBlocked.forEach(id => this.admissionBlocked.delete(id))
    if (!this.admissionBlocked.size) this.blockedByCapacity = false
    this.inputBytes += size
    this.inputHighWaterBytes = Math.max(this.inputHighWaterBytes, this.inputBytes)
    const input = {bytes: size, workspace, started: size > 0, transferred: false, released: false,
      begin: bytes => {
        if (input.released || !credit.resize(bytes)) return false
        this.inputBytes += bytes - input.bytes
        input.bytes = bytes; input.started = true
        this.inputHighWaterBytes = Math.max(this.inputHighWaterBytes, this.inputBytes)
        return true
      }, resize: bytes => {
      if (bytes === input.bytes) { credit.mark('resident'); return }
      if (!credit.resize(bytes)) throw new Error('Imagery input exceeded its production credit')
      credit.mark('resident')
      this.inputBytes += bytes - input.bytes
      input.bytes = bytes
      this.inputBlocked.clear()
      this.scheduleAdvance()
    }, release: () => {
      if (input.released) return
      input.released = true
      credit.release()
      --this.inputJobs
      this.inputBytes -= input.bytes
      input.bytes = 0
      this.inputBlocked.clear()
      this.releaseIdleWorkspace()
      this.scheduleAdvance()
    }}
    const cancel = reservation.cancel
    reservation.input = input
    reservation.cancel = () => {
      if (!input.transferred) input.release()
      const released = cancel()
      this.releaseIdleWorkspace()
      return released
    }
    return reservation
  }

  startInput(input) {
    if (input.released || input.workspace.retired || input.workspace !== this.workspace)
      throw Object.assign(new Error('Imagery input retired'), {name: 'AbortError'})
    if (input.started) return true
    const size = this.inputEnvelopeBytes
    if (this.inputBytes + size > this.maximumInputBytes) return false
    const needed = this.workspace.bytes - this.workspace.availableBytes + size +
      (this.inputBytes ? this.decodeOverlapBytes : 0)
    if (needed > this.maximumPipelineBytes || !this.admitGroup(new Map(), needed)) return false
    if (!input.begin(size)) throw new Error('Funded imagery input could not acquire its workspace')
    return true
  }

  requestBlocked(key) {
    // Temporary pipeline backpressure must not trigger capacity-driven
    // presentation coarsening or report a permanently infeasible target.
    if (this.inputBlocked.has(key) || this.preparationWaiting.has(key)) return
    this.groupCapacityBlocked.add(key)
    if (!this.inputJobs && !this.cache.reservations.size) super.requestBlocked(key)
  }

  requestEligible(key) {
    if (!super.requestEligible(key) || this.cache.has(key) || this.failed.has(key)) return false
    if (this.desired.has(key) && !this.currentRoots.has(key) &&
        !this.requestGroups.has(key)) return false
    if (this.inputBlocked.has(key) || this.preparationWaiting.has(key)) return false
    const groups = this.renderer.partitionGroups
    return !groups || this.recovering || this.currentRoots.has(key) || this.groupAdmission.pending.has(key) ||
      groups.imageryRunnable(this.requestGroups.get(key))
  }

  needsCapacityRetry() {
    const groups = this.renderer.partitionGroups
    // A UV quote can refuse asynchronously before a queued image observes it.
    // That parked producer also needs real capacity events to resume.
    return super.needsCapacityRetry() || this.groupCapacityBlocked.size > 0 ||
      Boolean(groups && (groups.refused.size || groups.quotes.size))
  }

  dependenciesChanged() { this.preparationWaiting.clear() }

  advance() {
    if (this.disposed || this.scheduler.paused) return
    // Reconcile cancelled/completed ownership before using read-only queue
    // hints. A stale group must not park all requests until one of those very
    // requests happens to enter prepareImagery and refresh it.
    if (this.renderer.partitionGroups) this.renderer.partitionGroups.refresh()
    super.advance()
  }

  sync(draws, retainedDraws, coarsening = false) {
    this.dependenciesChanged()
    super.sync(draws, retainedDraws, coarsening)
  }

  assetBytes(asset) {
    return this.resourceBytes(asset.width, asset.height) +
      (!asset.input && asset.image ? asset.width * asset.height * 4 : 0)
  }

  uploadedAsset(key, entry) {
    const asset = entry.value
    if (!asset.input) return // Externally supplied images remain their own recovery source.
    this.releasePixels(asset)
    asset.blob = null
    asset.input.release()
    asset.input = null
    this.cache.resize(key, this.assetBytes(asset), entry)
    this.uploadingAsset(key, entry)
  }

  releasePixels(asset) {
    if (asset.image) {
      if (typeof asset.image.close === 'function') asset.image.close()
      else asset.image.src = ''
    }
    asset.image = null
    if (asset.decodeCredit) asset.decodeCredit.release()
    asset.decodeCredit = null
  }

  uploadingAsset(key, entry) {
    // A rejected attempt retains its ready pixels in the cache. Once accepted,
    // only this upload's receipt may release them, independently of the decoder.
    entry.value.uploadStaged = Boolean(entry.value.image)
    const task = this.preparations.get(entry)
    if (task && task.ready) this.finishPreparation(task)
  }

  cancelledAsset(key, entry) {
    // CPU completion no longer owns a ready slot. Distinguish rejection from
    // cancellation using the accepted upload, never the current decode task.
    if (!entry.value.uploadStaged) return
    entry.value.uploadStaged = false
    const asset = entry.value
    if (asset.blob && asset.image) {
      this.releasePixels(asset)
    }
  }

  finishPreparation(task) {
    if (this.preparations.get(task.entry) === task) this.preparations.delete(task.entry)
    task.release()
  }

  retireObsoleteInputs(keys) {
    // Unsubmitted obsolete inputs must not fill the bounded pipeline while
    // the current view waits for admission. In-flight decoders retain their
    // retired entry until completion, just like submitted uploads.
    for (const [key, entry] of this.cache.entries) {
      if (!keys.has(key) && !entry.value.texture && !entry.value.uploading) this.cache.delete(key)
    }
    // An obsolete prepared image must not monopolize the lane. An in-flight
    // GPU submission owns another hold and keeps its input until its receipt.
    for (const task of this.preparations.values()) {
      if (task.ready && !keys.has(task.key) && task.entry.holds === 1) {
        const asset = task.entry.value
        this.releasePixels(asset)
        this.finishPreparation(task)
      }
    }
  }

  prepareUploads(keys = this.uploadKeys()) {
    if (this.disposed || this.renderer.contextLost || this.scheduler.paused) return
    this.retireObsoleteInputs(keys)
    // CPU preparation may run while earlier decoded pixels await uploading.
    // A bounded set can await the browser together. Every ready/in-flight
    // bitmap still owns exact credit before any further decode starts.
    if (this.preparations.size >= this.maximumPreparationTasks) return
    for (const key of keys) {
      const entry = this.cache.entries.get(key)
      if (!entry || entry.value.texture || entry.value.uploading || entry.value.image) continue
      this.prepareAsset(key, entry)
      if (this.preparations.size >= this.maximumPreparationTasks) break
    }
  }

  processUploads(deadline) {
    const keys = this.uploadKeys()
    this.prepareUploads(keys)
    super.processUploads(deadline, keys)
  }

  wantedKeys(now) {
    const keys = super.wantedKeys(now)
    if (this.recovering) this.renderer.presentedTextures.forEach((tile, key) => keys.add(key))
    return keys
  }

  isWanted(key) {
    return super.isWanted(key) || this.recovering && this.renderer.presentedTextures.has(key)
  }

  scheduleFrontier() {
    if (this.recovering) {
      this.recovering = Array.from(this.renderer.presentedTextures.keys()).some(key => !this.gpuReady(key))
      // Missing coverage gets the first slots, then the actual display,
      // before optional new target detail uses this same bounded pipeline.
      const recovery = new Map([...this.currentRoots, ...this.renderer.presentedTextures])
      Array.from(recovery).sort((a, b) => a[1].level - b[1].level).forEach(([key, tile]) => {
        if (!this.cache.has(key) && !this.failed.has(key) && !this.retryTimers.has(key) &&
            !this.scheduler.active.has(key) && !this.scheduler.queued.has(key)) {
          this.schedule(key, tile, 1000000 - tile.level)
        }
      })
    }
    super.scheduleFrontier()
    const producing = this.inputJobs > 0 || this.cache.reservations.size > 0
    if (producing) this.groupCapacityBlocked.forEach(key => this.admissionBlocked.delete(key))
    else this.groupCapacityBlocked.forEach(key => super.requestBlocked(key))
    // Another admitted group owns a complete production path and will refund
    // its headroom. Waiting for that receipt must not coarsen the display.
    if (producing && !this.admissionBlocked.size) this.blockedByCapacity = false
  }

  protectRequests() {
    // A capacity refund does not complete a suspended terrain/UV dependency.
    // Demand, publication and actual GPU receipts wake those waits explicitly.
    this.requestGroups.clear()
    const wanted = new Set(this.currentRoots.keys())
    for (const demand of this.candidateDemands) for (const key of demand.pendingKeys) wanted.add(key)
    // Roots keep scheduling priority without reserving all of their future
    // production. Eligibility is metadata; reserveRequest owns actual admission.
    this.currentRoots.forEach((tile, key) => {
      if (!this.cache.has(key) && !this.failed.has(key)) {
        this.requestGroups.set(key, new Map([[key, tile]]))
      }
    })
    for (const children of this.transitionGroups.values()) {
      if (this.groupComplete(children)) continue
      children.forEach((tile, key) => {
        this.requestGroups.set(key, children)
        wanted.add(key)
        // Protection must precede cache insertion: unrelated resource
        // admission can run before the next availability/advance callback.
        this.protectedKeys.add(key)
      })
    }
    this.groupAdmission.retain(wanted, this.scheduler.queued)
    this.groupCapacityBlocked.forEach(key => { if (!wanted.has(key)) this.groupCapacityBlocked.delete(key) })
    // Obsolete unsubmitted inputs have no display owner. Retire them before
    // pricing another request, otherwise their bytes can reject a feasible
    // source/view replacement even though the new group needs the same lane.
    this.retireObsoleteInputs(this.uploadKeys())
    this.releaseIdleWorkspace()
  }

  updateProtectionCapacity(protectedBytes, protectedEntries) {
    super.updateProtectionCapacity(protectedBytes, protectedEntries)
    this.updatePipelineLimit()
  }

  restoreContext() {
    // Uploaded images have no CPU recovery copy. The displayed cut remains
    // the authority, even when its fine tiles are absent from today's plan.
    for (const [key, entry] of this.cache.entries) {
      entry.value.texture = null
      if (!entry.value.blob && !entry.value.image) this.cache.delete(key)
    }
    this.recovering = true
    super.restoreContext()
  }

  setPaused(paused) {
    if (paused) this.groupAdmission.retain(new Set(), this.scheduler.queued)
    super.setPaused(paused)
    this.releaseIdleWorkspace()
  }

  clear() {
    this.recovering = false
    this.inputBlocked.clear()
    this.preparationWaiting.clear()
    this.groupCapacityBlocked.clear()
    this.requestGroups.clear()
    this.groupAdmission.retain(new Set(), this.scheduler.queued)
    if (this.workspace) this.workspace.retire()
    this.workspace = null
    for (const task of this.preparations.values()) {
      task.cancelled = true
      if (task.ready) this.finishPreparation(task)
    }
    super.clear()
  }

  disposeAsset(asset) {
    if (asset) this.releasePixels(asset)
    super.disposeAsset(asset)
    if (asset) {
      if (asset.input) asset.input.release()
      asset.input = asset.blob = asset.image = null
    }
  }

  stats() {
    const result = super.stats()
    let encodedBytes = 0, decodedBytes = 0, readyImages = 0
    for (const entry of [...this.cache.entries.values(), ...this.cache.retained]) {
      if (entry.value.blob) encodedBytes += entry.value.blob.size
      if (entry.value.image) decodedBytes += entry.value.width * entry.value.height * 4
      if (entry.value.image && !entry.value.texture && !entry.value.uploading) ++readyImages
    }
    result.encodedBytes = encodedBytes
    result.pipelineBytes = this.pipelineBytes()
    result.replacementBorrowedBytes = Math.max(0,
      this.cache.bytes + this.cache.reservedBytes + result.pipelineBytes - this.requestedMaximumBytes)
    result.maximumPipelineBytes = this.maximumPipelineBytes
    result.minimumPipelineBytes = this.minimumWorkspaceBytes()
    result.inputBytes = this.inputBytes
    result.maximumInputBytes = this.maximumInputBytes
    result.inputHighWaterBytes = this.inputHighWaterBytes
    result.waitingInputRequests = this.inputBlocked.size
    const pressure = this.capacityPressure
    result.sharedCapacityBlocked = Boolean(pressure && pressure.generation === this.generation &&
      pressure.camera === this.renderer.cameraVersion && pressure.keys.some(id => this.admissionBlocked.has(id)))
    result.sharedShortfallBytes = result.sharedCapacityBlocked ? pressure.shortfallBytes : 0
    result.recoveringPresentation = Boolean(this.recovering)
    if (this.recovering && Array.from(this.renderer.presentedTextures.keys()).some(key => this.failed.has(key))) {
      result.blockedByFailure = true
      result.state = 'degraded'
    }
    result.decodedBytes = decodedBytes
    result.readyImages = readyImages
    result.preparingImages = Array.from(this.preparations.values()).filter(task => !task.ready).length
    result.decodePhase = result.preparingImages ? 'decode' : readyImages ? 'upload' : 'idle'
    return result
  }
}

module.exports = { ProducedTextureStore }
