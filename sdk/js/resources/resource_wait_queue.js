// A producer may wait without owning payload that it has not read yet. The
// acquisition callback must obtain real credit synchronously before resolving.
// Wake only for capacity changes; a refused head does not poll or get bypassed.
class ResourceWaitQueue {
  constructor() { this.pending = []; this.scheduled = false; this.pumping = false }

  wait(acquire) {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    const entry = {acquire, resolve, reject}
    this.pending.push(entry)
    this.wake()
    return {promise, cancel: () => {
      const index = this.pending.indexOf(entry)
      if (index < 0) return
      this.pending.splice(index, 1)
      reject(Object.assign(new Error('Resource wait cancelled'), {name: 'AbortError'}))
      this.wake()
    }}
  }

  wake() {
    if (this.scheduled || this.pumping || !this.pending.length) return
    this.scheduled = true
    Promise.resolve().then(() => {
      this.scheduled = false; this.pumping = true
      try {
        while (this.pending.length) {
          const entry = this.pending[0]
          let value
          try { value = entry.acquire() }
          catch (error) {
            if (this.pending[0] === entry) this.pending.shift()
            entry.reject(error); continue
          }
          if (this.pending[0] !== entry) continue
          if (!value) break
          this.pending.shift(); entry.resolve(value)
        }
      } finally { this.pumping = false }
    })
  }
}

module.exports = {ResourceWaitQueue}
