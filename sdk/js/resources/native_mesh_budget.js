const {invariant} = require('../core/terra_globe_common')

// A native allocation can have many cache/display owners. Account its unique
// payload once, and keep production credit until an actual completion report.
class NativeMeshBudget {
  constructor(ledger, bytes = 0, provider = null) {
    this.ledger = ledger
    this.resident = ledger.reserve('mesh-native', bytes)
    if (!this.resident) throw Object.assign(new Error('Native mesh capacity is occupied'), {status: 9})
    this.resident.mark('resident')
    this.actual = bytes
    this.credit = null
    this.unregister = provider && ledger.reclamation.register({
      owner: 'mesh-native',
      revision: provider.revision,
      reclaim: needed => this.resident && this.actual ? provider.trim(needed) : 0,
      failed: provider.failed
    })
  }

  begin(credit) {
    invariant(!this.retiring && this.resident && !this.credit && credit && this.ledger.leases.has(credit) &&
      credit.owner === 'mesh-native' && credit.phase === 'reserved',
      'Native mesh production is not credited')
    this.credit = credit
  }

  observe(bytes) {
    invariant(this.resident && Number.isSafeInteger(bytes) && bytes >= 0 &&
      bytes <= this.resident.bytes + (this.credit ? this.credit.bytes : 0),
    'Native mesh allocation exceeded its credit')
    this.actual = bytes
    if (!this.credit && bytes < this.resident.bytes) this.resident.resize(bytes)
  }

  finish() {
    if (this.retiring) return
    if (!this.credit) return
    this.resident.merge(this.credit)
    this.credit = null
    if (this.actual < this.resident.bytes) this.resident.resize(this.actual)
  }

  retire() {
    this.retiring = true
    if (this.unregister) this.unregister()
    this.unregister = null
  }

  close() {
    if (this.unregister) this.unregister()
    this.unregister = null
    if (this.credit) this.credit.release()
    if (this.resident) this.resident.release()
    this.credit = this.resident = null
    this.actual = 0
  }
}

module.exports = {NativeMeshBudget}
