window.verifyTerrainVisibility = async function (sdk) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const gl = canvas.getContext('webgl2', {antialias: true, stencil: true, preserveDrawingBuffer: true})
  if (!gl) throw new Error('Visibility fixture requires WebGL2')
  const {TerrainVisibility} = sdk.testVisibility
  const shaders = [], program = gl.createProgram()
  let observer, sync, maximumQueries = 0, requests = 0, notifications = 0
  const live = new Set(), createQuery = gl.createQuery.bind(gl), deleteQuery = gl.deleteQuery.bind(gl)
  gl.createQuery = () => { const q=createQuery();live.add(q);maximumQueries=Math.max(maximumQueries,live.size);return q }
  gl.deleteQuery = q => {live.delete(q);deleteQuery(q)}
  const check = (value, message) => { if (!value) throw new Error(message) }
  const completed = async () => {
    sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush()
    const started=performance.now()
    while(true) {
      const status=gl.clientWaitSync(sync,0,0)
      if(status===gl.ALREADY_SIGNALED || status===gl.CONDITION_SATISFIED)break
      if(status!==gl.TIMEOUT_EXPIRED || performance.now()-started>5000)throw new Error('Visibility GPU deadline')
      await new Promise(resolve=>setTimeout(resolve,0))
    }
    gl.deleteSync(sync);sync=null
  }
  const pixels = () => {
    const out=new Uint8Array(128*128*4)
    gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,out)
    return out
  }
  try {
    for(const [type,source] of [
      [gl.VERTEX_SHADER,'#version 300 es\nvoid main(){vec2 p=vec2(gl_VertexID&1,(gl_VertexID>>1)&1);gl_Position=vec4(mix(vec2(-.8),vec2(.8),p),-.2,1.0);}'],
      [gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1.0);}']]) {
      const shader=gl.createShader(type);shaders.push(shader)
      gl.shaderSource(shader,source);gl.compileShader(shader)
      check(gl.getShaderParameter(shader,gl.COMPILE_STATUS),gl.getShaderInfoLog(shader))
      gl.attachShader(program,shader)
    }
    gl.linkProgram(program);check(gl.getProgramParameter(program,gl.LINK_STATUS),gl.getProgramInfoLog(program))
    const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
    const frame={projectionView:identity,cameraPosition:[0,0,0]}
    const draws=Array.from({length:25},(_,i)=>({resourceId:i+1,geometryKey:'mesh:1:'+(i+1),origin:[0,0,0],firstIndex:0,indexCount:4,flags:0}))
    const boxes=[[-.8,-.8,-.2,.8,.8,-.2],[-.4,-.4,.2,.4,.4,.2],[.82,-.2,.2,.95,.2,.2],[-.2,-.2,-1.1,.2,.2,.2],[2,0,0,3,1,0]]
    const largeOrigin=2**20
    boxes[10]=boxes[1].map(value=>Math.fround(largeOrigin+value))
    draws[10].origin=[-largeOrigin,-largeOrigin,-largeOrigin]
    const geometry=new Map(draws.map((d,i)=>{
      const b=boxes[i]||boxes[0]
      return [d.geometryKey,{model:{hull:[[0,0],[1,0],[1,1],[0,1]],faces:new Uint16Array([0,1,2,1,3,2]),blocks:[{
        minimum:b.slice(0,3),maximum:b.slice(3),faces:[0,3]}]}}]
    }))
    // One immutable occluder spans both the screen and an offscreen UV half.
    // Image selection can remove that half without changing any depth sample.
    const first=geometry.get(draws[0].geometryKey).model
    first.blocks[0].uv={minimumU:0,maximumU:.5,minimumV:0,maximumV:1}
    first.blocks.push({minimum:[2,-.8,-.2],maximum:[3,.8,-.2],faces:[6,9],
      uv:{minimumU:.5,maximumU:1,minimumV:0,maximumV:1}})
    first.faces=new Uint16Array(12)
    const r={gl,canvas,program,current:{frame,draws,imageryPlan:{quality:{limitedByTextureBudget:true}}},
      cameraVersion:1,plannedCameraVersion:1,geometry,
      options:{onImageryPlanningChange(){++notifications}},measurements:new Map(),
      onDiagnostic(kind,detail){throw new Error(kind+': '+detail.message)},requestRender(){++requests}}
    observer=new TerrainVisibility(r)
    gl.viewport(0,0,128,128);gl.clearColor(0,0,0,1);gl.clearDepth(1)
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE)
    gl.useProgram(program);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4)
    await completed()
    const before=pixels()
    gl.enable(gl.STENCIL_TEST);gl.stencilFunc(gl.ALWAYS,1,255);gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE)
    let earlyIndex, firstRevision
    for(let i=0;i<10 && !observer.done;++i) {
      // The first visible occluder is already present. Adding the last mesh
      // must not cancel the first query batch or discard its hidden result.
      observer.observe({current:r.current},true,(i ? draws : draws.slice(0,-1)).map(draw=>[draw,false]))
      check(gl.isEnabled(gl.STENCIL_TEST) && !gl.isEnabled(gl.CULL_FACE) && gl.getParameter(gl.DEPTH_WRITEMASK) &&
        gl.getParameter(gl.COLOR_WRITEMASK).every(Boolean),'Visibility changed draw state')
      check(live.size<=8,'Visibility query queue exceeded one bounded batch')
      if(observer.snapshot() && earlyIndex===undefined) {
        earlyIndex=observer.index;firstRevision=observer.snapshot().revision
        check(earlyIndex<draws.length,'Visibility waited for the whole scene')
      }
      await completed()
    }
    check(observer.snapshot() && JSON.stringify(observer.snapshot().hidden)==='[2,5]','Conservative visibility misclassified terrain')
    check(observer.done && observer.hiddenIds.has(11) && !observer.hidden(11) && notifications===1,
      'Visibility updates rebased an unacknowledged Worker snapshot')
    r.current.imageryPlan.quality.visibilityRevision=firstRevision
    r.current.imageryPlan.quality.planningComplete=false
    observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
    check(notifications===1,'Incomplete Worker plan admitted another visibility snapshot')
    r.current.imageryPlan.quality.planningComplete=true
    observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
    check(notifications===2 && observer.hidden(11) && observer.snapshot().revision>firstRevision,
      'Worker completion did not release the next accumulated snapshot')
    const after=pixels();check(before.every((v,i)=>v===after[i]),'Visibility changed color pixels')
    observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
    check(notifications===2 && live.size===0,'Settled visibility restarted its sweep')
    const partitioned=draws.flatMap(draw=>[0,1,2,3].map(i=>[{
      ...draw,imageryCellScale:2,imageryCellOffsetX:-(i%2),imageryCellOffsetY:-Math.floor(i/2)
    },true]))
    observer.observe({current:r.current},true,partitioned)
    check(notifications===2 && live.size===0 && observer.snapshot(),
      'Equivalent imagery subdivision invalidated terrain visibility')
    const visiblePartitions=partitioned.filter(([draw]) => draw.resourceId!==1 || draw.imageryCellOffsetX===0)
    const beforeLoss=observer.snapshot()
    observer.observe({current:r.current},true,visiblePartitions)
    check(observer.snapshot()===beforeLoss && !observer.invalidated && notifications===2 && live.size===0,
      'Offscreen UV coverage loss restarted visibility')
    // A changed submitted occluder/UV footprint invalidates demand even if the
    // native mesh set and camera have not changed. Geometry itself stays drawn.
    observer.observe({current:r.current},true,visiblePartitions.slice(1))
    check(observer.invalidated && !observer.snapshot() && !observer.hidden(2) && notifications===3,
      'Changed submitted coverage retained old occlusion')
    await completed()
    ++r.cameraVersion
    check(observer.snapshot()===null && !observer.hidden(2),'Camera change reused old occlusion')
    observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
    check(live.size===0,'Camera preview started visibility work before current planning')
    r.plannedCameraVersion=r.cameraVersion
    observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
    check(live.size>0,'Cancellation fixture did not issue queries')
    r.current={...r.current,draws:draws.map(d=>({...d}))}
    check(observer.snapshot()===null && live.size===0,'Scene change retained query owners')
    await completed()
    canvas.width=127
    check(observer.snapshot()===null,'Viewport change reused old occlusion')
    r.current.imageryPlan.quality.limitedByTextureBudget=false
    observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
    check(live.size===0,'Affordable imagery triggered unnecessary visibility work')
    // A backend failure after partial publication must revoke that evidence,
    // release its pending owners and stop retrying the same failed epoch.
    r.current.imageryPlan.quality.limitedByTextureBudget=true
    canvas.width=128
    gl.disable(gl.CULL_FACE);gl.useProgram(program)
    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4)
    for(let i=0;i<2;++i) {
      observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
      await completed()
    }
    check(observer.snapshot() && live.size>0,'Failure fixture did not hold partial evidence and pending queries')
    const getQuery=gl.getQueryParameter.bind(gl),diagnostic=r.onDiagnostic, failures=[]
    try {
      gl.getQueryParameter=()=>{throw new Error('Injected query receipt failure')}
      r.onDiagnostic=kind=>failures.push(kind)
      observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
      check(observer.invalidated && !observer.snapshot() && live.size===0,
        'Query failure retained published visibility or pending owners')
      check(observer.needsDraw({current:r.current}), 'Revoked evidence lost its one cleanup draw')
      observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
      check(!observer.needsDraw({current:r.current}), 'A failed epoch kept repainting unchanged pixels')
      check(failures.length===1 && live.size===0,'Failed visibility epoch retried continuously')
    } finally {gl.getQueryParameter=getQuery;r.onDiagnostic=diagnostic}
    const previousRevision=observer.revision
    observer.destroy();observer=new TerrainVisibility(r)
    for(let i=0;i<2;++i) {
      observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
      await completed()
    }
    check(observer.snapshot() && observer.snapshot().revision>previousRevision,
      'Observer replacement reused an old Worker receipt revision')
    const satisfactionCases = ['current', 'camera', 'plan', 'coverage', 'transition', 'surface', 'precision']
    for (const kind of satisfactionCases) {
      observer.reset()
      const quality = r.current.imageryPlan.quality = {limitedByTextureBudget:true,
        planningComplete:true, cameraCurrent:true, targetPixelError:1.25}
      r.qualityStats = {resolvedMaxPixelError:2, coverageSubmitted:0}
      r.presentedCameraVersion = r.cameraVersion
      r.lastSubmittedSurface = r.current
      r.presentation = {active:0}
      observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
      await completed()
      const index = observer.index, notified = notifications
      r.qualityStats.resolvedMaxPixelError = 1
      if (kind === 'camera') r.presentedCameraVersion = -1
      if (kind === 'plan') quality.planningComplete = false
      if (kind === 'coverage') r.qualityStats.coverageSubmitted = 1
      if (kind === 'transition') r.presentation.active = 1
      if (kind === 'surface') r.lastSubmittedSurface = {}
      if (kind === 'precision') quality.targetPixelError = .5
      observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
      if (kind === 'current') {
        check(live.size===0 && observer.index===index && !observer.done,
          'Satisfied imagery kept issuing optional visibility queries')
        check(notifications===notified && !observer.needsDraw({current:r.current}) && !observer.needsDepth(),
          'Satisfied imagery kept repainting or retaining optional depth')
        check(observer.hiddenIds.has(2) && !observer.snapshot(),
          'Parking discarded a completed query or published unnecessary feedback')
        r.qualityStats.resolvedMaxPixelError = 2
        check(observer.needsDraw({current:r.current}) && observer.needsDepth(),
          'Renewed precision demand did not wake the remaining sweep')
        observer.observe({current:r.current},true,draws.map(draw=>[draw,false]))
        check(observer.index>index && live.size>0 && observer.snapshot(),
          'Renewed demand failed to continue retained visibility progress')
      } else check(observer.index>index && live.size>0,
        'Unproven display quality parked visibility: '+kind)
      await completed()
    }
    check(gl.getError()===gl.NO_ERROR,'Visibility fixture generated a GL error')
    return {maximumQueries,notifications,pixelsUnchanged:true,conservativeHidden:[2,5,11],
      earlyIndex,workerBackpressure:true,coverageExpansion:true,equivalentSubdivision:true,cancellationBound:true,
      offscreenCoveragePreserved:true,visibleCoverageRevoked:true,
      failureRevoked:true,receiptGeneration:true,invalidated:true,satisfactionCases}
  } finally {
    if(sync)gl.deleteSync(sync)
    if(observer)observer.destroy()
    gl.createQuery=createQuery;gl.deleteQuery=deleteQuery
    shaders.forEach(shader=>gl.deleteShader(shader));gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context').loseContext()
    canvas.remove()
  }
}
