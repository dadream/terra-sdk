const { invariant } = require('../core/terra_globe_common')
const {ResourceLedger} = require('../resources/resource_ledger')
const {Cleanup}=require('../runtime/cleanup')
const {surfaceIds, identityReplacementPlan, atomicReplacementPlan, selectReplacementGroups, changedReplacementGroups} = require('./surface_replacement')
const {MeshCopyPlan, textureResourceKey, meshCutBytes} = require('../resources/mesh_coordinates')
const {indexPayloadBytes, holdIndices} = require('../resources/mesh_indices')
const {runCreditStage} = require('../resources/stage_credit')
const {MeasurementLoans,onMeasurementsReleased}=require('./measurement_rows')
const {capacityCheckpoint,capacityRefusalRevision}=require('../resources/capacity_refusal')

// Each immutable resource owns a CPU copy or a loan from the native producer.
// Keep the displayed cut until its replacement has actually reached the GPU.
class MeshFrames {
  constructor(ledger = new ResourceLedger(), owner = 'mesh-host') {
    this.ledger = ledger
    this.owner = owner
    this.resources = new Map()
    this.textureResources = new Map()
    this.indices = null
    this.candidate = null
    this.presented = null
    this.copiedBytes = 0
    this.retiredCount = 0
    this.retiredBytes = 0
    this.reserveOutputs = null // A headless owner has no renderer destination.
    this.onPreparation = null
    this.prepareOutputs = null
    this.measurementLoans=new MeasurementLoans()
  }

  async read(abi, threshold, budget) {
    let credit, packet, native, outputs, failure, copies
    const before=capacityCheckpoint(this.ledger)
    try {
      native = abi.setResourceLedger(this.ledger)
      packet = await this.describe(abi, threshold, budget)
      if (this.onPreparation) this.onPreparation(packet)
      const plan = packet.nativePlan
      const beforeIds = this.presented ? surfaceIds(this.presented.draws) : []
      const refine = async () => {
        const bytes = abi.replacementWorkBytes(plan, beforeIds)
        const refusal = {}
        const scratch = await this.reserveNativeWork('terrain-boundary-work', bytes,
          () => this.ledger.reserve('terrain-boundary-work', bytes, [], [], [], refusal))
        if (!scratch) throw Object.assign(new Error('Boundary planning capacity is occupied'),
          {status: 9, capacityShortfallBytes: refusal.shortfallBytes})
        let task
        try {
          task = this.replacementTask = abi.createReplacementTask(plan, beforeIds, bytes)
          const proof = await task.run()
          invariant(this.replacementTask === task && proof, 'Boundary planning was cancelled')
          return proof
        } finally { if (this.replacementTask === task) this.replacementTask = null; scratch.release() }
      }
      const admitted = await this.admitProduction(packet,
        value => {
          const next = new MeshCopyPlan(this, value.draws)
          if (copies) copies.release()
          copies = next
          return copies.bytes
        },
        (bytes, acquire) => this.reserveNativeWork('mesh-transfer', bytes, acquire),
        groups => abi.selectMeshGroups(plan, groups), refine)
      packet = admitted.packet; credit = admitted.credit; outputs = admitted.outputs
      if (outputs && !outputs.valid()) throw Object.assign(new Error('Mesh destination was invalidated'), {status: 9})
      native.begin(credit.split(packet.nativePlan.additionalBytes, 'reserved', 'mesh-native'))
      copies.allocate(credit)
      const task = this.productionTask = abi.createMeshTask(packet)
      try {
        const produced = await task.run()
        invariant(this.productionTask === task && produced, 'Mesh production was cancelled')
      } finally { if (this.productionTask === task) this.productionTask = null; task.cancel() }
      const result = copies.read(abi, Object.assign({}, packet, {outputs}), candidate => {
        abi.commitMeshFrame(candidate)
        packet.nativePlan = null
      })
      outputs = null // The candidate now owns every unclaimed destination.
      return result
    } catch (error) {
      failure = error
      if (error.status === 9) {
        error.requests = abi.getRequests()
        error.modelRevision = packet && packet.updateState.modelRevision
      }
      throw error
    } finally {
      try { if (packet) abi.discardMeshPlan(packet.nativePlan) }
      finally {
        if (native) native.finish()
        if (credit) credit.release()
        if (outputs) outputs.release()
        if (copies) copies.release()
        if (failure && failure.status === 9) failure.capacityRevision = capacityRefusalRevision(this.ledger,before)
      }
    }
  }

