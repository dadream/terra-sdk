// Ordered receipts keep native, Worker and host ownership in step. At most one
// retention is in flight and one newer display snapshot is pending. Full frame
// acknowledgement follows them; a reset invalidates all completions in flight.
class MeshReceipts {
  constructor(frames, owner, onError) {
    this.frames = frames
    this.owner = owner
    this.onError = onError
    this.generation = 0
    this.clear()
  }

  clear() {
    ++this.generation
    this.tail = Promise.resolve()
    this.pending = null
    this.flushing = null
  }

  enqueue(operation) {
    const generation = this.generation, owner = this.owner()
    const valid = () => generation === this.generation && owner &&
      this.owner() === owner && !owner.destroyed
    const result = this.tail.then(() => valid() ? operation(owner, valid) : false)
    this.tail = result.catch(() => {})
    return result
  }

  retain(sequence, draws) {
    this.pending = {sequence, draws: draws.slice()}
    if (this.flushing) return this.flushing
    const generation = this.generation
    const result = this.enqueue(async (owner, valid) => {
      try {
        while (this.pending && valid()) {
          const {sequence, draws} = this.pending
          this.pending = null
          if (!this.frames.candidate || this.frames.candidate.frame.sequence !== sequence) continue
          const prepared = this.frames.prepareRetention(sequence, draws)
          await owner.retainMeshes(sequence, draws)
          if (!valid()) return false
          this.frames.commitRetention(prepared)
        }
        return true
      } finally {
        if (generation === this.generation) { this.flushing = null; this.pending = null }
      }
    }).catch(error => {
      if (generation === this.generation) this.onError(error)
      return false
    })
    this.flushing = result
    return result
  }

  present(sequence) {
    return this.enqueue(async (owner, valid) => {
      await owner.presentFrame(sequence)
      return valid() && this.frames.present(sequence)
    })
  }
}

module.exports = { MeshReceipts }
