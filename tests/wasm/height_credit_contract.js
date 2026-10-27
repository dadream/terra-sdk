const assert = require('assert')
const fs = require('fs'), path = require('path')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')

// The same real producer must refuse unfunded work, release its cursor, resume
// after capacity changes and reclaim only idle heights on both transports.
module.exports = async function verifyHeightCredit(abi, manifest, worker) {
  const ledger = new ResourceLedger(8 * 1024 * 1024)
  abi.setResourceLedger(ledger)
  await abi.loadManifest(manifest)
  abi.setViewport(640, 360, Math.PI / 6)
  abi.setGlobeTarget(0, 0)
  abi.setCamera({distance: 18000000, tiltRadians: 0, yawRadians: 0})
  const budget = {maximumChangeCount: 8, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0}
  const advance = async threshold => {
    const value = await abi.advanceTerrain(threshold, budget)
    return worker ? value : {progress: value, requests: abi.getRequests()}
  }
  let state = await advance(1)
  const root = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_root_0_record.bin'))
  for (const request of state.requests) await abi.submitRecord(request.kind, request.key, root)
  const rootBytes = 65 * 66 * 4, before = ledger.bytes
  ledger.setLimit(before + rootBytes - 1)
  await assert.rejects(advance(1), error => error.status === 9 && Array.isArray(error.requests))
  assert.strictEqual(abi.heightBudget.actual, 0, 'One-byte-short grant produced height data')
  assert.strictEqual(ledger.bytes, before, 'Refused height work retained an issued grant')
  assert.strictEqual(abi.heightBudget.credits.size, 0)
  ledger.setLimit(8 * 1024 * 1024)
  const quotes = [], owner = abi.heightBudget, begin = owner.begin.bind(owner)
  owner.begin = bytes => {
    const credit = begin(bytes)
    if (credit) quotes.push(bytes)
    return credit
  }
  state = await advance(1)
  assert.strictEqual(owner.actual, 8 * rootBytes)
  assert.strictEqual(owner.stats().creditedBytes, owner.actual)
  assert.strictEqual(ledger.bytes, abi.recordBudget.actual + owner.actual)
  assert(quotes.length >= 1 && quotes.length <= 8, 'Bounded root batches made no progress')
  assert.strictEqual(quotes[0], 8 * rootBytes, 'Available room did not fund a bounded root batch')
  assert(quotes.every(bytes => bytes >= rootBytes && bytes <= 256 * 1024),
    'Height continuation exceeded its bounded preferred grant')
  const trim = () => worker ? abi.send({type: 'trim-heights', needed: owner.actual}) : abi.reclaimHeights(owner.actual)
  await trim()
  assert.strictEqual(owner.actual, 8 * rootBytes, 'Trim removed the current selection inputs')
  abi.setCamera({distance: 3000000, tiltRadians: -0.7, yawRadians: 0.3})
  state = await advance(0.005)
  for (const request of state.requests) if (request.kind === 2) await abi.noDataRecord(request.key)
  const beforeRecovery = owner.actual
  const recovery = await abi.advanceTerrain(0.005, {...budget, coarseningOnly: true})
  assert.strictEqual((worker ? recovery.progress : recovery).heightBuildCount, 0,
    'Coarsening produced speculative children instead of releasing capacity')
  assert.strictEqual(owner.actual, beforeRecovery)
  for (let turn = 0; turn < 8; ++turn) {
    state = await advance(0.005)
    for (const request of state.requests) {
      if (request.kind === 1) await abi.submitRecord(request.kind, request.key, root)
      else await abi.noDataRecord(request.key)
    }
  }
  const detailed = owner.actual
  assert(detailed > 8 * rootBytes, 'Refinement fixture has no idle-height candidates')
  abi.setCamera({distance: 30000000, tiltRadians: 0, yawRadians: 0})
  for (let turn = 0; turn < 40; ++turn) {
    state = await advance(1)
    if (!state.progress.pendingPriorityUpdateCount && !state.progress.budgetExhausted &&
        (!worker || state.selectionViewRevision === abi.viewRevision)) break
  }
  await trim()
  assert(owner.actual < detailed && owner.actual >= 8 * rootBytes,
    'Coarsened heights did not release idle storage or lost the active roots')
  assert.strictEqual(ledger.bytes, abi.recordBudget.actual + owner.actual)
  owner.begin = begin
  await abi.loadManifest(manifest)
  assert.strictEqual(owner.actual, 0, 'Source replacement retained old heights')
  console.log(`${worker ? 'Worker' : 'Direct'} height admission, refusal recovery, active protection and idle reclamation passed`)
}
