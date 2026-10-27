const {finiteResourceLimit} = require('./resource_ledger')
const {ResourceWorkspace} = require('./resource_workspace')

// A preferred local share may grow only after actual credit is obtained from
// the fixed global envelope. Unused grants remain owned until spent or revoked;
// spent credit belongs to real producers/destinations, not this policy object.
class ResourceShare {
  constructor(ledger, owner, preferredBytes, maximumBytes) {
    this.ledger = ledger
    this.owner = owner
    this.maximumBytes = finiteResourceLimit(maximumBytes)
    this.preferredBytes = Math.min(finiteResourceLimit(preferredBytes), this.maximumBytes)
    this.extraBytes = 0
    this.pressured = false
    this.workspace = new ResourceWorkspace(owner)
    this.attempts = 0
    this.grants = 0
    this.revocations = 0
    this.retractions = 0
    this.retractedBytes = 0
    this.refused = null
  }

  get bytes() { return this.preferredBytes + this.extraBytes }

  grow(bytes) {
    this.ledger.size(bytes)
    bytes = Math.min(bytes, this.maximumBytes - this.bytes)
    if (!bytes || this.pressured) return false
    const signature = [bytes, this.bytes, this.ledger.availabilityRevision].join(':')
    if (signature === this.refused) return false
    ++this.attempts
    const credit = this.ledger.reserve(this.owner, bytes)
    if (!credit) { this.refused = signature; return false }
    this.workspace.accept(credit)
    this.extraBytes += bytes
    ++this.grants
    this.refused = null
    return true
  }

  fund(reserve) { return this.workspace.fund(0, reserve) }

  // A spent grant is not a permanent promise of future replacement room.
  // Constrain planning after a confirmed complete-group refusal. Live assets
  // keep their credit until their own receipts; only unused grants refund now.
  retract(bytes) {
    bytes = Math.min(this.ledger.size(bytes), this.extraBytes)
    if (!bytes) return false
    this.extraBytes -= bytes
    this.workspace.trim(this.extraBytes)
    this.pressured = true
    this.refused = null
    ++this.retractions
    this.retractedBytes += bytes
    return true
  }

  revoke(pressure = false) {
    const changed = this.extraBytes > 0
    if (changed) ++this.revocations
    this.workspace.retire()
    this.workspace = new ResourceWorkspace(this.owner)
    this.extraBytes = 0
    this.pressured = pressure
    this.refused = null
    return changed
  }

  setPreferred(bytes) {
    bytes = Math.min(finiteResourceLimit(bytes), this.maximumBytes)
    if (bytes === this.preferredBytes) return false
    this.revoke()
    this.preferredBytes = bytes
    return true
  }

  stats() {
    return {preferredBytes: this.preferredBytes, maximumBytes: this.maximumBytes,
      grantedBytes: this.bytes, extraBytes: this.extraBytes, unusedBytes: this.workspace.availableBytes,
      pressured: this.pressured, attempts: this.attempts, grants: this.grants, revocations: this.revocations,
      retractions: this.retractions, retractedBytes: this.retractedBytes}
  }
}

module.exports = {ResourceShare}
