const {invariant} = require('../core/terra_globe_common')
const {ResourceWaitQueue} = require('./resource_wait_queue')

// One credit per synchronous native production/RPC. Cancellation is not a
// receipt: retain every issued credit until completion or producer termination.
class NativePayloadBudget {
  constructor(ledger, owner, bytes = 0, provider = null) {
    this.ledger = ledger
    this.owner = owner
    this.actual = bytes
    this.credits = new Set()
    this.queue = new ResourceWaitQueue()
    this.resident = ledger.reserve(this.owner, bytes)
    if (!this.resident) throw Object.assign(new Error('Native payload capacity is occupied'), {status: 9})
    this.resident.mark('resident')
    this.unsubscribe = ledger.subscribe(() => this.queue.wake())
    this.unregister = provider && ledger.reclamation.register({
      owner,
      revision: provider.revision,
      reclaim: needed => this.resident && this.actual ? provider.trim(needed) : 0,
      failed: provider.failed
    })
  }

  begin(bytes, reset = false, refusal = null) {
    if (!this.resident || this.retiring) throw Object.assign(new Error('Native payload producer is closed'), {name: 'AbortError'})
    if (this.ledger.maximumBytes && bytes > this.ledger.maximumBytes)
      throw Object.assign(new Error('Native payload exceeds the shared resource limit'), {status: 9})
    let credit
    if (reset) {
      // Native manifest reset releases all decoded records before producing its
      // zero input. Transfer only settled ownership, never another RPC's credit.
      // The ledger protects the source and transfers atomically on admission;
      // old payload remains charged until the reset's actual ownership receipt.
      this.resident.mark('reserved')
      try {
        credit = this.ledger.reserve(this.owner, bytes, [], [],
          [{lease: this.resident, bytes: Math.min(bytes, this.resident.bytes)}])
      } finally { this.resident.mark('resident') }
    } else credit = this.ledger.reserve(this.owner, bytes, [], [], [], refusal)
    if (credit) this.credits.add(credit)
    return credit
  }

  // A joint mesh transaction can prepay this producer alongside host/GPU
  // outputs. Adopting its grant must not compete for the same capacity again.
  adopt(credit) {
    invariant(this.resident && !this.retiring && credit && this.ledger.leases.has(credit) &&
      credit.owner === this.owner && credit.phase === 'reserved' && !this.credits.has(credit),
    'Native payload production is not credited')
    this.credits.add(credit)
    return credit
  }

  beginPreferred(bytes, preferred, refusal = null) {
    // A preferred batch uses only immediately available room. It must not
    // evict extra resources or reject a minimum allocation that would fit.
    return preferred > bytes && (!this.ledger.maximumBytes || this.ledger.bytes + preferred <= this.ledger.maximumBytes)
      ? this.begin(preferred, false, refusal) : this.begin(bytes, false, refusal)
  }

  execute(credit, produce) {
    try {
      if (!this.resident || this.retiring || !this.credits.has(credit))
        throw Object.assign(new Error('Native payload producer is closed'), {name: 'AbortError'})
      const result = produce(credit.bytes)
      if (result && typeof result.then === 'function') return result.finally(() => this.finish(credit))
      this.finish(credit)
      return result
    } catch (error) { this.finish(credit); throw error }
  }

  // A terrain producer cannot wait indefinitely while it owns the selection
  // needed for coarsening. Await one real reclamation attempt, then report
  // capacity refusal so the caller can discard its cursor and recover.
  async tryRun(bytes, produce, preferred = bytes) {
    const refusal = {}
    let credit = this.beginPreferred(bytes, preferred, refusal)
    if (!credit) { await this.ledger.reclamation.pending; credit = this.beginPreferred(bytes, preferred, refusal) }
    if (!credit) throw Object.assign(new Error('Native payload capacity is occupied'),
      {status: 9, capacityShortfallBytes: refusal.shortfallBytes})
    return this.execute(credit, produce)
  }

  runReset(bytes, produce) { return this.run(bytes, produce, true) }

  run(bytes, produce, reset = false) {
    const credit = this.begin(bytes, reset)
    if (credit) return this.execute(credit, produce)
    const waiting = this.queue.wait(() => this.begin(bytes, reset))
    const promise = waiting.promise.then(credit => this.execute(credit, produce))
    promise.cancel = waiting.cancel
    return promise
  }

  observe(bytes) {
    const funded = this.resident && this.resident.bytes +
      Array.from(this.credits).reduce((sum, credit) => sum + credit.bytes, 0)
    if (!this.resident || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > funded)
      throw new Error('Native payload allocation exceeded its credit: ' + this.owner +
        ' reported=' + bytes + ' funded=' + funded)
    this.actual = bytes
    if (bytes < this.resident.bytes) this.resident.resize(bytes)
  }

  finish(credit) {
    if (this.retiring) return
    if (!this.credits.delete(credit)) return
    this.resident.merge(credit)
    // Other issued operations can already be represented by this receipt.
    // Their credit remains held until their own terminal reply.
    if (this.actual < this.resident.bytes) this.resident.resize(this.actual)
    // An equal-size reset returns reusable resident ownership without freeing
    // ledger bytes. That is still an admission event for a subsequent reset.
    this.queue.wake()
  }

  retire() {
    this.retiring = true
    if (this.unregister) this.unregister()
    if (this.unsubscribe) this.unsubscribe()
    this.unregister = this.unsubscribe = null
    this.queue.wake()
  }

  stats() { return {residentBytes: this.actual, creditedBytes: (this.resident ? this.resident.bytes : 0) +
    Array.from(this.credits).reduce((n, c) => n + c.bytes, 0), waiting: this.queue.pending.length} }

  close() {
    if (this.unregister) this.unregister()
    if (this.unsubscribe) this.unsubscribe()
    this.unregister = this.unsubscribe = null
    this.credits.forEach(credit => credit.release())
    this.credits.clear()
    if (this.resident) this.resident.release()
    this.resident = null; this.actual = 0
    this.queue.wake()
  }
}

module.exports = {NativePayloadBudget}
