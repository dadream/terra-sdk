'use strict'
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path')
const {spawnSync} = require('child_process')
const {compare,csv} = require('../../scripts/compare_vertical_capacity')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ResourceShare} = require('../../sdk/js/resources/resource_share')
const hash = 'a'.repeat(64), copy = value=>JSON.parse(JSON.stringify(value))

function fixture() {
  const target = {longitudeDegrees:116,latitudeDegrees:40,heightMeters:500}
  const configuration = {datasetId:'globe',initialBudgets:{maximumTerrainMeshBytes:100,textureCacheBytes:200}}
  const samples = [{id:'global',rangeMeters:1000},{id:'level-1',rangeMeters:100}]
  const view = rangeMeters=>({schema:'terra.view-state.v2',mode:'globe',target,headingDegrees:0,tiltDegrees:0,rangeMeters})
  const steps = [samples[0],samples[1],samples[0]].map((sample,index)=>{
    const v = view(sample.rangeMeters)
    return {...sample,direction:index===2?'up':'down',view:v,status:'ready',durationMs:100,
      final:{metrics:{terrainThreshold:1,imageryThreshold:1.25,workingMeshBytes:100,
        textureGrantedBytes:200,textureMaximumShareBytes:500},
        sets:{terrain:['2/1/2/3/0'],imagery:['1/0/0/0'],targetImages:['2/2/0/0']},
        state:{view:v,resources:{achievedLodError:0.9,requestedLodThreshold:1},
          terrainSelection:{desiredViewRevision:1,preparedViewRevision:1,presentedViewRevision:1},
          renderer:{quality:{cameraCurrent:true,terrainSelectionCurrent:true,geometryTargetComplete:true,
            resolvedMaxPixelError:1.2,targetPixelError:1.25,targetMet:true,covered:true,missingCount:0,settled:true},
            draws:{submitted:1},textures:{},transition:{gpuSubmission:{pending:false},handoff:{phase:'presented'}}}}}}
  })
  const production = {schema:'terra.vertical-scale-benchmark.v1',status:'complete',viewerDestroyed:true,
    configuration,target,samples,steps,assets:{'terra_sdk.wasm':{sha256:hash}}}
  const terrain = {schema:'terra.terrain-reference.v1',status:'complete',configuration,terrain:{fixtureSha256:hash},
    binarySha256:hash,cleanup:{nativeProcessClosed:true,activeFetches:0},samples:samples.map(sample=>({...sample,
      view:view(sample.rangeMeters),threshold:1,achievedError:0.9,targetMet:true,meshBytesWithRoots:80,
      surfaceSnapshot:{sha256:hash,meshes:[{key:[2,1,2,3],fragment:0}]}}))}
  const imagery = {schema:'terra.imagery-demand-reference.v1',status:'complete',configuration,terrain:terrain.terrain,
    terrainBinarySha256:hash,cleanup:{childProcessesClosed:true},samples:samples.map(sample=>({...sample,
      view:view(sample.rangeMeters),surfaceSha256:hash,wasmSha256:hash,cameraVerified:true,targetMet:true,
      imageBytesWithRoots:120,quality:{targetPixelError:1.25,measuredMaxPixelError:1.2},
      internalNodes:['1/0/0/0'],sourceImages:['2/2/0/0']}))}
  return [production,terrain,imagery]
}

const input = fixture(), valid = compare(...input)
assert(valid.localChecksPassed && !valid.jointCapacityVerified)
assert(csv(valid).includes('referenceTerrainBytes'))

// Initial preference is not the admitted share. Use the real shared-ledger
// grant/revocation path to keep this report consistent with runtime ownership.
const ledger = new ResourceLedger(1000), share = new ResourceShare(ledger,'images',100,500)
const growing = copy(input)
growing[0].configuration.initialBudgets.textureCacheBytes = 100
assert(share.grow(100))
function observedShare() {
  for (const step of growing[0].steps) Object.assign(step.final.metrics,
    {textureGrantedBytes:share.stats().grantedBytes,textureMaximumShareBytes:share.stats().maximumBytes})
  return compare(...growing)
}
const expanded = observedShare()
assert(expanded.localChecksPassed,'Initial preference was treated as a hard imagery capacity limit')
assert.strictEqual(expanded.rows[0].initialImageCapacity.fits,false)
assert.strictEqual(expanded.rows[0].imageCapacity.configuredBytes,200)
assert.strictEqual(expanded.rows[0].maximumImageCapacity.configuredBytes,500)
share.revoke()
const revoked = observedShare()
assert(!revoked.localChecksPassed,'Unfunded potential growth was accepted as granted capacity')
assert(revoked.rows[0].findings.includes('reference-imagery-exceeds-granted-share'))
assert.strictEqual(revoked.rows[0].maximumImageCapacity.fits,true)
assert.strictEqual(ledger.bytes,0)

