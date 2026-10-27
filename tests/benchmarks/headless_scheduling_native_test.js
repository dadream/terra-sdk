'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path')
const {spawnSync,execFileSync}=require('child_process')
const root=path.resolve(__dirname,'../..'),mount=path.join(root,'viewer_verify_output')
execFileSync('mountpoint',['-q',mount])
const directory=fs.mkdtempSync(path.join(mount,'headless-scheduling-contract-'))
const output=path.join(directory,'global')
const run=spawnSync(process.execPath,[path.join(root,'scripts/benchmark_headless_scheduling.js'),
  '--case','global-contract','--output',output],{cwd:root,encoding:'utf8',timeout:30000})
assert.strictEqual(run.status,0,run.stderr+'\n'+run.stdout)
const report=JSON.parse(fs.readFileSync(path.join(output,'report.json')))
assert.strictEqual(report.status,'complete')
assert.strictEqual(report.productionResourcePolicy.maximumResourceBytes,report.configuration.maximumManagedBytes,
  'A changed SDK default overwrote the versioned case capacity')
assert(report.completeBoth&&report.allTargetsMet&&report.sameBackendSets&&report.sameRoundtripSets&&report.inputsUnchanged)
assert.deepStrictEqual(report.cleanup,{nativeProcessesClosed:true,activeRequests:0,liveSockets:0,testBrowsers:0,testServices:0})
assert.strictEqual(report.network.requests,0)
for(const [name,core] of Object.entries(report.cores)) {
  assert(core.complete&&core.nativeProcessClosed&&core.rows.length===2)
  assert(report.roundtrips[name].length===1&&report.roundtrips[name][0].sameSets)
  for(const row of core.rows) {
    assert(row.status==='ready'&&row.targetMet&&row.visibleKeys.length>8&&row.nodes>8)
    assert(row.pendingRefines===0&&row.pendingCoarsens===0)
    assert(row.activeHeightBytes>0&&row.terrainRelief.inFrustumVertices>0)
    assert(row.terrainRelief.maximumMeters>row.terrainRelief.minimumMeters)
    assert(row.meshPayload.fragmentsWithRoots>=row.visibleKeys.length)
    assert.strictEqual(row.meshPayload.positionBytes,row.meshPayload.fragmentsWithRoots*(65*66/2)*3*4)
    assert.strictEqual(row.meshPayload.selectionBytes,row.meshPayload.positionBytes+row.meshPayload.uniqueUvBytes)
    assert(row.meshPayload.sharedIndexBytes>0&&row.terrainCapacity.fitsSelection)
  }
}
assert.strictEqual(report.cores.desktop.rows[0].priorityUpdates,null,'Unavailable desktop counters were reported as zero')
assert(report.cores.desktop.rows[1].cachedUpdateReturns>0,'Driver did not exercise the original desktop cached-return path')
assert(report.cores.sdk.rows[0].priorityUpdates>0)
assert(report.cores.sdk.discoveryRows.length===2&&report.cores.sdk.frozenInputReceipt.heightRanges>8)
assert.strictEqual(new Set(report.cores.sdk.rows.map(row=>row.resourceInput.sha256)).size,1,
  'The fixed-input profile changed LOD resources between measured poses')
const binary=path.join(root,'workspace_old/build/cmake/tests/benchmarks/headless_scheduling/terra_benchmark_terrain')
const invalid=spawnSync(binary,['sdk',6378000,64,0.015625,960,640,Math.PI/6,1.25].map(String),{
  encoding:'utf8',input:'pose "bad" 117.1235 36.21228 0 1 0 90\nend\n',timeout:5000})
assert.strictEqual(invalid.status,1)
assert.match(invalid.stderr,/invalid pose/)
assert(!invalid.stdout.includes('"type":"result"'),'Invalid camera was silently clamped into a measured pose')
assert.strictEqual(report.desktopMode,'runtime')
assert.strictEqual(report.desktopTimingEligible,true)
const targetOutput=path.join(directory,'target')
const targetRun=spawnSync(process.execPath,[path.join(root,'scripts/benchmark_headless_scheduling.js'),
  '--case','global-coarsening-contract','--desktop-mode','target','--output',targetOutput],
  {cwd:root,encoding:'utf8',timeout:30000})
