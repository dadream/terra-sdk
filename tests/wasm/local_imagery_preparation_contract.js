const assert = require('assert')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ImageryPreparation} = require('../../adapters/wasm/imagery_preparation')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = async function(module, manifest) {
  const abi = new TerraAbi(module), ledger = new ResourceLedger(32 * 1024 * 1024)
  const preparation = new ImageryPreparation({abi, manifest, measurementFactory:require('../js/reference/measurement_production').measurementFactory})
  const fixture = require('../js/reference/measurement_fixture')(true)
  const model = surface.prepareSurface(fixture.positions, fixture.uv, fixture.indices, 0, fixture.indices.length)
  const frame = {sequence:1, projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], cameraPosition:[0,0,0]}
  const draw = {resourceId:1, textureNode:{level:0,root:0,row:0,column:0},
    texture:{level:1,matrix:2,row:0,column:0}, origin:[0,0,0], flags:0}
  let holds = 0
  const resource = {model, ownership:{hold() {
    ++holds
    let open = true
    return () => {if (open) {open = false; --holds}}
  }}}
  const packet = {frame, draws:[draw], resources:new Map([[1, resource]]),
    updateState:{modelRevision:1}, meshIdentity:'1'}
  const message = {sequence:1, viewRevision:1, planId:7, snapshot:frame,
    camera:{distance:1}, viewport:{width:320,height:320,fovRadians:1},
    imagery:{descriptor:manifest.texture, maximumTextures:1, maximumDraws:1024, targetPixelError:1.25}}
  const credits = {beginImageryInput:0, beginImageryReferences:0, beginImageryOutput:0}
  for (const name of Object.keys(credits)) {
    const original = abi[name]
    abi[name] = function(...args) {++credits[name]; return original.apply(this, args)}
  }
  const next = async request => {
    const result = await preparation.prepareImagery(packet, request)
    assert(!result.inputWork && !result.referenceWork && !result.outputWork,
      'Local execution waited for a remote credit response')
    return result
  }
  try {
    abi.loadManifest(manifest)
    abi.setResourceLedger(ledger)
    ledger.setLimit(1)
    await assert.rejects(async () => {
      for (let i=0;i<128;++i) await next(message)
      assert.fail('An unfunded local preparation did not refuse allocation')
    }, error => error.status === 9)
    assert.strictEqual(preparation.imageryJob, null)
    assert.strictEqual(holds, 0, 'Refused local preparation retained mesh ownership')
    assert.strictEqual(abi.imageryPackingBytes || 0, 0)
    assert.strictEqual(abi.imageryInputBudget.credits.size, 0)
    await ledger.reclamation.pending
    ledger.setLimit(32 * 1024 * 1024)

    let result
    for (let i=0;i<128;++i) {
      result = await next(message)
      if (result.candidateReady) break
    }
    assert(result.candidateReady && result.imageryPlan.quality.coverageGuaranteed,
      'Local execution did not produce a complete admissible candidate cut')
    const job = preparation.imageryJob
    assert(job && result.continuation, 'Fixture must retain precision work at candidate acceptance')
    preparation.publishImageryCandidate(7)
    assert.strictEqual(preparation.imageryJob, job)
    assert.strictEqual(job.planId, 0)
    for (let i=0;i<128;++i) {
      result = await next({...message, planId:undefined})
      if (!result.pending && !result.continuation) break
    }
    assert(result.imageryPlan.quality.planningComplete && result.imageryPlan.quality.meetsTarget)
    assert.strictEqual(result.imageryPlan.quality.selectedTextureCount, 1,
      'Local preparation retained false capacity pressure from the loose projection bound')
    assert.strictEqual(preparation.imageryJob, null)
    assert.strictEqual(holds, 0)
    for (const name of Object.keys(credits)) assert(credits[name] > 0, `Missing local credit owner: ${name}`)
    for (const name of ['imageryInputBudget','imageryReferenceBudget','imageryOutputBudget'])
      assert.strictEqual(abi[name].credits.size, 0, `Completed preparation retained ${name} credit`)
  } finally {
    preparation.clearPlanning()
    preparation.measurementHistory.clear()
    abi.destroy()
    await ledger.reclamation.pending
  }
  assert.strictEqual(holds, 0)
  assert.strictEqual(ledger.bytes, 0)
  console.log('Local shared imagery preparation: refusal, coverage admission, continued precision and credit cleanup passed')
}