  reserveNativeWork(owner, bytes, acquire = () => this.ledger.reserve(owner, bytes)) {
    const lease = acquire()
    // Direct-Wasm admission remains synchronous when capacity is available.
    // Only a refused producer needs to await another owner's real refund.
    return lease || Promise.resolve(this.ledger.reclamation.pending).then(acquire)
  }

  async admitProduction(packet, copyBytes, reserve, select, refine, stage) {
    let outputs
    const targetDraws = packet.draws
    const preparation = this.prepareOutputs && this.prepareOutputs(packet)
    let transferred = false, shortfall = Infinity
    try {
      const tryReserve = async (value, withBoundary = true) => {
        outputs = undefined
        const boundary = withBoundary ? stage : null
        // All CBDAM draws share one immutable strip. Price its GPU destination
        // with the first copied frame, before geometry can consume its space.
        value.indexBytes = this.indices ? 0 : indexPayloadBytes(value.draws)
        const plan = value.nativePlan
        // A full candidate borrows cached targets which a smaller group may
        // release again. Native feasibility belongs to each selected cut;
        // rejecting the full candidate before group selection loses that path.
        if (plan.residentBytes + plan.additionalBytes - plan.reclaimableBytes > plan.maximumBytes) return null
        const bytes = plan.additionalBytes + copyBytes(value)
        if (preparation) {
          outputs = await preparation.admit(value, bytes, boundary)
          if (!outputs && preparation.capacityShortfallBytes > 0)
            shortfall = Math.min(shortfall, preparation.capacityShortfallBytes)
          return outputs && outputs.credit
        }
        const peak = Math.max(bytes, boundary ? boundary.bytes : 0)
        const acquire = this.reserveOutputs ? () => {
          outputs = this.reserveOutputs(value, peak)
          return outputs && outputs.credit
        } : undefined
        const credit = await reserve(peak, acquire)
        if (credit && boundary && boundary.bytes) {
          try {
            await runCreditStage(credit, 'terrain-boundary-work', boundary.bytes, boundary.run)
            credit.split(credit.bytes - bytes).release()
          } catch (error) {
            credit.release()
            if (outputs) outputs.release()
            throw error
          }
        }
        return credit
      }
      const canMix = this.presented && this.presented.frame.coverageComplete !== false &&
        packet.frame && packet.frame.coverageComplete && !packet.frame.omittedDrawCount && packet.replacementPlan
      let groups, proof
      const refineGroups = async () => {
        if (packet.replacementPlan.atomic) {
          invariant(typeof refine === 'function', 'Partial production requires boundary refinement')
          packet.replacementPlan = await refine()
          invariant(packet.replacementPlan && !packet.replacementPlan.atomic,
            'Partial production requires a native boundary proof')
        }
        proof = packet.replacementPlan
        groups = changedReplacementGroups(proof, this.presented.draws, packet.draws)
      }
      const tryGroups = async indices => {
        const mixed = await select(indices)
        mixed.replacementPlan = selectReplacementGroups(proof, indices)
        const credit = await tryReserve(mixed)
        return credit ? {packet: mixed, credit, outputs} : null
      }
      // A GPU upload window limits work per resource turn, not the size of a
      // funded terrain target. Re-selecting the whole cut for every upload
      // window repeats boundary/imagery preparation and blocks model progress.
      // Admit the complete target first; actual capacity refusal, rather than
      // a preferred upload quantum, is what requires a smaller boundary group.
      let credit = await tryReserve(packet)
      // A complete successor can publish atomically without a seam-group
      // proof. If that optional workspace cannot fit, still price the actual
      // full production path. Its old display and every new destination stay
      // charged. A later candidate refusal must acquire a real proof before
      // selecting any partial group, or discard this private successor.
      if (!credit && canMix && stage && stage.bytes && packet.replacementPlan.atomic)
        credit = await tryReserve(packet, false)
      if (credit) { transferred = true; return {packet, credit, outputs} }
      if (canMix) {
        if (!groups) await refineGroups()
        for (const {index} of groups) {
          const admitted = await tryGroups([index])
          if (admitted) { transferred = true; return admitted }
        }
      }
      throw Object.assign(new Error('Mesh production capacity is occupied'),
        {status: 9, capacityRevision: this.ledger.availabilityRevision,
          capacityShortfallBytes: Number.isFinite(shortfall) ? shortfall : 0})
    } catch (error) {
      if (error.status === 9) error.capacitySelectedBytes = meshCutBytes(targetDraws)
      throw error
    } finally { if (preparation && !transferred) preparation.release() }
  }

