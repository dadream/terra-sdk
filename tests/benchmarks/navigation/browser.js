'use strict'
const report={schema:'terra.controlled-navigation.v1',status:'running',sdkProductAccepted:false,
  phases:[],samples:[],errors:[],blankSamples:0,missingSamples:0,
  scope:'Offline real terrain and one256px PNG; fixed public direct-flight path and endpoints. Async publications and intermediate request sets can differ. State coverage is not pixel/visual acceptance.'}
const output=document.getElementById('report'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const check=(value,message)=>{if(!value)throw Error(message)}
const save=final=>{output.textContent=JSON.stringify(final?report:{status:report.status,phase:report.phase,
  samples:report.samples.length,last:report.samples[report.samples.length-1]})}
let viewer,presentation,terrain,pipeline,animation=null,closeVisual,captureEndpoint
const origin=performance.now(),now=()=>performance.now()-origin
async function main() {
  const [test,catalogue,payload]=await Promise.all(['case.json','terrain.json','terrain.bin'].map(
    p=>fetch(p).then(r=>p.endsWith('.bin')?r.arrayBuffer():r.json())))
  const {config,dataset,options}=test,sdk=window.TerraWebSdk
  const backend=new URL(location.href).searchParams.get('backend')
  check(['worker','direct'].includes(backend),'Unknown execution backend')
  check(config.schema==='terra.navigation-case.v1','Unknown navigation case')
  const legs=window.TerraNavigationAcceptance.legs(config)
  report.backend=backend;report.configuration=config;report.monotonicOrigin=origin
  report.expectedEndpoint=window.TerraNavigationAcceptance.endpoint(config)
  dataset.textures[0].url_template=location.origin+'/tile.png?z={z}&x={x}&y={y}'
  // The49 proxy accepts logical source levels; generic TMS {z} is the matrix.
  // Use the same public Tianditu adapter as the demo, including its +1 matrix.
  const liveSource=options.liveImagery?sdk.imagery.resolveImageryProfile('tianditu-img-c',null,null,location.origin):undefined
  report.liveImagery=Boolean(options.liveImagery)
  if(options.liveImagery)report.scope='Verified terrain, live Tianditu imagery via49; fixed Web trajectory. Not offline timing.'
  terrain=window.TerraNavigationTerrain.create(catalogue,payload,sdk.common.fnv1a64)
  if(options.terrainUpstream) {
    report.acquisition=true
    report.scope='Explicit terrain input acquisition; not offline timing or functional acceptance'
    const known=terrain.stats(),keys=new Set();let requests=0
    terrain={assertComplete(){},stats:()=>({...known,requests,uniqueRequests:keys.size,acquisition:true}),
      request(options) {
        const match=/\/(root|detail)\/(-?\d+)\/(-?\d+)\/(-?\d+)$/.exec(new URL(options.url).pathname)
        check(match,'Unexpected acquisition request');const key=match.slice(1).join('/'),controller=new AbortController()
        ++requests;keys.add(key)
        return {abort:()=>controller.abort(),promise:fetch('/capture/'+key,{signal:controller.signal}).then(async response=>{
          const data=await response.arrayBuffer()
          return {statusCode:response.status,data,header:{'Content-Length':String(data.byteLength),
            'X-Terra-Checksum':'fnv1a64:'+sdk.common.fnv1a64(new Uint8Array(data))}}
        })}
      }}
  }
  const canvas=document.createElement('canvas');canvas.width=config.viewport.width;canvas.height=config.viewport.height
  const phase=name=>{report.phase=name;const row={name,startMs:now()};report.phases.push(row);save();return row}
  function sample() {
    terrain.assertComplete()
    const state=viewer.getState(),r=state.renderer||{},q=window.TerraVerticalScaleBenchmark.quality(state)
    const resources=state.resources||{},selection=state.terrainSelection||{},textures=r.textures||{},requests=state.terrain||{}
    check(!state.error&&!report.errors.length,'Runtime failure')
    check(!state.resourceMemory.overBudgetBytes,'Managed capacity exceeded')
    if(pipeline)pipeline.sample()
    const row={timeMs:now(),phase:report.phase,view:state.view,quality:q,
      sequence:state.frame&&state.frame.sequence,decisionsComplete:state.frame&&state.frame.decisionsComplete,
      modelRevision:selection.presentedModelRevision,
      terrainNodes:resources.topologyNodeCount,terrainRequests:requests.active,
      terrainQueued:requests.queued,targets:textures.targetDesired,
      imageRequests:textures.active,imageQueued:textures.queued,
      targetCoverage:(r.quality||{}).targetCoverage,managedBytes:state.resourceMemory.bytes,
      highWaterBytes:state.resourceMemory.highWaterBytes,draws:(r.draws||{}).submitted||0,
      missing:(r.quality||{}).missingCount,planning:(state.performance||{}).workerImageryPlanning,
      encodedSource:viewer.runtime.renderer.textures.sourceCache&&viewer.runtime.renderer.textures.sourceCache.stats(),
      world:(r.transition||{}).worldDisplay}
    report.samples.push(row)
    if(report.phase==='motion') {
      if(!row.draws)++report.blankSamples
      if(row.missing>0)++report.missingSamples
    }
    check(report.samples.length<=1200,'Navigation sample limit exceeded')
    save();return {state,quality:q}
  }
  async function condition(name,view,leg) {
    const row=phase(name),windowCheck=new window.TerraNavigationAcceptance.SettledWindow(config,view,
      window.TerraVerticalScaleBenchmark.sameView,name==='settlement'&&(config.sourceLimits||{})[leg])
    row.leg=leg
    for(;;) {
      const observation=sample(),elapsed=now()-row.startMs
      const status=windowCheck.observe(elapsed,observation.state,observation.quality)
      if(status!=='waiting') {
        Object.assign(row,{status,durationMs:elapsed,final:window.TerraVerticalScaleProbe.read(viewer)})
        if(captureEndpoint)await captureEndpoint(status)
        return status==='ready'||status==='source-limited'
      }
      await sleep(100)
    }
  }
  try {
    presentation=window.TerraCanvasPresentation.mount(canvas,config.viewport)
    phase('creation')
    viewer=await sdk.viewer.TerraViewer.create({mode:'globe',canvas,dataset,request:terrain.request,
      imagery:liveSource,
      serviceOrigin:'https://terrain.example',wasmUrl:location.origin+'/terra_sdk.wasm',
      workerUrl:backend==='worker'?location.origin+'/terra_worker.js':undefined,
      initialView:config.view,viewport:config.viewport,verticalFovRadians:config.verticalFovRadians,
      terrainPixelError:config.terrainPixelError,imageryPixelError:config.imageryPixelError,...options.capacity,
      onDiagnostic(kind,detail) {
        if(kind==='texture_load_failed'||kind==='texture_request_failed') {
          if(!report.imageFailures)report.imageFailures=[]
          if(report.imageFailures.length<64)report.imageFailures.push({timeMs:now(),kind,detail})
        }
        if(options.tracePipeline&&kind==='imagery_input_capacity') {
          if(!report.capacityWaits)report.capacityWaits=[]
          if(report.capacityWaits.length<64)report.capacityWaits.push({timeMs:now(),detail})
        }
        if(['frame_callback_failed','imagery_refresh_failed','runtime_refresh_failed','terrain_worker_failed',
          'terrain_advance_failed','webgl_allocation_failed','webgl_context_restore_failed','partition_prepare_failed'].includes(kind))
          report.errors.push({kind,detail})
      }})
    Object.assign(report.phases[0],{status:'ready',durationMs:now()-report.phases[0].startMs})
    const runtime=viewer.runtime,renderer=runtime.renderer,gl=renderer.gl
    check(Boolean(runtime.abi.isWorker)===(backend==='worker'),'Wrong execution backend')
    report.effectiveCapacity={...config.expectedCapacity,...options.capacity}
    for(const [key,value]of Object.entries(report.effectiveCapacity))
      check(runtime.resourcePolicy[key==='maximumPartitionBytes'?'partitionCacheBytes':key]===value,
        'Effective capacity differs: '+key)
    const extension=gl.getExtension('WEBGL_debug_renderer_info')
    report.renderer=gl.getParameter(extension?extension.UNMASKED_RENDERER_WEBGL:gl.RENDERER)
    if(options.visual) {
      const render=renderer.render,counts=new Map();let last=-Infinity,pendingEndpoint
      report.visualFrames=[]
      renderer.render=function(...args) {
        const value=render.apply(this,args),time=now(),key=report.phases.length
        if(value&&this.surfaceDrawn!==false&&report.visualFrames.length<24&&
            (pendingEndpoint||time-last>=1000&&(counts.get(key)||0)<4)) {
          last=time;counts.set(key,(counts.get(key)||0)+1)
          const view=viewer.getState().view,coverage=[]
          for(let level=0;level<=17;++level) {
            const row=Math.floor((90-view.target.latitudeDegrees)/180*2**level)
            const column=Math.floor((view.target.longitudeDegrees+180)/360*2**(level+1))
            const id=[level,level+1,row,column].join('/')
            coverage.push({level,resident:this.textures.gpuReady(id),
              available:this.textures.availableKeys.has(id),target:this.textures.targetDesired.has(id)})
          }
          report.visualFrames.push({timeMs:time,phase:report.phase,leg:report.phases[key-1].leg,
            endpoint:pendingEndpoint,view,centerCoverage:coverage,image:canvas.toDataURL('image/png')})
          pendingEndpoint=null
        }
        return value
      }
      captureEndpoint=async status=>{
        pendingEndpoint=status
        const deadline=performance.now()+1000
        while(pendingEndpoint&&performance.now()<deadline) {renderer.render();if(pendingEndpoint)await sleep(16)}
        check(!pendingEndpoint,'Endpoint canvas capture did not submit')
      }
      closeVisual=()=>{renderer.render=render}
    }
    if(options.tracePipeline) {
      pipeline=window.TerraStaticPipeline.installPipelineTrace(renderer,now)
      report.pipeline=pipeline.trace;report.pipeline.monotonicOrigin=origin
      const cancel=runtime.abi.cancelImagery
      report.planningChanges=[]
      if(cancel)runtime.abi.cancelImagery=function(previous,next) {
        if(report.planningChanges.length<64)report.planningChanges.push({timeMs:now(),phase:report.phase,previous,next})
        return cancel.call(this,previous,next)
      }
    }
    report.settled=await condition('preparation',config.view)
    for(const leg of legs) {
      if(!report.settled)break
      viewer.diagnostics.reset()
      const row=phase('motion'),target=leg.view.target,motion=leg.motion
      row.leg=leg.index;row.kind=motion.kind
      let zoomDone=false,zoomError,lastZoom=-1
      if(motion.kind==='log-zoom') {
        const tick=()=>{
          animation=null
          try {
            const progress=Math.min(motion.samples,Math.floor((now()-row.startMs)/motion.durationMs*motion.samples))/motion.samples
            if(progress!==lastZoom)viewer.camera.setView(window.TerraNavigationAcceptance.zoomView(leg.from,leg.view,progress))
            lastZoom=progress
            zoomDone=progress===1
            if(!zoomDone)animation=requestAnimationFrame(tick)
          }catch(error){zoomError=error}
        }
        animation=requestAnimationFrame(tick)
      }else viewer.camera.flyTo([target.longitudeDegrees,target.latitudeDegrees,target.heightMeters],{
        path:'direct',durationMs:motion.durationMs,headingDegrees:leg.view.headingDegrees,
        rangeMeters:leg.view.rangeMeters,tiltDegrees:leg.view.tiltDegrees})
      for(;;) {
        if(zoomError)throw zoomError
        const {state}=sample(),elapsed=now()-row.startMs
        if(motion.kind==='log-zoom'?zoomDone:state.cameraMotion.mode==='idle'&&state.cameraMotion.progress===1) {
          check(window.TerraVerticalScaleBenchmark.sameView(state.view,leg.view),
            'Public flight did not reach the declared endpoint')
          Object.assign(row,{status:'complete',durationMs:elapsed,endpoint:state.view});break
        }
        check(elapsed<=motion.durationMs+1000,'Public flight exceeded its animation watchdog')
        await sleep(100)
      }
      report.motionPerformance=viewer.diagnostics.snapshot()
      row.performance=report.motionPerformance
      report.settled=await condition('settlement',leg.view,leg.index)
    }
    report.final=window.TerraVerticalScaleProbe.read(viewer)
    report.withinOriginalDeadline=report.settled&&report.phases.filter(p=>p.name==='preparation'||p.name==='settlement')
      .every(p=>['ready','source-limited'].includes(p.status)&&p.durationMs<=config.acceptanceMs)
    report.motionExecuted=report.phases.filter(p=>p.name==='motion'&&p.status==='complete').length===legs.length
    report.performance=viewer.diagnostics.snapshot()
    report.status='collected'
  } catch(error) {
    report.status='failed';report.error=error.stack||String(error)
    if(viewer)report.failureState=viewer.getState()
  } finally {
    report.cleanupErrors=[]
    const clean=operation=>{try{operation()}catch(error){report.cleanupErrors.push(error.stack||String(error))}}
    if(animation!==null)clean(()=>cancelAnimationFrame(animation))
    if(closeVisual)clean(closeVisual)
    if(pipeline)clean(()=>pipeline.close())
    if(viewer) {
      clean(()=>viewer.camera.cancelAnimation());clean(()=>viewer.destroy())
      if(viewer.runtime.abi.termination)try{await viewer.runtime.abi.termination}
      catch(error){report.cleanupErrors.push(error.stack||String(error))}
      const deadline=performance.now()+2000
      while(viewer.runtime.resourceLedger.bytes&&performance.now()<deadline)await sleep(20)
    }
    if(presentation)clean(()=>presentation.release())
    report.terrain=terrain.stats();report.durationMs=now()
    report.cleanup={runtimeDestroyed:!viewer||viewer.runtime.destroyed,
      managedBytes:viewer?viewer.runtime.resourceLedger.bytes:0,
      owners:viewer?viewer.runtime.resourceLedger.stats().owners:{},
      producerStopped:!viewer||(backend==='worker'?Boolean(viewer.runtime.abi.termination):viewer.runtime.abi.destroyed),
      canvasRemoved:!canvas.isConnected}
    save(true)
  }
  check(!report.cleanupErrors.length&&report.cleanup.managedBytes===0&&report.cleanup.producerStopped,
    'Incomplete navigation cleanup')
  document.documentElement.dataset.terraStatus=report.status==='collected'?'passed':'failed'
}
main().catch(error=>{
  report.status='failed'
  if(report.error)report.collectionError=error.stack||String(error)
  else report.error=error.stack||String(error)
  save(true)
  document.documentElement.dataset.terraStatus='failed'
})
