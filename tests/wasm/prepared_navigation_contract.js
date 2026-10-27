const assert = require('assert')
const fs = require('fs'), path = require('path')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {NativePayloadBudget} = require('../../sdk/js/resources/native_payload_budget')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {invertMatrix4} = require('../../sdk/js/math/matrix')
const preparedSurface = require('./prepared_surface_contract')

// Exercise the successor forecast on actual oblique-view terrain, including
// thousands of clipped projection regions. This is an input-ownership/parity
// contract, not evidence that the production runtime has joint admission.
module.exports = async function verifyPreparedNavigation(module) {
  const directory = path.join(__dirname, '../../testdata/miniprogram/navigation_terrain')
  const catalogue = JSON.parse(fs.readFileSync(path.join(directory, 'terrain-records.json')))
  const bytes = fs.readFileSync(path.join(directory, 'terrain-records.bin'))
  const records = new Map(catalogue.records.map(row => [row.key.join('/'), row]))
  const descriptor = {kind:'global-geodetic', matrix_level_offset:0, minimum_level:0, maximum_level:17,
    tile_size:256, level_zero_columns:2, level_zero_rows:1, bounds:[[-180,-90],[180,90]]}
  const manifest = {formatVersion:1, patchDimension:64, transform:'cylindrical', heightScale:0.015625,
    minimumU:-180, minimumV:-90, maximumU:180, maximumV:90, radius:6378000, texture:descriptor}
  const abi = new TerraAbi(module), ledger = new ResourceLedger(16 * 1024 * 1024)
  let predictor, task
  try {
    abi.loadManifest(manifest)
    abi.setViewport(640, 360, 30 * (3.14 / 180))
    abi.setGlobeTarget(116.5623, 40.74863)
    abi.setCamera({distance:9567, tiltRadians:-76.3 * Math.PI / 180,
      yawRadians:68.27680000002681 * Math.PI / 180})
    const threshold = 0.0018597704681097907
    const budget = {maximumChangeCount:32, maximumPriorityUpdateCount:256,
      maximumElapsedMs:0, maximumNodeCount:65536, meshBudgetBytes:8 * 1024 * 1024}
    for (let round = 0; ; ++round) {
      assert(round < 512, 'Prepared navigation terrain failed to settle')
      const progress = abi.advanceTerrain(threshold, budget), requests = abi.getRequests()
      for (const request of requests) {
        const k = request.key, key = [request.kind, k.i, k.j, k.k].join('/'), row = records.get(key)
        assert(row, 'Uncaptured prepared-navigation terrain key: ' + key)
        if (row.status === 404) abi.noDataRecord(k)
        else abi.submitRecord(request.kind, k, bytes.subarray(row.offset, row.offset + row.bytes))
      }
      if (!requests.length && !progress.budgetExhausted && !progress.pendingPriorityUpdateCount) break
    }
    const packet = abi.prepareMeshFrame(threshold, budget), samples = new Map()
    const indices = abi.getIndices(), adapter = new ImageryAdapter(descriptor)
    const context = surface.projectionContext(packet.frame, {width:640,height:360},
      invertMatrix4(packet.frame.projectionView))
    const draws = packet.draws.filter(draw => !(draw.flags & 1)).map(draw => adapter.prepareDraw(draw))
    const measured = new Map()
    const {preparedSurfaceBytes} = require('../../adapters/wasm/prepared_surface')
    const measure = (draw, mesh) => {
      const model = surface.prepareSurface(mesh.positions, mesh.textureUv, indices, draw.firstIndex, draw.indexCount)
      return {...surface.measureSurface(model, draw.origin, context, true), bounds:model.bounds, hull:model.hull}
    }
    for (const draw of draws) {
      if (samples.has(draw.resourceId)) continue
      task = abi.createPreparedSurfaceTask(packet.nativePlan.id, draw, preparedSurfaceBytes(draw))
      const mesh = await task.run(() => Promise.resolve())
      samples.set(draw.resourceId, mesh); measured.set(draw.resourceId, measure(draw, mesh))
    }
    const visible = [...measured.values()].filter(m => m.visible)
    const regions = visible.reduce((n, m) => n + m.regions.length, 0)
    const hull = visible.reduce((n, m) => n + m.hull.length, 0)
    assert(draws.length > 200 && regions > 20000, 'Fixture lost the dense oblique candidate')
    assert.strictEqual(abi.meshPayloadBytes(), 0, 'Forecast sampling materialized the candidate')
    assert.throws(() => abi.getFrame(), error => error.status === 2, 'Forecast sampling published a frame')

    // Only input conversion/storage is funded here. Native tree/queue memory,
    // JS measurement metadata and GPU destinations are deliberately separate.
    abi.imageryInputBudget = new NativePayloadBudget(ledger, 'imagery-input-native', 0)
    const options = {descriptor, detached:true, targetPixelError:1.25,
      maximumTextures:256, maximumDraws:4096}
    const display = abi.getImageryPlanner()
    const first = draws.find(draw => measured.get(draw.resourceId).visible)
    const shown = display.plan([first], draw => measured.get(draw.resourceId), options)
    const resident = abi.imageryInputPayloadBytes()
    const inputBytes = module.call('terra_imagery_input_work_bytes', visible.length, visible.length, regions, hull) >>> 0
    const scratchBytes = 52 + 48 + Math.min(regions, 256) * 176 + Math.min(hull, 256) * 16
    predictor = abi.createImageryPlanner()
    ledger.setLimit(resident + inputBytes + scratchBytes - 1)
    assert.throws(() => predictor.plan(draws, draw => measured.get(draw.resourceId), options),
      error => error.status === 9, 'Unfunded candidate input was produced')
    assert.strictEqual(abi.imageryInputPayloadBytes(), resident)
    assert.deepStrictEqual(display.readPlan([first], options), shown, 'Refusal changed the displayed cut')

    ledger.setLimit(resident + inputBytes + scratchBytes)
    task = predictor.createTask(draws, draw => measured.get(draw.resourceId), options)
    task.maximumSteps = 1
    while (!abi.imageryPackingBytes) assert(!task.step().done)
    assert(abi.imageryInputPayloadBytes() > resident, 'Candidate did not stage its owned input')
    task.cancel()
    assert.strictEqual(ledger.bytes, resident, 'Cancelled candidate retained input credit')
    assert.deepStrictEqual(display.readPlan([first], options), shown)
    let forecast, slices = 0, rounds = 0
    do {
      task = predictor.createTask(draws, draw => measured.get(draw.resourceId),
        {...options, maximumRounds:1, continuation:rounds > 0})
      task.maximumSteps = 1
      let next
      do {
        next = task.step()
        assert(++slices < 8192, 'Prepared forecast did not converge within its bounded continuations')
        if (slices === 2) module.exports.memory.grow(1)
        if (slices % 32 === 0) assert.deepStrictEqual(display.readPlan([first], options), shown,
          'Candidate continuation changed displayed planning state')
        if (!next.done) await Promise.resolve()
      } while (!next.done)
      forecast = next.value; ++rounds
    } while (!forecast.quality.planningComplete)
    assert(slices > 100, 'Dense candidate did not exercise persistent input/native work')
    const ownedInput = abi.imageryInputPayloadBytes()
    assert(ownedInput > resident && ownedInput <= resident + inputBytes,
      'Converted input exceeded its production quote or lost ownership')
    assert.strictEqual(ledger.bytes, ownedInput, 'Converted input did not refund unused production credit')
    assert.strictEqual(abi.imageryPackingBytes, 0, 'Completed input retained its packing workspace')
    assert.strictEqual(abi.imageryInputBudget.credits.size, 0, 'Completed input retained a production grant')
    assert(forecast.quality.meetsTarget && forecast.quality.measuredMaxPixelError <= 1.25)
    const plannerBytes = abi.imageryPayloadBytes()
    assert.strictEqual(abi.meshPayloadBytes(), 0)
    predictor.destroy(); predictor = null
    assert.strictEqual(ledger.bytes, resident)
    assert.deepStrictEqual(display.readPlan([first], options), shown)

    abi.materializeMeshFrame(packet); abi.commitMeshFrame(packet)
    preparedSurface.verify(abi, {draws}, samples)
    for (const draw of draws) assert.deepStrictEqual(measure(draw, abi.copyMeshResource(draw)),
      measured.get(draw.resourceId), 'Publication changed the forecast measurement')
    const actual = display.plan(draws, draw => measured.get(draw.resourceId), options)
    assert.deepStrictEqual(actual.draws, forecast.draws, 'Publication changed the forecast imagery cut')
    assert.deepStrictEqual(actual.quality, forecast.quality, 'Publication changed forecast quality')
    console.log(`Prepared navigation: ${draws.length} draws, ${regions} regions, ${slices} slices, ` +
      `${ownedInput - resident} input bytes (quote ${inputBytes}), ` +
      `${plannerBytes} total native imagery bytes; refusal, cancellation and publication parity passed`)
  } finally {
    if (task) task.cancel()
    if (predictor) predictor.destroy()
    abi.destroy()
  }
  assert.strictEqual(ledger.bytes, 0, 'Destroyed forecast retained input ownership')
}
