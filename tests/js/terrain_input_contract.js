const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {TerrainInputBudget} = require('../../sdk/js/terrain/terrain_input_budget')
const {TerrainTransport} = require('../../sdk/js/terrain/terrain_transport')
const {maximumEncodedRecordBytes} = require('../../sdk/js/terrain/terrain_record')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')
const {requestWithWx} = require('../../adapters/miniprogram/wx_request')
const {createCloudbaseRequest} = require('../../adapters/miniprogram/terra_cloudbase_transport')

const tick = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve() }
const deferred = () => { let resolve, reject
  const promise = new Promise((a,b) => {resolve = a; reject = b})
  return {promise, resolve, reject} }
const options = url => ({url, method: 'GET', responseType: 'arraybuffer', maximumResponseBytes: 4})
const response = size => ({statusCode: 200, data: new ArrayBuffer(size), header: {}})

module.exports = async function () {
  const bytes = 3 * maximumEncodedRecordBytes(64, 1), ledger = new ResourceLedger(bytes + 10)
  const inputs = new TerrainInputBudget(ledger, 64), display = ledger.reserve('display', 10)
  assert(display)
  const first = await inputs.acquire(bytes).promise
  let acquired = false
  const next = inputs.acquire(bytes), waiting = next.promise.then(value => {acquired = true; return value})
  await tick(); assert(!acquired, 'Second input started without credit')
  assert.strictEqual(ledger.bytes, bytes + 10)
  const cancelled = inputs.acquire(1), rejected = assert.rejects(cancelled.promise, /cancelled/)
  cancelled.cancel(); await rejected
  first.release()
  const second = await waiting
  assert.strictEqual(ledger.bytes, bytes + 10, 'Continuation surrendered its reserve to competing detail')
  inputs.destroy()
  assert.strictEqual(ledger.stats().retiredBytes, bytes, 'Destroy refunded an unacknowledged producer')
  second.release(); display.release()
  assert.strictEqual(ledger.bytes, 0)
  assert.strictEqual(ledger.leases.size, 0)

  // Copy bounds apply before native allocation and before Worker postMessage.
  const manifest = {patchDimension: 64}, tooLarge = new Uint8Array(maximumEncodedRecordBytes(64, 1) + 1)
  const abi = {manifest, alloc() {assert.fail('Oversized input reached Wasm allocation')}}
  assert.throws(() => TerraAbi.prototype.submitRecord.call(abi, 1, {}, tooLarge), e => e.code === 'response_too_large')
  assert.throws(() => TerraAbi.prototype.submitHeightQueryRecord.call(abi, 1, 1, {}, tooLarge), e => e.code === 'response_too_large')
  const calls = [], client = Object.create(TerrainWorkerClient.prototype)
  client.manifest = manifest; client.call = (...args) => { calls.push(args); return Promise.resolve() }
  client.send = message => {
    assert.strictEqual(message.recordCreditBytes, 65 * 65 * 4)
    calls.push([message.method, ...message.args]); return Promise.resolve()
  }
  assert.throws(() => client.submitRecord(1, {}, tooLarge), e => e.code === 'response_too_large')
  assert.throws(() => client.submitHeightQueryRecord(1, 1, {}, tooLarge), e => e.code === 'response_too_large')
  assert.strictEqual(calls.length, 0)
  const backing = new Uint8Array(1024 * 1024), view = backing.subarray(500, 504)
  view.set([1,2,3,4])
  await client.submitRecord(1, {}, view)
  await client.submitHeightQueryRecord(1, 1, {}, view)
  for (const call of calls) {
    const copied = call[call.length - 1]
    assert.strictEqual(copied.buffer.byteLength, 4, 'Structured clone retained an oversized backing buffer')
    assert.deepStrictEqual(Array.from(copied), [1,2,3,4])
  }

  const native = global.wx
  try {
    for (const kind of ['wx', 'cloud']) {
      const started = []
      global.wx = {
        request(value) { started.push(value); return {abort() {}} },
        cloud: {callContainer() { const pending = deferred(); started.push(pending); return pending.promise }}
      }
      const request = kind === 'wx' ? requestWithWx : createCloudbaseRequest({envId: 'test', serviceName: 'test'})
      const transport = new TerrainTransport(request, 1)
      const a = transport.request(options('https://test.invalid/a'))
      const duplicate = transport.request(options('https://test.invalid/a'))
      assert.throws(() => transport.request(Object.assign(options('https://test.invalid/a'), {maximumResponseBytes: 5})),
        /inconsistent byte limits/)
      const b = transport.request(options('https://test.invalid/b'))
      const cancelledA = assert.rejects(a.promise, /cancelled/), cancelledDuplicate = assert.rejects(duplicate.promise, /cancelled/)
      await tick()
      a.abort(); duplicate.abort(); await cancelledA; await cancelledDuplicate
      let done = false; a.done.then(() => {done = true})
      await tick()
      assert(!done && started.length === 1, `${kind} cancellation refunded the physical producer early`)
      if (kind === 'wx') started[0].success(response(4))
      else started[0].resolve(response(4))
      await a.done; await tick()
      assert.strictEqual(started.length, 2)
      const oversized = assert.rejects(b.promise, e => e.code === 'response_too_large')
      if (kind === 'wx') started[1].success(response(5))
      else started[1].resolve(response(5))
      await oversized; await b.done
      transport.destroy(); await tick()
      assert.strictEqual(transport.entries.size, 0)
      assert.strictEqual(transport.scheduler.active.size, 0)
    }
  } finally { global.wx = native }
  console.log('Funded terrain ingress, bounded copies, shared limits and native cancellation receipts passed')
}