  async describe(abi, threshold, budget) {
    invariant(!this.candidate, 'A mesh frame is awaiting presentation')
    return this.describePacket(abi, await abi.prepareMeshFrame(threshold, budget))
  }

  describePacket(abi, packet) {
    if (this.presented) packet.replacementPlan = identityReplacementPlan(this.presented.draws, packet.draws) ||
      abi.reuseReplacementPlan(packet.nativePlan, surfaceIds(this.presented.draws)) ||
      atomicReplacementPlan(this.presented.draws, packet.draws)
    return packet
  }

  reserve(bytes) {
    const lease = this.ledger.reserve(this.owner, bytes)
    if (!lease) throw Object.assign(new Error('Mesh payload capacity is occupied'), {status: 9})
    return lease
  }

  missing(draws) {
    return Array.from(new Map(draws.filter(draw => !this.resources.has(draw.resourceId))
      .map(draw => [draw.resourceId, draw])).values())
  }

  present(sequence) {
    if (!this.candidate || this.candidate.frame.sequence !== sequence) return false
    if (this.candidate.outputs) {
      const outputs = this.candidate.outputs
      if (outputs.presented) outputs.presented()
      else outputs.release()
    }
    this.presented = this.candidate
    this.candidate = null
    this.prune()
    return true
  }

  prepareRetention(sequence, draws) {
    const candidate = this.candidate, previous = this.presented
    invariant(candidate && candidate.frame.sequence === sequence && Array.isArray(draws),
      'Stale mesh retention')
    const resources = new Map()
    draws.forEach(draw => {
      const id = draw.resourceId
      const resource = candidate.resources.get(id) || previous && previous.resources.get(id)
      invariant(resource, 'Retained mesh has no presentation owner')
      resources.set(id, resource)
    })
    return {candidate, surface: Object.assign({}, candidate, {
      draws: draws.slice(), meshIdentity: surfaceIds(draws).join(','), resources, additions: [], partial: true})}
  }

  commitRetention(prepared) {
    invariant(this.candidate === prepared.candidate, 'Stale mesh retention')
    const surface = prepared.surface
    if (this.presented) this.presented.resources.forEach((resource, id) => {
      if (!surface.resources.has(id)) {
        this.retiredBytes += resource.positions.byteLength + resource.textureUv.byteLength
        ++this.retiredCount
      }
    })
    // The exact mixed cut owns old and new resources. Keep immutable jobs' maps
    // intact; a later candidate can be discarded without losing this display.
    this.presented = surface
    this.prune()
  }

