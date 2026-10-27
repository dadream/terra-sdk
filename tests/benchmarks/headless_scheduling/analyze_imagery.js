'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path')
const {verifiedReport}=require('./analyze_targets')
const {validate,compare,profile}=require('./imagery')
const {roundtrip}=require('./compare')
const {digest}=require('./records')

function analyze(base) {
  const cases={}
  let reference
  for(const name of ['nadir','oblique']) {
    const directory=path.resolve(base,name),verified=verifiedReport(directory),r=verified.report
    assert(r.configuration.benchmarkImagery&&r.cores.sdk.discoveryRows.every(row=>!row.imagery))
    assert.deepStrictEqual(r.imageryProfile,profile(r.configuration))
    if(reference) {
      for(const field of ['sourceSha256','binarySha256'])assert.strictEqual(r[field],reference[field])
      assert.strictEqual(r.data.datasetSha256,reference.data.datasetSha256)
    } else reference=r
    const cores={}
    for(const [backend,core] of Object.entries(r.cores)) {
      for(const stage of core.rows) {
        const actual=validate(stage.imagery,r.configuration)
        const file=path.resolve(directory,stage.imageryObservation.file)
        assert(file.startsWith(directory+path.sep),'Imagery snapshot leaves output directory')
        const bytes=fs.readFileSync(file)
        assert.strictEqual(digest(bytes),stage.imageryObservation.sha256)
        assert.deepStrictEqual(actual,JSON.parse(bytes))
      }
      const rows=core.rows.map(row=>({...row.imagery,id:row.id}))
      const peak=field=>Math.max(...rows.map(row=>row[field]))
      cores[backend]={stages:rows.length,precisionMetStages:rows.filter(row=>row.targetMet).length,
        sourceLimited:rows.filter(row=>row.sourceLimited).map(row=>({id:row.id,error:row.maximumPixelError,tiles:row.levelLimitedTiles})),
        policyLimited:rows.filter(row=>row.policyLimitedTiles>0).map(row=>({id:row.id,error:row.maximumPixelError,tiles:row.policyLimitedTiles})),
        peakVisibleImages:Math.max(...rows.map(row=>row.physicalKeys.length)),
        peakNominalRgbaBytes:peak('visibleNominalRgbaBytes'),peakPlannerOwnedBytes:peak('plannerOwnedBytes'),
        peakPreparationWorkspaceBytes:peak('preparationPeakBytes'),
        maximumPreparationCpuMs:peak('preparationCpuMs'),maximumScheduleCpuMs:peak('scheduleCpuMs'),
        maximumScheduleCallCpuMs:peak('maximumScheduleCallCpuMs'),
        roundtrips:roundtrip(rows,r.poses),first:rows[0],last:rows.at(-1)}
    }
    cases[name]={cores,comparisons:r.cores.desktop.rows.map((row,i)=>({id:row.id,
      ...compare(row.imagery,r.cores.sdk.rows[i].imagery)})),terrainDifferences:verified.differences}
  }
  assert.strictEqual(cases.nadir.cores.sdk.stages,33)
  assert.strictEqual(cases.oblique.cores.sdk.stages,10)
  return {schema:'terra.imagery-target-diagnosis.v1',status:'diagnosed',sourceSha256:reference.sourceSha256,
    binarySha256:reference.binarySha256,datasetSha256:reference.data.datasetSha256,cases,
    comparisonScope:reference.imageryProfile,
    timing:'Single diagnostic route; preparation rebuilds real models. No warmed runtime speed ratio or frame-time claim.',
    capacity:'Visible base-level RGBA estimates only; no decoder, mipmap, GPU, transition or joint-memory proof.',
    fullBenchmarkComplete:false,sdkProductAccepted:false,cleanupVerified:true}
}
if(require.main===module) {
  try {
    const base=path.resolve(process.argv[2]),result=analyze(base)
    fs.writeFileSync(path.join(base,'imagery-diagnosis.json'),JSON.stringify(result,null,2))
    for(const [name,value] of Object.entries(result.cases))for(const [backend,core] of Object.entries(value.cores))
      console.log(name,backend,'stages='+core.stages,'peakImages='+core.peakVisibleImages,
        'precisionMet='+core.precisionMetStages,'sourceLimited='+core.sourceLimited.length)
  } catch(error) {console.error(error.stack);process.exitCode=1}
}
module.exports={analyze}