assert.strictEqual(targetRun.status,0,targetRun.stderr+'\n'+targetRun.stdout)
const target=JSON.parse(fs.readFileSync(path.join(targetOutput,'report.json')))
assert(target.completeBoth&&target.allTargetsMet&&target.sameBackendSets&&target.sameRoundtripSets&&target.inputsUnchanged)
assert.strictEqual(target.desktopTimingEligible,false,'Target adapter was accepted as original runtime timing')
assert.strictEqual(target.desktopMode,'target')
assert.strictEqual(target.network.requests,0)
assert.deepStrictEqual(target.cleanup,report.cleanup)
for(const row of target.cores.desktop.rows) {
  assert.strictEqual(row.backend,'desktop-native-target')
  assert(row.logicalPublications>0&&row.logicalConsumerCpuMs>=0)
  assert(row.pendingRefines===0&&row.pendingCoarsens===0)
  const observation=JSON.parse(fs.readFileSync(path.join(targetOutput,row.terrainObservation.file)))
  assert(observation.leaves.length>8)
  for(const leaf of observation.leaves) {
    assert(leaf.activeHeightRange[0]<=leaf.activeHeightRange[1])
    assert(leaf.retainedHeightRange[0]<=leaf.activeHeightRange[0]&&leaf.retainedHeightRange[1]>=leaf.activeHeightRange[1])
    if(leaf.visible)assert(leaf.projectedError<=row.threshold*1.001)
  }
}
console.log('Headless native cores: original desktop/SDK sets, persistent repeat, DEM inspection and process cleanup passed; '+directory)
const imageryOutput=path.join(directory,'imagery')
const imageryRun=spawnSync(process.execPath,[path.join(root,'scripts/benchmark_headless_scheduling.js'),
  '--case','global-coarsening-contract','--desktop-mode','target','--imagery','demand','--output',imageryOutput],
  {cwd:root,encoding:'utf8',timeout:30000})
assert.strictEqual(imageryRun.status,2,imageryRun.stderr+'\n'+imageryRun.stdout)
const images=JSON.parse(fs.readFileSync(path.join(imageryOutput,'report.json')))
assert(images.allTargetsMet&&images.allImageryTargetsMet&&images.inputsUnchanged)
assert.strictEqual(images.network.requests,0)
assert.deepStrictEqual(images.cleanup,report.cleanup)
assert(images.imageryRoundtrips.sdk.every(row=>row.sameSets))
assert(images.imageryRoundtrips.desktop.some(row=>!row.sameSets),
  'Original desktop neutral-priority retention was silently canonicalized')
const {validate:validateImage}=require('./headless_scheduling/imagery')
for(const [name,core] of Object.entries(images.cores)) {
  assert(core.nativeProcessClosed&&core.rows.length===3)
  assert.strictEqual(core.rows[0].imagery.initializationFixtureCopies,name==='desktop'?8:0)
  for(const row of core.rows) {
    const value=row.imagery
    validateImage(value,images.configuration)
    assert(value.coverageRegions>0&&value.uncoveredUvArea<1e-8)
    assert(value.preparationOperations>0&&value.scheduleCpuMs>=0)
    assert(!value.sourceLimited&&value.levelLimitedTiles===0&&value.policyLimitedTiles===0)
    assert.deepStrictEqual(value,JSON.parse(fs.readFileSync(path.join(imageryOutput,row.imageryObservation.file))))
  }
}
const value=images.cores.sdk.rows[0].imagery
assert.throws(()=>validateImage({...value,targetMet:false},images.configuration))
assert.throws(()=>validateImage({...value,physicalKeys:[]},images.configuration))
assert.throws(()=>validateImage({...value,uncoveredUvArea:1},images.configuration))
assert.throws(()=>validateImage({...value,sourceLimited:true},images.configuration))
assert(images.cores.desktop.rows.at(-1).imagery.neutralCoarsenCandidates>0)
console.log('Headless imagery: real persistent trees, clipped coverage, precision, TMS/WMTS binding and neutral desktop retention checked')
