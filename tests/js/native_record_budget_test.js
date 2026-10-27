const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {NativePayloadBudget} = require('../../sdk/js/resources/native_payload_budget')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')

async function verifyReset() {
  const ledger = new ResourceLedger(100), budget = new NativePayloadBudget(ledger, 'terrain-record-native', 40)
  const pressure = ledger.reserve('pressure', 60)
  let reply
  const reset = budget.runReset(40, bytes => {
    assert.strictEqual(bytes, 40)
    assert.strictEqual(ledger.bytes, 100, 'Reset refunded live records before the receipt')
    return new Promise(resolve => {reply = resolve})
  })
  let nextStarted = false
  const next = budget.runReset(40, () => {nextStarted = true; budget.observe(40)})
  await Promise.resolve()
  assert(!nextStarted, 'Concurrent reset reused issued credit')
  budget.observe(40); reply(); await reset; await next
  assert(nextStarted, 'Returned resident credit did not wake the next reset')
  assert.strictEqual(ledger.bytes, 100)
  const cancelled = budget.runReset(50, () => {throw new Error('cancelled reset ran')})
  assert.strictEqual(budget.resident.bytes, 40, 'Failed reset admission split resident credit')
  cancelled.cancel(); await assert.rejects(cancelled, /cancelled/)
  assert.throws(() => budget.runReset(40, () => {throw new Error('bad manifest')}), /bad manifest/)
  assert.strictEqual(budget.resident.bytes, 40, 'Failure lost old record ownership')
  const growing = budget.runReset(50, () => budget.observe(50))
  pressure.release(); await growing
  assert.strictEqual(ledger.bytes, 50)
  assert.strictEqual(ledger.stats().reservedBytes, 0)

  // An unrelated producer may complete on either side of the reset receipt.
  for (const resetFirst of [true, false]) {
    let decodeReply, resetReply
    const decode = budget.run(20, () => new Promise(resolve => {decodeReply = resolve}))
    const reloading = budget.runReset(50, () => new Promise(resolve => {resetReply = resolve}))
    assert.strictEqual(ledger.bytes, 70)
    budget.observe(resetFirst ? 50 : 70)
    if (resetFirst) { resetReply(); await reloading }
    else { decodeReply(); await decode }
    assert.strictEqual(ledger.bytes, 70, 'One receipt refunded another producer')
    budget.observe(resetFirst ? 70 : 50)
    if (resetFirst) { decodeReply(); await decode }
    else { resetReply(); await reloading }
    assert.strictEqual(ledger.bytes, resetFirst ? 70 : 50)
    budget.observe(50)
  }
  await assert.rejects(budget.runReset(50, () => {
    budget.observe(0)
    return Promise.reject(new Error('reset production failed'))
  }), /reset production failed/)
  assert.strictEqual(ledger.bytes, 0, 'Failure after reset retained destroyed records')
  budget.close(); assert.strictEqual(ledger.bytes, 0)
}

async function verifyHeightTermination(maximumBytes = 100, expectedCredit = 40) {
  let posted, terminated
  const ledger = new ResourceLedger(maximumBytes)
  const client = new TerrainWorkerClient({
    postMessage(message) { posted = message },
    terminate() { return new Promise(resolve => {terminated = resolve}) }
  })
  client.setResourceLedger(ledger)
  const task = client.requestTerrain({type: 'advance'})
  const rejected = assert.rejects(task, /destroyed/)
  client.receive({id: posted.id, memoryBytes:0,nativeRevision: 0, nativeBytes: 0, recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0,
    value: {heightPending: true, heightWorkBytes: 40, workId: 1}})
  for (let i = 0; i < 8 && posted.type !== 'terrain-continue'; ++i) await Promise.resolve()
  assert.strictEqual(posted.type, 'terrain-continue')
  assert.strictEqual(posted.heightCreditBytes, expectedCredit)
  assert.strictEqual(ledger.bytes, expectedCredit)
  const closing = client.destroy()
  await Promise.resolve()
  assert.strictEqual(ledger.bytes, expectedCredit, 'Worker cancellation refunded an active height producer')
  terminated(); await closing; await rejected
  assert.strictEqual(ledger.bytes, 0)
}

