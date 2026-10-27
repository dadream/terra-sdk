// A funded production workspace lends credit without competing with unrelated
// allocations between stages. Retirement releases free credit immediately;
// running producers keep their own shares until actual completion.
class ResourceWorkspace {
  constructor(owner, changed = () => {}) {
    this.owner = owner
    this.changed = changed
    this.credit = null
    this.bytes = 0
    this.children = new Set()
    this.retired = false
  }

  get availableBytes() { return this.credit ? this.credit.bytes : 0 }

  surplus(requiredBytes) {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new Error('Invalid workspace requirement')
    return this.retired ? 0 : Math.min(this.availableBytes, Math.max(0, this.bytes - requiredBytes))
  }

  // Synchronous complete-group admission may transfer free credit beyond its
  // required continuation envelope. The ledger commits or rejects the entire
  // exchange; active producers and rejected offers keep their original owner.
  fund(requiredBytes, reserve) {
    const bytes = this.surplus(requiredBytes), credit = this.credit
    if (!bytes) return reserve([])
    const funding = {lease: credit, bytes}
    try { return reserve([funding]) }
    finally {
      // Eviction may refund a child's input to this same credit. The consumed
      // offer, rather than its net balance change, is the transfer receipt.
      const transferred = bytes - funding.bytes
      if (transferred) { this.bytes -= transferred; this.changed() }
    }
  }

  accept(credit) {
    if (this.retired) throw new Error('Cannot fund a retired workspace')
    const bytes = credit.bytes
    if (!bytes) { credit.release(); return }
    if (this.credit) this.credit.merge(credit)
    else this.credit = credit
    this.bytes += bytes
    this.changed()
  }

  refund(credit) {
    if (this.retired) { this.bytes -= credit.bytes; credit.release() }
    else {
      credit.mark('reserved')
      if (this.credit) this.credit.merge(credit)
      else this.credit = credit
    }
  }

  take(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid workspace allocation')
    if (this.retired || !this.credit || bytes > this.availableBytes) return null
    const lease = this.credit.split(bytes)
    this.children.add(lease)
    let closed = false
    return {
      get bytes() { return closed ? 0 : lease.bytes },
      mark: phase => lease.mark(this.retired ? 'retired' : phase),
      resize: size => {
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid workspace allocation')
        if (closed) return false
        const delta = size - lease.bytes
        if (delta > 0) {
          if (this.retired || delta > this.availableBytes) return false
          lease.merge(this.credit.split(delta))
        } else if (delta < 0) this.refund(lease.split(-delta))
        this.changed()
        return true
      },
      release: () => {
        if (closed) return
        closed = true
        this.children.delete(lease)
        this.refund(lease)
        this.changed()
      }
    }
  }

  trim(requiredBytes = 0) {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new Error('Invalid workspace requirement')
    if (!this.credit) return
    const bytes = Math.min(this.availableBytes, Math.max(0, this.bytes - requiredBytes))
    if (!bytes && requiredBytes) return
    this.bytes -= bytes
    if (bytes === this.credit.bytes) { this.credit.release(); this.credit = null }
    else this.credit.split(bytes).release()
    this.changed()
  }

  retire() {
    if (this.retired) return
    this.retired = true
    this.children.forEach(lease => lease.mark('retired'))
    this.trim()
    this.changed()
  }
}

module.exports = { ResourceWorkspace }
