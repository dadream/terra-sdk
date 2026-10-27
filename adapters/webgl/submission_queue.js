// One display and one resource batch may be outstanding. GL commands remain
// ordered; resources publish only after their own completion and validation.
// Keeping one allocation batch also preserves getError attribution.
class SubmissionQueue {
  constructor() { this.batches = [] }

  get pending() { return this.batches[0] || null }
  get uploading() { return this.batches.some(batch => !batch.drawn) }

  submit(batch, drawn = false) {
    if (drawn ? this.batches.length : this.uploading) throw new Error('GPU submission lane is occupied')
    if (drawn && batch.items.length) throw new Error('Display receipts cannot own resource allocations')
    if (batch.defer(drawn)) this.batches.push(batch)
    else batch.commit()
  }

  poll(completed) {
    while (this.pending) {
      const batch = this.pending
      if (!batch.poll()) return false
      // Keep the batch owned until publication succeeds so a failing callback
      // is cancelled together with any later queued allocations.
      batch.commit()
      this.batches.shift()
      completed(batch)
    }
    return true
  }

  cancel(lost = false) {
    const batches = this.batches.splice(0)
    batches.forEach(batch => batch.cancel(lost))
  }
}

module.exports = {SubmissionQueue}
