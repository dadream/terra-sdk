'use strict'
const assert = require('assert')
const {analyze, read} = require('./joint_capacity/ownership')

const snapshot = {ledger:{bytes:100}, leases:[
  {id:0, owner:'root', bytes:10, reclaimable:true, dependencies:[]},
  {id:1, owner:'shared', bytes:20, reclaimable:false, dependencies:[0, 2]},
  {id:2, owner:'display', bytes:30, reclaimable:false, dependencies:[]},
  {id:3, owner:'retired', bytes:15, reclaimable:false, dependencies:[0]},
  {id:4, owner:'cycle', bytes:5, reclaimable:false, dependencies:[5]},
  {id:5, owner:'cycle', bytes:5, reclaimable:false, dependencies:[4]},
  {id:6, owner:'unknown', bytes:15, reclaimable:false, dependencies:[-1]}
]}
const result = analyze(snapshot)
assert.strictEqual(result.eligibleBytes, 25)
assert.strictEqual(result.remainingBytes, 75)
assert.strictEqual(result.owners.shared.remainingBytes, 20, 'A single disposable owner cannot refund a shared allocation')
assert.strictEqual(result.owners.cycle.eligibleBytes, 0, 'Cycles are not free capacity')
assert.strictEqual(result.owners.unknown.eligibleBytes, 0)
const allOwners = structuredClone(snapshot); allOwners.leases[2].reclaimable = true
assert.strictEqual(analyze(allOwners).eligibleBytes, 75)
assert.throws(() => analyze({...snapshot, ledger:{bytes:101}}), /reconcile/)
const duplicate = structuredClone(snapshot); duplicate.leases[1].id = 0
assert.throws(() => analyze(duplicate), /Invalid/)

const root = {owner:'root', bytes:7, phase:'resident', reclaimable:() => true}
const dependent = {owner:'child', bytes:9, phase:'retired', reclaimWith:() => [root]}
const runtime = {resourceLedger:{leases:new Set([root, dependent]),
  stats:() => ({bytes:16}), reclamation:{stats:() => ({attempts:0})},
  planRoom:() => {throw new Error('Diagnostic must not trigger reclamation')}},
  abi:{pending:new Map([[5, {type:'imagery-plan'}]])}}
const observed = read(runtime)
assert.deepStrictEqual(observed.rpc, ['imagery-plan'])
assert.strictEqual(analyze(observed).eligibleBytes, 16)
assert.strictEqual(root.bytes, 7)
assert.strictEqual(dependent.bytes, 9)

// The observer must not serialize or render prior multi-megabyte snapshots
// while the browser workload is timed. A pending fetch keeps main() idle.
const fs = require('fs'), path = require('path'), vm = require('vm')
let clock = 0
const writes = [], element = {set textContent(value) {writes.push(value)}}
const context = {document:{getElementById:() => element}, performance:{now:() => clock},
  fetch:() => new Promise(() => {})}
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'joint_capacity/browser.js'), 'utf8') +
  '\n globalThis.observerTest = {report, save};', context)
const observer = context.observerTest
observer.report.steps.push({id:'sample', durationMs:1, settled:true, quality:{terminal:'ready'},
  ownership:{payload:'x'.repeat(2000000)}})
observer.save()
assert(writes[0].length < 1000)
assert(!writes[0].includes('ownership'))
clock = 100; observer.save(); assert.strictEqual(writes.length, 1)
clock = 1000; observer.save(); assert.strictEqual(writes.length, 2)
observer.save(true); assert(writes[2].length > 2000000)

const {validate:validateRefund, comparePixels} = require('./joint_capacity/reclamation')
const ready = {current:true, covered:true, terrainMet:true, imageryMet:true, busy:[], reasons:[], terminal:'ready'}
const refund = {sameFrame:true, sameSets:true, samePixels:true,
  controlComparison:{changedBytes:0, changedPixels:0, maximumDifference:0},
  beforeQuality:ready, afterQuality:ready,
  beforePixels:{width:960, height:640, fnv1a32:123, sampledColorCount:4},
  afterPixels:{width:960, height:640, fnv1a32:123, sampledColorCount:4},
  stages:[{owner:'imagery-input-native', ownerBeforeBytes:100, ownerAfterBytes:30, releasedBytes:70},
    {owner:'synchronous-closure', requestedBytes:50, releasedBytes:50}]}
