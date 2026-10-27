const assert = require('assert')
const fs = require('fs')
const path = require('path')
const loader = require('../../adapters/wasm/terra_wasm')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')

const manifest = {formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
  heightScale: 1 / 512, minimumU: -180, minimumV: -90, maximumU: 180, maximumV: 90,
  radius: 6378000, texture: {kind: 'global-geodetic', matrix_level_offset: 0,
    maximum_level: 18, minimum_level: 0, tile_size: 256,
    level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180, -90], [180, 90]]}}

module.exports = async function verifyTerrainWait(bytes) {
  const imports = loader.createTerraImports()
  let now = 0, tick = 0
  imports.env.terra_monotonic_milliseconds = () => { now += tick; return now }
  const module = loader.initializeTerraInstance(await WebAssembly.instantiate(bytes, imports), imports)
  const abi = new TerraAbi(module)
  const root = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_root_0_record.bin'))
  const detail = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_patch_record.bin'))
  const budget = {maximumChangeCount: 4, maximumPriorityUpdateCount: 256, maximumElapsedMs: 4}
  try {
    abi.loadManifest(manifest)
    abi.setViewport(1280, 720, Math.PI / 4)
    abi.setGlobeTarget(116.5623, 40.74863)
    abi.setCamera({distance: 510240, tiltRadians: 0, yawRadians: 0})
    let state = abi.advanceTerrain(0.001, budget)
    assert.strictEqual(state.pendingPriorityUpdateCount, 0)
    assert(abi.getRequests().some(request => request.kind === 1))
    const waitingRevision = state.modelRevision
    // Expire every slice after its first clock read, with no runnable work.
    // Missing records must remain event-driven even on a slow host.
    tick = 4
    for (let turn = 0; turn < 8; ++turn) {
      state = abi.advanceTerrain(0.001, budget)
      assert.strictEqual(state.pendingPriorityUpdateCount, 0)
      assert.strictEqual(state.topologyChangeCount, 0)
      assert.strictEqual(state.modelRevision, waitingRevision)
      assert.strictEqual(state.budgetExhausted, false, 'I/O wait advertised runnable terrain continuation')
    }
    // Arrival must still wake priorities and preserve real clock exhaustion.
    abi.getRequests().filter(request => request.kind === 1).forEach(request =>
      abi.submitRecord(request.kind, request.key, root))
    state = abi.advanceTerrain(0.001, budget)
    assert(state.budgetExhausted && state.pendingPriorityUpdateCount > 0,
      'An unfinished priority scan lost its continuation')
    tick = 0
    for (let turn = 0; turn < 8; ++turn) {
      state = abi.advanceTerrain(0.001, budget)
      if (!state.pendingPriorityUpdateCount) break
    }
    assert.strictEqual(state.pendingPriorityUpdateCount, 0)
    const requests = abi.getRequests().filter(request => request.kind === 2)
    assert(requests.length > 0, 'Root arrival lost the pending detail frontier')
    tick = 4
    state = abi.advanceTerrain(0.001, budget)
    assert.strictEqual(state.budgetExhausted, false, 'Waiting for detail records spun the model')
    requests.forEach(request => abi.submitRecord(request.kind, request.key, detail))
    tick = 0
    let changes = 0
    for (let turn = 0; turn < 8; ++turn) {
      state = abi.advanceTerrain(0.001, budget)
      assert(state.topologyChangeCount <= budget.maximumChangeCount)
      changes += state.topologyChangeCount
    }
    assert(changes > 0, 'Data arrival did not resume bounded refinement')
    console.log('Wasm terrain I/O parking, clock continuation and data wakeup passed')
  } finally { abi.destroy() }
  verifyFrozenFrontier(module)
}

function verifyFrozenFrontier(module) {
  const abi = new TerraAbi(module)
  const directory = path.join(__dirname, '../../testdata/miniprogram/golden')
  // The frozen Web replay needs an asymmetric dependency frontier: a uniform
  // maximum level does not exercise waiting neighbour splits. Store only keys
  // and references to existing record bytes, not a second terrain dataset.
  const records = new Map(require('../../testdata/miniprogram/golden/terrain_wait_records.json')
    .map(row => [row.slice(0, 5).join(','), fs.readFileSync(path.join(directory, row[5]))]))
  const threshold = 0.0009298852340548953
  const budget = {maximumChangeCount: 32, maximumPriorityUpdateCount: 256,
    maximumElapsedMs: 0, meshBudgetBytes: 16 * 1024 * 1024}
  try {
    abi.loadManifest(manifest)
    abi.setViewport(1280, 720, Math.PI / 6)
    abi.setGlobeTarget(116.4074, 39.9042)
    abi.setCamera({distance: 1913400, tiltRadians: 0, yawRadians: 74 * Math.PI / 180})
    let parked
    for (let turn = 0; turn < 100; ++turn) {
      const state = abi.advanceTerrain(threshold, budget)
      let received = 0
      for (const request of abi.getRequests()) {
        const key = request.key
        const bytes = records.get([request.kind, key.level, key.i, key.j, key.k].join(','))
        if (bytes) { abi.submitRecord(request.kind, key, bytes); ++received }
      }
      if (!received && !state.budgetExhausted && !state.pendingPriorityUpdateCount &&
          state.topologyChangeCount === 0) {
        parked = state; break
      }
    }
    assert(parked && abi.getRequests().length > 0, 'Frozen terrain did not reach an I/O wait')
    for (let turn = 0; turn < 3; ++turn) {
      const packet = abi.prepareMeshFrame(threshold, {...budget, maximumChangeCount: 0})
      try {
        assert.strictEqual(packet.updateState.budgetExhausted, false,
          'Preparing an unchanged cut forgot the model I/O wait')
        assert.strictEqual(packet.updateState.modelRevision, parked.modelRevision)
        assert.strictEqual(packet.updateState.topologyChangeCount, 0)
        assert.strictEqual(packet.frame.decisionsComplete, false,
          'Parking missing data must not claim precision convergence')
        assert(packet.frame.requestCount > 0, 'Preparing a parked cut dropped its data demand')
      } finally { abi.discardMeshPlan(packet.nativePlan) }
      const state = abi.advanceTerrain(threshold, budget)
      assert.strictEqual(state.budgetExhausted, false)
      assert.strictEqual(state.modelRevision, parked.modelRevision)
    }
    const detail = fs.readFileSync(path.join(directory, 'globe_patch_record.bin'))
    abi.getRequests().filter(request => request.kind === 2).forEach(request =>
      abi.submitRecord(request.kind, request.key, detail))
    let changes = 0
    for (let turn = 0; turn < 8; ++turn) {
      const state = abi.advanceTerrain(threshold, budget)
      assert(state.topologyChangeCount <= budget.maximumChangeCount)
      changes += state.topologyChangeCount
    }
    assert(changes > 0, 'A parked dependency frontier did not wake when records arrived')
    console.log('Wasm frozen neighbour frontier preserves I/O wait through preparation and wakes on data')
  } finally { abi.destroy() }
}