// A legitimate retained finer display must not fail capacity/precision checks,
// and equal counts must not hide different spatial membership.
const history = copy(input)
history[0].steps[2].final.sets.terrain = ['3/1/2/3/0']
history[0].steps[2].final.sets.targetImages.push('2/2/0/1')
const retained = compare(...history)
assert(retained.localChecksPassed)
assert.deepStrictEqual(retained.rows[2].terrainMembership,
  {reference:1,actual:1,onlyReference:1,onlyActual:1,same:false})
assert.strictEqual(retained.rows[2].imageMembership.onlyActual,1)

const undersized = copy(input)
undersized[0].configuration.initialBudgets.maximumTerrainMeshBytes = 60
const shortfall = compare(...undersized)
assert(!shortfall.localChecksPassed && shortfall.allGrantedPayloadsFit === false)
assert.strictEqual(shortfall.rows[0].terrainCapacity.shortfallBytes,20)
assert(shortfall.rows[0].findings.includes('reference-terrain-exceeds-configured-quota'))
assert.strictEqual(shortfall.identity.referenceBudgets.terrain.maximumTerrainMeshBytes,100)

// A focused profile may reuse a larger reference ladder without recomputing
// geometry/images. Every requested pose is still required and identity-checked.
const extra = copy(input)
for (const report of extra.slice(1)) report.samples.push({...copy(report.samples[1]),id:'unused'})
const reused = compare(...extra)
assert(reused.localChecksPassed)
assert.deepStrictEqual(reused.identity.unusedReferenceSamples,{terrain:['unused'],imagery:['unused']})

const reduced = copy(input)
reduced[0].steps[0].final.metrics.workingMeshBytes = 60
const recovery = compare(...reduced)
assert(recovery.allGrantedPayloadsFit && !recovery.allWorkingMeshQuotasFit && !recovery.localChecksPassed)
assert(recovery.rows[0].findings.includes('working-quota-below-reference'))

const unknown = copy(input)
for (const step of unknown[0].steps) delete step.final.metrics.textureGrantedBytes
assert.strictEqual(compare(...unknown).allGrantedPayloadsFit,null)
assert(!compare(...unknown).localChecksPassed)

const ceiling = copy(input)
ceiling[2].samples[0].imageBytesWithRoots = 600
assert(compare(...ceiling).rows[0].findings.includes('reference-imagery-exceeds-maximum-share'))

// Re-evaluate the final diagnostics; a stale ready label cannot conceal pending
// work or an error above the target. Reference limitations remain independent.
const busy = copy(input)
busy[0].steps[0].final.state.renderer.quality.measurementPending = true
assert(!compare(...busy).allProductionTargetsMet)
const imprecise = copy(input)
imprecise[0].steps[0].final.state.resources.achievedLodError = 2
assert(!compare(...imprecise).allProductionTargetsMet)
const limited = copy(input)
limited[2].samples[1].targetMet = false
limited[2].samples[1].quality.limitedByLevel = true
assert(compare(...limited).rows[1].findings.includes('reference-source-level-limit'))
assert(!compare(...limited).localChecksPassed)

for (const mutate of [
  reports=>{reports[1].samples[0].view.headingDegrees=90},
  reports=>{reports[2].samples[0].surfaceSha256='b'.repeat(64)},
  reports=>{reports[2].samples[0].wasmSha256='b'.repeat(64)},
  reports=>{reports[2].terrain.fixtureSha256='b'.repeat(64)},
  reports=>{reports[1].samples[0].threshold=0.5},
  reports=>{reports[1].configuration.viewport={physicalWidth:600}},
  reports=>{reports[1].samples.pop()},
  reports=>{reports[0].steps.pop()},
  reports=>{reports[0].viewerDestroyed=false},
  reports=>{reports[0].steps[0].final.metrics.textureGrantedBytes=501}
]) {
  const changed = copy(input); mutate(changed)
  assert.throws(()=>compare(...changed))
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(),'terra-capacity-comparison-'))
try {
  const names = ['production','terrain','imagery'], args = []
  for (const [index,name] of names.entries()) {
    const file = path.join(directory,name+'.json')
    fs.writeFileSync(file,JSON.stringify(undersized[index])); args.push('--'+name,file)
  }
  const output = path.join(directory,'output')
  const result = spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/compare_vertical_capacity.js'),
    ...args,'--output',output],{encoding:'utf8',timeout:5000})
  assert.strictEqual(result.status,2,result.stdout+result.stderr)
  assert(!JSON.parse(fs.readFileSync(path.join(output,'report.json'))).localChecksPassed)
  assert(fs.readFileSync(path.join(output,'steps.csv'),'utf8').includes('reference-terrain-exceeds-configured-quota'))
} finally {fs.rmSync(directory,{recursive:true,force:true})}
console.log('Vertical capacity: reference identity, precision, quota, history and offline report acceptance passed')