validateRefund(refund)
for (const mutate of [
  value => {value.sameFrame = false}, value => {value.sameSets = false},
  value => {value.samePixels = false}, value => {++value.afterPixels.fnv1a32},
  value => {value.controlComparison.changedBytes = 1},
  value => {value.beforePixels.sampledColorCount = 1},
  value => {value.afterQuality.busy = ['imagery']},
  value => {value.afterQuality.terrainMet = false},
  value => {value.afterQuality.reasons = ['terrain-budget']},
  value => {value.stages[0].ownerAfterBytes = 31},
  value => {value.stages[1].releasedBytes = 49}
]) {
  const changed = structuredClone(refund); mutate(changed)
  assert.throws(() => validateRefund(changed))
}
const sourceLimited = structuredClone(refund)
for (const key of ['beforeQuality','afterQuality'])
  sourceLimited[key] = {...ready, terminal:'data-limited', reasons:['source-level']}
validateRefund(sourceLimited)
assert.deepStrictEqual(comparePixels({bytes:Uint8Array.from([10,20,30,255,1,2,3,255])},
  {bytes:Uint8Array.from([10,40,30,255,2,2,3,255])}),
  {changedBytes:2, changedPixels:2, maximumDifference:20})
console.log('Joint capacity ownership contracts passed')

// Equal maximum errors/counts cannot prove identical resource demand. Exact
// image comparisons also require the same geometry and visibility inputs;
// submitted depth-occluded draws are not visible precision failures.
const {compare:compareReference, physicalKey} = require('./joint_capacity/compare_reference')
const source = {id:'fixture', kind:'global-geodetic', matrix_level_offset:1,
  minimum_level:0, maximum_level:2, level_zero_columns:2, level_zero_rows:1}
const sourceSchema = {...source}; delete sourceSchema.id
const reference = {case:'case', imageryProfile:{source}, cores:{sdk:{
  discoveryRows:[{id:'pose', visibleKeys:['mesh']}],
  rows:[{id:'pose', visibleKeys:['mesh'], imagery:{status:'ready',
    maximumPixelError:2.23, physicalKeys:['fixture/3/0/0','fixture/3/0/1']}}]}}}
const report = {schema:'terra.joint-capacity.v1', case:'case', fullRouteCompleted:true, options:{visibility:'renderer'},
  steps:[{id:'pose', settled:true, withinOriginalDeadline:true,
    cameraCheck:{positionErrorMeters:0, projectionViewRelativeError:0},
    visibility:{observerEnabled:true, evidence:null}, final:{
    state:{renderer:{quality:{occludedMeshCount:0, visibilityRevision:0}}},
    configuration:{imageryId:'fixture', source:sourceSchema}, metrics:{imageryError:2.23},
    sets:{terrain:['mesh'], presentedImages:['2/3/0/1','2/3/0/0']}}}]}
const matching = compareReference(reference, report)
assert(matching.allTerrainSetsMatch && matching.allPresentedImageSetsMatch)
assert.strictEqual(matching.allImageReferencesMatch, true)
const differentGeometry = structuredClone(reference)
differentGeometry.cores.sdk.rows[0].visibleKeys.push('frozen-addition')
const differentInput = compareReference(differentGeometry, report)
assert(!differentInput.steps[0].frozenTerrain.matches)
assert.strictEqual(differentInput.allImageReferencesMatch, null)
assert(differentInput.steps[0].imageComparison.reasons.includes('different-frozen-terrain'))
const coarse = structuredClone(report)
coarse.steps[0].final.sets.presentedImages = ['1/2/0/0']
assert.strictEqual(compareReference(reference, coarse).allPresentedImageSetsMatch, false,
  'Equal maximum error hid a coarser physical image set')
assert.strictEqual(compareReference(reference, coarse).allImageReferencesMatch, false)
const wrongTile = structuredClone(report)
wrongTile.steps[0].final.sets.presentedImages[0] = '2/3/0/2'
assert.strictEqual(compareReference(reference, wrongTile).allPresentedImageSetsMatch, false,
  'Equal image counts hid different physical identities')
