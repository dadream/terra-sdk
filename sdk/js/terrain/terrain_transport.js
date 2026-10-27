const {RequestScheduler, invariant} = require('../core/terra_globe_common')
const {responseLimit, binaryResponseBytes} = require('../transport/response_limits')

// Reference-counted, URL-keyed terrain GETs. Rendering and independent queries
// share both the network concurrency cap and the response. Cancelling one owner
// cannot abort another owner's request; done observes the actual producer exit.
class TerrainTransport {
  constructor(request, maximumConcurrent) {
    this.requestImpl = request
    this.scheduler = new RequestScheduler(maximumConcurrent)
    this.entries = new Map()
    this.serial = 0
    this.destroyed = false
  }

  request(options, priority = 0) {
    invariant(!this.destroyed && options && options.url &&
      (options.method || 'GET') === 'GET' && options.responseType === 'arraybuffer',
    'Terrain transport requires a binary GET')
    const maximumBytes = responseLimit(options.maximumResponseBytes)
    let entry = this.entries.get(options.url)
    invariant(!entry || entry.maximumBytes === maximumBytes, 'Shared terrain request has inconsistent byte limits')
    if (!entry) {
      entry = {key: ++this.serial, url: options.url, maximumBytes,
        options: Object.assign({}, options), consumers: new Set(), task: null, finished: false, priority}
      entry.done = new Promise(resolve => { entry.finish = resolve })
      this.entries.set(options.url, entry)
    }
    const consumer = {}
    const promise = new Promise((resolve, reject) => Object.assign(consumer, {resolve, reject}))
    entry.consumers.add(consumer)
    entry.priority = Math.max(entry.priority, priority)
    const finish = (error, response) => {
      entry.finished = true
      if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url)
      for (const owner of entry.consumers) {
        if (error) owner.reject(error)
        else owner.resolve(response)
      }
      entry.consumers.clear(); entry.finish()
    }
    this.scheduler.enqueue(entry.key, () => {
      try {
        entry.task = this.requestImpl(entry.options)
        invariant(entry.task && entry.task.promise && typeof entry.task.abort === 'function',
          'Terrain producer must support cancellation')
        return {promise: Promise.resolve(entry.task.promise).then(response => {
          // Custom/native transports must obey the limit while receiving too.
          // This boundary prevents an oversized result entering caches/Wasm.
          binaryResponseBytes(response.data, maximumBytes)
          finish(null, response)
        }).catch(error => finish(error)), abort: () => entry.task.abort()}
      } catch (error) { finish(error); return {promise: Promise.resolve(), abort() {}} }
    }, entry.priority)
    const abort = () => {
      if (!entry.consumers.delete(consumer)) return
      consumer.reject(Object.assign(new Error('Terrain request cancelled'), {code: 'cancelled'}))
      if (entry.consumers.size || entry.finished) return
      if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url)
      this.scheduler.cancelExcept(new Set(Array.from(this.entries.values(), value => value.key)))
      if (!entry.task) finish(new Error('Terrain request cancelled before start'))
    }
    consumer.abort = abort
    return {promise, abort, done: entry.done}
  }

  destroy() {
    this.destroyed = true
    for (const entry of Array.from(this.entries.values()))
      for (const consumer of Array.from(entry.consumers)) consumer.abort()
    this.scheduler.clear()
  }
}

module.exports = {TerrainTransport}
