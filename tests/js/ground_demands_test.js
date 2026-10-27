const assert = require('assert')
const {GroundDemands, groundPoints, demandOptions} = require('../../sdk/js/terrain/ground_demands')
const {cameraSnapshot} = require('../../sdk/js/camera/terra_camera_snapshot')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {TerraGlobeRuntime} = require('../../adapters/wasm/terra_globe_runtime')
const ground = require('../../sdk/js/terrain/terra_ground')

const manifest = {transform: 'cylindrical', radius: 6378000}
const viewport = {width: 800, height: 600, fovRadians: 0.6}
const camera = (u = 116.5623, tilt = 76.3, heading = 14.5) => ({longitudeDegrees: u,
  latitudeDegrees: 40.74863, distance: 1000, targetHeightMeters: 500,
  tiltRadians: -tilt * Math.PI / 180, yawRadians: heading * Math.PI / 180})
const snapshot = value => cameraSnapshot(manifest, value, viewport)
const sample = (height = 500) => ({available: true, heightMeters: height,
  sampleSpacingMeters: 152, status: 'limited', reasons: ['no-data'], verticalAccuracyMeters: null})
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function fixture(options = {}) {
  const work = new Map(), requests = [], cached = []
  let changes = 0
  const runtime = {options: {terrainNavigation: options}, manifest, abi: {}, serviceOrigin: 'http://local',
    resourceLedger: new ResourceLedger(), frameClock: {
      enqueueWork: (key, callback) => work.set(key, callback), cancelWork: key => work.delete(key)
    }, heightQueries: {
      peek: (u, v) => { const value = cached.find(row => Math.hypot(u - row.u, v - row.v) <= row.radius)
        return value ? sample(value.height + (u - value.u) * 1000) : null },
      query: (u, v, value) => new Promise((resolve, reject) => requests.push({u, v, ...value, resolve, reject}))
    }}
  const demand = new GroundDemands(runtime, () => ++changes)
  const flush = async () => { const jobs = Array.from(work.values()); work.clear(); jobs.forEach(fn => fn()); await tick() }
  const finish = async (index, radius = 0.01) => {
    const request = requests[index]
    cached.push({u: request.u, v: request.v, height: 500, radius})
    request.resolve(sample()); await tick(); await flush()
  }
  const close = async () => {
    demand.destroy()
    requests.forEach(value => value.reject(Object.assign(new Error('cancelled'), {code: 'terrain_query_cancelled'})))
    await tick(); assert.strictEqual(work.size, 0); assert.strictEqual(runtime.resourceLedger.listeners.size, 0)
  }
  return {runtime, work, demand, requests, cached, flush, finish, close, changes: () => changes}
}