async function main() {
  await verifyReset()
  await verifyHeightTermination()
  await verifyHeightTermination(1000, 320)
  const ledger = new ResourceLedger(100), budget = new NativePayloadBudget(ledger, 'terrain-record-native')
  let replyA, replyB
  const a = budget.run(40, () => new Promise(resolve => {replyA = resolve}))
  const b = budget.run(40, () => new Promise(resolve => {replyB = resolve}))
  budget.observe(70)
  replyB(); await b
  assert.strictEqual(ledger.bytes, 80, 'One receipt prematurely refunded another producer')
  replyA(); await a
  assert.strictEqual(ledger.bytes, 70)
  let produced = 0
  const waiting = budget.run(40, () => {++produced; budget.observe(90)})
  await Promise.resolve()
  assert.strictEqual(produced, 0, 'Unfunded record production started')
  budget.observe(50)
  await waiting
  assert.strictEqual(ledger.bytes, 90)
  const cancelled = budget.run(40, () => {throw new Error('cancelled producer ran')})
  cancelled.cancel()
  await assert.rejects(cancelled, /cancelled/)
  assert.strictEqual(ledger.bytes, 90)
  assert.throws(() => budget.observe(91), /exceeded its credit/)
  budget.observe(40)
  const failed = budget.run(30, () => {budget.observe(40); return Promise.reject(new Error('bad record'))})
  await assert.rejects(failed, /bad record/)
  assert.strictEqual(ledger.bytes, 40)
  budget.close(); assert.strictEqual(ledger.bytes, 0)

  // A rejected RPC is not the end of an asynchronous platform producer.
  // Native record and mesh work both remain funded until termination receipt.
  let client, terminate, posted
  const shared = new ResourceLedger(100)
  const worker = {
    postMessage(message) {posted = message},
    terminate() {return new Promise(resolve => {terminate = resolve})}
  }
  client = new TerrainWorkerClient(worker, {workerTimeoutMs: 1000})
  client.setResourceLedger(shared)
  client.nativeBudget.begin(shared.reserve('mesh-native', 20))
  client.recordBudget.run(36, () => client.recordBudget.observe(36))
  client.manifest = {patchDimension: 2}
  const request = client.loadManifest({patchDimension: 3})
  assert.strictEqual(client.manifest.patchDimension, 2, 'Pending reset published its manifest')
  let releasedInput = false
  request.catch(() => {releasedInput = true})
  const rejected = assert.rejects(request, /destroyed/)
  assert.strictEqual(posted.recordCreditBytes, 36)
  const terminated = client.destroy()
  await Promise.resolve()
  assert(!releasedInput, 'RPC rejection allowed input credit to return before termination')
  client.nativeBudget.finish()
  assert.strictEqual(shared.bytes, 56, 'Termination in progress refunded native producers')
  terminate(); await terminated; await rejected
  assert(releasedInput)
  assert.strictEqual(shared.bytes, 0)

  // Replies report actual native ownership even when the operation fails.
  let receive
  const owned = new ResourceLedger(100)
  const remote = new TerrainWorkerClient({terminate() {}, postMessage(message) {
    receive = () => remote.receive({id: message.id, memoryBytes:0,nativeRevision: 1, nativeBytes: 0,
      recordBytes: 20, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, error: 'decode failed'})
  }})
  remote.setResourceLedger(owned)
  const failure = remote.produceRecord(40, 'submitRecord', [])
  const checked = assert.rejects(failure, /decode failed/)
  assert.strictEqual(owned.bytes, 40)
  receive(); await checked
  assert.strictEqual(owned.bytes, 20, 'Failed RPC lost actual retained native ownership')
  remote.destroy(); assert.strictEqual(owned.bytes, 0)
  console.log('Native record grants, reset reuse, queued cancellation, concurrent receipts and producer termination passed')
}
const deadline = setTimeout(() => {console.error('Native record credit contract did not finish'); process.exit(1)}, 10000)
main().catch(error => {console.error(error); process.exitCode = 1}).finally(() => clearTimeout(deadline))
