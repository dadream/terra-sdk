const {ResourceReclamation} = require('./resource_reclamation')

// Public runtime/standalone-renderer configuration is always bounded. The
// low-level ledger retains zero as an explicit unlimited test/host policy.
function finiteResourceLimit(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error('Managed resource limit must be a positive safe integer')
  return bytes
}

// Shared admission for explicitly owned allocations. This measures SDK payload
// ownership, not browser/process memory or GPU driver residency. Wasm heap and
// borrowed JS views must not be added here as if they were new allocations.
class ResourceLedger {
  constructor(maximumBytes = 0) {
    this.maximumBytes = this.size(maximumBytes)
    this.bytes = 0
    this.disposableBytes = 0
    this.highWaterBytes = 0
    this.revision = 0
    this.availabilityRevision = 0
    this.eligibilityRevision = 0
    this.clock = 0
    this.reclaimedBytes = 0
    this.dependentReclaimedBytes = 0
    this.leases = new Set()
    this.ownerTotals = Object.create(null)
    this.phaseTotals = {reserved: 0, resident: 0, retired: 0}
    this.listeners = new Set()
    // An unchanged memo -> work -> memo probe restores already reclaimable
    // capacity; it must not manufacture another producer retry epoch.
    this.memoClaims = new WeakMap()
    // Completion releases waiters, but a no-op receipt does not change which
    // payloads are eligible. Real refunds are accounted by their lease receipts.
    this.reclamation = new ResourceReclamation(() => this.available(true))
  }

