// Admission failure describes a physical byte deficit after reclaimable owners
// have been considered. A smaller CBDAM cut can release native, host and GPU
// geometry, while keeping the old display until a complete replacement exists.
class TerrainCapacity {
  constructor(preferred, minimum) {
    this.preferred = this.bytes = preferred
    this.minimum = minimum
    this.reductions = this.restorations = 0
    this.restoring = false
  }

  updateView(view) {
    if (this.view === view) return
    this.view = view
    this.recoveryView = this.recoveryBytes = undefined
    this.restoring = false
  }

  refuse(shortfall, view, selectedBytes = this.bytes) {
    if (!Number.isSafeInteger(shortfall) || shortfall <= 0) return false
    this.updateView(view)
    const recovery = this.recoveryView === view ? this.recoveryBytes : this.bytes
    const ceiling = Math.min(this.bytes, recovery)
    const next = Math.max(this.minimum, Math.min(ceiling, selectedBytes || this.bytes) - Math.ceil(shortfall / 3))
    // Even at the minimum relief floor, a refused restoration must revoke
    // the larger target allowance. Compare with the currently open quota;
    // comparing with the floor would leave restoration active indefinitely.
    if (next >= this.bytes) return false
    this.bytes = this.recoveryBytes = next
    this.recoveryView = this.refusedView = view
    this.restoring = false
    ++this.reductions
    return true
  }

  complete(view) {
    if (this.bytes !== this.preferred || this.recoveryView !== view) return
    this.recoveryView = this.recoveryBytes = undefined
    this.restoring = false
  }

  beginRestore(view) {
    this.updateView(view)
    if (this.bytes === this.preferred) return false
    // Reopen selection, not allocation. The runtime keeps its configured work
    // window; height/mesh/UV/image producers still acquire their actual group
    // and workspace grants before allocation. Serializing every mutation into
    // a publication is not a substitute for those production grants.
    // Requiring another whole generation here would prevent rolling recovery
    // even when the next complete replacement group fits beside the old display.
    // A camera change clears the previous view's refusal history, but retains
    // its actual working quota. Capture that finite quota before reopening the
    // target so a failed first restoration at this view has a valid ceiling.
    if (this.recoveryBytes === undefined) this.recoveryBytes = this.bytes
    this.bytes = this.preferred
    this.recoveryView = view
    this.restoring = true
    ++this.restorations
    return true
  }

  stats() {return {workingMeshBytes: this.bytes, preferredMeshBytes: this.preferred,
    recoveryMeshBytes:this.recoveryBytes, restoring:this.restoring,
    reductions: this.reductions, restorations: this.restorations}}
}

module.exports = {TerrainCapacity}
