const {CooperativeTask} = require('../runtime/cooperative_task')
const {cleanupAfterError} = require('../runtime/cleanup')

// One bounded lane across many small cost tasks. Only the current row owns
// scratch/model input; each slice drains scalar costs without a host round trip
// to start the next mesh. Cancellation closes the active child before returning.
class PartitionPlanBatch {
  constructor(rows, create, release = () => {}) {
    this.completed = []
    this.release = release
    this.work = new CooperativeTask(this.steps(rows, create), 64)
  }

  *steps(rows, create) {
    for (const row of rows) {
      const input = create(row)
      try {
        input.task.maximumSteps = 1
        let result
        do {
          result = input.task.step()
          if (!result.done) yield
        } while (!result.done)
        this.completed.push({resourceId: row.draw.resourceId, source: input.source, prices: result.value})
      } finally {
        try { input.task.cancel() } finally { input.release() }
      }
      yield
    }
  }

  step() {
    try {
      const result = this.work.step()
      if (result.done) this.close()
      return {done: result.done, value: {rows: this.completed.splice(0)}}
    } catch (error) { cleanupAfterError(error, () => this.cancel()) }
  }

  close() { const release = this.release; this.release = null; if (release) release() }

  cancel() {
    this.cancelled = true
    try { this.work.cancel() } finally { this.completed.length = 0; this.close() }
  }

  async run(onRows, yieldWork = () => new Promise(resolve => setTimeout(resolve, 0))) {
    try {
      for (;;) {
        if (this.cancelled) return null
        const result = this.step()
        if (onRows(result.value.rows) === false) return null
        if (result.done) return true
        await yieldWork()
      }
    } finally { this.cancel() }
  }
}

module.exports = {PartitionPlanBatch}
