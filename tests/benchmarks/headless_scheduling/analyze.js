'use strict'
const fs=require('fs'),path=require('path')
const {digest}=require('./records'),{roundtrip}=require('./compare')
const assert=(value,message)=>{if(!value)throw new Error(message)}

// Diagnose this terrain implementation stage. A valid diagnosis is not a
// completed two-backend benchmark or an SDK product/performance pass.
function analyze(directories) {
  const names=['nadir','oblique','production','desktop']
  const reports=Object.fromEntries(names.map(name=>{
    const report=JSON.parse(fs.readFileSync(path.join(directories[name],'report.json')))
    assert(report.schema==='terra.headless-scheduling.v1'&&report.status==='complete'&&report.inputsUnchanged,
      'Incomplete or changing benchmark inputs: '+name)
    assert(report.network.requests===0&&report.cleanup.nativeProcessesClosed&&
      report.cleanup.activeRequests===0&&report.cleanup.liveSockets===0&&
      report.cleanup.testBrowsers===0&&report.cleanup.testServices===0,'Online or unclosed benchmark: '+name)
    return [name,report]
  }))
  for(const field of ['sourceSha256','binarySha256'])assert(new Set(names.map(name=>reports[name][field])).size===1,
    'Diagnostic reports use different '+field)
  assert(new Set(names.map(name=>reports[name].data.datasetSha256)).size===1,'Diagnostic datasets differ')
  for(const name of ['nadir','oblique']) {
    const r=reports[name]
    assert(r.sdkResourceMode==='fixed'&&r.capacityProfile==='demand'&&r.selectedBackendTargetsMet&&
      r.sameRoundtripSets===true,'Unproven fixed-input SDK cut: '+name)
    assert(new Set(r.cores.sdk.rows.map(row=>row.resourceInput.sha256)).size===1,'Fixed resource inputs changed')
    assert(r.cores.sdk.rows.length===r.poses.length,'Incomplete measured route')
    for(const row of r.cores.sdk.rows) {
      assert(row.unverifiedMaximumLevelLeaves===0&&!row.limitedByCapacity,'Unverified target quality')
      assert(row.meshPayload.selectionBytes===row.meshPayload.positionBytes+row.meshPayload.uniqueUvBytes,
        'Invalid selection payload')
    }
  }
  assert(reports.nadir.cores.sdk.rows.length===33&&reports.oblique.cores.sdk.rows.length===10,
    'Unexpected Tai\'an case shape')
  assert(reports.oblique.reliefQualification.sdk===true&&
    reports.oblique.cameraValidation.every(row=>row.clearanceMeters>1),'Invalid oblique DEM/camera')
  const production=reports.production,block=production.firstBlocker
  assert(production.capacityProfile==='production'&&block?.status==='capacity-limited'&&
    production.productionTerrainMeshBytes===reports.oblique.productionTerrainMeshBytes,'Missing production capacity result')
  const constrained=production.cores.sdk.rows.find(row=>row.id===block.id)
  const target=reports.oblique.cores.sdk.rows.find(row=>row.id===block.id)
  assert(target&&constrained.limitedByCapacity&&!constrained.targetMet&&
    constrained.resourceInput.sha256===target.resourceInput.sha256&&
    constrained.threshold===target.threshold&&JSON.stringify([constrained.projection,constrained.view])===
      JSON.stringify([target.projection,target.view]),'Capacity comparison inputs differ')
  assert(target.meshPayload.selectionBytes>production.productionTerrainMeshBytes,'No proved mesh quota shortfall')
  const readInput=(name,row)=>{
    const bytes=fs.readFileSync(path.resolve(directories[name],row.resourceInput.file))
    assert(digest(bytes)===row.resourceInput.sha256,'Resource input snapshot changed')
    return JSON.parse(bytes)
  }
  const discovery=reports.oblique.cores.sdk.discoveryRows
  const changes=roundtrip(discovery,reports.oblique.poses).filter(row=>!row.sameSets).map(pair=>{
    const first=discovery.find(row=>row.id===pair.first),second=discovery.find(row=>row.id===pair.second)
    const a=readInput('oblique',first),b=readInput('oblique',second)
    const current=new Map(b.heightRanges.map(row=>[row.slice(0,4).join('/'),row.slice(4)]))
    const changedRanges=a.heightRanges.filter(row=>current.has(row.slice(0,4).join('/'))&&
      JSON.stringify(row.slice(4))!==JSON.stringify(current.get(row.slice(0,4).join('/'))))
    const differingNodes=new Set([...pair.sets.visible.onlyFirst,...pair.sets.visible.onlySecond]
      .map(key=>key.split('/').slice(0,4).join('/')))
    return {first:pair.first,second:pair.second,firstVisible:pair.sets.visible.first,secondVisible:pair.sets.visible.second,
      inputsChanged:first.resourceInput.sha256!==second.resourceInput.sha256,changedRangeCount:changedRanges.length,
      changedRangesAtDifferingNodes:changedRanges.filter(row=>differingNodes.has(row.slice(0,4).join('/')))
        .map(row=>({key:row.slice(0,4),before:row.slice(4),after:current.get(row.slice(0,4).join('/'))}))}
  })
  const desktop=reports.desktop.firstBlocker
  assert(desktop?.status==='stalled'&&desktop.cachedUpdateReturnEligible&&desktop.cachedUpdateReturns>=10&&
    desktop.pendingCoarsenKeys.length>0,'Desktop fixed-pose driving limitation was not reproduced')
  const maximum=rows=>Math.max(...rows.map(row=>row.meshPayload.selectionBytes))
  return {schema:'terra.headless-terrain-diagnosis.v1',status:'diagnosed',
    sourceSha256:reports.nadir.sourceSha256,binarySha256:reports.nadir.binarySha256,
    datasetSha256:reports.nadir.data.datasetSha256,
    fixedSdk:{nadirStages:33,obliqueStages:10,nadirRoundtrips:reports.nadir.roundtrips.sdk.length,
      obliqueRoundtrips:reports.oblique.roundtrips.sdk.length,sameEndpointSets:true,
      maximumNadirSelectionBytes:maximum(reports.nadir.cores.sdk.rows),
      maximumObliqueSelectionBytes:maximum(reports.oblique.cores.sdk.rows)},
    productionCapacity:{configuredBytes:production.productionTerrainMeshBytes,firstLimitedPose:block.id,
      targetSelectionBytes:target.meshPayload.selectionBytes,
      shortfallBytes:target.meshPayload.selectionBytes-production.productionTerrainMeshBytes,
      achievedPixelError:constrained.achievedError/constrained.threshold*reports.production.configuration.terrainPixelError,
      scope:'Required cut from this core, one position copy plus certified UVs/roots; not a proof of total joint memory'},
    progressiveInputDifferences:changes,desktopDrivingLimitation:desktop,
    remaining:['Complete original desktop fixed-pose driving semantics without changing its algorithm',
      'Desktop/SDK imagery controllers and source-resource comparison','Actual Wasm Direct and Worker profiles',
      'Joint terrain/image/temporary/transition capacity','Repeated fixed-work performance and real Web acceptance'],
    fullBenchmarkComplete:false,sdkProductAccepted:false,cleanupVerified:true}
}
if(require.main===module) {
  try {
    const base=path.resolve(process.argv[2]||'viewer_verify_output/headless_scheduling_20261022')
    const result=analyze({nadir:path.join(base,'nadir-final'),oblique:path.join(base,'oblique-final'),
      production:path.join(base,'oblique-production'),desktop:path.join(base,'desktop-final')})
    fs.writeFileSync(path.join(base,'diagnosis.json'),JSON.stringify(result,null,2))
    console.log('Headless terrain diagnosis recorded; full benchmark and SDK acceptance remain open')
  } catch(error) {console.error(error.message);process.exitCode=1}
}
module.exports={analyze}
