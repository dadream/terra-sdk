const {ResourceWorkspace} = require('../resources/resource_workspace')
const {ResourceWaitQueue} = require('../resources/resource_wait_queue')
const {maximumEncodedRecordBytes} = require('./terrain_record')

// One serial ingress/clone/native-copy path is funded before imagery fills the
// ledger. Additional inputs borrow real global room; their actual completion
// returns credit to this lane, rather than racing unrelated detail producers.
class TerrainInputBudget {
  constructor(ledger, patchDimension) {
    this.ledger = ledger
    this.minimumBytes = 3 * maximumEncodedRecordBytes(patchDimension, 1)
    this.workspace = new ResourceWorkspace('terrain-input')
    this.queue = new ResourceWaitQueue()
    const credit = ledger.reserve('terrain-input', this.minimumBytes)
    if (!credit) throw new Error('Terrain input continuation does not fit the shared resource limit')
    this.workspace.accept(credit)
    this.unsubscribe = ledger.subscribe(() => this.queue.wake())
  }

  acquire(bytes) {
    this.ledger.size(bytes)
    if (bytes > this.minimumBytes) throw new Error('Terrain input exceeds its continuation envelope')
    return this.queue.wait(() => {
      if (this.workspace.retired) throw Object.assign(new Error('Terrain input retired'), {name: 'AbortError'})
      const missing = Math.max(0, bytes - this.workspace.availableBytes)
      if (missing) {
        const credit = this.ledger.reserve('terrain-input', missing)
        if (!credit) return null
        this.workspace.accept(credit)
      }
      const credit = this.workspace.take(bytes)
      return {release: () => {
        credit.release()
        this.workspace.trim(this.minimumBytes)
        this.queue.wake()
      }}
    })
  }

  destroy() {
    this.workspace.retire()
    this.unsubscribe()
    this.queue.wake()
  }

  stats() { return {reservedBytes: this.workspace.bytes, availableBytes: this.workspace.availableBytes,
    minimumBytes: this.minimumBytes, waiting: this.queue.pending.length} }
}

module.exports = {TerrainInputBudget}
