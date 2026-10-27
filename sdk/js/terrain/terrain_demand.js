// A current, complete image group must own its continuation before growing
// physical terrain selection. The candidate separately prices its new geometry,
// UV and image outputs; the full final target is not simultaneous production.
class TerrainDemand {
  constructor() {
    this.blocked = false
    this.reason = null
    this.pauses = this.resumptions = 0
    this.planningWaits = 0
    this.measurementWaits = 0
  }

  expect(view, sequence) { this.expected = {view, sequence} }

  prepare(view, sequence) {
    const pending = this.pending = {view, sequence}
    return () => {if (this.pending === pending) this.pending = null}
  }

  update(view, demand, admit) {
    const before = this.blocked
    const reason = this.reason
    // A new camera/source must be able to select its first surface. Within the
    // same view, incomplete replacement planning cannot erase known pressure.
    if (view !== this.view) {
      this.view = view; this.reason = null
    }
    // The prepared cut must acquire its own complete imagery price before
    // another physical selection grows. An affordable predecessor price cannot
    // authorize allocations for a newer, still-unmeasured surface.
    const expected = this.pending && this.pending.view === view ? this.pending :
      this.expected && this.expected.view === view ? this.expected : null
    if (expected && (!demand || !(demand.sequence >= expected.sequence))) {
      if (this.reason !== 'capacity') this.reason = 'planning'
    }
    // Admission owns the concrete group's credit. Requiring the entire future
    // viewport as additional room would block rolling replacements even when
    // the final target fits and old display receipts can fund subsequent groups.
    else if (demand) this.reason = admit(demand)
      ? null : demand.refinable ? 'measurement' : 'capacity'
    else if (!expected && this.reason === 'planning') this.reason = null
    this.blocked = this.reason !== null
    if (this.reason === 'planning' && reason !== 'planning') ++this.planningWaits
    if (this.reason === 'measurement' && reason !== 'measurement') ++this.measurementWaits
    if (!before && this.blocked) ++this.pauses
    if (before && !this.blocked) ++this.resumptions
    return this.blocked
  }

  stats() {return {blocked: this.blocked, reason: this.reason, planningWaits: this.planningWaits,
    measurementWaits: this.measurementWaits,
    pauses: this.pauses, resumptions: this.resumptions}}
}

module.exports = {TerrainDemand}
