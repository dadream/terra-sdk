const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {TerraPlanarRuntime} = require('../../adapters/wasm/terra_globe_runtime')
const createOwner = require('./support/terrain_owner')
const {fnv1a64} = require('../../sdk/js/core/terra_globe_common')
const {FakeCanvas, FakeGl} = require('../js/support/webgl_fixture')

async function verify(bytes, worker) {
  const abi = await createOwner(bytes, worker), gl = new FakeGl(), canvas = new FakeCanvas(gl)
  const loaded = new Set(), requests = new Set(), blocked = new Set(), receipts = [], diagnostics = []
  const record = name => fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden', name))
  const root = record('planar_root_record.bin'), detail = record('planar_root_detail_record.bin')
  const manifest = {schema:'terra.dataset-manifest', schema_version:1, dataset_id:'empty-receipt',
    format_version:1, patch_dim:64, height_scale:1e-14,
    transform:{kind:'planar', bounds:[[0,0],[1025,1025]], radius:0},
    endpoints:{root:'/root/{i}/{j}/{k}', detail:'/detail/{i}/{j}/{k}'},
    textures:[{id:'fixture', kind:'planar-tms', url_template:'/image/{z}/{x}/{y}',
      matrix_level_offset:0, maximum_level:3, tile_size:64}]}
  const maximumResourceBytes = 4 * 1024 * 1024
  let runtime, holdDetails = false, requestCount = 0, observations
  const present = abi.presentFrame.bind(abi)
  abi.presentFrame = sequence => {receipts.push(sequence); return present(sequence)}
  const turn = () => new Promise(resolve => setTimeout(resolve, 2))
  const wait = async predicate => {
    const started = Date.now()
    while (Date.now() - started < 30000) {
      for (const image of canvas.images) if (!loaded.has(image) && image.onload) {
        loaded.add(image); image.width = image.height = 64; image.onload()
      }
      assert.strictEqual(runtime.resourceLedger.maximumBytes, maximumResourceBytes)
      assert.strictEqual(runtime.resourceLedger.stats().overBudgetBytes, 0)
      assert(!runtime.lastError, runtime.lastError)
      if (predicate()) return
      await turn()
    }
    assert.fail('Actual terrain/UV/image publication did not progress: ' + JSON.stringify({
      worker, state: runtime.state(), candidate: runtime.meshFrames.candidate && runtime.meshFrames.candidate.frame}))
  }
  try {
    runtime = await TerraPlanarRuntime.create({canvas, abi, manifest, planarLevel:0,
      serviceOrigin:'http://127.0.0.1', initialTarget:{x:600,y:400}, initialTiltRadians:0,
      maximumResourceBytes, viewport:{width:640,height:360,devicePixelRatio:1},
      onDiagnostic: value => diagnostics.push(value),
      request(options) {
        ++requestCount
        const data = options.url.includes('/detail/') ? detail : root
        let resolve, reject, active = true
        const entry = {promise: new Promise((a,b) => {resolve=a; reject=b}), finish() {
          if (!active) return
          active = false; requests.delete(entry); blocked.delete(entry)
          resolve({statusCode:200, data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),
            header:{'Content-Length':String(data.byteLength), 'X-Terra-Checksum':'fnv1a64:'+fnv1a64(data)}})
        }, abort() {
          if (!active) return
          active = false; requests.delete(entry); blocked.delete(entry)
          reject(Object.assign(new Error('Fixture record cancelled'), {code:'cancelled'}))
        }}
        requests.add(entry)
        if (holdDetails && options.url.includes('/detail/')) blocked.add(entry)
        else Promise.resolve().then(() => entry.finish())
        return entry
      }})
    await wait(() => runtime.meshFrames.presented && runtime.meshFrames.presented.draws.length === 2 &&
      runtime.renderer.stats().quality.ready && !runtime.refreshing && !runtime.refreshPending)
    const shown = runtime.meshFrames.presented, shownFrame = runtime.presentedFrame
    const oldResources = Array.from(shown.resources), oldReceipts = receipts.length
    holdDetails = true
    runtime.planarLevel = 1
    await abi.setPlanarLevel(1)
    runtime.scheduleRefresh()
    await wait(() => blocked.size > 0 && runtime.lastFrame.drawCount === 0 && !runtime.refreshing)
    // Drain any illegally queued automatic acknowledgement too. Observing
    // only the candidate races its native/host receipt continuation.
    await runtime.meshReceipts.tail
    await turn()
    const missing = runtime.meshFrames.candidate
    assert(runtime.meshFrames.presented === shown,
      'Actual missing-data selection retired the displayed native/host cut')
    assert(missing && missing.frame.coverageComplete === false && !missing.draws.length)
    assert(runtime.presentedFrame === shownFrame, 'Missing data changed the presented frame')
    assert.strictEqual(receipts.length, oldReceipts, 'Empty incomplete selection reached the native receipt')
    for (const [id, resource] of oldResources)
      assert(runtime.meshFrames.resources.get(id) === resource, 'Missing data retired old CPU resource ' + id)
    assert.strictEqual(runtime.renderer.displaySurface.current.draws.length, 2)
    assert.strictEqual(runtime.renderer.stats().quality.missingCount, 0)
    assert(gl.calls.some(call => call.name === 'drawElements'), 'Fixture never submitted its old textured surface')

    holdDetails = false
    for (const entry of Array.from(blocked)) entry.finish()
    await wait(() => runtime.meshFrames.presented && runtime.meshFrames.presented.draws.length === 4 &&
      runtime.renderer.stats().quality.ready && !runtime.refreshing && !runtime.refreshPending)
    assert(receipts.length > oldReceipts, 'Data arrival did not produce a real successor receipt')
    assert.strictEqual(runtime.renderer.stats().quality.fallbackCount, 0)
    assert(runtime.renderer.partitionBytes > 0, 'Real UV output did not reach the renderer')
    assert.strictEqual(diagnostics.length, 0, JSON.stringify(diagnostics))
    observations = {worker, missingSequence:missing.frame.sequence, oldMeshes:2, finalMeshes:4,
      requestCount, maximumResourceBytes, peakManagedBytes:runtime.resourceLedger.highWaterBytes,
      finalPixelError:runtime.renderer.stats().quality.resolvedMaxPixelError}
  } finally {
    try {
      if (runtime) runtime.destroy()
      else abi.destroy()
    } finally {
      for (const entry of Array.from(requests)) entry.abort()
      if (abi.termination) await abi.termination
      await turn()
      assert.strictEqual(requests.size, 0)
      assert.strictEqual(blocked.size, 0)
      if (runtime) assert.strictEqual(runtime.resourceLedger.bytes, 0,
        'Actual terrain/UV/image ownership survived teardown')
    }
  }
  return observations
}

module.exports = async bytes => {
  const result = []
  for (const worker of [false, true]) result.push(await verify(bytes, worker))
  console.log('Wasm/Worker actual terrain, UV and image receipts preserve missing-data coverage', JSON.stringify(result))
  return result
}

if (require.main === module) module.exports(fs.readFileSync(process.argv[2])).catch(error => {
  console.error(error); process.exitCode = 1
})
