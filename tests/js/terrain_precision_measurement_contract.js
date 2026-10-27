const assert = require('assert')
const {TerraWebGlRenderer} = require('../../adapters/webgl/terra_webgl_renderer')

// Resident image targets can meet SSE using loose bounds while preventing
// terrain recovery. No missing image or producer refusal will request tighter
// measurement in that state; restoration must request it before giving up.
module.exports = async function verifyRecoveryMeasurement({createRuntime, FakeAbi, settle}) {
  const abi = new FakeAbi(); abi.getRequests = () => []
  const {runtime, renderer} = await createRuntime({abi, canvas:{requestAnimationFrame:() => 1}})
  await settle(3)
  const ledger = runtime.resourceLedger, capacity = runtime.terrainCapacity
  const preferred = capacity.preferred
  const images = ledger.reserve('resident-conservative-images',
    ledger.maximumBytes - ledger.bytes - 3 * preferred + 1)
  assert(images)
  let measurements = 0, redraws = 0
  const demand = {sequence:runtime.lastFrame.sequence, bytes:0, keep:[images], refinable:true}
  renderer.terrainRefinementDemand = () => demand
  renderer.current = {}; renderer.mode = 'texture'; renderer.cameraVersion = runtime.cameraRevision
  renderer.options.onImageryPlanningChange = () => {++measurements}
  renderer.requestRender = () => {++redraws}
  renderer.refineImageryDemand = TerraWebGlRenderer.prototype.refineImageryDemand
  try {
    assert(capacity.refuse(90000, runtime.cameraRevision))
    const reduced = capacity.bytes, owned = ledger.bytes
    runtime.frameClock.work.clear(); runtime.refreshPending = false
    runtime.retryTerrainPrecision()
    assert.strictEqual(measurements, 1,
      'SSE-safe conservative imagery permanently blocked terrain recovery without requesting tighter measurement')
    assert.strictEqual(capacity.bytes, reduced, 'Requesting measurement spent unavailable terrain capacity')
    assert.strictEqual(ledger.bytes, owned, 'Requesting measurement refunded resident images')
    assert(!runtime.frameClock.work.has('terrain'), 'Pending measurement restarted unfunded topology')
    for (let i = 0; i < 8; ++i) runtime.retryTerrainPrecision()
    assert.strictEqual(measurements, 1, 'Unchanged capacity pressure restarted the same measurement job')
    assert.strictEqual(redraws, 1)
    demand.refinable = false
    runtime.retryTerrainPrecision()
    assert.strictEqual(capacity.bytes, preferred, 'Exact pricing did not reopen bounded recovery')
    assert.strictEqual(ledger.bytes, owned, 'Reopening selection refunded or allocated a whole terrain generation')
    assert.strictEqual(runtime.terrainUpdateBudget().maximumChangeCount, undefined,
      'Measured relief replaced the native bounded-work defaults')
    assert(runtime.frameClock.work.has('terrain'))
    assert.strictEqual(measurements, 1)
  } finally {images.release(); runtime.destroy()}
}
