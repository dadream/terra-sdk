(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraNetworkNavigation = factory()
})(typeof self === 'undefined' ? this : self, function () {
'use strict'

// Keep the strict trajectory result intact. A network lifecycle check can also
// finish at an explicitly capacity-limited endpoint, but cannot call it target
// precision or forgive outstanding work. The original 30s failure is retained.
function outcome(report) {
  const end = report.settlement
  if (report.status === 'complete' && end && end.status === 'stable' && end.final.quality.targetMet)
    return 'target-met'
  if (report.status !== 'failed' || report.failedPhase !== 'settlement' || !end || end.status !== 'timeout') return null
  const limited = s => {
    const q=s.quality||{}, t=s.textures||{}
    return q.covered && q.quiescent && q.cameraCurrent && q.planningComplete && q.terrainSelectionCurrent &&
      q.state==='limited' && q.limitedByTextureBudget && (q.limitationReasons||[]).includes('texture-budget') &&
      !q.targetMet && Number.isFinite(q.feasiblePixelError) && Number.isFinite(q.resolvedMaxPixelError) &&
      q.feasiblePixelError>q.targetPixelError && q.resolvedMaxPixelError<=q.feasiblePixelError*(1+1e-9) &&
      q.missingCount===0 && t.targetMissing===0 && t.active===0 && t.queued===0 &&
      s.memory && s.memory.overBudgetBytes===0
  }
  const reason = reasons => reasons && reasons.length===1 && reasons[0]==='imagery-target'
  const identity = s => JSON.stringify([s.view,s.selection,s.quality.feasiblePixelError])
  if (!reason(end.pendingReasons) || !limited(end.final)) return null
  const samples=(end.samples||[]).filter(s=>s.timeMs>=end.durationMs-1000)
  if (!samples.length || end.durationMs-samples[0].timeMs<250 || !samples.every(s=>
    reason(s.pendingReasons)&&limited(s.state)&&identity(s.state)===identity(end.final))) return null
  return 'capacity-limited'
}

async function verify({sdk, wasm, manifest, catalogue, payload, check, execution='worker', faults=true}) {
  const network = new window.TerraNetworkReplay.NetworkReplay(faults ? {} : {rule:(kind,key) => ({
    latencyMs:key.includes('network-teardown') ? 200 : 0,chunkDelayMs:0,chunkBytes:65536,fail:false})})
  const terrain = window.TerraNavigationTerrain.create(catalogue, payload, sdk.common.fnv1a64)
  const report = {schema: 'terra.network-navigation.v1',
    scope: 'keyed terrain; synthetic PNG through fetch/stream/decode/upload; renderer recorded by enclosing report',
    profile: faults ? {latencyMs: [40,250], chunkBytes: 4096, chunkDelayMs: 20,
      failures: 'first root attempt; first imagery attempt when key hash modulo 13 is zero',
      timing: 'faults keyed by path and attempt; motion workload remains display-clock dependent'} :
      {latencyMs:0,chunkBytes:65536,chunkDelayMs:0,failures:'none',teardownProbeLatencyMs:200}, scenarios: [],
    runtimeFailures:{count:0,first:[]}}
  const canvas = document.createElement('canvas'); canvas.width=640;canvas.height=360
  canvas.requestAnimationFrame = callback => requestAnimationFrame(callback)
  // Generate once, before the measured trajectory. Actual PNG bytes then pass
  // through Response.body and createImageBitmap; no Image.src replacement.
  const tile = document.createElement('canvas');tile.width=256;tile.height=256
  const context=tile.getContext('2d'),pixels=context.createImageData(256,256)
  for(let y=0;y<256;++y)for(let x=0;x<256;++x) {
    const p=(y*256+x)*4,n=(Math.imul(x>>2,97)^Math.imul(y>>2,163))&15
    pixels.data[p]=40+n*9;pixels.data[p+1]=80+n*7;pixels.data[p+2]=160-n*5;pixels.data[p+3]=255
  }
  context.putImageData(pixels,0,0)
  const blob=await new Promise(resolve=>tile.toBlob(resolve,'image/png'))
  if(!blob) throw new Error('PNG fixture encoding failed')
  const bytes=new Uint8Array(await blob.arrayBuffer());report.imageBytes=bytes.length
  let viewer, presentation
  const waitFor=async(predicate,label)=>{
    const deadline=performance.now()+5000
    while(performance.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20))}
    throw new Error(label)
  }
  function captureDisplayFailure(beforeRestore) {
    if(!viewer||!viewer.runtime.renderer)return
    const r=viewer.runtime.renderer,world=r.worldDisplay,plan=r.meshOutputPlan
    const key=tile=>tile&&[tile.level,tile.matrix,tile.row,tile.column].join('/')
    const rowState=row=>{
      const entry=r.geometry.entries.get(row.geometryKey),geometry=entry&&entry.value
      const target=key(row.imageryTarget||row.texture),image=r.textures.cache.entries.get(target)
      return {mesh:row.geometryKey,cell:key(row.texture),target,group:row.imageryGroup,
        targetDesired:r.textures.targetDesired.has(target),imageResident:Boolean(image&&image.value.texture),
        ready:Boolean(row.imageryPublicationState&&row.imageryPublicationState.ready),
        missingPart:Boolean(row.imageryClipCell&&!row.imageryDirectClip&&
          (!geometry||!geometry.partitions.has(row.imageryIndexCell||key(row.texture))))}
    }
    // onPhase('failed') runs before the scenario restores the original view.
    // Outer catch alone observes that newer view and loses the failed stamp.
    report.failedDisplay={capturedBeforeViewRestore:beforeRestore,
      meshPlanId:plan?plan.planId:null,
      meshPlanAccepted:Boolean(plan&&plan.accepted),meshPlanValid:Boolean(plan&&plan.valid()),
      forecastPlanId:r.forecastOutputPlan?r.forecastOutputPlan.planId:null,
      cameraVersion:r.cameraVersion,plannedCameraVersion:r.plannedCameraVersion,
      bridges:r.presentationBridges.map(key),
      records:world.records.map(record=>({current:record.aliases.has(r.renderDraws),
        handoffPlanId:record.handoffPlanId||null,goalRevision:record.goalRevision,
        stampCurrent:record.stamp===world.signature(record),
        demandCurrent:record.demandStamp===world.demandSignature(record),
        cuts:record.cuts.size,coarseCuts:record.coarseCuts?record.coarseCuts.size:0,
        problemRows:(record.rows||[]).map(rowState).filter(row=>!row.ready||row.missingPart||!row.imageResident).slice(0,32),
        pendingGroups:record.publication?Array.from(record.publication.pending,([group,members])=>({group,meshes:members.size,
          rows:(record.publication.groupRows.get(group)||[]).map(rowState).filter(row=>row.missingPart||!row.imageResident).slice(0,8)})).slice(0,32):[]})),
      worldPreparing:Boolean(world.job),resourcesRequested:r.resourcesRequested,
      renderRequested:r.renderRequested,submittedWorldRevision:r.submittedWorldRevision,
      worldRevision:world.publicationRevision}
  }
  try {
    presentation = window.TerraCanvasPresentation.mount(canvas, {width:640,height:360,devicePixelRatio:1})
    viewer=await sdk.viewer.TerraViewer.create({mode:'globe',canvas,
      dataset:Object.assign({},manifest,{dataset_id:'globe-network-snapshot'}),
      serviceOrigin:'https://terrain.example',terraModule:wasm.module,
      wasmUrl:'generated/terra_sdk.wasm',workerUrl:execution==='worker' ? 'generated/terra_worker.js' : undefined,
      request: options=>network.terrain(terrain.request,options),
      fetchTextures:(url,options)=>network.imagery(url,options,bytes),
      maximumTerrainRequests:4,maximumTerrainRetries:2,terrainRetryDelayMs:100,
      maximumTextureRetries:2,textureRetryDelayMs:100,
      onDiagnostic(kind,detail) {
        // Observe the whole trajectory, not only the bounded final-state ring.
        // Injected network retries are expected; recovered engine errors are not.
        if(['frame_callback_failed','imagery_refresh_failed','runtime_refresh_failed',
          'webgl_allocation_failed','webgl_context_restore_failed'].includes(kind)) {
          ++report.runtimeFailures.count
          if(report.runtimeFailures.first.length<8)report.runtimeFailures.first.push({kind,detail})
        }
      },
      viewport:{width:640,height:360,devicePixelRatio:1},
      initialTarget:{longitudeDegrees:116.4074,latitudeDegrees:39.9042}})
    const runtime=viewer.runtime
    report.execution=execution;report.faults=faults
    check('navigation_execution',execution==='worker' ? runtime.abi.isWorker :
      !runtime.abi.isWorker && Boolean(runtime.localExecution),execution)
    const source=id=>sdk.viewer.createTmsImagerySource({id,
      url:'https://network-fixture.invalid/'+id+'/{z}/{x}/{y}.png',texture:{maximum_level:17}})
    viewer.imagery.setSource(source('network-a'))
    for(const name of window.TerraNavigationScenarios.names) {
      // Exercise funded growth explicitly, rather than requiring the SDK's
      // calibrated default to be too small. This private fixture changes only
      // the preferred share; the real global ledger and all receipts remain.
      const preferredImageryBytes = name === 'oblique' ? 48 * 1024 * 1024 :
        runtime.resourcePolicy.textureCacheBytes
      runtime.renderer.textures.setPreferredBytes(preferredImageryBytes)
      let result
      const presentedPhases = []
      try { result=await window.TerraNavigationScenarios.run(viewer,name,{durationMs:3000,
        onPhase:phase=>{
          presentedPhases.push({phase,...presentation.inspect()})
          if(phase==='failed')captureDisplayFailure(true)
        }}) }
      catch(error) {
        if (!error.report || outcome(error.report)!=='capacity-limited') throw error
        result=error.report
      }
      result.networkOutcome=outcome(result)
      result.imageryCapacityProfile={sdkPreferredBytes:runtime.resourcePolicy.textureCacheBytes,
        scenarioPreferredBytes:preferredImageryBytes,explicitPressure:name==='oblique'}
      result.canvasPresentation={schema:'terra.canvas-presentation.v1',phases:presentedPhases}
      result.comparison.environment=faults ? 'offline keyed faults; streamed synthetic PNG' :
        'offline keyed terrain; streamed synthetic PNG without injected faults'
      report.scenarios.push(result)
      check('network_'+name+'_canvas_presented',presentedPhases.length===4,
        JSON.stringify(result.canvasPresentation))
      check('network_'+name+'_coverage',!result.blankSamples&&!result.missingSamples,
        JSON.stringify({blank:result.blankSamples,missing:result.missingSamples,samples:result.samples.length}))
      check('network_'+name+'_progress',result.terrainMeshChangeCount>0,
        JSON.stringify({submissions:result.terrainPublicationCount,meshes:result.terrainMeshChangeCount}))
      check('network_'+name+'_settled',!!result.networkOutcome,
        JSON.stringify({outcome:result.networkOutcome,durationMs:result.settlement.durationMs,
          error:result.settlement.final.quality.resolvedMaxPixelError}))
      // Preserve capacity-limited classification for failure evidence, but it
      // no longer satisfies the selected profile's imagery precision regression.
      check('network_'+name+'_imagery_target',result.networkOutcome==='target-met',
        JSON.stringify({error:result.settlement.final.quality.resolvedMaxPixelError,
          share:result.settlement.final.textures.resourceShare}))
      for (const phase of ['preparation', 'settlement']) {
        const final=result[phase].final,q=final.quality,r=final.resources
        check('network_'+name+'_'+phase+'_precision',q.ready&&q.settled&&
          q.geometryTargetComplete&&q.targetMet&&!r.limitedByCapacity&&
          Number.isFinite(r.achievedLodError)&&r.achievedLodError<=r.requestedLodThreshold*1.001&&
          Number.isFinite(q.resolvedMaxPixelError)&&q.resolvedMaxPixelError<=q.targetPixelError*1.001,
        JSON.stringify({quality:q,terrain:r}))
      }
      if (name === 'roam') {
        const final=result.settlement.final,capacity=final.selection.capacity
        check('network_roam_terrain_precision_recovered',final.quality.geometryTargetComplete &&
          !final.resources.limitedByCapacity && capacity.workingMeshBytes===capacity.preferredMeshBytes &&
          (!capacity.reductions||capacity.restorations>0),JSON.stringify({capacity,
            terrainTarget:final.quality.geometryTargetComplete,limited:final.resources.limitedByCapacity}))
      }
      if (name === 'oblique') {
        const gate=result.settlement.final.selection.demand
        const before=result.preparation.samples[0].state.selection.demand
        check('network_oblique_joint_demand',!gate.blocked&&gate.pauses>before.pauses&&
          gate.resumptions>before.resumptions&&gate.reason===null&&
          gate.planningWaits>before.planningWaits,JSON.stringify({before,final:gate}))
        const share = result.settlement.final.textures.resourceShare
        check('network_oblique_plans_before_images',share && share.preferredBytes===preferredImageryBytes &&
          share.grantsBeforeImagesReady > 0,
          JSON.stringify(share))
      }
    }
    const native=report.scenarios.find(scene=>scene.scenario==='oblique').settlement.final.imageryPlanning.work.nativeMeasurements
    check('network_native_measurements',native&&native.producer==='native'&&native.modelsBuilt>0&&
      native.measurements>0&&native.building===0&&native.activeModels===0,JSON.stringify(native))
    report.beforeDestroy=viewer.getState()
    report.traffic=network.snapshot()
    if (faults) check('network_faults_exercised',report.traffic.terrain503>=8&&report.traffic.terrainRetrySuccess>=8&&
      report.traffic.imagery503>0&&report.traffic.imageryRetrySuccess>0&&
      report.traffic.reordered>0&&report.traffic.bodyChunks>0&&report.traffic.bodyBytes>0,JSON.stringify(report.traffic))
    else check('network_without_faults',report.traffic.transient503===0&&report.traffic.bodyBytes>0,JSON.stringify(report.traffic))
    terrain.assertComplete()
    check('network_snapshot_complete',true,JSON.stringify(terrain.stats()))
    viewer.imagery.setSource(source('network-teardown'))
    await waitFor(()=>network.snapshot().activeImagery>0,'SDK did not start teardown probe')
    const before=network.snapshot().cancelled
    viewer.destroy();viewer=null
    await waitFor(()=>network.snapshot().active===0,'SDK teardown left network requests alive')
    await waitFor(()=>!runtime.refreshing&&!runtime.imageryRefreshing&&runtime.resourceLedger.bytes===0,
      'SDK teardown retained candidate or imagery ownership')
    report.releasedResourceBytes=runtime.resourceLedger.bytes
    check('network_runtime_errors',report.runtimeFailures.count===0,JSON.stringify(report.runtimeFailures))
    check('network_destroy_cancels',network.snapshot().cancelled>before,JSON.stringify(network.snapshot()))
    report.afterDestroy=network.snapshot()
    report.passed=true
    return report
  } catch(error) {
    report.passed=false;report.error=error.message;report.failedScenario=error.report||null
    if(!report.failedDisplay)captureDisplayFailure(false)
    report.state=viewer&&viewer.getState();error.networkReport=report
    throw error
  } finally {
    const cleanupErrors = []
    for (const close of [() => {if(viewer)viewer.destroy()}, () => network.close(),
      () => {if(presentation)presentation.release()}, () => canvas.remove(), () => tile.remove()]) {
      try {close()} catch (error) {cleanupErrors.push(error)}
    }
    report.finalTraffic=network.snapshot();report.terrain=terrain.stats()
    if (cleanupErrors.length) {
      report.passed=false;report.cleanupErrors=cleanupErrors.map(error=>error.message)
      if (!report.error) {cleanupErrors[0].networkReport=report;throw cleanupErrors[0]}
    }
  }
}
return {verify,outcome}
})
