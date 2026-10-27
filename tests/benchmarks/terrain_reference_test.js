const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path')
const {spawnSync} = require('child_process')
const {posesFromReport} = require('../../scripts/benchmark_terrain_reference')

const root = path.resolve(__dirname, '../..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'terra-reference-contract-'))
try {
  const fov = 0.5233333333333334, radius = 6378000
  const sample = {id:'global',level:null,rangeMeters:radius*4}
  const report = {schema:'terra.vertical-scale-benchmark.v1',
    configuration:{datasetId:'globe',radiusMeters:radius,fovRadians:fov,
      initialBudgets:{maximumTerrainMeshBytes:8388608},
      viewport:{physicalWidth:960,physicalHeight:519,devicePixelRatio:1},terrainPixelError:1.25},
    target:{longitudeDegrees:116.5623,latitudeDegrees:40.74863,heightMeters:508.131826},
    samples:[sample],steps:[{...sample,direction:'down',status:'ready',final:{metrics:{
      terrainThreshold:Math.fround(1.25/519*2*Math.tan(fov/2)),workingMeshBytes:8388608}}}]}
  const input = path.join(directory,'input.json')
  fs.writeFileSync(input,JSON.stringify(report))
  const runs = []
  for (let i=0; i<2; ++i) {
    // The reference target is independent of the production quota. A known
    // undersized quota must fail capacity acceptance without changing that cut.
    report.configuration.initialBudgets.maximumTerrainMeshBytes = i === 0 ? 8388608 : 1
    fs.writeFileSync(input,JSON.stringify(report))
    const output = path.join(directory,'run-'+i)
    const result = spawnSync(process.execPath,[path.join(root,'scripts/benchmark_terrain_reference.js'),
      '--report',input,'--output',output,'--surfaces'],{cwd:root,encoding:'utf8',timeout:15000})
    assert.strictEqual(result.status,i === 0 ? 0 : 2,result.stderr+'\n'+result.stdout)
    const evidence = JSON.parse(fs.readFileSync(path.join(output,'report.json')))
    assert(evidence.allTerrainTargetsMet && evidence.samples.length===1)
    assert.deepStrictEqual(evidence.cleanup,{nativeProcessClosed:true,activeFetches:0})
    assert.strictEqual(evidence.network.requests,0)
    const row = evidence.samples[0]
    assert.strictEqual(evidence.allReferenceCutsFitConfiguredMeshCapacity,i === 0)
    assert.strictEqual(row.meshCapacity.fitsReference,i === 0)
    assert.strictEqual(row.meshCapacity.shortfallBytes,i === 0 ? 0 : row.meshBytesWithRoots-1)
    assert(row.targetMet && !row.unverifiedMaximumLevelLeaves && !row.limitedBySafetyNodes)
    assert(row.achievedError <= row.threshold*1.001)
    assert(row.visibleMeshes > 8 && row.meshesWithRoots >= row.visibleMeshes)
    assert.strictEqual(row.positionBytes,row.meshesWithRoots * (65*66/2) * 3 * 4)
    assert.strictEqual(row.meshBytesWithRoots,row.positionBytes+row.uniqueUvBytes)
    assert(row.decodedRecordBytes>0 && row.retainedHeightBytes>0 && row.recordRequests>0)
    assert.strictEqual(row.surfaceSnapshot.meshes.length,row.visibleMeshes)
    assert.strictEqual(fs.statSync(row.surfaceSnapshot.file).size,row.surfaceSnapshot.bytes)
    assert.strictEqual(row.surfaceSnapshot.projectionView.length,16)
    runs.push(row)
  }
  assert.deepStrictEqual(runs[0].visibleKeys,runs[1].visibleKeys)
  assert.strictEqual(runs[0].surfaceSnapshot.sha256,runs[1].surfaceSnapshot.sha256)
  for (const name of ['nodes','visibleMeshes','meshBytesWithRoots','achievedError','steps'])
    assert.strictEqual(runs[0][name],runs[1][name],name+' changed for the same cold pose')
  const view={schema:'terra.view-state.v2',mode:'globe',target:report.target,
    rangeMeters:sample.rangeMeters,headingDegrees:180,tiltDegrees:0}
  const explicit={schema:'terra.demand-poses.v1',configuration:report.configuration,
    poses:[{id:'rotated',view,terrainThreshold:report.steps[0].final.metrics.terrainThreshold}]}
  assert.deepStrictEqual(posesFromReport(explicit)[0].view,view)
  assert.throws(()=>posesFromReport({...explicit,poses:explicit.poses.concat(explicit.poses)}),/Invalid reference pose/)
  assert.throws(()=>posesFromReport({...explicit,poses:[{...explicit.poses[0],view:{...view,tiltDegrees:90}}]}),/Invalid reference pose/)
  delete explicit.configuration.initialBudgets.maximumTerrainMeshBytes
  fs.writeFileSync(input,JSON.stringify(explicit))
  const output=path.join(directory,'rotated')
  const result=spawnSync(process.execPath,[path.join(root,'scripts/benchmark_terrain_reference.js'),
    '--report',input,'--output',output,'--surfaces'],{cwd:root,encoding:'utf8',timeout:15000})
  assert.strictEqual(result.status,2,result.stderr+'\n'+result.stdout)
  const rotated=JSON.parse(fs.readFileSync(path.join(output,'report.json'))).samples[0]
  assert.strictEqual(rotated.meshCapacity.fitsReference,null,'Missing capacity was reported as a fit')
  assert.deepStrictEqual(rotated.view,view)
  assert.notDeepStrictEqual(rotated.surfaceSnapshot.projectionView,runs[0].surfaceSnapshot.projectionView,
    'Explicit heading was silently treated as nadir north')
  console.log('Terrain reference: real captured records, repeated cold target, physical mesh bytes and process cleanup passed')
} finally { fs.rmSync(directory,{recursive:true,force:true}) }
