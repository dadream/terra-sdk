const {
  RequestScheduler,
  ResourceCache,
  clamp,
  finiteNumber,
  invariant,
  textureKeyString
} = require('../../sdk/js/core/terra_globe_common')
const { monotonicNow } = require('../../sdk/js/diagnostics/timing')
const {ResourceShare} = require('../../sdk/js/resources/resource_share')
const {ResourceWorkspace} = require('../../sdk/js/resources/resource_workspace')
const {Cleanup} = require('../../sdk/js/runtime/cleanup')
const { availableImageryCut } = require('../../sdk/js/imagery/imagery_availability')
const {ImageryResolution} = require('../../sdk/js/imagery/imagery_resolution')
const { ImageryPyramid } = require('../../sdk/js/imagery/terra_imagery_pyramid')
const {imageryCapacity, MAXIMUM_IMAGERY_RESOURCES} = require('../../sdk/js/imagery/imagery_capacity')
const { textureTileContains, parentTextureTile, ancestorUvTransform } = require('../../sdk/js/imagery/terra_texture_tiles')

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0
}

function textureByteSize(width, height) {
  let mipWidth = Math.max(1, Number(width) || 1)
  let mipHeight = Math.max(1, Number(height) || 1)
  if (!isPowerOfTwo(mipWidth) || !isPowerOfTwo(mipHeight)) {
    return mipWidth * mipHeight * 4
  }
  let pixels = 0
  while (true) {
    pixels += mipWidth * mipHeight
    if (mipWidth === 1 && mipHeight === 1) break
    mipWidth = Math.max(1, Math.floor(mipWidth / 2))
    mipHeight = Math.max(1, Math.floor(mipHeight / 2))
  }
  return pixels * 4
}

