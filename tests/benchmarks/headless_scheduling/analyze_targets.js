'use strict'
const fs=require('fs'),path=require('path')
const {digest,datasetIdentity}=require('./records'),{compare,roundtrip}=require('./compare')
const root=path.resolve(__dirname,'../../..')
const assert=(value,message)=>{if(!value)throw new Error(message)}
const read=file=>JSON.parse(fs.readFileSync(file))
function snapshot(directory,receipt) {
  const file=path.resolve(directory,receipt.file)
  assert(file.startsWith(path.resolve(directory)+path.sep),'Snapshot leaves report directory')
  const bytes=fs.readFileSync(file)
  assert(digest(bytes)===receipt.sha256,'Changed observation/input snapshot')
  return JSON.parse(bytes)
}
function verifiedReport(directory) {
  const r=read(path.join(directory,'report.json')),frozen=read(path.join(directory,'source-state.json'))
  assert(r.schema==='terra.headless-scheduling.v1'&&r.status==='complete'&&r.inputsUnchanged&&
    r.completeBoth&&r.allTargetsMet&&r.desktopMode==='target'&&r.desktopTimingEligible===false&&
    r.sdkResourceMode==='fixed'&&r.capacityProfile==='demand','Incomplete target comparison')
  assert(r.network.requests===0&&r.cleanup.nativeProcessesClosed&&r.cleanup.activeRequests===0&&
    r.cleanup.liveSockets===0&&r.cleanup.testBrowsers===0&&r.cleanup.testServices===0,'Unclosed or online sample')
  assert(digest(Buffer.from(JSON.stringify(frozen.files)))===r.sourceSha256&&
    frozen.sourceSha256===r.sourceSha256&&frozen.binarySha256===r.binarySha256,'Invalid provenance receipt')
  for(const row of frozen.files) {
    const file=path.resolve(root,row.file)
    assert(file.startsWith(root+path.sep)&&digest(fs.readFileSync(file))===row.sha256,'Changed source: '+row.file)
  }
  assert(digest(fs.readFileSync(r.binaryPath))===r.binarySha256,'Changed native binary')
  const pack=read(path.join(directory,'records.json'))
  assert(datasetIdentity(pack)===r.data.datasetSha256,'Changed fixture catalogue')
  for(const row of pack.records)if(row.status===200) {
    const file=path.resolve(directory,row.file)
    assert(file.startsWith(path.resolve(directory)+path.sep),'Record leaves fixture directory')
    const bytes=fs.readFileSync(file)
    assert(bytes.length===row.bytes&&digest(bytes)===row.sha256,'Changed encoded fixture')
  }
  assert(digest(fs.readFileSync(path.join(root,'testdata/miniprogram/navigation_terrain/terrain-records.bin')))===
    pack.fixtureSha256,'Changed base terrain fixture')
  const desktop=r.cores.desktop.rows,sdk=r.cores.sdk.rows
  assert(desktop.length===r.poses.length&&sdk.length===r.poses.length,'Incomplete route')
  assert(r.cores.desktop.complete&&r.cores.sdk.complete&&r.cores.desktop.nativeProcessClosed&&
    r.cores.sdk.nativeProcessClosed,'Unfinished core process')
  assert(new Set(sdk.map(row=>row.resourceInput.sha256)).size===1,'Changing fixed SDK inputs')
  const differences=[]
  const comparisons=desktop.map((row,i)=>{
    const result=compare(row,sdk[i])
    assert(row.id===r.poses[i].id&&result.bothReady&&result.bothTargetsMet,'Unfinished or reordered target stage')
    for(const actual of [row,sdk[i]])assert(actual.unverifiedMaximumLevelLeaves===0&&!actual.limitedByCapacity&&
      actual.threshold>0&&Number.isFinite(actual.achievedError)&&actual.achievedError<=actual.threshold*1.001,
      'Target quality does not meet its actual threshold')
    const observation=snapshot(directory,row.terrainObservation)
    const inputs=snapshot(directory,sdk[i].resourceInput)
    assert(row.pendingCoarsens===0&&row.pendingRefines===0&&row.logicalPublications>0,
      'Unfinished desktop target/consumer')
    if(!result.sameSets) {
      const onlyDesktop=new Set(result.sets.visible.onlyFirst.map(key=>key.split('/').slice(0,4).join('/')))
      const ranges=new Map(inputs.heightRanges.map(value=>[value.slice(0,4).join('/'),value.slice(4)]))
      differences.push({id:row.id,sets:result.sets,desktopOnlyVisibleLeaves:observation.leaves
        .filter(leaf=>onlyDesktop.has(leaf.key.join('/'))).map(leaf=>({...leaf,
          sdkInputHeightRange:ranges.get(leaf.key.join('/')),
          sameHeightRange:JSON.stringify(leaf.activeHeightRange)===JSON.stringify(ranges.get(leaf.key.join('/'))),
          threshold:row.threshold}))})
    }
    return result
  })
  return {report:r,comparisons,differences,roundtrips:{desktop:roundtrip(desktop,r.poses),sdk:roundtrip(sdk,r.poses)},
    discoveryComparisons:desktop.map((row,i)=>compare(row,r.cores.sdk.discoveryRows[i])),
    completionCoarsens:desktop.reduce((sum,row)=>sum+row.completionCoarsens,0),
    sourceFilesVerified:frozen.files.length}
}
function analyze(base) {
  const nadir=verifiedReport(path.join(base,'nadir')),oblique=verifiedReport(path.join(base,'oblique'))
  for(const field of ['sourceSha256','binarySha256'])assert(nadir.report[field]===oblique.report[field],'Different '+field)
  assert(nadir.report.data.datasetSha256===oblique.report.data.datasetSha256,'Different terrain dataset')
  assert(nadir.comparisons.length===33&&oblique.comparisons.length===10,'Unexpected route shape')
  assert(nadir.comparisons.every(row=>row.sameSets)&&
    Object.values(nadir.roundtrips).every(rows=>rows.every(row=>row.sameSets)),'Nadir target set mismatch')
  assert(oblique.report.cameraValidation.every(row=>row.clearanceMeters>1)&&
    oblique.report.reliefQualification.desktop&&oblique.report.reliefQualification.sdk,'Invalid mountain case')
  return {schema:'terra.desktop-target-comparison.v1',status:'diagnosed',
    sourceSha256:nadir.report.sourceSha256,binarySha256:nadir.report.binarySha256,
    datasetSha256:nadir.report.data.datasetSha256,sourceFilesVerified:nadir.sourceFilesVerified,
    nadir:{stages:33,allSetsEqual:true,roundtripPairs:nadir.roundtrips.desktop.length,
      completionCoarsens:nadir.completionCoarsens},
    oblique:{stages:10,differences:oblique.differences,roundtrips:oblique.roundtrips,
      discoveryDifferences:oblique.discoveryComparisons.filter(row=>!row.sameSets),
      completionCoarsens:oblique.completionCoarsens},
    precision:'Both controllers meet their actual bounding-volume error; different input bounds do not establish equal cuts',
    desktopScope:'Original heap/coarsen with explicit cached-return completion and original accessor logical cut ownership; not desktop runtime timing',
    fullTerrainParity:oblique.differences.length===0,fullBenchmarkComplete:false,sdkProductAccepted:false,
    cleanupVerified:true,remaining:['Explain and close oblique height-bound input semantics',
      'Actual desktop/SDK imagery target and physical image capacity','Wasm Direct/Worker integration',
      'Joint resource capacity and real Web performance/visual acceptance']}
}
if(require.main===module) {
  try {
    const base=path.resolve(process.argv[2])
    const result=analyze(base)
    fs.writeFileSync(path.join(base,'comparison.json'),JSON.stringify(result,null,2))
    console.log('Verified target comparison: nadir '+result.nadir.stages+' equal stages; oblique '+
      result.oblique.differences.length+' different stages; complete SDK acceptance remains open')
  } catch(error) {console.error(error.message);process.exitCode=1}
}
module.exports={analyze,verifiedReport}
