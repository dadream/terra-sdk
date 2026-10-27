const assert = require('assert')
const {browserRequest} = require('../../adapters/browser/browser_request')

module.exports = async function () {
  const original = {fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout,
    AbortController: global.AbortController}
  if (!global.AbortController) global.AbortController = class {
    constructor() {this.signal = {aborted: false}}
    abort() {this.signal.aborted = true}
  }
  const timers = new Map()
  let id = 0, signal, consume, started, pulling, reads, cancellations, releases, chunks, headers
  const deferred = () => { let resolve, reject
    const promise = new Promise((yes, no) => {resolve = yes; reject = no})
    return {promise, resolve, reject} }
  const reset = () => {
    assert.strictEqual(timers.size, 0, 'Request deadline leaked after settlement')
    started = deferred(); consume = deferred(); pulling = deferred(); reads = cancellations = releases = 0; chunks = []
    headers = new Map([['content-type', 'application/octet-stream']])
    global.fetch = async (url, options) => {
      signal = options.signal
      assert.strictEqual(url, 'https://terrain.example/record')
      assert.strictEqual(options.cache, 'no-store')
      started.resolve()
      return {status: 200, headers,
        arrayBuffer() { assert.fail('Bounded request used unbounded body assembly') },
        text() { assert.fail('Bounded JSON request used unbounded text assembly') },
        body: {cancel: async () => {++cancellations}, getReader: () => ({
          read: async () => {
            ++reads; pulling.resolve()
            if (reads === 1) return {done: false, value: await consume.promise}
            return chunks.length ? {done: false, value: chunks.shift()} : {done: true}
          }, cancel: async () => {++cancellations}, releaseLock: () => {++releases}
        })}}
    }
  }
  global.setTimeout = (callback, delay) => { assert.strictEqual(delay, 15); timers.set(++id, callback); return id }
  global.clearTimeout = key => timers.delete(key)
  const deadline = () => { assert.strictEqual(timers.size, 1); Array.from(timers.values())[0]() }
  const options = {url: 'https://terrain.example/record', responseType: 'arraybuffer', timeout: 15, maximumResponseBytes: 64}
  try {
    reset()
    const success = browserRequest(options), bytes = new Uint8Array([1, 2, 3])
    await started.promise; consume.resolve(bytes)
    assert.deepStrictEqual(await success.promise,
      {statusCode: 200, data: bytes.buffer, header: {'content-type': 'application/octet-stream'}})
    assert.strictEqual(releases, 1); assert.strictEqual(cancellations, 0)
    success.abort(); assert.strictEqual(signal.aborted, false)

    reset()
    const json = browserRequest(Object.assign({}, options, {responseType: undefined}))
    await started.promise; consume.resolve(new Uint8Array(Buffer.from('{"schema":"manifest"}')))
    assert.deepStrictEqual((await json.promise).data, {schema: 'manifest'})

    for (const first of ['deadline', 'cancel']) {
      reset()
      const task = browserRequest(options)
      await pulling.promise
      const expected = first === 'deadline' ? 'TimeoutError' : 'AbortError'
      const rejection = assert.rejects(task.promise, error => error.name === expected)
      if (first === 'deadline') {deadline(); task.abort()}
      else {task.abort(); deadline()}
      assert(signal.aborted)
      consume.resolve(bytes) // A late producer cannot publish after cancellation.
      await rejection
      assert.strictEqual(cancellations, 1)
    }

    reset()
    headers.set('content-length', '65')
    await assert.rejects(browserRequest(options).promise, e => e.code === 'response_too_large')
    assert.strictEqual(reads, 0, 'Oversized declared response pulled its body')
    assert.strictEqual(cancellations, 1)

    for (const declared of [null, '1']) {
      reset()
      if (declared) headers.set('content-length', declared)
      chunks.push(new Uint8Array(33))
      const task = browserRequest(options), rejection = assert.rejects(task.promise, e => e.code === 'response_too_large')
      consume.resolve(new Uint8Array(32))
      await rejection
      assert.strictEqual(reads, 2)
      assert.strictEqual(cancellations, 1); assert.strictEqual(releases, 1)
    }

    reset()
    const complete = browserRequest(options)
    consume.resolve(new Uint8Array(64))
    assert.strictEqual((await complete.promise).data.byteLength, 64, 'Exact limit was rejected')

    reset()
    const stalledBody = browserRequest(options)
    await pulling.promise
    const rejection = assert.rejects(stalledBody.promise, error => error.name === 'TimeoutError')
    deadline(); consume.reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))
    await rejection
    assert.strictEqual(releases, 1)

    reset()
    global.fetch = () => {throw new Error('transport unavailable')}
    await assert.rejects(browserRequest(options).promise, /transport unavailable/)
    for (const value of [undefined, 0, -1, Infinity, 1.5])
      assert.throws(() => browserRequest(Object.assign({}, options, {maximumResponseBytes: value})), /byte limit/)
    assert.strictEqual(timers.size, 0)
  } finally { Object.assign(global, original) }
}
