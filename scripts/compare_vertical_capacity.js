#!/usr/bin/env node
'use strict'

// Join already completed, bounded measurements. This command starts no viewer,
// native process or network client and never changes runtime resource limits.
const assert = require('assert'), fs = require('fs'), path = require('path')
const {sameView, quality} = require('../tests/benchmarks/vertical_scale')

function capacity(required, configured) {
  assert(Number.isSafeInteger(required) && required >= 0, 'Invalid reference payload')
  const known = Number.isSafeInteger(configured) && configured > 0
  return {requiredBytes:required, configuredBytes:known ? configured : null,
    fits:known ? required <= configured : null, shortfallBytes:known ? Math.max(0,required-configured) : null}
}
function membership(reference, actual) {
  assert(Array.isArray(reference) && Array.isArray(actual), 'Missing spatial membership')
  const a = new Set(reference), b = new Set(actual)
  const onlyReference = [...a].filter(key=>!b.has(key)).length
  const onlyActual = [...b].filter(key=>!a.has(key)).length
  return {reference:a.size, actual:b.size, onlyReference, onlyActual, same:!onlyReference && !onlyActual}
}
const allKnown = values => values.includes(false) ? false : values.includes(null) ? null : true
function demandConfiguration(configuration) {
  const {initialBudgets, ...demand} = configuration
  return demand
}

