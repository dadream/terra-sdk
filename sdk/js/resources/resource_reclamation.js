// Asynchronous owners cannot promise memory to a synchronous admission. Pressure
// requests coalesce here; only the owner's actual receipt may refund its lease.
class ResourceReclamation {
  constructor(completed = () => {}) {
    this.completed = completed
    this.owners = new Set()
    this.requestedBytes = 0
    this.pending = null
    this.attempts = 0
    this.failures = 0
    this.reclaimedBytes = 0
  }

  register(provider) {
    const owner = {provider, exhaustedRevision: null, stats: {owner:provider.owner || 'unnamed',
      attempts:0, failures:0, reclaimedBytes:0, emptyReceipts:0, lastRequestedBytes:0, lastReleasedBytes:0}}
    this.owners.add(owner)
    return () => this.owners.delete(owner)
  }

  request(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid reclamation pressure')
    if (!this.owners.size || !bytes) return this.pending || Promise.resolve()
    this.requestedBytes = Math.max(this.requestedBytes, bytes)
    if (this.pending) return this.pending
    if (!Array.from(this.owners).some(owner => owner.provider.revision() !== owner.exhaustedRevision)) {
      this.requestedBytes = 0
      return Promise.resolve()
    }
    this.pending = Promise.resolve().then(async () => {
      try {
        while (this.requestedBytes) {
          let requested = this.requestedBytes
          this.requestedBytes = 0
          for (const owner of Array.from(this.owners)) {
            if (!this.owners.has(owner)) continue
            const {provider} = owner, revision = provider.revision()
            if (!requested) break
            // Successful partial trims leave more idle cache for later pressure.
            // A no-op receipt cannot create another reclamation epoch.
            if (revision === owner.exhaustedRevision) continue
            // Continue across requests instead of repeatedly trimming the
            // first productive cache. Tiny grants must not starve older mesh,
            // record or height caches behind a regenerating projection cache.
            // Rotate before awaiting so unregistering a provider cannot revive it.
            this.owners.delete(owner); this.owners.add(owner)
            ++this.attempts
            ++owner.stats.attempts; owner.stats.lastRequestedBytes = requested
            owner.stats.lastReleasedBytes = 0
            try {
              const released = await provider.reclaim(requested)
              if (!Number.isSafeInteger(released) || released < 0) throw new Error('Invalid reclamation receipt')
              this.reclaimedBytes += released
              owner.stats.reclaimedBytes += released; owner.stats.lastReleasedBytes = released
              if (!released) ++owner.stats.emptyReceipts
              requested = Math.max(0, requested - released)
              this.requestedBytes = Math.max(0, this.requestedBytes - released)
              if (!released) owner.exhaustedRevision = revision
            } catch (error) {
              owner.exhaustedRevision = revision
              ++this.failures
              ++owner.stats.failures
              if (provider.failed) provider.failed(error)
            }
          }
        }
      } finally {
        // Clear before resolving: a later request must not join a completed
        // task and leave its pressure stranded between promise microtasks.
        this.pending = null
        this.completed()
      }
    })
    // A rejected admission may have no asynchronous caller. Keep diagnostics
    // and teardown safe even if the failure observer itself throws.
    this.pending.catch(() => {})
    return this.pending
  }

  stats() {
    return {pending: Boolean(this.pending), requestedBytes: this.requestedBytes,
      attempts: this.attempts, failures: this.failures, reclaimedBytes: this.reclaimedBytes, owners: this.owners.size,
      providers: Array.from(this.owners, owner => ({...owner.stats}))}
  }
}

module.exports = {ResourceReclamation}
