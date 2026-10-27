const assert = require('assert')
const fs = require('fs'), path = require('path')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')

module.exports = async function verifyNativeRecords(abi, manifest, worker) {
  const ledger = new ResourceLedger(1024 * 1024)
  abi.setResourceLedger(ledger)
  await abi.loadManifest(manifest)
  const zero = 4 * manifest.patchDimension * manifest.patchDimension
  const rootBytes = 4 * (manifest.patchDimension + 1) ** 2
  assert.strictEqual(abi.recordBudget.actual, zero, 'Manifest input was not funded/reported')
  assert.strictEqual(ledger.bytes, zero)
  abi.setViewport(640, 360, Math.PI / 6)
  abi.setGlobeTarget(0, 0)
  abi.setCamera({distance: 25000000, tiltRadians: 0, yawRadians: 0})
  const result = await abi.advanceTerrain(1, {maximumChangeCount: 16, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0})
  const request = (worker ? result.requests : abi.getRequests()).find(r => r.kind === 1)
  assert(request, 'Record credit fixture lacks a pending root')
  const bytes = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_root_0_record.bin'))
  const pressure = ledger.reserve('record-test-pressure', ledger.maximumBytes - ledger.bytes)
  assert(pressure)
  let completed = false
  const waiting = abi.submitRecord(request.kind, request.key, bytes)
  waiting.then(() => {completed = true})
  await new Promise(resolve => setTimeout(resolve, 10))
  assert(!completed && abi.recordBudget.actual === zero && !abi.recordBudget.credits.size,
    'Native decode started before global admission')
  pressure.release()
  await waiting
  assert.strictEqual(abi.recordBudget.actual, zero + rootBytes)
  assert.strictEqual(ledger.bytes, zero + rootBytes)
  assert.strictEqual(ledger.stats().reservedBytes, 0, 'Record completion retained production credit')
  await abi.submitRecord(request.kind, request.key, bytes)
  assert.strictEqual(ledger.bytes, zero + rootBytes, 'Duplicate data added another resident owner')
  if (worker) await abi.send({type: 'trim-records', needed: rootBytes})
  else abi.reclaimRecords(rootBytes)
  assert.strictEqual(ledger.bytes, zero + rootBytes, 'Reclamation lost an active dependency')
  // Reset destroys the old decoded payload before producing the new zero input.
  // A full ledger must not require both generations to fit simultaneously.
  ledger.setLimit(ledger.bytes)
  const reload = async value => {
    let timer, operation
    try {
      operation = abi.loadManifest(value)
      return await Promise.race([operation, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Funded manifest reset stalled')), 1000)
      })])
    } finally {
      clearTimeout(timer)
      if (operation && operation.cancel) operation.cancel()
    }
  }
  await reload(manifest)
  assert.strictEqual(ledger.bytes, zero, 'Manifest reset lost its actual release receipt')
  assert.strictEqual(abi.recordBudget.actual, zero)
  ledger.setLimit(zero)
  await reload(manifest)
  const previousAdapter = abi.imageryAdapter
  const invalid = Object.assign({}, manifest, {formatVersion: 999,
    texture: Object.assign({}, manifest.texture, {maximum_level: 7})})
  await assert.rejects(reload(invalid), /terra_load_terrain_manifest/)
  assert.strictEqual(abi.manifest, manifest, 'Refused reset published a new manifest')
  assert.strictEqual(abi.imageryAdapter, previousAdapter, 'Refused reset changed imagery coordinates')
  assert.strictEqual(ledger.bytes, zero, 'Refused reset lost old record credit')
  assert.strictEqual(ledger.stats().reservedBytes, 0)
  await reload(manifest)
  assert.strictEqual(ledger.bytes, zero)
  // Subsequent contracts choose their own policy; migrate already owned bytes
  // only after the new ledger has admitted them.
  abi.setResourceLedger(new ResourceLedger())
  assert.strictEqual(ledger.bytes, 0, 'Ledger transfer kept the old charge')
  console.log((worker ? 'Worker' : 'Direct Wasm') + ' predecode credit, delayed admission, full-budget reset and failure receipts passed')
}
