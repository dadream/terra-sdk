const {invariant} = require('../core/terra_globe_common')

const fields = ['modelRevision', 'pendingPriorityUpdateCount', 'budgetExhausted',
  'limitedByCapacity', 'achievedLodError', 'requestedLodThreshold']
function snapshot(state) {
  const value = {}
  for (const key of fields) value[key] = state[key] || 0
  return value
}

// Logical work has its own input clock. Accepting a paid output never spends
// the next model round's operation budget, nor proves that output is current.
// This controller retains numbers only; native snapshots/ledger own payloads.
class TerrainModelWork {
  constructor() { this.clear() }
  clear() {
    this.latest = this.output = this.refusal = null
    this.check = true
    this.rounds = this.changes = this.maximumChanges = 0
  }
  observe(input, view, state, maximum, dataRevision) {
    const changes = state.topologyChangeCount
    invariant(Number.isInteger(changes) && changes >= 0 && changes <= maximum,
      'Invalid terrain topology change count')
    this.latest = {input, view, dataRevision, state: snapshot(state), runnable:
      state.pendingPriorityUpdateCount > 0 ||
      state.budgetExhausted && maximum > 0 && !state.limitedByCapacity}
    ++this.rounds; this.changes += changes
    this.maximumChanges = Math.max(this.maximumChanges, changes)
    this.check = false; this.refusal = null
  }
  accepted(view, state, dataRevision) {
    this.output = {view, dataRevision, state: snapshot(state)}
    // Selection can itself finish priorities/heights. Observe the actual
    // logical state once; do not repeatedly publish identical idle metadata.
    this.check = true; this.refusal = null
  }
  refused(input, view, availability) {
    this.refusal = {input, view, availability}
    this.check = false
  }
  needsAdvance(input, view, availability) {
    const wait = this.refusal
    if (wait) return wait.input !== input || wait.view !== view || wait.availability !== availability
    const last = this.latest
    return this.check || !last || last.input !== input || last.view !== view || last.runnable
  }
  needsPublication() {
    if (this.refusal || !this.output) return true
    const last = this.latest, output = this.output
    if (!last || last.view < output.view || last.state.modelRevision < output.state.modelRevision) return false
    // NoData/retry completion can change frame convergence without changing
    // visible topology. Acknowledged data still needs one fresh publication.
    return last.view !== output.view || last.dataRevision !== output.dataRevision ||
      fields.some(key => !Object.is(last.state[key], output.state[key]))
  }
  stats() {
    return {rounds: this.rounds, topologyChanges: this.changes, maximumRoundChanges: this.maximumChanges,
      modelRevision: this.latest && this.latest.state.modelRevision,
      dataRevision: this.latest && this.latest.dataRevision,
      viewRevision: this.latest && this.latest.view, capacityWait: !!this.refusal}
  }
}

module.exports = {TerrainModelWork}