  size(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid resource byte size')
    return bytes
  }

  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback) }
  available(refundOnly = false) {
    ++this.revision; ++this.availabilityRevision
    // A transaction may return only its own scratch credit. Eligibility and
    // limit changes remain meaningful even without a net payload reduction.
    if (!refundOnly) ++this.eligibilityRevision
    // Wake consumers after the whole cache/admission mutation. Synchronous
    // observers could otherwise allocate between eviction and reservation.
    if (this.notificationPending || !this.listeners.size) return
    this.notificationPending = true
    Promise.resolve().then(() => {
      this.notificationPending = false
      this.listeners.forEach(callback => callback())
    })
  }
  setLimit(bytes) {
    const before = this.maximumBytes
    this.maximumBytes = this.size(bytes)
    if (bytes !== before) this.available()
  }

  // The same victim plan serves feasibility checks and actual admission. A
  // check owns no credit and evicts nothing; asynchronous native owners may
  // refund real idle allocations before the caller checks again.
  canReserve(bytes, victims = [], keep = []) {
    return Boolean(this.planRoom(this.size(bytes), victims, keep))
  }

  // Restoring ownership links is not itself new capacity. A retired payload
  // becomes reclaimable only if every owner can reach a real eviction root.
  // Visit just this dependency graph; rootless cycles remain unavailable.
  canReclaim(target) {
    if (!this.leases.has(target)) return false
    const pending = [target], seen = new Set(), ready = new Set(), roots = []
    const dependents = new Map(), remaining = new Map()
    while (pending.length) {
      const lease = pending.pop()
      if (seen.has(lease)) continue
      seen.add(lease)
      if (lease.reclaimable && lease.reclaimable()) {
        ready.add(lease); roots.push(lease)
        continue
      }
      const owners = lease.reclaimWith && lease.reclaimWith()
      // Every owner on this reachable graph must be releasable. A pinned or
      // unbound leaf disproves the target immediately; unrelated siblings
      // cannot repair it. Rootless cycles still use the closure below.
      if (!owners || !owners.length) return false
      const unique = new Set(owners)
      if (Array.from(unique).some(owner => !this.leases.has(owner))) return false
      remaining.set(lease, unique.size)
      for (const owner of unique) {
        if (!dependents.has(owner)) dependents.set(owner, [])
        dependents.get(owner).push(lease)
        pending.push(owner)
      }
    }
    while (roots.length) {
      const lease = roots.pop()
      if (lease === target) return true
      for (const dependent of dependents.get(lease) || []) {
        const count = remaining.get(dependent) - 1
        remaining.set(dependent, count)
        if (!count && !ready.has(dependent)) {
          ready.add(dependent); roots.push(dependent)
        }
      }
    }
    return false
  }

  // Optional memo data is always immediately reclaimable, never borrowed or
  // transferred to a producer. Changing it cannot improve admission capacity:
  // the same bytes were already available through reclamation. Account it, but
  // do not wake refused producers when that memo is replaced or discarded.
  reserveDisposable(owner, bytes, reclaim) {
    bytes = this.size(bytes)
    if (typeof reclaim !== 'function') throw new Error('Disposable resource requires reclamation')
    if (this.reclaiming || this.maximumBytes && this.bytes + bytes > this.maximumBytes) return null
    const lease = this.create(owner, bytes, 'resident', true)
    Object.defineProperties(lease, {
      disposable: {value: true}, reclaimable: {value: () => true}, reclaim: {value: reclaim}
    })
    return lease
  }

  // A completed numerical workspace can become an optional memo without
  // double charging or an unowned interval. Callers must first remove every
  // payload reference/loan. The old handle is revoked, not lent to the memo.
  memoize(lease, owner, reclaim) {
    if (!this.leases.has(lease) || lease.disposable || lease.reclaimWith ||
        typeof reclaim !== 'function') throw new Error('Invalid memo handoff')
    const alreadyEligible = this.memoClaims.get(lease) === lease.bytes
    const memo = this.replaceLease(lease, owner, true)
    Object.defineProperties(memo, {disposable:{value:true},
      reclaimable:{value:()=>memo.active}, reclaim:{value:()=>{if(memo.active)reclaim()}}})
    if (!alreadyEligible) this.available()
    this.memoClaims.delete(lease)
    return memo
  }

  // Claim the SAME allocation before attaching live inputs or attempting
  // production. A tightened policy cannot turn an over-budget memo into work.
  claimMemo(lease, owner) {
    if (!this.leases.has(lease) || !lease.disposable) return null
    if (this.reclaiming || this.maximumBytes && this.bytes > this.maximumBytes) return null
    const claimed = this.replaceLease(lease, owner, false)
    this.memoClaims.set(claimed, claimed.bytes)
    return claimed
  }

  replaceLease(lease, owner, disposable) {
    if (!this.leases.has(lease)) throw new Error('Invalid lease handoff')
    const bytes = lease.bytes, phase = lease.phase
    const next = this.create(owner, 0, 'resident', disposable)
    this.account(lease.owner, phase, -bytes, -1)
    this.account(owner, 'resident', bytes)
    this.leases.delete(lease)
    this.disposableBytes -= lease.disposable ? bytes : 0
    this.disposableBytes += disposable ? bytes : 0
    lease.bytes = 0; next.bytes = bytes
    ++this.revision
    return next
  }

  planRoom(bytes, victims = [], keep = [], refusal = null) {
    if (keep.some(lease => lease.disposable)) throw new Error('Disposable resource cannot be protected')
    if (this.reclaiming) return null
    if (!victims.length && (!this.maximumBytes || this.bytes + bytes <= this.maximumBytes))
      return {selected: new Set(), released: new Set()}
    const selected = new Set(), released = new Set(), protectedLeases = new Set(keep)
    const dependents = new Map(), remaining = new Map()
    // A dependent allocation is refunded only after every declared owner will
    // be disposed. Unbound borrowers (display, queries, active work) prevent a
    // declaration. Build reverse edges once, rather than rescan all leases for
    // each possible victim. Cycles without a reclaimable root cannot self-fund.
    for (const lease of this.leases) {
      const owners = lease.reclaimWith && lease.reclaimWith()
      if (!owners || !owners.length) continue
      const unique = new Set(owners)
      if (Array.from(unique).some(owner => !this.leases.has(owner))) continue
      remaining.set(lease, unique.size)
      unique.forEach(owner => {
        if (!dependents.has(owner)) dependents.set(owner, [])
        dependents.get(owner).push(lease)
      })
    }
    let projected = this.bytes + bytes
    const select = root => {
      const pending = [root], added = [], decremented = []
      while (pending.length) {
        const lease = pending.pop()
        if (released.has(lease)) continue
        if (protectedLeases.has(lease)) {
          added.forEach(item => { released.delete(item); projected += item.bytes })
          decremented.forEach(item => remaining.set(item, remaining.get(item) + 1))
          return false
        }
        released.add(lease); added.push(lease); projected -= lease.bytes
        for (const dependent of dependents.get(lease) || []) {
          const count = remaining.get(dependent) - 1
          remaining.set(dependent, count); decremented.push(dependent)
          if (!count) pending.push(dependent)
        }
      }
      selected.add(root)
      return true
    }
    for (const lease of victims) {
      if (!this.leases.has(lease) || !lease.reclaimable || !lease.reclaimable()) return null
      if (!released.has(lease) && !select(lease)) return null
    }
    if (this.maximumBytes && projected > this.maximumBytes) {
      const candidates = Array.from(this.leases).filter(lease => !released.has(lease) &&
        !protectedLeases.has(lease) && lease.reclaimable && lease.reclaimable())
        .sort((a, b) => Number(!!b.disposable) - Number(!!a.disposable) || a.touched - b.touched)
      for (const lease of candidates) {
        if (!released.has(lease)) select(lease)
        if (projected <= this.maximumBytes) break
      }
    }
    if (this.maximumBytes && projected > this.maximumBytes) {
      if (refusal) Object.assign(refusal, {reason: 'shared-budget',
        shortfallBytes: projected - this.maximumBytes, requestedBytes: bytes})
      this.reclamation.request(projected - this.maximumBytes)
      return null
    }
    return {selected, released}
  }

  // Plan every victim before evicting anything. Failed admission is atomic,
  // including local-cache victims required independently of the shared limit.
  makeRoom(bytes, victims = [], keep = [], refusal = null) {
    if (this.reclaiming) return false
    if (!victims.length && (!this.maximumBytes || this.bytes + bytes <= this.maximumBytes)) return true
    const plan = this.planRoom(bytes, victims, keep, refusal)
    if (!plan) return false
    const {selected, released} = plan
    const before = this.bytes
    const dependentBytes = Array.from(released).reduce((n, lease) => n + (selected.has(lease) ? 0 : lease.bytes), 0)
    this.reclaiming = true
    try { selected.forEach(lease => { if (this.leases.has(lease)) lease.reclaim() }) }
    finally { this.reclaiming = false }
    if (Array.from(released).some(lease => this.leases.has(lease))) {
      throw new Error('Resource reclamation did not release its declared allocations')
    }
    this.reclaimedBytes += before - this.bytes
    this.dependentReclaimedBytes += dependentBytes
    return true
  }

  reserve(owner, bytes, victims = [], keep = [], funding = [], refusal = null) {
    bytes = this.size(bytes)
    let supplied = 0
    const sources = new Set(), transfers = []
    for (const offer of funding) {
      this.size(offer.bytes)
      if (!this.leases.has(offer.lease) || offer.lease.phase !== 'reserved' ||
          offer.bytes > offer.lease.bytes || sources.has(offer.lease)) throw new Error('Invalid resource funding')
      sources.add(offer.lease)
      const amount = Math.min(bytes - supplied, offer.bytes)
      supplied += amount
      transfers.push({offer, amount})
    }
    // Already owned credit is transferred only after the complete victim plan
    // succeeds. Protect its source, including indirect reclamation edges; a
    // refused group neither refunds the offer nor partially evicts its peers.
    if (!this.makeRoom(bytes - supplied, victims, keep.concat(Array.from(sources)), refusal)) return null
    const credit = this.create(owner, bytes - supplied, 'reserved')
    for (const {offer, amount} of transfers) if (amount) {
      credit.merge(offer.lease.split(amount, 'reserved', owner))
      offer.bytes -= amount
    }
    return credit
  }

  // Ownership fields change only through lease methods. Keep their aggregate
  // at those same mutation points: a state notification must not walk every
  // tile allocation, even when real work changed the ledger since its last read.
  account(owner, phase, bytes, leases = 0) {
    const totals = this.ownerTotals[owner] || (this.ownerTotals[owner] = {
      leases: 0, reserved: 0, resident: 0, retired: 0})
    totals[phase] += bytes
    this.phaseTotals[phase] += bytes
    totals.leases += leases
    // Zero-byte live leases can still own dependencies. Remove a category only
    // when its last lease ends, rather than when its byte balance reaches zero.
    if (!totals.leases) delete this.ownerTotals[owner]
  }

  create(owner, bytes, phase, disposable = false) {
    const ledger = this
    const lease = {
      owner, bytes, phase, touched: ++this.clock,
      get active() { return ledger.leases.has(lease) },
      availabilityChanged() { if (!disposable && ledger.canReclaim(lease)) ledger.available() },
      touch() { lease.touched = ++ledger.clock },
      mark(value) {
        if (!ledger.leases.has(lease)) return
        if (!['reserved', 'resident', 'retired'].includes(value)) throw new Error('Invalid resource phase')
        if (disposable && value !== 'resident') throw new Error('Disposable resource cannot be protected')
        ledger.account(owner, lease.phase, -lease.bytes)
        ledger.account(owner, value, lease.bytes)
        lease.phase = value; ++ledger.revision
      },
      resize(value, victims = [], keep = []) {
        value = ledger.size(value)
        if (!ledger.leases.has(lease)) return false
        const delta = value - lease.bytes
        if (disposable) {
          if (victims.length || keep.length) throw new Error('Disposable resource cannot borrow credit')
          if (delta > 0 && (ledger.reclaiming || ledger.maximumBytes && ledger.bytes + delta > ledger.maximumBytes)) return false
        } else if (delta >= 0 && !ledger.makeRoom(delta, victims, keep.concat(lease))) return false
        ledger.account(owner, lease.phase, delta)
        lease.bytes = value; ledger.bytes += delta
        if (disposable) ledger.disposableBytes += delta
        ledger.highWaterBytes = Math.max(ledger.highWaterBytes, ledger.bytes)
        ++ledger.revision
        if (delta < 0 && !disposable) ledger.available(true)
        return true
      },
      split(value, nextPhase = lease.phase, nextOwner = lease.owner) {
        if (disposable) throw new Error('Disposable resource cannot transfer credit')
        value = ledger.size(value)
        if (!['reserved', 'resident', 'retired'].includes(nextPhase)) throw new Error('Invalid resource phase')
        if (!ledger.leases.has(lease) || value > lease.bytes) throw new Error('Invalid resource transfer')
        ledger.account(owner, lease.phase, -value)
        lease.bytes -= value; ledger.bytes -= value
        return ledger.create(nextOwner, value, nextPhase)
      },
      merge(other) {
        if (disposable || other.disposable || other === lease || !ledger.leases.has(lease) || !ledger.leases.has(other) ||
            other.owner !== lease.owner) throw new Error('Invalid resource merge')
        // Debit first, so an exact safe-integer balance never has a temporary
        // double charge that could round before the matching subtraction.
        ledger.account(owner, other.phase, -other.bytes, -1)
        ledger.account(owner, lease.phase, other.bytes)
        lease.bytes += other.bytes
        other.bytes = 0
        ledger.leases.delete(other)
        ++ledger.revision
      },
      release() {
        if (!ledger.leases.delete(lease)) return false
        const bytes = lease.bytes
        ledger.account(owner, lease.phase, -bytes, -1)
        ledger.bytes -= bytes; lease.bytes = 0
        if (disposable) ledger.disposableBytes -= bytes
        if (bytes && !disposable) ledger.available(true)
        else ++ledger.revision
        return true
      }
    }
    this.leases.add(lease); this.bytes += bytes
    if (disposable) this.disposableBytes += bytes
    this.account(owner, phase, bytes, 1)
    this.highWaterBytes = Math.max(this.highWaterBytes, this.bytes)
    ++this.revision
    return lease
  }

  stats() {
    const owners = Object.create(null), totals = this.phaseTotals
    for (const key of Reflect.ownKeys(this.ownerTotals)) {
      const owner = this.ownerTotals[key]
      owners[key] = {reserved: owner.reserved, resident: owner.resident, retired: owner.retired}
    }
    return {maximumBytes: this.maximumBytes, bytes: this.bytes, highWaterBytes: this.highWaterBytes,
      reclaimedBytes: this.reclaimedBytes, dependentReclaimedBytes: this.dependentReclaimedBytes,
      overBudgetBytes: this.maximumBytes ? Math.max(0, this.bytes - this.maximumBytes) : 0,
      reservedBytes: totals.reserved, residentBytes: totals.resident, retiredBytes: totals.retired,
      reclamation: this.reclamation.stats(), owners}
  }
}

module.exports = { ResourceLedger, finiteResourceLimit }