function compare(production, terrain, imagery) {
  assert(production.schema === 'terra.vertical-scale-benchmark.v1' && production.status === 'complete' &&
    production.viewerDestroyed, 'Completed and destroyed vertical benchmark required')
  assert(terrain.schema === 'terra.terrain-reference.v1' && terrain.status === 'complete' &&
    terrain.cleanup?.nativeProcessClosed && terrain.cleanup.activeFetches === 0, 'Completed terrain reference required')
  assert(imagery.schema === 'terra.imagery-demand-reference.v1' && imagery.status === 'complete' &&
    imagery.cleanup?.childProcessesClosed, 'Completed imagery reference required')
  // Reference selection is independent of production quotas. Reuse its exact
  // surfaces across capacity profiles, but never across projection/source/error
  // changes. The current production quotas below determine capacity acceptance.
  assert.deepStrictEqual(demandConfiguration(terrain.configuration), demandConfiguration(production.configuration), 'Terrain configuration differs')
  assert.deepStrictEqual(demandConfiguration(imagery.configuration), demandConfiguration(production.configuration), 'Imagery configuration differs')
  assert.deepStrictEqual(imagery.terrain, terrain.terrain, 'Terrain data identity differs')
  assert.strictEqual(imagery.terrainBinarySha256, terrain.binarySha256, 'Terrain binary identity differs')
  const wasm = production.assets?.['terra_sdk.wasm']?.sha256
  assert(typeof wasm === 'string' && /^[a-f0-9]{64}$/.test(wasm), 'Production Wasm identity required')
  const samples = production.samples
  assert(Array.isArray(samples) && samples.length >= 2 && new Set(samples.map(row=>row.id)).size === samples.length,
    'Unique vertical samples required')
  for (const reference of [terrain, imagery]) {
    assert(new Set(reference.samples.map(row=>row.id)).size === reference.samples.length &&
      samples.every(sample=>reference.samples.some(row=>row.id === sample.id)), 'Incomplete reference ladder')
  }
  const expected = samples.map(sample=>['down',sample.id]).concat(samples.slice(0,-1).reverse().map(sample=>['up',sample.id]))
  assert.deepStrictEqual(production.steps.map(row=>[row.direction,row.id]), expected, 'Incomplete production round trip')
  const budgets = production.configuration.initialBudgets || {}
  const rows = production.steps.map(step => {
    const t = terrain.samples.find(row=>row.id === step.id), i = imagery.samples.find(row=>row.id === step.id)
    const sample = samples.find(row=>row.id === step.id)
    const expectedView = {mode:'globe',target:production.target,headingDegrees:0,tiltDegrees:0,rangeMeters:sample.rangeMeters}
    assert(sameView(step.view, expectedView) && sameView(t.view,step.view) && sameView(i.view,step.view) &&
      sameView(step.final?.state?.view,step.view), 'Reference view differs: '+step.id)
    assert(t.surfaceSnapshot?.sha256 && i.surfaceSha256 === t.surfaceSnapshot.sha256 && i.cameraVerified,
      'Imagery surface identity differs: '+step.id)
    assert.strictEqual(i.wasmSha256,wasm,'Imagery Wasm identity differs')
    const m = step.final.metrics, q = quality(step.final.state)
    assert(Number.isFinite(m.terrainThreshold) && Math.abs(t.threshold-m.terrainThreshold) <= m.terrainThreshold*1e-6 &&
      i.quality.targetPixelError === m.imageryThreshold, 'Reference error threshold differs: '+step.id)
    const terrainCapacity = capacity(t.meshBytesWithRoots,budgets.maximumTerrainMeshBytes)
    const workingCapacity = capacity(t.meshBytesWithRoots,m.workingMeshBytes)
    // A viewport preference is only the starting share. Growth must have a
    // real ledger grant; the maximum share is merely a ceiling, not credit.
    // Older captures without the observed share remain unknown, never inferred
    // from a ready flag, initial preference or unused global headroom.
    const initialImageCapacity = capacity(i.imageBytesWithRoots,budgets.textureCacheBytes)
    const imageCapacity = capacity(i.imageBytesWithRoots,m.textureGrantedBytes)
    const maximumImageCapacity = capacity(i.imageBytesWithRoots,m.textureMaximumShareBytes)
    if (imageCapacity.configuredBytes !== null && maximumImageCapacity.configuredBytes !== null)
      assert(imageCapacity.configuredBytes <= maximumImageCapacity.configuredBytes, 'Imagery grant exceeds its ceiling: '+step.id)
    if (imageCapacity.configuredBytes !== null && Number.isSafeInteger(m.maximumManagedBytes))
      assert(imageCapacity.configuredBytes <= m.maximumManagedBytes, 'Imagery grant exceeds shared capacity: '+step.id)
    const findings = []
    if (terrainCapacity.fits === false) findings.push('reference-terrain-exceeds-configured-quota')
    if (workingCapacity.fits === false && terrainCapacity.fits === true) findings.push('working-quota-below-reference')
    if (initialImageCapacity.fits === false) findings.push('reference-imagery-exceeds-initial-preference')
    if (imageCapacity.fits === false) findings.push('reference-imagery-exceeds-granted-share')
    if (maximumImageCapacity.fits === false) findings.push('reference-imagery-exceeds-maximum-share')
    if ([terrainCapacity.fits,workingCapacity.fits,imageCapacity.fits].includes(null)) findings.push('capacity-unknown')
    if (i.quality.limitedByLevel) findings.push('reference-source-level-limit')
    const terrainTargetMet = t.targetMet === true && Number.isFinite(t.achievedError) && t.achievedError <= t.threshold*1.001
    const imageryTargetMet = i.targetMet === true && Number.isFinite(i.quality.measuredMaxPixelError) &&
      i.quality.measuredMaxPixelError <= i.quality.targetPixelError*1.001
    if (!terrainTargetMet) findings.push('reference-terrain-target-unmet')
    if (!imageryTargetMet) findings.push('reference-imagery-target-unmet')
    const productionTargetMet = step.status === 'ready' && q.terminal === 'ready'
    if (!productionTargetMet) findings.push('production-target-unmet')
    return {id:step.id,direction:step.direction,rangeMeters:step.view.rangeMeters,productionStatus:step.status,
      productionTargetMet,terrainTargetMet,imageryTargetMet,findings,
      terrainCapacity,workingCapacity,initialImageCapacity,imageCapacity,maximumImageCapacity,
      terrainMembership:membership(t.surfaceSnapshot.meshes.map(row=>row.key.concat(row.fragment).join('/')),step.final.sets.terrain),
      imageryMembership:membership(i.internalNodes,step.final.sets.imagery),
      imageMembership:membership(i.sourceImages,step.final.sets.targetImages),
      referenceErrors:{terrain:t.achievedError,imagery:i.quality.measuredMaxPixelError},
      productionErrors:{terrain:step.final.state.resources.achievedLodError,imagery:step.final.state.renderer.quality.resolvedMaxPixelError},
      shared:{maximumBytes:m.maximumManagedBytes,finalBytes:m.managedBytes,sampledPeakBytes:step.sampledPeakBytes,
        lifetimeHighWaterBytes:m.lifetimeHighWaterBytes},
      timing:{stageWallMs:step.durationMs,firstCoverageMs:step.firstCoverageMs,terrainTargetMs:step.terrainTargetMs,
        imageryTargetMs:step.imageryTargetMs,referenceLodMs:t.lodMs,referenceImagery:i.timing,production:step.timings}}
  })
  const report = {schema:'terra.vertical-capacity-comparison.v2',status:'complete',configuration:production.configuration,rows,
    allReferenceTargetsMet:rows.every(row=>row.terrainTargetMet && row.imageryTargetMet),
    allGrantedPayloadsFit:allKnown(rows.flatMap(row=>[row.terrainCapacity.fits,row.imageCapacity.fits])),
    allWorkingMeshQuotasFit:allKnown(rows.map(row=>row.workingCapacity.fits)),
    allProductionTargetsMet:rows.every(row=>row.productionTargetMet),jointCapacityVerified:false,
    scope:'Fresh production-algorithm references, not a unique/minimum-cut oracle. Display membership differences alone are not failures. Imagery reference uses reference terrain, which may differ from displayed terrain.',
    memoryScope:'Local mesh and image payload comparisons only. Shared snapshots/peaks do not prove transition feasibility or total process/GPU residency.',
    imageryCapacityScope:'Initial preference is advisory; imageCapacity uses the observed granted share. The maximum share does not prove available growth, and payload fit excludes transition/workspace reserves.',
    timingScope:'Reference CPU sections and browser stage wall times have different work and execution environments; no speedup ratio is inferred.',
    identity:{wasmSha256:wasm,terrainBinarySha256:terrain.binarySha256,terrain:terrain.terrain,
      referenceBudgets:{terrain:terrain.configuration.initialBudgets,imagery:imagery.configuration.initialBudgets},
      unusedReferenceSamples:{terrain:terrain.samples.filter(row=>!samples.some(sample=>sample.id===row.id)).map(row=>row.id),
        imagery:imagery.samples.filter(row=>!samples.some(sample=>sample.id===row.id)).map(row=>row.id)},
      scope:'Matching demand configuration, poses, error thresholds, terrain capture and Wasm. Quota-only changes may reuse references; browser JavaScript equivalence is not independently verified.'}}
  report.localChecksPassed = report.allReferenceTargetsMet && report.allGrantedPayloadsFit === true &&
    report.allWorkingMeshQuotasFit === true && report.allProductionTargetsMet
  return report
}