async function main() {
  assert.throws(() => demandOptions({sampleSpacingMeters: 0}), /Invalid/)
  for (const longitude of [-179.999, 0, 116.5623, 179.999]) {
    for (const heading of [0, 90, 180, 270]) {
      const view = snapshot(camera(longitude, 89.5, heading)), points = groundPoints(view, manifest.radius, 50)
      const up = view.cameraPosition.map(v => v / Math.hypot(...view.cameraPosition))
      assert.deepStrictEqual(points.eye.unit, up)
      const angle = 2 * Math.asin(Math.hypot(...points.front.unit.map((v, i) => v - up[i])) / 2)
      assert(Math.abs(angle * manifest.radius - 50) < 1e-6)
      const forward = [-view.viewMatrix[8], -view.viewMatrix[9], -view.viewMatrix[10]]
      assert(points.front.unit.reduce((sum, v, i) => sum + (v - up[i]) * forward[i], 0) > 0)
      assert(Math.hypot(points.eye.u - longitude, points.eye.v - 40.74863) > 0.001,
        'Demand used orbit target instead of actual eye')
    }
  }
  const top = groundPoints(snapshot(camera(116, 0)), manifest.radius, 50)
  assert.deepStrictEqual(top.eye, top.front, 'Top-down demand did not coalesce')

  const f = fixture()
  try {
    f.demand.update(snapshot(camera())); await f.flush()
    assert.strictEqual(f.requests.length, 1)
    assert.strictEqual(f.demand.job.role, 'eye')
    f.demand.update(snapshot(camera(116.5633)))
    assert(!f.requests[0].signal.aborted, 'Nearby movement starved useful reconstruction')
    await f.finish(0)
    assert.strictEqual(f.requests.length, 1, 'Front in the admitted region was downloaded again')
    assert(Math.abs(f.demand.state().eye.heightMeters - 501) < 0.01, 'Late scalar height reused at a new point')
    assert.strictEqual(f.demand.state().eye.status, 'limited')
    assert.strictEqual(f.demand.state().eye.verticalAccuracyMeters, null)
    assert.strictEqual(f.work.size, 0, 'Settled demand polls while idle')
    const state = f.demand.state(); state.eye.reasons.push('mutated')
    assert(!f.demand.state().eye.reasons.includes('mutated'))
    f.demand.update(snapshot(camera(117))); await f.flush()
    assert.strictEqual(f.requests.length, 2)
    f.demand.update(snapshot(camera(140))); await f.flush()
    assert(f.requests[1].signal.aborted)
    assert.strictEqual(f.requests.length, 2, 'Replaced owner admitted work before cancellation receipt')
    f.requests[1].resolve(sample(9000)); await tick(); await f.flush()
    assert.strictEqual(f.requests.length, 3)
    assert.strictEqual(f.demand.state().eye.heightMeters, null, 'Stale query changed new eye clearance')
    assert.strictEqual(f.demand.job.point.u, f.demand.points.eye.u)
    const far = camera(); far.distance = 1e7
    f.demand.update(snapshot(far))
    assert(!f.demand.state().active && f.requests[2].signal.aborted)
    assert.strictEqual(f.demand.state().eye, null)
  } finally { await f.close() }

  const priority = fixture()
  try {
    priority.demand.update(snapshot(camera())); await priority.flush()
    await priority.finish(0, 1e-6)
    assert.strictEqual(priority.demand.job.role, 'front')
    priority.demand.update(snapshot(camera(116.5624)))
    assert(priority.requests[1].signal.aborted, 'Front prefetch blocked newly uncovered eye')
  } finally { await priority.close() }

  const blocked = fixture()
  try {
    blocked.demand.update(snapshot(camera(116, 0))); await blocked.flush()
    blocked.requests[0].reject(Object.assign(new Error('full'), {code: 'terrain_query_capacity'}))
    await tick(); await blocked.flush()
    // The same missing eye must be retried before an identical front request.
    assert.strictEqual(blocked.requests.length, 1)
    assert.strictEqual(blocked.demand.state().eye.status, 'limited')
    for (let i = 0; i < 5; ++i) { blocked.demand.update(snapshot(camera(116, 0))); await blocked.flush() }
    assert.strictEqual(blocked.requests.length, 1, 'Capacity failure spun on camera ticks')
    blocked.runtime.resourceLedger.setLimit(1e7); await tick(); await blocked.flush()
    assert.strictEqual(blocked.requests.length, 2)
    blocked.requests[1].reject(Object.assign(new Error('offline'), {code: 'terrain_query_failed'}))
    await tick(); await blocked.flush()
    blocked.runtime.resourceLedger.setLimit(2e7); await tick(); await blocked.flush()
    assert.strictEqual(blocked.requests.length, 2, 'Network failure retried on unrelated resource release')
    blocked.demand.retry(); await blocked.flush()
    assert.strictEqual(blocked.requests.length, 3)
    blocked.demand.pause(); assert(blocked.requests[2].signal.aborted)
    blocked.requests[2].resolve(sample()); await tick()
    assert(!blocked.demand.active && !blocked.work.size)
    blocked.demand.resume(); blocked.demand.update(snapshot(camera(116, 0))); await blocked.flush()
    assert.strictEqual(blocked.requests.length, 4)
    blocked.runtime.manifest = {...manifest}; blocked.demand.update(snapshot(camera(116, 0)))
    assert(blocked.requests[3].signal.aborted, 'Dataset replacement retained stale owner')
  } finally { await blocked.close() }

  // Exercise real runtime constraint geometry for high tilt and arbitrary yaw.
  // Independent terrain must work even before any rendered surface exists.
  for (const tilt of [0, 45, 76.3, 89.5]) for (const heading of [0, 90, 180, 270]) {
    const runtime = Object.create(TerraGlobeRuntime.prototype)
    Object.assign(runtime, {options: {}, manifest, budget: {physicalWidth: 800, physicalHeight: 600},
      fovRadians: 0.6, camera: {...camera(116, tilt, heading), targetHeightMeters: 0, distance: 1},
      groundDemands: {revision: 1, samples: {eye: sample(1200)}, update() {}, state: () => ({active: true})}})
    const before = snapshot(runtime.camera)
    assert(runtime.constrainCamera())
    const after = snapshot(runtime.camera)
    assert(Math.abs(Math.hypot(...after.cameraPosition) - manifest.radius - 1202) < 0.01)
    assert.strictEqual(runtime.camera.distance, 1)
    assert.strictEqual(runtime.camera.yawRadians, heading * Math.PI / 180)
    assert(Math.hypot(...after.cameraPosition.map((v, i) => v - before.cameraPosition[i])) < 1203,
      'Clearance displaced the eye along its nearly horizontal view')
    assert.strictEqual(runtime.cameraGround.constraintSource, 'cbdam-query')
    assert.strictEqual(runtime.cameraGround.terrainHeightMeters, 1200)
  }
  const runtime = Object.create(TerraGlobeRuntime.prototype)
  Object.assign(runtime, {options: {}, manifest, budget: {physicalWidth: 800, physicalHeight: 600},
    fovRadians: 0.6, camera: camera(116, 0)})
  runtime.constrainCamera()
  assert.strictEqual(runtime.cameraGround.terrainHeightMeters, null, 'Unknown terrain fabricated as sea level')
  assert.strictEqual(runtime.cameraGround.constraintSource, 'reference-sphere')
  // A visibly higher mesh remains a conservative floor, independently of query precision.
  const original = ground.surfaceHit
  try {
    ground.surfaceHit = () => [0, 0, manifest.radius + 2000]
    runtime.groundDemands = {revision: 1, samples: {eye: sample(1200)}, update() {}, state: () => ({})}
    runtime.constrainCamera()
    assert.strictEqual(runtime.cameraGround.terrainHeightMeters, 2000)
    assert.strictEqual(runtime.cameraGround.constraintSource, 'rendered-surface')
  } finally { ground.surfaceHit = original }
  console.log('Eye/front demand, latest-region sampling, bounded cancellation, parked failure and clearance passed')
}

main().catch(cause => { console.error(cause.stack); process.exitCode = 1 })