function imageTask(canvas, url, timeoutMs, useFetch) {
  if (useFetch && canvas && canvas.ownerDocument && typeof createImageBitmap === 'function' &&
      (typeof useFetch === 'function' || typeof fetch === 'function')) {
    const requestImage = typeof useFetch === 'function' ? useFetch : fetch
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs || 15000)
    return { promise: requestImage(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) {
        const error = new Error(`Texture returned HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      const image = await createImageBitmap(await response.blob())
      if (controller.signal.aborted) { image.close(); throw new Error('Texture image request was cancelled') }
      return image
    }).catch(error => {
      if (timedOut) throw new Error('Texture image request timed out')
      throw error
    }).finally(() => clearTimeout(timer)), abort() { controller.abort() } }
  }
  let image = null
  let settled = false
  let rejectPromise = null
  let timer = null
  const finish = () => {
    settled = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (image) { image.onload = null; image.onerror = null }
  }
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject
    if (!canvas || typeof canvas.createImage !== 'function') {
      reject(new Error('Canvas image API is unavailable'))
      return
    }
    image = canvas.createImage()
    image.onload = () => {
      if (!settled) {
        finish()
        resolve(image)
      }
    }
    image.onerror = (error) => {
      if (!settled) {
        finish()
        image.src = ''
        reject(new Error('Texture image failed'))
      }
    }
    image.src = url
    if (!settled) timer = setTimeout(() => {
      finish()
      image.src = ''
      reject(new Error('Texture image request timed out'))
    }, timeoutMs || 15000)
  })
  return {
    promise,
    abort() {
      if (!settled) {
        finish()
        if (image) {
          image.src = ''
        }
        rejectPromise(new Error('Texture image request was cancelled'))
      }
    }
  }
}

class TextureStore {
  constructor(renderer, options) {
    this.renderer = renderer
    this.resourceBytes = (width, height) => textureByteSize(width, height) +
      (renderer.options.managedResources ? width * height * 4 : 0)
    this.canvas = renderer.canvas
    this.onDiagnostic = options.onDiagnostic || (() => {})
    this.scheduler = new RequestScheduler(options.maximumConcurrent || 3)
    this.protectedKeys = new Set()
    this.demandKeys = new Set()
    this.candidateDemands = new Set()
    this.cache = new ResourceCache({
      ledger: renderer.resourceLedger, owner: 'imagery-decoded-and-gpu',
      maximumEntries: options.maximumEntries || MAXIMUM_IMAGERY_RESOURCES,
      maximumBytes: options.maximumBytes || 32 * 1024 * 1024,
      dispose: (asset) => this.disposeAsset(asset),
      canEvict: (key) => !this.protectedKeys.has(key) && !this.demandKeys.has(key) &&
        !Array.from(this.candidateDemands).some(demand => demand.targets.has(key))
    })
    this.requestedMaximumBytes = this.cache.maximumBytes
    this.resourceShare = options.maximumShareBytes === undefined ? null : new ResourceShare(
      renderer.resourceLedger, 'imagery-share', this.requestedMaximumBytes, options.maximumShareBytes)
    if (this.resourceShare) this.cache.maximumBytes = this.requestedMaximumBytes = this.resourceShare.bytes
    this.grantsBeforeImagesReady = 0
    this.demandCredit = new ResourceWorkspace('imagery-demand')
    this.demandGrants = 0
    this.demandHighWaterBytes = 0
    this.requestedMaximumEntries = this.cache.maximumEntries
    this.maximumRetries = Number.isInteger(options.maximumRetries)
      ? clamp(options.maximumRetries, 0, 3)
      : 2
    this.retryDelayMs = options.retryDelayMs === undefined
      ? 400
      : Math.max(0, finiteNumber(options.retryDelayMs,
        'Texture retry delay'))
    this.pyramid = new ImageryPyramid()
    this.desired = this.pyramid.desired
    this.targetDesired = new Map()
    this.retainedTargets = new Map()
    this.requiredChildren = this.pyramid.children
    this.requiredPriorities = this.pyramid.priorities
    this.currentRoots = this.pyramid.roots
    this.availableKeys = new Set()
    this.presentationKeys = new Set()
    this.frontierKeys = new Set()
    this.stagedKeys = new Set()
    this.transitionGroups = new Map()
    this.blockedByCapacity = false
    this.blockedGroupCount = 0
    this.blockedTileCount = 0
    this.admissionBlocked = new Set()
    this.transitionReserved = 0
    this.retries = new Map()
    this.failed = new Map()
    this.failureExpiry = new Map()
    this.prefetchAncestors = options.prefetchAncestors !== false
    this.directTargets = options.directTargets !== false
    this.configureSource(options.urlForTile, options.coverageTiles)
    this.retryTimers = new Map()
    this.retainedUntil = new Map()
    this.staleRequestGraceMs = options.staleRequestGraceMs === undefined
      ? 250
      : Math.max(0, finiteNumber(options.staleRequestGraceMs,
        'Texture request grace'))
    this.estimatedTileBytes = Math.max(1,
      Number(options.estimatedTileBytes) || this.resourceBytes(256, 256))
    this.transitionReserveEntries = Number.isInteger(
      options.transitionReserveEntries)
      ? Math.max(0, options.transitionReserveEntries) : 0
    this.retainedTimer = null
    this.advanceTimer = null
    this.frameUsage = { exact: 0, fallback: 0, missing: 0 }
    this.generation = 0
  }

  configureSource(urlForTile, coverageTiles) {
    invariant(typeof urlForTile === 'function',
      'Texture URL resolver is required')
    this.urlForTile = urlForTile
    this.coverageTiles = Array.isArray(coverageTiles)
      ? coverageTiles.slice() : []
    this.coverageKeys = new Set(this.coverageTiles.map((tile) =>
      textureKeyString(tile)))
  }

  setSource(urlForTile, coverageTiles) {
    this.clear()
    this.configureSource(urlForTile, coverageTiles)
  }

  minimumWorkspaceBytes() { return 0 }
  resolveCapacityPressure() { return false }

  resourceDemand(tiles = new Map([...this.currentRoots, ...this.targetDesired, ...(this.forecastTargets || [])])) {
    const keep = [], targets = new Set(tiles.keys()), groups = new Map()
    const coarsening = this.coarseningAncestors()
    let missing = 0, roots = 0
    for (const [id, tile] of tiles) {
      const entry = this.cache.entries.get(id), pending = this.cache.reservations.get(id)
      if (entry) keep.push(entry.lease)
      if (pending) keep.push(pending.lease)
      // Parked source failures have no runnable production demand. Retrying
      // clears this state and quotes their destinations again.
      if (!entry && !pending && !this.failed.has(id)) {
        ++missing
        const parent = parentTextureTile(tile)
        if (this.currentRoots.has(id) || this.coverageKeys.has(id) || !parent) ++roots
        else {
          const group = coarsening.has(id) ? 'coarsen:' + id : textureKeyString(parent)
          groups.set(group, (groups.get(group) || 0) + 1)
        }
      }
    }
    // Funded images are already in the ledger, including uploads not yet
    // visible. Quote only missing destinations and their serial input lane;
    // unused imagery share can fund that demand without a second allocation.
    const workspace = missing ? Math.max(0, this.minimumWorkspaceBytes() -
      (this.workspace ? this.workspace.bytes : 0)) : 0
    const granted = this.resourceShare ? this.resourceShare.workspace.availableBytes : 0
    // Publication must preserve the candidate's rolling admission contract.
    // Keep the full target protected, but fund only coarse coverage plus the
    // largest missing visible sibling group. Further groups exchange credit
    // with actual retirements instead of reserving the whole future viewport.
    const groupCount = Array.from(groups.values()).reduce((n, count) => Math.max(n, count), 0)
    const count = this.directTargets ? roots + groupCount : missing
    const requiredBytes = count * Math.ceil(this.estimatedTileBytes) + workspace
    const targetBytes = missing * Math.ceil(this.estimatedTileBytes) + workspace
    // Preserve the complete future target for capacity/quality diagnostics.
    // Only one complete image group acquires continuation credit now; this
    // forecast is not an additional allocation required to resume terrain.
    return {bytes: Math.max(0, targetBytes - granted - this.demandCredit.availableBytes),
      requiredBytes, targetBytes, keep, targets}
  }

  reserveDemand(demand) {
    // Convert a feasible complete group into owned continuation credit before
    // unrelated terrain producers can consume it. Existing share grants move,
    // rather than count twice; actual groups consume this credit atomically.
    this.demandCredit.trim(demand.requiredBytes)
    const growth = Math.max(0, demand.requiredBytes - this.demandCredit.availableBytes)
    if (growth) {
      const reserve = funding => this.cache.ledger.reserve(this.demandCredit.owner, growth, [], demand.keep, funding)
      const credit = this.resourceShare ? this.resourceShare.fund(reserve) : reserve([])
      if (!credit) return false
      this.demandCredit.accept(credit)
      ++this.demandGrants
      this.demandHighWaterBytes = Math.max(this.demandHighWaterBytes, this.demandCredit.bytes)
    }
    this.protectDemand(demand.targets)
    return true
  }

  reserveCandidateDemand(draws) {
    const tiles = new Map([...this.currentRoots, ...draws.map(draw => [textureKeyString(draw.texture), draw.texture])])
    for (const draw of draws) {
      let root = draw.texture, parent
      while ((parent = parentTextureTile(root))) root = parent
      tiles.set(textureKeyString(root), root)
    }
    this.coverageTiles.forEach(tile => tiles.set(textureKeyString(tile), tile))
    const demand = this.resourceDemand(tiles), refusal = {}
    const targets = demand.targets
    let continuationBytes = demand.requiredBytes
    const workspace = new ResourceWorkspace('imagery-candidate')
    const requests = new Map()
    for (const id of targets) {
      const paid = this.cache.entries.get(id) || this.cache.reservations.get(id)
      if (paid) requests.set(id, paid.byteSize)
    }
    let images = this.cache.borrowBatch(requests)
    invariant(images, 'Candidate image quote lost its paid destinations')
    const reserve = funding => this.cache.ledger.reserve(workspace.owner, continuationBytes, [], demand.keep, funding, refusal)
    let credit
    try { credit = this.resourceShare ? this.resourceShare.fund(reserve) : reserve([]) }
    catch (error) { images.release(); throw error }
    if (!credit) { images.release(); return {shortfallBytes: refusal.shortfallBytes || 0} }
    workspace.accept(credit)
    const generation = this.generation
    let closed = false, accepted = false
    const transaction = {targets, pendingKeys: images.pendingKeys, targetBytes:demand.targetBytes,
      get continuationBytes() { return continuationBytes },
      get bytes() { return workspace.bytes },
      valid: () => (accepted || !closed && images.valid()) && generation === this.generation,
      quote: () => accepted && generation === this.generation ? this.resourceDemand(tiles) : null,
      prepareAcceptance: () => {
        if (transaction.valid()) return
        if (closed || generation !== this.generation) throw Object.assign(new Error('Candidate image source changed'),
          {superseded: true, candidateAdmissionRejected: true})
        // A producer can fail between native publication and host reception.
        // Reprice the same immutable tile set before changing the renderer;
        // keep old loans until the replacement exchange has actually funded.
        const next = this.resourceDemand(tiles), fresh = new Map()
        for (const id of targets) {
          const paid = this.cache.entries.get(id) || this.cache.reservations.get(id)
          if (paid) fresh.set(id, paid.byteSize)
        }
        const borrowed = this.cache.borrowBatch(fresh)
        invariant(borrowed, 'Candidate image exchange lost its paid destinations')
        const refused = {}, extra = Math.max(0, next.requiredBytes - workspace.availableBytes)
        const acquire = funding => this.cache.ledger.reserve(workspace.owner, extra, [], next.keep, funding, refused)
        let additional
        try { additional = this.resourceShare ? this.resourceShare.fund(acquire) : acquire([]) }
        catch (error) { borrowed.release(); throw error }
        if (!additional) {
          borrowed.release()
          throw Object.assign(new Error('Candidate image exchange capacity is occupied'),
            {status: 9, candidateAdmissionRejected: true, capacityShortfallBytes: refused.shortfallBytes || 0})
        }
        workspace.accept(additional); workspace.trim(next.requiredBytes)
        const previous = images
        images = borrowed; transaction.pendingKeys = images.pendingKeys
        continuationBytes = next.requiredBytes
        previous.release()
      },
      release: () => {
        if (closed) return
        closed = true; this.candidateDemands.delete(transaction)
        const cleanup = new Cleanup()
        cleanup.run(images.release); cleanup.run(() => workspace.retire()); cleanup.finish()
      },
      accept: () => {
        transaction.prepareAcceptance()
        invariant(transaction.valid(), 'Candidate imagery demand was invalidated')
        if (accepted) return
        this.demandCredit.retire()
        this.demandCredit = workspace
        this.forecastTargets = tiles
        this.protectDemand(targets)
        accepted = closed = true; this.candidateDemands.delete(transaction)
        images.release()
        ++this.demandGrants
        this.demandHighWaterBytes = Math.max(this.demandHighWaterBytes, workspace.bytes)
      }}
    this.candidateDemands.add(transaction)
    return transaction
  }

  protectDemand(keys) {
    if (keys.size === this.demandKeys.size && Array.from(keys).every(key => this.demandKeys.has(key))) return
    this.demandKeys = new Set(keys)
    this.protectionRevision = (this.protectionRevision || 0) + 1
    this.cache.ledger.available()
  }

  releaseDemand() { this.forecastTargets = null; this.demandCredit.trim(); this.protectDemand(new Set()) }

  setMaximumConcurrent(value) {
    this.scheduler.maximumConcurrent = Math.max(1, Math.floor(value))
    this.scheduler.pump()
  }

  setPreferredBytes(bytes) {
    if (this.resourceShare) {
      this.resourceShare.setPreferred(bytes)
      bytes = this.resourceShare.bytes
    }
    this.requestedMaximumBytes = bytes
    this.applyShareLimit()
  }

  applyShareLimit() {
    if (this.resourceShare) this.requestedMaximumBytes = this.resourceShare.bytes
    this.cache.maximumBytes = this.requestedMaximumBytes
    this.cache.evict()
  }

  fundShare(reserve) {
    return this.demandCredit.fund(0, demand => this.resourceShare
      ? this.resourceShare.fund(share => reserve(demand.concat(share))) : reserve(demand))
  }

  withdrawShare(pressure = false) {
    if (!this.resourceShare) return false
    const changed = this.resourceShare.revoke(pressure)
    this.applyShareLimit()
    return changed
  }

  growShare() {
    const r = this.renderer, quality = r.current && r.current.imageryPlan && r.current.imageryPlan.quality
    if (!this.resourceShare || this.resourceShare.pressured || !quality ||
        !quality.planningComplete || quality.cameraCurrent === false || !quality.limitedByTextureBudget ||
        quality.maximumTextureCount !== this.targetCapacity() || r.plannedCameraVersion !== r.cameraVersion ||
        r.meshOutputPlan || r.heldCandidate || r.geometryPublicationPending ||
        !this.coarseCoverageReady() || !r.options.onImageryPlanningChange) return false
    // Planning describes the current view independently of image readiness.
    // Active inputs and GPU submissions already own their resource credit;
    // waiting for them here would serialize every capacity-limited image cut
    // before the final affordable target could even be requested. A grant only
    // changes demand; existing group admission and receipts still own display.
    const bytes = Math.min(this.resourceShare.maximumBytes - this.resourceShare.bytes,
      Math.max(1, this.replacementEntries()) * Math.ceil(this.estimatedTileBytes))
    // An entry ceiling or a sub-image remainder cannot buy another target.
    // Do not occupy global credit when the planner cannot use the grant.
    if (this.capacityPlan(this.requestedMaximumBytes + bytes).targets <= this.targetCapacity()) return false
    if (!this.resourceShare.grow(bytes)) return false
    if (Array.from(this.targetDesired.keys()).some(id => !this.gpuReady(id))) ++this.grantsBeforeImagesReady
    this.applyShareLimit()
    r.options.onImageryPlanningChange()
    r.requestRender()
    return true
  }

  replacementEntries() { return Math.max(this.transitionReserveEntries, this.prefetchAncestors ? 4 : 0) }

  replacementHeadroomBytes() { return 0 }

  capacityPlan(maximumBytes = this.requestedMaximumBytes) {
    return imageryCapacity({maximumBytes,
      maximumEntries: this.requestedMaximumEntries,
      imageBytes: this.estimatedTileBytes, workspaceBytes: this.minimumWorkspaceBytes(),
      coverageEntries: Math.max(this.coverageKeys.size, this.prefetchAncestors ? 1 : 0),
      // A source quadtree sibling group contains at most four physical images.
      // Headroom is a ceiling, never permission to bypass actual admission.
      replacementEntries: this.replacementEntries(),
      replacementHeadroomBytes: this.replacementHeadroomBytes()})
  }

  cacheCapacity() { return this.capacityPlan().capacity }

  targetCapacity() { return this.capacityPlan().targets }

  transitionCapacity() { return Math.max(1, this.capacityPlan().replacement) }

  addRequiredPath(tile, priority, pixelError) {
    this.pyramid.addPath(tile, Number(priority) || 0, this.prefetchAncestors,
      this.directTargets, key => this.gpuReady(key), pixelError)
  }

  buildRequirementTree(draws, retainedDraws) {
    this.pyramid.begin()
    this.targetDesired.clear()
    this.retainedTargets.clear()

    this.coverageTiles.forEach((tile) =>
      this.addRequiredPath(tile, 200000))
    draws.forEach((draw) => {
      const tile = draw.texture
      const key = textureKeyString(tile)
      if (!draw.imageryCoverageDraw) {
        this.targetDesired.set(key, tile)
      }
      this.addRequiredPath(tile, 1000 + (Number(draw.imageryPriority) || 0),
        Math.max(1, Number(draw.imageryPixelError) || 1.25) /
          (this.renderer.options.imageryPixelError || 1.25))
    })
    const retained = Array.isArray(retainedDraws) ? retainedDraws : []
    retained.forEach((draw) => {
      const tile = draw.texture
      const key = textureKeyString(tile)
      // Presentation references protect resident fallbacks, not obsolete I/O.
      // A cached fine tile can be drawn directly from the presentation ledger.
      if (!this.cache.has(key)) return
      if (!draw.imageryCoverageDraw) {
        this.retainedTargets.set(key, tile)
      }
    })
    this.pyramid.finish()
    if (this.forecastTargets && Array.from(this.forecastTargets.keys()).every(key =>
        this.targetDesired.has(key) || this.currentRoots.has(key))) this.forecastTargets = null
  }

  coarseningAncestors() {
    const displayed = this.renderer.presentedTextures
    const count = displayed ? displayed.size : 0
    if (!this.coarseningParents || this.coarseningPresentation !== displayed || this.coarseningSize !== count) {
      this.coarseningPresentation = displayed; this.coarseningSize = count
      const parents = this.coarseningParents = new Set()
      if (displayed) displayed.forEach(tile => {
        for (let parent = parentTextureTile(tile); parent; parent = parentTextureTile(parent)) {
          const id = textureKeyString(parent)
          if (parents.has(id)) break // Its remaining ancestors are already indexed.
          parents.add(id)
        }
      })
    }
    return this.coarseningParents
  }

  resourceGroups() {
    if (!this.directTargets) return Array.from(this.requiredChildren.entries())
    const coarsening = this.coarseningAncestors()
    if (this.groupRevision === this.pyramid.revision && this.groupCoarsening === coarsening) return this.groups
    // Request dependency and presentation adjacency are different relations.
    // A distant leaf can use the resident root for coverage without downloading
    // its ancestors, while at most four visible siblings are admitted together.
    const groups = new Map()
    this.requiredChildren.forEach(children => children.forEach((tile,key) => {
      const parent = parentTextureTile(tile) || tile
      // A coarse target independently replaces its displayed descendants.
      // Coupling neighbouring coarse parents can require four free slots when
      // one parent would already release its own fine subtree. Refinement
      // siblings still enter together; neither path retires display ownership.
      const groupKey = coarsening.has(key) ? 'coarsen:' + key : textureKeyString(parent)
      if (!groups.has(groupKey)) groups.set(groupKey,new Map())
      groups.get(groupKey).set(key,tile)
    }))
    this.groupRevision = this.pyramid.revision
    this.groupCoarsening = coarsening
    this.groups = Array.from(groups.entries())
    return this.groups
  }

  coverageReady() {
    if (!this.currentRoots.size) return true
    for (const key of this.currentRoots.keys()) {
      if (!this.availableKeys.has(key) || !this.cache.has(key)) return false
    }
    return true
  }

  coarseCoverageReady() {
    if (!this.coverageKeys.size) return this.coverageReady()
    for (const key of this.coverageKeys) {
      if (!this.availableKeys.has(key) || !this.cache.has(key)) return false
    }
    return true
  }

  requiresResident(key) {
    return this.targetDesired.has(key) || this.retainedTargets.has(key) ||
      this.coverageKeys.has(key) || this.currentRoots.has(key)
  }

  recomputeAvailability() {
    const previous=this.availableKeys
    this.availableKeys = availableImageryCut(this.currentRoots, this.resourceGroups(), this.availableKeys, {
      ready: key => this.gpuReady(key), failed: key => this.failed.has(key),
      required: key => this.requiresResident(key), direct: this.directTargets
    })
    if(previous.size!==this.availableKeys.size||Array.from(previous).some(id=>!this.availableKeys.has(id)))
      this.availabilityRevision=(this.availabilityRevision||0)+1
  }

  presentationKeyFor(tile, resolution) {
    if (resolution) {
      const resolved = resolution.resolve(tile)
      return resolved ? textureKeyString(resolved) : null
    }
    for (let candidate = tile; candidate; candidate = parentTextureTile(candidate)) {
      const key = textureKeyString(candidate)
      if (this.availableKeys.has(key) && this.cache.has(key)) return key
    }
    return null
  }

  presentationTileFor(tile) {
    let root = tile
    for (let candidate = tile; candidate; candidate = parentTextureTile(candidate)) {
      root = candidate
      const key = textureKeyString(candidate)
      if (this.gpuReady(key) && (this.availableKeys.has(key) ||
          this.renderer.presentedTextures.has(key))) return candidate
    }
    return root
  }

  refreshProtection() {
    const previousProtection = new Set(this.protectedKeys)
    this.protectedKeys.clear()
    this.presentationKeys.clear()
    this.stagedKeys.clear()
    this.transitionGroups.clear()
    this.transitionReserved = 0
    this.currentRoots.forEach((tile, key) => this.protectedKeys.add(key))
    this.coverageKeys.forEach((key) => {
      if (this.availableKeys.has(key)) this.protectedKeys.add(key)
    })
    // A synchronous protection pass observes one availability state. Shared
    // ancestor paths need no repeated search; never retain this after the pass.
    const resolution = new ImageryResolution(id => this.availableKeys.has(id) && this.cache.has(id))
    const protectPresentation = (tile) => {
      const key = this.presentationKeyFor(tile, resolution)
      if (!key) return
      this.presentationKeys.add(key)
      this.protectedKeys.add(key)
    }
    // Keep actual GPU submissions pinned until the next submission confirms
    // their replacement, including finer leaves beneath a cached coarse target.
    this.renderer.presentedTextures.forEach((tile, key) => {
      if (this.cache.has(key)) { this.presentationKeys.add(key); this.protectedKeys.add(key) }
    })
    this.targetDesired.forEach(protectPresentation)
    this.retainedTargets.forEach(protectPresentation)

    const capacity = this.transitionCapacity()
    this.frontierGroups().forEach((group) => {
      if (group.parentKey === null || this.transitionReserved + group.groupSize > capacity) return
      // Keep the selected complete groups in their admission order. Upload
      // preparation consumes this selection, not another request-priority pass.
      this.transitionGroups.set(group.parentKey, group.allChildren)
      this.transitionReserved += group.groupSize
      group.allChildren.forEach((tile, key) => {
        if (this.cache.has(key) && !this.availableKeys.has(key)) {
          this.stagedKeys.add(key)
          this.protectedKeys.add(key)
        }
      })
    })
    // Complete producer-specific protection before eviction or comparing its
    // identity. Removing and re-adding the same future children is not a new
    // availability epoch and must not reopen a refused admission.
    this.protectRequests()
    this.protectedKeys.forEach((key) => {
      if (this.cache.has(key)) this.cache.get(key)
    })
    let protectedBytes = 0, protectedEntries = 0
    this.protectedKeys.forEach(key => {
      const entry = this.cache.entries.get(key)
      if (entry) { protectedBytes += entry.byteSize; ++protectedEntries }
    })
    this.updateProtectionCapacity(protectedBytes, protectedEntries)
    this.cache.evict()
    if (previousProtection.size !== this.protectedKeys.size ||
        Array.from(previousProtection).some(key => !this.protectedKeys.has(key))) {
      this.protectionRevision = (this.protectionRevision || 0) + 1
    }
  }

  protectRequests() {}

  updateProtectionCapacity(protectedBytes, protectedEntries) {
    if (protectedBytes <= this.requestedMaximumBytes &&
        protectedEntries <= this.requestedMaximumEntries) {
      this.cache.maximumBytes = this.requestedMaximumBytes
      this.cache.maximumEntries = this.requestedMaximumEntries
    }
  }

  groupComplete(children) {
    if (!children.size) return false
    for (const key of children.keys()) {
      if (!this.failed.has(key) && (!this.availableKeys.has(key) ||
          this.requiresResident(key) && !this.cache.has(key))) return false
    }
    return true
  }

  frontierGroups() {
    const groups = []
    // This pass is read-only. A fresh resolver per pass sees upload/retirement
    // immediately without rescanning shared ancestor paths for every leaf.
    const resolution = new ImageryResolution(id =>
      (this.availableKeys.has(id) || this.renderer.presentedTextures.has(id)) && this.gpuReady(id))
    this.resourceGroups().forEach(([parentKey, children]) => {
      if (!this.directTargets && !this.availableKeys.has(parentKey) && !this.failed.has(parentKey)) return
      // Completed groups remain in the coverage/protection model, but are not
      // request work. Do not measure their screen-space priorities. Recheck
      // readiness each pass so retirement and retry reopen the exact group.
      if (this.groupComplete(children)) return
      // A cold sparse ladder completes its local coverage predecessor first.
      // Already downloaded finer input may skip a slow optional predecessor.
      // This only offers the group; complete GPU/UV pricing remains mandatory.
      if(this.pyramid.coverageParents.size&&!parentKey.startsWith('coarsen:')&&
          Array.from(children.keys()).some(key=>{
            const predecessor=this.pyramid.coverageParents.get(key)
            return !this.gpuReady(key)&&predecessor&&!this.failed.has(predecessor)&&
              !this.gpuReady(predecessor)&&!this.coverageInputReady(key)
          }))return
      const missing = new Map()
      let priority = Number.NEGATIVE_INFINITY
      let level = Number.POSITIVE_INFINITY
      let staged = 0
      let inFlight = 0
      children.forEach((tile, key) => {
        priority = Math.max(priority, this.pyramid.refinementPriority(tile, resolution.fallback(tile).level))
        level = Math.min(level, tile.level)
        if (this.cache.has(key) && !this.availableKeys.has(key)) staged += 1
        if (this.scheduler.active.has(key) || this.cache.reservations.has(key)) {
          inFlight += 1
        }
        const needsResident = this.requiresResident(key)
        if (!this.failed.has(key) && !this.cache.has(key) &&
          (!this.availableKeys.has(key) || needsResident)) {
          missing.set(key, tile)
        }
      })
      groups.push({ parentKey, children: missing, allChildren: children,
        coarsening: this.directTargets && parentKey.startsWith('coarsen:'),
        groupSize: children.size, level, priority, staged, inFlight })
    })
    groups.sort((left, right) =>
      Number(right.coarsening) - Number(left.coarsening) ||
      Number(right.staged + right.inFlight > 0) -
        Number(left.staged + left.inFlight > 0) ||
      right.staged - left.staged ||
      right.priority - left.priority || left.level - right.level)
    const roots = new Map()
    this.currentRoots.forEach((tile, key) => {
      if (!this.cache.has(key) && !this.failed.has(key)) roots.set(key, tile)
    })
    // Roots receive first request priority, not a global publication barrier.
    if (roots.size) groups.unshift({ parentKey: null, children: roots })
    return groups
  }

  refinementPriority(tile) {
    const predecessor = this.presentationTileFor(tile)
    return this.pyramid.refinementPriority(tile, predecessor.level)
  }

  scheduleFrontier() {
    this.frontierKeys.clear()
    this.blockedByCapacity = false
    this.blockedGroupCount = 0
    this.blockedTileCount = 0
    const groups = this.frontierGroups()
    if (!groups.length) return

    groups.forEach((group, rank) => {
      const bootstrapping = group.parentKey === null
      group.children.forEach((tile, key) => this.frontierKeys.add(key))
      if (!bootstrapping &&
        !this.transitionGroups.has(group.parentKey)) {
        // A queued request has no reservation. If re-ranking gives this
        // replacement slot to another group, withdraw only that metadata;
        // active producers keep their own admission and completion path.
        group.children.forEach((tile, key) => this.scheduler.queued.delete(key))
        this.blockedByCapacity = true
        this.blockedGroupCount += 1
        this.blockedTileCount += group.children.size
        return
      }
      const unscheduled = []
      // Keep completion-first group ordering through the network queue too.
      // Queued work owns no producer; re-rank it without cancelling active I/O.
      const priority = bootstrapping ? 1000000 : 900000 - rank
      group.children.forEach((tile, key) => {
        const queued = this.scheduler.queued.get(key)
        if (queued) queued.priority = priority
        if (!this.scheduler.active.has(key) &&
          !queued && !this.retryTimers.has(key) && this.requestEligible(key)) {
          unscheduled.push({ key, tile })
        }
      })
      // Rank only runnable requests. Waiting producers retain their frontier
      // and protection, but cannot consume another ancestor walk on each GPU
      // receipt. This synchronous sort has no readiness mutations: measure
      // each candidate once, then discard these scores before admission.
      if (unscheduled.length > 1) {
        for (const item of unscheduled) item.score = this.refinementPriority(item.tile)
        unscheduled.sort((left, right) => right.score - left.score)
      }
      unscheduled.forEach(({ key, tile }) => {
        this.schedule(key, tile, priority)
      })
    })
  }

  advance() {
    if (this.disposed || this.scheduler.paused) return
    const demand = this.resourceDemand()
    this.demandCredit.trim(demand.requiredBytes)
    this.protectDemand(new Set(Array.from(this.demandKeys).filter(key => demand.targets.has(key))))
    const previous = this.availableKeys
    this.recomputeAvailability()
    this.refreshProtection()
    const admission = [this.cache.revision, this.cache.ledger.availabilityRevision, this.cache.maximumBytes,
      this.cache.maximumEntries, this.protectionRevision || 0].join(':')
    if (admission !== this.admissionSignature) {
      this.admissionBlocked.clear()
      this.admissionSignature = admission
    }
    // Parked queue entries own no payload. Another producer may have supplied
    // their image, or their demand may have expired before a dependency woke.
    for (const key of this.scheduler.queued.keys())
      if (!this.isWanted(key) || this.cache.has(key) || this.failed.has(key)) this.scheduler.queued.delete(key)
    this.scheduleFrontier()
    this.scheduler.pump()
    this.blockedByCapacity = this.blockedByCapacity || this.admissionBlocked.size > 0
    if (previous.size !== this.availableKeys.size ||
        Array.from(previous).some(key => !this.availableKeys.has(key))) this.renderer.requestRender()
    this.renderer.requestResources()
  }

  scheduleAdvance() {
    if (this.disposed || this.scheduler.paused) return
    if (this.advanceTimer) return
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = null
      this.advance()
    }, 0)
  }

  needsCapacityRetry() { return this.admissionBlocked.size > 0 }

  dependenciesChanged() {}

  sync(draws, retainedDraws, coarsening = false) {
    this.admissionBlocked.clear()
    const previous = new Map(this.desired)
    this.buildRequirementTree(draws, retainedDraws)
    const desired = new Set(this.desired.keys())
    const now = Date.now()
    if (coarsening) this.retainedUntil.clear()
    previous.forEach((tile, key) => {
      if (!coarsening && !desired.has(key) && this.staleRequestGraceMs > 0) {
        this.retainedUntil.set(key, now + this.staleRequestGraceMs)
      }
    })
    desired.forEach((key) => this.retainedUntil.delete(key))
    const wanted = this.wantedKeys(now)
    this.scheduler.cancelExcept(wanted)
    this.cancelStaleRetries(wanted)
    this.advance()
    this.scheduleRetainedPrune()
  }

  wantedKeys(now) {
    const wanted = new Set(this.desired.keys())
    for (const demand of this.candidateDemands) for (const key of demand.pendingKeys) wanted.add(key)
    this.retainedUntil.forEach((expiresAt, key) => {
      if (expiresAt > now) {
        wanted.add(key)
      } else {
        this.retainedUntil.delete(key)
      }
    })
    return wanted
  }

  isWanted(key) {
    return this.desired.has(key) ||
      Array.from(this.candidateDemands).some(demand => demand.pendingKeys.has(key)) ||
      (this.retainedUntil.get(key) || 0) > Date.now()
  }

  scheduleRetainedPrune() {
    if (this.retainedTimer || !this.retainedUntil.size) {
      return
    }
    let next = Number.POSITIVE_INFINITY
    this.retainedUntil.forEach((expiresAt) => { next = Math.min(next, expiresAt) })
    this.retainedTimer = setTimeout(() => {
      this.retainedTimer = null
      const wanted = this.wantedKeys(Date.now())
      this.scheduler.cancelExcept(wanted)
      this.cancelStaleRetries(wanted)
      this.scheduleRetainedPrune()
    }, Math.max(1, next - Date.now()))
  }

  priorityForKey(key) {
    if (this.currentRoots.has(key)) return 1000000
    const rank = this.frontierGroups().findIndex(group => group.allChildren && group.allChildren.has(key))
    return rank < 0 ? 0 : 900000 - rank
  }

  reserveRequest(key) {
    return this.fundShare(funding => this.cache.reserve(key, Math.ceil(this.estimatedTileBytes), funding))
  }
  requestBlocked(key) {
    // An asynchronous refund is backpressure, not yet a reason to coarsen
    // displayed detail. Its completion wakes one fresh admission attempt.
    if (this.cache.ledger.reclamation.pending) return
    this.admissionBlocked.add(key)
    this.blockedByCapacity = true
  }

  requestAsset(url) {
    const task = imageTask(this.canvas, url, 15000, this.renderer.options.fetchTextures)
    return {abort: task.abort, promise: task.promise.then(image => ({image, texture: null,
      width: Number(image.width) || 1, height: Number(image.height) || 1, url}))}
  }

  assetBytes(asset) { return this.resourceBytes(asset.width, asset.height) }
  prepareUploads() {}
  prepareAsset() { return true }
  uploadingAsset() {}
  cancelledAsset() {}
  uploadedAsset() {}

  coverageInputReady() { return false }

  requestEligible(key) { return !this.disposed && !this.admissionBlocked.has(key) }

  schedule(key, tile, priority) {
    // Admission of an earlier sibling may change eligibility after selection.
    if (!this.requestEligible(key)) return
    const generation = this.generation
    this.scheduler.enqueue(key, () => {
      // Reserve decoded-image and mipmapped GPU capacity before starting I/O.
      // The lease remains charged through fetch/decode, then becomes the cache
      // entry without a second allocation window.
      const reservation = this.reserveRequest(key)
      if (!reservation) {
        this.requestBlocked(key)
        return {promise: Promise.resolve(), abort() {}}
      }
      let url
      let task
      try {
        url = this.urlForTile(tile)
        task = this.requestAsset(url, reservation)
      } catch (error) {
        reservation.cancel()
        this.failed.set(key, tile)
        this.onDiagnostic('texture_request_failed', {
          key,
          message: error.message || String(error)
        })
        return {
          promise: Promise.resolve().then(() => this.scheduleAdvance()),
          abort() {}
        }
      }
      const promise = task.promise.then((asset) => {
        if (generation !== this.generation || !this.isWanted(key)) {
          this.disposeAsset(asset)
          return
        }
        const bytes = this.resourceBytes(asset.width, asset.height, asset)
        if (bytes > this.estimatedTileBytes) {
          this.estimatedTileBytes = bytes
          if (this.renderer.options.onImageryPlanningChange) this.renderer.options.onImageryPlanningChange()
        }
        this.retries.delete(key)
        this.failed.delete(key)
        if (!reservation.resize(this.assetBytes(asset)) || !reservation.commit(asset)) {
          this.admissionBlocked.add(key)
          this.disposeAsset(asset)
          this.onDiagnostic('texture_admission_blocked', { key })
        }
        this.scheduleAdvance()
      }).catch(error => this.requestFailed(key, tile, error, generation)).finally(() => {
        const released = reservation.cancel()
        if (released) this.scheduleAdvance()
      })
      return {promise, abort: () => {
        task.abort()
        // Decode may finish after cancellation. Its promise closes late images;
        // the reservation stays charged until that work actually stops.
      }}
    }, priority, () => this.requestEligible(key))
  }

  requestFailed(key, tile, error, generation) {
    const message = error.message || String(error)
    if (generation !== this.generation || /cancelled/.test(message) ||
        error.name === 'AbortError' || !this.isWanted(key)) return
    const terminal = error.status === 404 || error.status === 410
    const attempt = (this.retries.get(key) || 0) + 1
    this.retries.set(key, attempt)
    if (!terminal && attempt <= this.maximumRetries) {
      this.scheduleRetry(key, tile, attempt)
      this.onDiagnostic('texture_retry', { key, attempt, message })
      this.renderer.requestResources()
    } else {
      this.failed.set(key, tile)
      this.failureExpiry.set(key, terminal ? Infinity : Date.now() + 30000)
      this.onDiagnostic('texture_load_failed', { key, message })
      this.scheduleAdvance()
    }
  }

  scheduleRetry(key, tile, attempt) {
    if (this.retryTimers.has(key)) {
      return
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      if (this.isWanted(key) && !this.cache.has(key) &&
        !this.failed.has(key)) {
        this.schedule(key, tile, this.priorityForKey(key))
      }
    }, attempt * this.retryDelayMs)
    this.retryTimers.set(key, timer)
  }

  cancelStaleRetries(desired) {
    this.retryTimers.forEach((timer, key) => {
      if (!desired.has(key)) {
        clearTimeout(timer)
        this.retryTimers.delete(key)
      }
    })
    this.retries.forEach((value, key) => {
      if (!desired.has(key)) {
        this.retries.delete(key)
      }
    })
    this.failed.forEach((value, key) => {
      if ((this.failureExpiry.get(key) || Infinity) <= Date.now()) {
        this.failed.delete(key)
        this.failureExpiry.delete(key)
      }
    })
    if (this.failed.size > 1024) {
      for (const key of this.failed.keys()) {
        if (!desired.has(key)) { this.failed.delete(key); this.failureExpiry.delete(key) }
        if (this.failed.size <= 1024) break
      }
    }
  }

  retryFailed() {
    if (!this.failed.size && !this.retries.size) {
      return false
    }
    this.retryTimers.forEach((timer) => clearTimeout(timer))
    this.retryTimers.clear()
    this.retries.clear()
    this.failed.clear()
    this.failureExpiry.clear()
    this.advance()
    return true
  }

  uploadedTexture(asset) {
    return asset.texture || this.renderer.fallbackTexture
  }

  gpuReady(key) {
    const entry = this.cache.entries.get(key)
    return !!(entry && entry.value.texture && !this.renderer.contextLost)
  }

  uploadKeys() {
    const keys = new Set(this.currentRoots.keys())
    // Context recovery must restore the actual displayed cut, including fine
    // tiles retained beneath coarser planning targets. Keep uploads bounded.
    this.renderer.presentedTextures.forEach((tile, key) => keys.add(key))
    this.transitionGroups.forEach(children => {
      if (!this.groupComplete(children)) children.forEach((tile, key) => keys.add(key))
    })
    return keys
  }

  processUploads(deadline, keys = this.uploadKeys()) {
    if (this.renderer.contextLost) return
    let uploaded = false
    let pending = false
    for (const key of keys) {
      const entry = this.cache.entries.get(key)
      if (!entry || entry.value.texture || entry.value.uploading) continue
      if (monotonicNow() >= deadline) { pending = true; continue }
      if (!this.prepareAsset(key, entry)) continue
      const asset = entry.value
      const release = this.cache.retain(key)
      asset.uploading = true
      const accepted = this.renderer.uploadTexture(asset.image, asset.width, asset.height, texture => {
        asset.uploading = false
        if (this.cache.entries.get(key) !== entry) { release(); return false }
        asset.texture = texture
        this.uploadedAsset(key, entry)
        release()
        if (this.renderer.presentedTextures.has(key)) this.renderer.requestRender()
      }, () => { asset.uploading = false; this.cancelledAsset(key, entry); release() })
      if (accepted === false) { pending = true; break }
      this.uploadingAsset(key, entry)
      uploaded = true
    }
    if (uploaded && !this.renderer.uploadBatch) this.advance()
    if (pending) this.renderer.requestResources()
  }

  beginFrame() {
    this.frameUsage = { exact: 0, fallback: 0, missing: 0 }
  }

  binding(cell, tile) {
    const asset = this.cache.get(textureKeyString(tile))
    if (!asset || !asset.texture || !textureTileContains(tile, cell)) return null
    return Object.assign({texture: asset.texture, resolvedTile: tile, resolvedLevel: tile.level,
      kind: tile.level === cell.level ? 'exact' : 'fallback'}, ancestorUvTransform(cell, tile))
  }

  get(tile, record = true) {
    for (let candidate = tile; candidate; candidate = parentTextureTile(candidate)) {
      const key = textureKeyString(candidate)
      if (!this.availableKeys.has(key) && !this.renderer.presentedTextures.has(key)) continue
      const asset = this.cache.get(key)
      if (!asset || !asset.texture) continue
      if (candidate === tile) {
        if (record) this.frameUsage.exact += 1
        return {
          texture: this.uploadedTexture(asset),
          scale: 1,
          offsetX: 0,
          offsetY: 0,
          exact: true,
          kind: 'exact',
          resolvedTile: candidate,
          resolvedLevel: tile.level
        }
      }
      const transform = ancestorUvTransform(tile, candidate)
      if (record) this.frameUsage.fallback += 1
      return Object.assign({
        texture: this.uploadedTexture(asset),
        exact: false,
        kind: 'fallback',
        resolvedTile: candidate,
        resolvedLevel: candidate.level
      }, transform)
    }
    if (record) this.frameUsage.missing += 1
    return {
      texture: this.renderer.fallbackTexture,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      exact: false,
      kind: 'missing',
      resolvedLevel: -1
    }
  }

  restoreContext() {
    this.cache.values().forEach((asset) => {
      asset.texture = null
    })
    this.availableKeys.clear()
    this.advance()
  }

  setPaused(paused) {
    if (paused) {
      this.releaseDemand()
      this.withdrawShare()
      this.scheduler.pause()
      if (this.advanceTimer) clearTimeout(this.advanceTimer)
      if (this.retainedTimer) clearTimeout(this.retainedTimer)
      this.advanceTimer = null; this.retainedTimer = null
      this.retryTimers.forEach(timer => clearTimeout(timer))
      this.retryTimers.clear()
    } else {
      this.scheduler.resume()
      this.advance()
      this.scheduleRetainedPrune()
    }
  }

  disposeAsset(asset) {
    if (asset && asset.texture && this.renderer.gl) {
      this.renderer.gl.deleteTexture(asset.texture)
    }
    if (asset && asset.image && typeof asset.image.close === 'function') asset.image.close()
  }

  clear() {
    Array.from(this.candidateDemands).forEach(demand => demand.release())
    this.releaseDemand()
    this.withdrawShare()
    const maximumConcurrent = this.scheduler.maximumConcurrent
    const previousScheduler = this.scheduler
    this.generation += 1
    this.scheduler = new RequestScheduler(maximumConcurrent)
    previousScheduler.clear()
    if (this.retainedTimer) {
      clearTimeout(this.retainedTimer)
      this.retainedTimer = null
    }
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer)
      this.advanceTimer = null
    }
    this.retryTimers.forEach((timer) => clearTimeout(timer))
    this.retryTimers.clear()
    this.targetDesired.clear()
    this.retainedTargets.clear()
    this.availableKeys.clear()
    this.presentationKeys.clear()
    this.frontierKeys.clear()
    this.stagedKeys.clear()
    this.transitionGroups.clear()
    this.protectedKeys.clear()
    this.blockedByCapacity = false
    this.blockedGroupCount = 0
    this.blockedTileCount = 0
    this.transitionReserved = 0
    this.retries.clear()
    this.failed.clear()
    this.retainedUntil.clear()
    this.failureExpiry.clear()
    // An aborted browser decode can still own memory until its promise settles.
    // A source switch must not reuse those bytes for another simultaneous job.
    this.cache.clear({retainReservations: true})
    this.admissionBlocked.clear()
    this.pyramid.clear()
    this.coarseningPresentation = null
    this.coarseningParents = null
    this.coarseningSize = 0
    this.groupCoarsening = null
    this.groups = null
    this.groupRevision = undefined
  }

  destroy() {
    this.disposed = true
    this.clear()
    this.scheduler.pause()
  }

  stats() {
    const capacityPlan = this.capacityPlan(), capacity = capacityPlan.capacity
    let cachedDesired = 0
    this.desired.forEach((tile, key) => {
      if (this.cache.has(key)) cachedDesired += 1
    })
    const used = this.frameUsage.exact + this.frameUsage.fallback +
      this.frameUsage.missing
    let residentTarget = 0
    let cachedTarget = 0
    let coverageTargets = 0
    this.targetDesired.forEach((tile, key) => {
      if (this.coverageKeys.has(key)) ++coverageTargets
      if (this.cache.has(key)) residentTarget += 1
      if (this.cache.has(key) && this.availableKeys.has(key)) {
        cachedTarget += 1
      }
    })
    let cachedCoverage = 0
    this.coverageKeys.forEach((key) => {
      if (this.cache.has(key) && this.availableKeys.has(key)) {
        cachedCoverage += 1
      }
    })
    let cachedRoots = 0
    this.currentRoots.forEach((tile, key) => {
      if (this.cache.has(key) && this.availableKeys.has(key)) cachedRoots += 1
    })
    let blockedByFailure = false
    this.failed.forEach((tile, key) => {
      blockedByFailure = blockedByFailure || this.desired.has(key)
    })
    const scheduler = this.scheduler.stats()
    const coverageReady = this.coverageReady()
    const targetMissing = this.targetDesired.size - cachedTarget
    // The planner allowance already excludes mandatory coverage. A coarse or
    // hidden surface can also request that same physical root as a target;
    // count it once, in coverage, rather than charging a detail slot again.
    const detailTargets = this.targetDesired.size - coverageTargets
    const requiredImages = detailTargets + this.coverageKeys.size
    const stalledByCapacity = this.blockedByCapacity &&
      scheduler.active === 0 && scheduler.queued === 0 && targetMissing > 0
    const blockedAdmission = Array.from(this.admissionBlocked).some(key => this.desired.has(key))
    const state = blockedAdmission ? 'blocked-capacity' : blockedByFailure ? 'degraded'
      : (!coverageReady ? 'bootstrapping'
        : (targetMissing === 0 ? 'settled'
          : (stalledByCapacity ? 'blocked-capacity' : 'refining')))
    return Object.assign(this.cache.stats(), scheduler, {
      state,
      admissionBlocked: blockedAdmission,
      desired: this.desired.size,
      cachedDesired,
      desiredMissing: this.desired.size - cachedDesired,
      targetDesired: this.targetDesired.size,
      residentTarget,
      cachedTarget,
      targetMissing,
      supportDesired: Math.max(0,
        this.desired.size - this.targetDesired.size),
      rootDesired: this.currentRoots.size,
      cachedRoots,
      coverageReady,
      coarseCoverageReady: this.coarseCoverageReady(),
      coverageDesired: this.coverageKeys.size,
      cachedCoverage,
      available: this.availableKeys.size,
      presentationTiles: this.presentationKeys.size,
      frontierTiles: this.frontierKeys.size,
      stagedTiles: this.stagedKeys.size,
      capacity,
      capacityPlan,
      resourceShare: this.resourceShare ? Object.assign(this.resourceShare.stats(),
        {grantsBeforeImagesReady: this.grantsBeforeImagesReady}) : null,
      demandReservation: {bytes: this.demandCredit.bytes + Array.from(this.candidateDemands).reduce((sum,demand)=>sum+demand.bytes,0), grants: this.demandGrants,
        highWaterBytes: this.demandHighWaterBytes, targets: this.demandKeys.size},
      targetCapacity: capacityPlan.targets,
      transitionCapacity: this.transitionCapacity(),
      transitionGroups: this.transitionGroups.size,
      transitionReserved: this.transitionReserved,
      protected: this.protectedKeys.size,
      limitedByCapacity: detailTargets > capacityPlan.targets || requiredImages > capacityPlan.steadyCapacity,
      limitedByPhysicalCapacity: requiredImages > capacity,
      blockedByCapacity: this.blockedByCapacity,
      blockedGroupCount: this.blockedGroupCount,
      blockedTileCount: this.blockedTileCount,
      blockedByFailure,
      failed: this.failed.size,
      fallbackRatio: used ? this.frameUsage.fallback / used : 0,
      missingRatio: used ? this.frameUsage.missing / used : 0,
      idle: scheduler.active === 0 && scheduler.queued === 0
    })
  }
}

module.exports = { TextureStore, textureByteSize, isPowerOfTwo, imageTask }