function csv(report) {
  const keys = ['direction','id','productionStatus','stageWallMs','referenceTerrainBytes','configuredTerrainBytes',
    'workingTerrainBytes','referenceImageBytes','initialImageBytes','grantedImageBytes','maximumImageBytes','terrainError','imageryError',
    'terrainMembershipSame','imageryMembershipSame','sampledSharedPeakBytes','findings']
  const rows = report.rows.map(row=>[row.direction,row.id,row.productionStatus,row.timing.stageWallMs,
    row.terrainCapacity.requiredBytes,row.terrainCapacity.configuredBytes,row.workingCapacity.configuredBytes,
    row.imageCapacity.requiredBytes,row.initialImageCapacity.configuredBytes,row.imageCapacity.configuredBytes,
    row.maximumImageCapacity.configuredBytes,row.productionErrors.terrain,row.productionErrors.imagery,
    row.terrainMembership.same,row.imageryMembership.same,row.shared.sampledPeakBytes,row.findings.join(';')])
  const cell = value => value == null ? '' : '"'+String(value).replaceAll('"','""')+'"'
  return [keys,...rows].map(row=>row.map(cell).join(',')).join('\n')+'\n'
}

function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/compare_vertical_capacity.js --production <report.json> --terrain <report.json> --imagery <report.json> --output <new-directory>\nOffline join; exit 0 = local precision/payload checks pass, 2 = unmet or unknown, 1 = invalid evidence. Shared transition capacity remains a separate requirement.')
    return
  }
  const options = {}, names = ['production','terrain','imagery','output']
  for (let n=0;n<args.length;n+=2) {
    assert(args[n].startsWith('--') && names.includes(args[n].slice(2)) && args[n+1], 'Invalid comparison option')
    options[args[n].slice(2)] = args[n+1]
  }
  assert(names.every(name=>options[name]), 'All report paths and --output are required')
  const inputs = names.slice(0,3).map(name=>JSON.parse(fs.readFileSync(options[name])))
  const report = compare(...inputs), output = path.resolve(options.output)
  assert(!fs.existsSync(output) || !fs.readdirSync(output).length, 'Output must be new or empty')
  fs.mkdirSync(output,{recursive:true})
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
  fs.writeFileSync(path.join(output,'steps.csv'),csv(report))
  console.log('Capacity comparison: '+path.join(output,'report.json'))
  process.exitCode = report.localChecksPassed ? 0 : 2
}
if (require.main === module) {try {main(process.argv.slice(2))} catch(error) {console.error(error.message);process.exitCode=1}}
module.exports = {compare,csv}
