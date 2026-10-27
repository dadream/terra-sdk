// Resumable CPU work owns its iterator until completion/cancellation. A slice
// returns to its scheduler; yielding to the host alone is not task fairness.
// This checkpoint needs an external dependency, unlike an ordinary CPU yield.
// End the slice immediately so the scheduler can return a quote or await a
// receipt; another iterator step in this same turn cannot satisfy it.
const TASK_WAIT = Symbol('task dependency')
const {Cleanup,cleanupAfterError}=require('./cleanup')
const {monotonicNow}=require('../diagnostics/timing')

class CooperativeTask {
  constructor(iterator, maximumSteps = 8, now = monotonicNow) {
    this.maximumSteps = maximumSteps
    this.now = now
    this.iterator = iterator
    this.done = false
    this.value = null
  }

  step(deadline = Infinity) {
    if (this.done) return {done: true, value: this.value}
    const until = Math.min(this.now() + 4, deadline)
    try {
      let result, steps = 0
      do {
        result = this.iterator.next()
        ++steps
        if (!result.done && result.value === TASK_WAIT)
          return {done: false, value: this.value, waiting: true}
      } while (!result.done && steps < this.maximumSteps && this.now() < until)
      if (result.done) {
        this.done = true
        this.value = result.value
        this.iterator = null
      }
      return {done: this.done, value: this.value}
    } catch (error) {cleanupAfterError(error,()=>this.cancel())}
  }

  cancel() {
    const iterator = this.iterator
    this.iterator = null
    this.done = true
    this.value = null
    if (iterator) iterator.return()
  }

  async run(yieldWork) {
    const cleanup=new Cleanup()
    try {
      for (;;) {
        const result = this.step()
        if (result.done) return result.value
        if (yieldWork) await yieldWork()
        else await new Promise(resolve => setTimeout(resolve, 0))
      }
    } catch(error){cleanup.capture(error)}
    finally {if(!this.done)cleanup.run(()=>this.cancel());cleanup.finish()}
  }
}

module.exports = { CooperativeTask, TASK_WAIT }
