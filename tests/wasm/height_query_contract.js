const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {sampleRegion, queryGrid, HeightRegions} = require('../../sdk/js/terrain/height_regions')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')

const manifest = {formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
  heightScale: 1 / 512, minimumU: -180, minimumV: -90, maximumU: 180, maximumV: 90,
  radius: 6378000, texture: {kind: 'global-geodetic', matrix_level_offset: 0, maximum_level: 18,
    minimum_level: 0, tile_size: 256, level_zero_columns: 2, level_zero_rows: 1,
    bounds: [[-180, -90], [180, 90]]}}

module.exports = async function verify(abi, worker = false) {
  const directory = path.join(__dirname, '../../testdata/miniprogram/golden')
  const root = fs.readFileSync(path.join(directory, 'globe_root_0_record.bin'))
  const detail = fs.readFileSync(path.join(directory, 'globe_patch_record.bin'))
  const options = {u: 116.5623, v: 40.74863, sampleSpacingMeters: 1,
    maximumLevel: 6, maximumBytes: 2 * 1024 * 1024}
  await abi.loadManifest(manifest)
  const before = await abi.sampleTerrain(options.u, options.v)
  assert.strictEqual(before.status, 'unavailable')
  async function run(absent, query = options) {
    const first = await abi.beginHeightQuery(query)
    let result, requests = 0, maximumFrontier = 0
    try {
      for (let i = 0; i < 10000; ++i) {
        result = await abi.stepHeightQuery(first.id, 32)
        assert(result.payloadBytes <= result.maximumBytes && result.peakBytes <= result.maximumBytes)
        if (result.state >= 4) {
          if (result.sample.available) await assert.rejects(async () => abi.getHeightQueryRegion(first.id, 1),
            cause => cause.status === 6, 'Region export exceeded admitted receiver capacity')
          const region = result.sample.available ? await abi.getHeightQueryRegion(first.id, 2145) : null
          return {result, region, requests, maximumFrontier}
        }
        if (result.state !== 3) continue
        const held = await abi.stepHeightQuery(first.id, 32)
        assert.deepStrictEqual(held, result, 'I/O wait mutated query or continuously allocated')
        maximumFrontier = Math.max(maximumFrontier, result.requests.length)
        for (const request of result.requests.slice().reverse()) {
          ++requests
          if (absent && request.kind === 2 && request.key.level >= 2)
            await abi.heightQueryUnavailable(first.id, request.kind, request.key, false)
          else await abi.submitHeightQueryRecord(first.id, request.kind, request.key, request.kind === 1 ? root : detail)
        }
      }
      throw new Error('Height query failed to complete')
    } finally { await abi.endHeightQuery(first.id) }
  }
  const fine = await run(false)
  assert.strictEqual(fine.result.state, 5)
  assert.strictEqual(fine.result.reasons, 4)
  assert.strictEqual(fine.result.sample.level, 6)
  assert.strictEqual(fine.result.sample.dataLevel, 6)
  assert(fine.requests > 1 && fine.maximumFrontier <= 8)
  assert.strictEqual(fine.result.payloadBytes, fine.region.heights.byteLength,
    'Finished query retained heights beyond the exported target fragment')
  assert.strictEqual(sampleRegion(fine.region, queryGrid(options.u, options.v, manifest)), fine.result.sample.heightMeters)
  const nearby = Object.assign({}, options, {u: options.u + 0.001, v: options.v - 0.001})
  const oracle = await run(false, nearby)
  assert.strictEqual(sampleRegion(fine.region, queryGrid(nearby.u, nearby.v, manifest)), oracle.result.sample.heightMeters,
    'Cached region extrapolates or disagrees with independent nearby reconstruction')
  const limited = await run(true)
  assert.strictEqual(limited.result.state, 5)
  assert(limited.result.reasons & 1)
  assert(limited.result.sample.available && limited.result.sample.level === 6 &&
    limited.result.sample.dataLevel <= 2, 'Zero residual invented source precision or stopped reconstruction')
  assert(limited.requests < fine.requests, 'Known absence continued requesting synthetic descendants')
  assert.strictEqual(sampleRegion(limited.region, queryGrid(options.u, options.v, manifest)), limited.result.sample.heightMeters)
  const ledger = new ResourceLedger(), regions = new HeightRegions(ledger)
  const reservation = regions.reserve(64)
  try {
    regions.publish(reservation, limited.region, Object.assign({}, limited.result.sample,
      {source: 'cbdam-query', reasons: ['no-data', 'source-level'], verticalAccuracyMeters: null}))
    const hit = regions.sample(options, manifest)
    assert(hit.cacheHit && hit.status === 'limited' && hit.dataLevel <= 2)
    assert(hit.reasons.includes('no-data') && hit.reasons.includes('source-level'))
    const coarser = regions.sample(Object.assign({}, options, {sampleSpacingMeters: 1e9}), manifest)
    assert.strictEqual(coarser.status, 'ready')
    assert(!coarser.reasons.includes('source-level'), 'Cache reused the previous caller precision decision')
    assert.strictEqual(regions.sample(Object.assign({}, options, {maximumLevel: 5}), manifest), null,
      'Cache ignored the caller level ceiling')
    assert.strictEqual(regions.sample(Object.assign({}, options, {maximumLevel: 7}), manifest), null,
      'Cache suppressed a finer reconstruction demand')
    assert.strictEqual(regions.sample(Object.assign({}, options, {u: -116}), manifest), null,
      'Cache projected a point on the opposite cylinder face')
  } finally { reservation.cancel(); regions.clear() }
  assert.strictEqual(ledger.bytes, 0)
  assert.deepStrictEqual(await abi.sampleTerrain(options.u, options.v), before,
    'Independent query mutated the visible height cache')

  let first = await abi.beginHeightQuery(options)
  await abi.endHeightQuery(first.id)
  await assert.rejects(async () => abi.getHeightQueryRegion(first.id, 2145), cause => cause.status === 1)
  const next = await abi.beginHeightQuery(options)
  assert.notStrictEqual(next.id, first.id)
  await assert.rejects(async () => abi.stepHeightQuery(first.id, 1), cause => cause.status === 1)
  await assert.rejects(async () => abi.endHeightQuery(first.id), cause => cause.status === 1)
  assert.strictEqual((await abi.stepHeightQuery(next.id, 1)).id, next.id)
  await abi.endHeightQuery(next.id)

  first = await abi.beginHeightQuery(Object.assign({}, options, {sampleSpacingMeters: 1e8}))
  let waiting
  do { waiting = await abi.stepHeightQuery(first.id, 32) } while (waiting.state !== 3)
  const request = waiting.requests[0]
  await assert.rejects(async () => abi.submitHeightQueryRecord(first.id, request.kind, request.key, detail),
    cause => cause.status === 4, 'Wrong shape decoded into query storage')
  assert.strictEqual((await abi.stepHeightQuery(first.id, 0)).payloadBytes, 0)
  await abi.submitHeightQueryRecord(first.id, request.kind, request.key, root)
  let ready
  do { ready = await abi.stepHeightQuery(first.id, 32) } while (ready.state < 4)
  assert.strictEqual(ready.state, 4)
  assert.strictEqual(ready.sample.level, 0)
  await abi.endHeightQuery(first.id)
  // Reload is a new dataset lifetime; IDs cannot revive old submissions.
  first = await abi.beginHeightQuery(options)
  await abi.loadManifest(manifest)
  await assert.rejects(async () => abi.stepHeightQuery(first.id, 1), cause => cause.status === 1)

  // Rendering can satisfy a query from its cache while the query's own I/O is
  // still in flight. A late response must acknowledge that exact input without
  // restarting the query, allocating another record, or replacing its result.
  first = await abi.beginHeightQuery(options)
  await abi.setViewport(640, 360, Math.PI / 4)
  await abi.setGlobeTarget(options.u, options.v)
  await abi.setCamera({distance: 510240, tiltRadians: 0, yawRadians: 0})
  let lastReceipt, raceResult, kinds = new Set(), cacheKinds = new Set()
  const equalRequest = (a, b) => a.kind === b.kind && JSON.stringify(a.key) === JSON.stringify(b.key)
  const duplicate = async request => {
    const before = await abi.stepHeightQuery(first.id, 0)
    await abi.submitHeightQueryRecord(first.id, request.kind, request.key, new Uint8Array([255]))
    await abi.heightQueryUnavailable(first.id, request.kind, request.key, true)
    await abi.heightQueryUnavailable(first.id, request.kind, request.key, false)
    assert.deepStrictEqual(await abi.stepHeightQuery(first.id, 0), before,
      'Late receipt decoded data, changed precision, or mutated the query')
  }
  try {
    for (let i = 0; i < 10000; ++i) {
      raceResult = await abi.stepHeightQuery(first.id, 32)
      if (raceResult.state >= 4) break
      if (raceResult.state !== 3) continue
      const held = raceResult.requests
      const advancement = await abi.advanceTerrain(0.001,
        {maximumChangeCount: 4, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0})
      const renderRequests = worker ? advancement.requests : abi.getRequests()
      for (const request of held) {
        const bytes = request.kind === 1 ? root : detail
        if (renderRequests.some(r => equalRequest(r, request))) {
          await abi.submitRecord(request.kind, request.key, bytes)
          cacheKinds.add(request.kind)
        } else await abi.submitHeightQueryRecord(first.id, request.kind, request.key, bytes)
        kinds.add(request.kind)
      }
      let consumed = false
      for (let j = 0; j < 10000; ++j) {
        const state = await abi.stepHeightQuery(first.id, 32)
        if (!held.some(r => state.requests.some(p => equalRequest(r, p)))) { consumed = true; break }
      }
      assert(consumed, 'Rendering cache did not satisfy outstanding height inputs')
      for (const request of held) await duplicate(request)
      lastReceipt = held[held.length - 1]
    }
    assert.deepStrictEqual(Object.assign({}, raceResult.sample, {revision: 0}),
      Object.assign({}, fine.result.sample, {revision: 0}))
    assert.strictEqual(raceResult.reasons, fine.result.reasons)
    assert(raceResult.peakBytes <= raceResult.maximumBytes)
    assert(kinds.has(1) && kinds.has(2), 'Race regression must exercise root and detail inputs')
    assert(cacheKinds.has(1) && cacheKinds.has(2), 'Race regression must reuse rendering root and detail records')
    await duplicate(lastReceipt) // Completed query, before its release receipt.
    const unknown = Object.assign({}, lastReceipt.key, {level: 39})
    await assert.rejects(async () => abi.submitHeightQueryRecord(first.id, 2, unknown, detail),
      cause => cause.status === 7, 'Never-requested input was accepted or misreported as capacity')
    await assert.rejects(async () => abi.heightQueryUnavailable(first.id, 2, unknown, true),
      cause => cause.status === 7)
  } finally { await abi.endHeightQuery(first.id) }
  await assert.rejects(async () => abi.submitHeightQueryRecord(first.id, lastReceipt.kind, lastReceipt.key, root),
    cause => cause.status === 1, 'Released query accepted an old receipt')
  await abi.loadManifest(manifest)
  console.log((worker ? 'Worker' : 'Wasm') + ' independent CBDAM height query, cache/I/O race and stale-ID isolation passed')
  return fine.result.sample
}
