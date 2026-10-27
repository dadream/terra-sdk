// One host task between bounded Worker slices. Keep the channel only while
// the pump is busy; an idle/cancelled worker owns no dispatch handles.
class WorkerTurn {
  constructor(scope) {
    this.Channel = scope.MessageChannel
  }

  wait() {
    if (this.pending) return this.pending
    this.pending = new Promise(resolve => {
      this.resume = () => {
        this.pending = this.resume = this.timer = null
        resolve()
      }
      if (this.Channel) {
        if (!this.channel) {
          this.channel = new this.Channel()
          this.channel.port1.onmessage = () => { if (this.resume) this.resume() }
        }
        this.channel.port2.postMessage(0)
      } else this.timer = setTimeout(this.resume, 0)
    })
    return this.pending
  }

  close() {
    if (this.channel) {
      this.channel.port1.close()
      this.channel.port2.close()
      this.channel = null
    }
    if (this.timer != null) clearTimeout(this.timer)
    if (this.resume) this.resume()
  }
}

module.exports = { WorkerTurn }
