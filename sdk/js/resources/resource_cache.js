// Cache admission owns a reservation before a producer starts allocating. A
// reservation is not resident content and cannot be used for presentation.
// Cancellation, source replacement and failed allocation release it exactly once.
const { ResourceLedger } = require('./resource_ledger')
const {Cleanup} = require('../runtime/cleanup')
class ResourceCache {
  constructor(options = {}) {
    this.maximumEntries = options.maximumEntries || 0
    this.softEntryLimit = options.softEntryLimit === true
    this.maximumBytes = options.maximumBytes || 0
    this.dispose = options.dispose || (() => {})
    this.canEvict = options.canEvict || (() => true)
    this.entries = new Map()
    this.reservations = new Map()
    this.retained = new Set()
    this.bytes = 0
    this.reservedBytes = 0
    this.revision = 0
    this.contentRevision = 0
    this.highWaterBytes = 0
    this.ledger = options.ledger || new ResourceLedger()
    this.owner = options.owner || 'cache'
  }

  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return null
    this.entries.delete(key)
    this.entries.set(key, entry)
    entry.lease.touch()
    return entry.value
  }

  has(key) { return this.entries.has(key) }

  resize(key, byteSize, expected = this.entries.get(key)) {
    const entry = this.entries.get(key), size = this.size(byteSize)
    if (!entry || entry !== expected) return false
    if (size === entry.byteSize) return true
    const victims = size < entry.byteSize ? [] : this.makeRoom(key, this.bytes + this.reservedBytes + size - entry.byteSize,
      this.entries.size + this.retained.size + this.reservations.size)
    if (!victims || !entry.lease.resize(size, victims)) return false
    this.bytes += size - entry.byteSize
    entry.byteSize = size
    this.changed()
    return true
  }

  size(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Resource byte size must be a nonnegative safe integer')
    return value
  }

  within(bytes, entries, admission = false, maximumBytes = this.maximumBytes) {
    return (maximumBytes <= 0 || bytes <= maximumBytes) &&
      (admission && this.softEntryLimit || this.maximumEntries <= 0 || entries <= this.maximumEntries)
  }

  // Select all victims before mutating the cache. Rejected admission cannot
  // evict a partial set or take memory from a submitted/pinned resource.
  makeRoom(key, bytes, entries, protectedKeys = new Set(), admission = {}) {
    const victims = []
    for (const [candidate, entry] of this.entries) {
      if (this.within(bytes, entries, true, admission.maximumBytes)) break
      if (candidate === key || protectedKeys.has(candidate) || entry.holds || !this.canEvict(candidate, entry.value)) continue
      victims.push(candidate); bytes -= entry.byteSize; --entries
    }
    if (!this.within(bytes, entries, true, admission.maximumBytes))
      return this.roomFailure(bytes, entries, admission.refusal, admission.maximumBytes)
    return victims.map(candidate => this.entries.get(candidate).lease)
  }

  roomFailure(bytes, entries, refusal, maximumBytes = this.maximumBytes) {
    if (refusal) Object.assign(refusal, {reason:'cache-budget', owner:this.owner,
      shortfallBytes:maximumBytes > 0 ? Math.max(0, bytes - maximumBytes) : 0,
      shortfallEntries:!this.softEntryLimit && this.maximumEntries > 0 ? Math.max(0, entries - this.maximumEntries) : 0})
    return false
  }

  changed() {
    ++this.revision
    this.highWaterBytes = Math.max(this.highWaterBytes, this.bytes + this.reservedBytes)
  }

  reserve(key, byteSize, funding = []) {
    const size = this.size(byteSize)
    if (this.reservations.has(key)) return null
    const victims = this.makeRoom(key, this.bytes + this.reservedBytes + size,
      this.entries.size + this.retained.size + this.reservations.size + 1)
    if (!victims) return null
    const old = this.entries.get(key), keep = old ? [old.lease] : []
    const lease = this.ledger.reserve(this.owner, size, victims, keep, funding)
    if (!lease) return null
    return this.adoptReservation(key, lease, keep)
  }

  planBatch(requests, producerBytes, keep = [], admission = {}) {
    this.size(producerBytes)
    if (admission.maximumBytes !== undefined) this.size(admission.maximumBytes)
    const wanted = new Map(), existing = new Map(), producing = new Map()
    for (const [key, bytes] of requests) {
      const size = this.size(bytes), entry = this.entries.get(key)
      const reservation = this.reservations.get(key)
      if (reservation) {
        // Replacing a mutable cached value is not an immutable destination.
        if (entry) return null
        if (reservation.byteSize !== size) throw new Error('Immutable destination size changed')
        producing.set(key, reservation)
      } else if (entry) {
        if (entry.byteSize !== size) throw new Error('Immutable destination size changed')
        existing.set(key, entry)
      } else wanted.set(key, size)
    }
    const total = Array.from(wanted.values()).reduce((n, size) => n + size, 0)
    const victims = this.makeRoom(null, this.bytes + this.reservedBytes + total,
      this.entries.size + this.retained.size + this.reservations.size + wanted.size, new Set(existing.keys()), admission)
    if (!victims) return null
    return {wanted, existing, producing, bytes: producerBytes + total, victims,
      keep: Array.from(existing.values(), entry => entry.lease)
        .concat(Array.from(producing.values(), reservation => reservation.lease), keep)}
  }

  // A lower-bound check starts neither production nor eviction. Existing and
  // in-flight destinations have exactly the same ownership rules as reserve.
  canReserveBatch(requests, producerBytes, keep = []) {
    const plan = this.planBatch(requests, producerBytes, keep)
    return Boolean(plan && this.ledger.canReserve(plan.bytes, plan.victims, plan.keep))
  }

  // One producer must be able to finish every destination in its replacement
  // group. Immutable cached or already-producing destinations are borrowed
  // until the receiver pins them. Borrowing neither starts a second producer
  // nor cancels the original producer when this group is abandoned.
  reserveBatch(requests, producerBytes, producerOwner, keep = [], funding = [], refusal = null, admission = {}) {
    const plan = this.planBatch(requests, producerBytes, keep, Object.assign({}, admission, {refusal}))
    if (!plan) return null
    const {wanted, existing, producing} = plan
    const credit = this.ledger.reserve(producerOwner, plan.bytes, plan.victims, plan.keep, funding, refusal)
    if (!credit) return null
    const borrowed = this.borrowBatch(new Map([...existing, ...producing].map(([key, entry]) => [key, entry.byteSize])))
    if (!borrowed) { credit.release(); return null }
    const pending = new Map()
    wanted.forEach((size, key) => pending.set(key,
      this.adoptReservation(key, credit.split(size, 'reserved', this.owner), [])))
    let closed = false
    return {
      credit,
      valid: () => !closed && borrowed.valid() &&
        Array.from(pending.values()).every(reservation => reservation.valid()),
      take: key => { const value = pending.get(key); pending.delete(key); return value },
      release: () => {
        if (closed) return
        closed = true
        pending.forEach(reservation => reservation.cancel()); pending.clear()
        borrowed.release()
        existing.clear()
      }
    }
  }

  // Borrow only paid destinations. A producer cancellation, replacement or
  // changed size invalidates the quote; successful completion transfers the
  // loan to its resident entry. No allocation or second producer is started.
  borrowBatch(requests) {
    const existing = new Map(), producing = [], releases = [], pendingKeys = new Set()
    let closed = false, transferred = false
    const release = () => {
      if (closed) return
      closed = true
      const cleanup = new Cleanup()
      for (const close of releases.splice(0)) cleanup.run(close)
      existing.clear(); producing.length = 0; pendingKeys.clear()
      cleanup.finish()
    }
    try {
      for (const [key, bytes] of requests) {
        const entry = this.entries.get(key), pending = this.reservations.get(key)
        if (entry && entry.byteSize === bytes) {
          existing.set(key, entry); releases.push(this.retain(key))
        } else if (!entry && pending && pending.byteSize === bytes) {
          const loan = this.borrowReservation(key, pending)
          producing.push(loan); releases.push(() => loan.release()); pendingKeys.add(key)
        } else return null
      }
      transferred = true
      return {pendingKeys, valid: () => !closed &&
        Array.from(existing).every(([key, entry]) => this.entries.get(key) === entry) &&
        producing.every(loan => loan.valid()), release}
    } finally { if (!transferred) release() }
  }

  borrowReservation(key, reservation) {
    const size = reservation.byteSize, borrower = {release: null}
    reservation.borrowers.add(borrower)
    let held = true
    return {
      valid: () => held && (reservation.entry
        ? this.entries.get(key) === reservation.entry && reservation.entry.byteSize === size
        : this.reservations.get(key) === reservation && reservation.byteSize === size),
      release: () => {
        if (!held) return
        held = false
        reservation.borrowers.delete(borrower)
        if (borrower.release) borrower.release()
      }
    }
  }

  adoptReservation(key, lease, keep) {
    const size = lease.bytes
    const reservation = {byteSize: size, lease, borrowers: new Set()}
    this.reservations.set(key, reservation)
    this.reservedBytes += size
    this.changed()
    const current = () => this.reservations.get(key) === reservation
    const cancel = (release = true) => {
      if (!current()) return false
      this.reservations.delete(key)
      this.reservedBytes -= reservation.byteSize
      if (release) lease.release()
      this.changed()
      return true
    }
    return {
      lease,
      valid: current,
      resize: bytes => {
        const next = this.size(bytes)
        if (!current()) return false
        const victims = next <= reservation.byteSize ? [] : this.makeRoom(key,
          this.bytes + this.reservedBytes - reservation.byteSize + next,
          this.entries.size + this.retained.size + this.reservations.size)
        if (!victims || !lease.resize(next, victims, keep)) return false
        this.reservedBytes += next - reservation.byteSize
        reservation.byteSize = next
        this.changed()
        return true
      },
      commit: value => {
        if (!current()) return false
        // Previously owned content stays charged until its replacement exists.
        this.delete(key)
        this.insert(key, value, reservation.byteSize, lease)
        reservation.entry = this.entries.get(key)
        reservation.borrowers.forEach(borrower => { borrower.release = this.retain(key) })
        this.bytes += reservation.byteSize
        lease.mark('resident')
        cancel(false)
        if (this.softEntryLimit) this.evict()
        return true
      },
      cancel: () => cancel()
    }
  }

  trySet(key, value, byteSize) {
    const reservation = this.reserve(key, byteSize)
    return Boolean(reservation && reservation.commit(value))
  }

  // Synchronous record caches may insert then evict. Allocation-producing
  // owners use reserve instead, including all managed renderer resources.
  set(key, value, byteSize) {
    const size = this.size(byteSize)
    if (this.reservations.has(key)) throw new Error('Resource key is reserved')
    const previous = this.entries.get(key)
    const lease = this.ledger.reserve(this.owner, size, [], previous ? [previous.lease] : [])
    if (!lease) return value
    this.delete(key)
    this.insert(key, value, size, lease)
    lease.mark('resident')
    this.bytes += size
    this.changed()
    this.evict()
    return value
  }

  insert(key, value, byteSize, lease) {
    const entry = {value, byteSize, lease}
    this.entries.set(key, entry)
    ++this.contentRevision
    lease.reclaimable = () => this.entries.get(key) === entry && !entry.holds && this.canEvict(key, value)
    lease.reclaim = () => this.delete(key)
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    ++this.contentRevision
    if (entry.holds) { this.retained.add(entry); entry.lease.mark('retired') }
    else { this.bytes -= entry.byteSize; this.dispose(entry.value); entry.lease.release() }
    this.changed()
    return true
  }

  // Work already using an entry owns its bytes even after a source/reset
  // removes the key. Release disposes retired content exactly once.
  retain(key) {
    const entry = this.entries.get(key)
    if (!entry) return null
    entry.holds = (entry.holds || 0) + 1
    let held = true
    return () => {
      if (!held) return
      held = false
      if (--entry.holds === 0) {
        if (this.retained.delete(entry)) {
          this.bytes -= entry.byteSize
          this.dispose(entry.value)
          entry.lease.release()
        } else if (entry.lease.reclaimable()) {
          // The last reader only adds capacity if the live entry can now be
          // evicted. Display/demand pins may still protect it. Treating such
          // a loan return as a refund repeatedly restarts refused producers.
          this.ledger.available()
        }
        this.changed()
      }
    }
  }

  clear(options = {}) {
    if (!options.retainReservations) {
      this.reservations.forEach(reservation => reservation.lease.release())
      this.reservations.clear()
      this.reservedBytes = 0
    }
    for (const key of this.entries.keys()) this.delete(key)
    this.changed()
  }

  values() { return Array.from(this.entries.values(), entry => entry.value) }

  stats() {
    return {entries: this.entries.size, retainedEntries: this.retained.size, bytes: this.bytes,
      reservedEntries: this.reservations.size, reservedBytes: this.reservedBytes,
      highWaterBytes: this.highWaterBytes}
  }

  evict() {
    for (const [key, entry] of this.entries) {
      if (this.within(this.bytes + this.reservedBytes, this.entries.size + this.retained.size + this.reservations.size)) break
      if (!entry.holds && this.canEvict(key, entry.value)) this.delete(key)
    }
  }
}

module.exports = { ResourceCache }
