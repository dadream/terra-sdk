// Unstarted destinations belong to the group, not the request queue. Once a
// producer takes a reservation, only its actual completion may release it.
class ImageryGroupAdmission {
  constructor(cache) {
    this.cache = cache
    this.pending = new Map()
  }

  destinations(children, bytes, failed) {
    const requests = []
    let missing = false
    for (const [key] of children) {
      if (failed.has(key)) continue
      const entry = this.cache.entries.get(key) || this.cache.reservations.get(key)
      missing = missing || !entry
      requests.push([key, entry ? entry.byteSize : bytes])
    }
    return {requests, missing}
  }

  // Necessary image capacity only: no credit, eviction, UV preparation or
  // producer state. Shared-budget and complete output admission still follow.
  canFitImages(children, bytes, failed, maximumBytes) {
    const {requests, missing} = this.destinations(children, bytes, failed)
    return !missing || Boolean(this.cache.planBatch(requests, 0, [], {maximumBytes}))
  }

  admit(children, bytes, failed, workspace, workspaceBytes = 0, outputs = null, retainedWorkspaceBytes = workspaceBytes, grants = []) {
    this.refusal = {}
    const {requests, missing} = this.destinations(children, bytes, failed)
    if (!requests.length && !outputs && !workspace) return true
    const producerBytes = workspace ? Math.max(0, workspaceBytes - workspace.bytes) : 0
    if (!missing && !producerBytes && !outputs) return true
    const outputBytes = outputs ? outputs.bytes : 0
    this.cache.ledger.size(outputBytes)
    const reserve = funding => this.cache.reserveBatch(requests, producerBytes + outputBytes,
      workspace ? workspace.owner : this.cache.owner, outputs ? outputs.keep : [], funding.concat(grants), this.refusal)
    const batch = workspace ? workspace.fund(Math.max(workspaceBytes, retainedWorkspaceBytes), reserve) : reserve([])
    if (!batch) return false
    for (const [key] of requests) {
      const reservation = batch.take(key)
      if (reservation) this.pending.set(key, reservation)
    }
    batch.release()
    if (outputs) outputs.accept(batch.credit.split(outputBytes))
    if (workspace) workspace.accept(batch.credit)
    else batch.credit.release()
    return true
  }

  take(key) {
    const reservation = this.pending.get(key)
    this.pending.delete(key)
    return reservation
  }

  retain(wanted, queued) {
    for (const [key, reservation] of this.pending) {
      if (wanted.has(key)) continue
      queued.delete(key)
      reservation.cancel()
      this.pending.delete(key)
    }
  }
}

module.exports = { ImageryGroupAdmission }