  prepare(packet) {
    invariant(!this.candidate, 'A mesh frame is awaiting presentation')
    if (packet.outputs && !packet.outputs.valid())
      throw Object.assign(new Error('Mesh destination changed during production'), {status: 9})
    const indices = this.indices || packet.indices
    invariant(indices, 'Mesh frame indices are unavailable')
    const required = new Set(packet.draws.map(draw => draw.resourceId)), additions = new Map()
    packet.additions.forEach(resource => {
      const id = resource.resourceId
      invariant(Number.isInteger(id) && id > 0 && id <= 0xffffffff &&
        required.has(id) && !this.resources.has(id) && !additions.has(id),
      'Mesh additions must be new resources required by the candidate')
      invariant(resource.positions instanceof Float32Array &&
        resource.textureUv instanceof Float32Array && resource.positions.length > 0 &&
        resource.positions.length % 3 === 0 && resource.textureUv.length * 3 === resource.positions.length * 2,
      'Mesh resource arrays are invalid')
      invariant(resource.ownership, 'Mesh payload must be owned before adoption')
      additions.set(id, resource)
    })
    const resources = new Map(packet.draws.map(draw => {
      textureResourceKey(draw)
      const resource = this.resources.get(draw.resourceId) || additions.get(draw.resourceId)
      invariant(resource, 'Mesh frame resource is unavailable')
      invariant(resource.textureResourceId === draw.textureResourceId && resource.positions.length === draw.vertexCount * 3,
        'Mesh payload differs from the candidate')
      return [draw.resourceId, resource]
    }))
    // Validation and copying must finish before any owner changes. A failed
    // read/transfer cannot replace displayed content or retain partial additions.
    const candidate = Object.assign({}, packet, {resources, indices, meshIdentity: surfaceIds(packet.draws).join(',')})
    return candidate
  }

  publish(candidate, publish = () => {}) {
    invariant(!this.candidate, 'A mesh frame is awaiting presentation')
    if (candidate.outputs && !candidate.outputs.valid())
      throw Object.assign(new Error('Mesh destination changed during publication'), {status:9})
    publish(candidate)
    candidate.additions.forEach(resource => this.resources.set(resource.resourceId, resource))
    this.copiedBytes += candidate.copiedBytes || 0
    if (this.indices !== candidate.indices) {
      const release = this.indexHold
      this.indexHold = holdIndices(candidate.indices)
      if (release) release()
    }
    // Empty incomplete cuts must not cache an empty strip for a later model.
    this.indices = candidate.indices.length ? candidate.indices : null
    this.candidate = candidate
    const measurements=candidate.measurements
    onMeasurementsReleased(measurements,()=>{
      for(const frame of [candidate,this.candidate,this.presented])if(frame&&frame.measurements===measurements)frame.measurements=[]
      this.syncMeasurementLoans()
    })
    this.syncMeasurementLoans()
    return this.candidate
  }

  adopt(packet, publish = () => {}) { return this.publish(this.prepare(packet), publish) }

  discard(sequence) {
    if (!this.candidate || this.candidate.frame.sequence !== sequence) return false
    const cleanup=new Cleanup(),candidate=this.candidate
    this.candidate = null
    if(candidate.outputs)cleanup.run(()=>candidate.outputs.release())
    cleanup.run(()=>this.prune());cleanup.finish()
    return true
  }

  prune() {
    this.syncMeasurementLoans()
    const cleanup=new Cleanup()
    const keep = new Set()
    ;[this.candidate, this.presented].forEach(frame => {
      if (frame) frame.draws.forEach(draw => keep.add(draw.resourceId))
    })
    this.resources.forEach((resource, id) => {
      if (!keep.has(id)) {
        this.resources.delete(id)
        cleanup.run(()=>resource.ownership.retire())
      }
    })
    cleanup.finish()
  }

  syncMeasurementLoans() {
    const frames=this
    function* values(){for(const frame of [frames.candidate,frames.presented])if(frame&&frame.measurements)yield* frame.measurements}
    this.measurementLoans.replace(values())
  }

  clear() {
    const cleanup=new Cleanup(),production=this.productionTask,replacement=this.replacementTask,indexHold=this.indexHold,
      frames=[this.candidate,this.presented],resources=Array.from(this.resources.values())
    this.productionTask = null
    this.replacementTask = null
    this.resources.clear()
    // Retired GPU/jobs can still own the old pool. New terrain generations must
    // not acquire a same-numbered UV identity from that source.
    this.textureResources = new Map()
    this.indices = null
    this.indexHold = null
    this.candidate = null
    this.presented = null
    this.measurementLoans.clear()
    if(production)cleanup.run(()=>production.cancel())
    if(replacement)cleanup.run(()=>replacement.cancel())
    for(const frame of frames)if(frame&&frame.outputs)cleanup.run(()=>frame.outputs.release())
    for(const resource of resources)cleanup.run(()=>resource.ownership.retire())
    if(indexHold)cleanup.run(indexHold)
    cleanup.finish()
  }
}

module.exports = { MeshFrames }