const wrongSource = structuredClone(report); wrongSource.steps[0].final.configuration.imageryId = 'other'
assert.throws(() => compareReference(reference, wrongSource), /Different imagery/)
for (const key of ['2/2/0/0','2/3/4/0','2/3/0/8','2/3/0/-1','2/3/0/00'])
  assert.throws(() => physicalKey(key, source), /identity/)

const {visibilityMembers} = require('../../sdk/js/terrain/visibility_evidence')
const {read:readVisibility, viewerOptions} = require('./joint_capacity/visibility')
assert.strictEqual(readVisibility({renderer:{current:null}}), null, 'Keep initial-frame timeout evidence')
const frame = {projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], cameraPosition:[0,0,10]}
const draws = [{geometryKey:'mesh', resourceId:7, firstIndex:0, indexCount:3, flags:0, origin:[0,0,0]}]
const evidence = {schema:'terra.terrain-visibility.v2', revision:3,
  projectionView:frame.projectionView, cameraPosition:frame.cameraPosition,
  members:visibilityMembers(draws), hidden:[7], viewport:[960,640]}
const auditRuntime = {renderer:{current:{frame, draws}, canvas:{width:960,height:640},
  visibility:{valid:() => true, evidence,
    snapshot:() => {throw new Error('Observation must not mutate visibility')}}}}
const occluded = structuredClone(coarse)
occluded.steps[0].visibility = readVisibility(auditRuntime)
occluded.steps[0].final.state.renderer.quality = {occludedMeshCount:1, visibilityRevision:3}
const hiddenResult = compareReference(reference, occluded)
assert.strictEqual(hiddenResult.allPresentedImageSetsMatch, false, 'Keep the literal difference')
assert.strictEqual(hiddenResult.allImageReferencesMatch, null, 'GPU occlusion is neither a set pass nor a failure')
assert.strictEqual(hiddenResult.steps[0].imageComparison.visibility.status, 'gpu-occluded')
for (const mutate of [
  value => {value.steps[0].visibility.scene.frame.cameraPosition[2]++},
  value => {value.steps[0].visibility.scene.frame.projectionView[0]++},
  value => {value.steps[0].visibility.scene.draws[0].indexCount++},
  value => {value.steps[0].visibility.scene.viewport.width++},
  value => {value.steps[0].visibility.evidence.hidden = [99]},
  value => {value.steps[0].visibility.evidence.hidden.push(7)},
  value => {value.steps[0].final.state.renderer.quality.visibilityRevision++},
  value => {value.steps[0].final.state.renderer.quality.occludedMeshCount++},
  value => {value.steps[0].visibility.evidence = null},
  value => {value.options.visibility = 'all-visible'}
]) {
  const stale = structuredClone(occluded); mutate(stale)
  const result = compareReference(reference, stale)
  assert.strictEqual(result.steps[0].imageComparison.visibility.status, 'invalid-evidence')
  assert.strictEqual(result.allImageReferencesMatch, null)
}
assert.strictEqual(evidence.hidden.length, 1, 'Recorded snapshots must not mutate the renderer')
assert.strictEqual(frame.cameraPosition[2], 10)
const unrecorded = structuredClone(report); delete unrecorded.steps[0].visibility
assert.strictEqual(compareReference(reference, unrecorded).allImageReferencesMatch, null,
  'Matching identities without comparable inputs must not become an oracle pass')
const unaligned = structuredClone(report); unaligned.steps[0].cameraCheck.positionErrorMeters = 10
assert(compareReference(reference, unaligned).steps[0].imageComparison.reasons.includes('camera-not-aligned'))
const control = structuredClone(report); control.options.visibility = 'all-visible'
control.steps[0].visibility.observerEnabled = false
assert.strictEqual(compareReference(reference, control).allImageReferencesMatch, true)
assert.deepStrictEqual(viewerOptions('renderer'), {})
assert.deepStrictEqual(viewerOptions('all-visible'), {createTerrainVisibility:null})
assert.throws(() => viewerOptions('unknown'), /visibility policy/)
console.log('Joint capacity reference identity, visibility and incompatible-input contracts passed')
