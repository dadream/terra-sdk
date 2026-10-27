window.verifySurfacePublication = async function (sdk) {
  const results=[]
  for (const type of ['webgl2','webgl']) {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64
    // Retain fixture pixels across awaits. The deployed navigation harness
    // separately exercises the normal discardable canvas/compositor path.
    const gl=canvas.getContext(type,{alpha:false,depth:true,stencil:true,preserveDrawingBuffer:true})
    if(!gl)throw Error('Missing '+type+' fixture context')
    const renderer=new sdk.webgl.TerraWebGlRenderer(canvas,{gl,mode:'height',urlForTile:()=>{throw Error('Unexpected fixture network')}})
    renderer.textures.scheduler.pause()
    const draw=gl.drawElements.bind(gl);let draws=0
    gl.drawElements=(...args)=>{++draws;return draw(...args)}
    const idle=async()=>{
      const end=performance.now()+10000
      do {
        renderer.render(false)
        if(!renderer.pendingSubmission&&!renderer.renderRequested&&!renderer.resourcesRequested)return
        await new Promise(resolve=>setTimeout(resolve,10))
      }while(performance.now()<end)
      throw Error('Surface publication fixture did not settle')
    }
    const pixels=()=>{const out=new Uint8Array(64*64*4);gl.readPixels(0,0,64,64,gl.RGBA,gl.UNSIGNED_BYTE,out);return out}
    try {
      const target={resourceId:1, textureResourceId:4294967296 + (1), flags:0,key:{level:0,i:1,j:2,k:3},fragment:0,
        texture:{level:0,matrix:0,row:0,column:0},origin:[0,0,0],firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}
      renderer.setMeshFrame({sequence:1,coverageComplete:true,
        projectionView:new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),cameraPosition:[10,20,30]},
        [target],new Map([[1,{resourceId:1,positions:new Float32Array([-.5,-.5,0,.5,-.5,0,-.5,.5,0,.5,.5,0]),
          textureUv:new Float32Array([0,0,1,0,0,1,1,1])}]]),new Uint16Array([1,0,3,2]),{modelRevision:1})
      await idle()
      const before=pixels(),initial=draws
      const setPlan=()=>renderer.setImageryPlan(1,{draws:renderer.current.draws.slice(),levels:new Map(),
        quality:{planningComplete:true,cameraCurrent:true,targetPixelError:1.25}},[])
      setPlan();await idle()
      const planned=draws
      for(let i=0;i<5;++i){setPlan();await idle()}
      const after=pixels(),center=(32*64+32)*4
      if(before[center]===before[0]&&before[center+1]===before[1])throw Error('Fixture did not paint foreground')
      if(draws!==initial||draws!==planned||!after.every((value,i)=>value===before[i]))
        throw Error('Equivalent plans changed pixels or repeated GPU draws')
      if(renderer.pendingSubmission)throw Error('Equivalent plan retained a GPU fence')
      const selected=renderer.current, camera=renderer.cameraVersion
      renderer.setMeshFrame(Object.assign({},selected.frame,{sequence:2}),selected.draws,
        selected.meshResources,selected.indices,{modelRevision:2},selected.imageryPlan,[])
      await idle()
      if(renderer.cameraVersion!==camera||draws!==planned||renderer.presentedSequence!==2||
          !pixels().every((value,i)=>value===after[i]))
        throw Error('Same-view model metadata repainted pixels or lost its display receipt')
      const retainedBytes=renderer.surfaceCommands.values.byteLength
      renderer.heightRange=[-1000,1000];renderer.requestRender();await idle()
      const changed=pixels()
      if(draws<=planned||changed.every((value,i)=>value===after[i]))throw Error('Changed uniforms reused stale pixels')
      const forced=draws;renderer.render();await idle()
      if(draws<=forced)throw Error('Explicit draw was suppressed')
      const endpoints=await verifyBlendEndpoints(renderer,gl,idle,pixels,()=>draws)
      results.push({type,initialDraws:initial,equivalentPlanDraws:planned-initial,
        retainedBytes,pixelsPreserved:true,modelReceiptWithoutDraw:true,materialChanged:true,forcedDraw:true,endpoints})
    }finally{
      gl.drawElements=draw;renderer.destroy()
      if(renderer.resourceLedger.bytes)throw Error('Surface publication fixture retained memory')
      const loss=gl.getExtension('WEBGL_lose_context');if(loss)loss.loseContext()
      canvas.remove()
    }
  }
  return results
}

// Control only material selection at the renderer boundary. Real terrain
// geometry, shaders, command comparison, submissions and pixel readback remain
// active. A forced draw is the oracle for every skipped endpoint, including
// different sampler transforms; neither downloads nor clock speed affect it.
async function verifyBlendEndpoints(r,gl,idle,pixels,drawCount) {
  const check=(value,message)=>{if(!value)throw Error(message)}
  const store=r.textures, saved={get:store.get,binding:store.binding,gpuReady:store.gpuReady,
    resolve:r.presentation.resolve,worldRead:r.worldDisplay.read}
  const images=[]
  const image=rgba=>{
    const texture=gl.createTexture();images.push(texture)
    gl.bindTexture(gl.TEXTURE_2D,texture)
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,2,2,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(rgba))
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
    return texture
  }
  const a={level:0,matrix:0,row:0,column:0},b={level:1,matrix:1,row:0,column:0}
  const binding=(texture,tile)=>({texture,resolvedTile:tile,resolvedLevel:tile.level,
    kind:'exact',scale:1,offsetX:0,offsetY:0})
  let oldColor,newColor,alpha=1,initial=true
  const draw={...r.current.draws[0],texture:b,sourceTexture:b,imageryTarget:b}
  const repaint=async()=>{r.requestRender();await idle();return pixels()}
  const identical=(a,b)=>a.every((v,i)=>v===b[i])
  const forceMatches=async expected=>{r.render();await idle();check(identical(pixels(),expected),
    'Skipped endpoint differs from its real shader draw')}
  try {
    oldColor=binding(image([240,20,20,255,20,240,20,255,20,20,240,255,240,240,20,255]),a)
    newColor=binding(image([20,240,240,255,240,20,240,255,200,100,20,255,20,100,200,255]),b)
    const alternate=image([10,40,60,255,180,90,50,255,90,50,180,255,200,200,200,255])
    store.get=()=>initial?oldColor:newColor
    store.binding=(_,tile)=>tile===a?oldColor:newColor
    store.gpuReady=()=>true
    r.presentation.resolve=()=>({a,b:initial?a:b,alpha})
    r.worldDisplay.read=()=>[draw]
    r.setMode('texture');await idle()
    const before=pixels();let count=drawCount()
    initial=false;alpha=0
    check(identical(await repaint(),before)&&drawCount()===count,
      'Zero-weight destination repainted unchanged terrain')
    await forceMatches(before)
    count=drawCount();newColor={...newColor,texture:alternate,scale:.5,offsetX:.25,offsetY:.5}
    check(identical(await repaint(),before)&&drawCount()===count,
      'Inactive destination sampler caused a GPU draw')
    await forceMatches(before)
    count=drawCount();alpha=.5
    const middle=await repaint()
    check(drawCount()>count&&!identical(middle,before),'Intermediate blend lost its visible update')
    count=drawCount();alpha=1
    const after=await repaint()
    check(drawCount()>count&&!identical(after,middle),'Completed blend failed to display its destination')
    count=drawCount();oldColor={...oldColor,texture:newColor.texture,scale:.25,offsetX:.75,offsetY:.5}
    check(identical(await repaint(),after)&&drawCount()===count,
      'Inactive old sampler repainted completed color')
    await forceMatches(after)
    alpha=0;r.setDebugOptions({textureState:true});await idle()
    const diagnostic=pixels();count=drawCount();newColor={...newColor,kind:'fallback'}
    check(!identical(await repaint(),diagnostic)&&drawCount()>count,
      'Endpoint comparison suppressed changed debug colors')
    check(gl.getError()===gl.NO_ERROR,'Blend endpoint fixture generated a GL error')
    return {zeroWeightSkipped:true,completedOldSamplerSkipped:true,
      forcedPixelsEqual:true,intermediateChanged:true,debugChanged:true}
  } finally {
    Object.assign(store,{get:saved.get,binding:saved.binding,gpuReady:saved.gpuReady})
    r.presentation.resolve=saved.resolve;r.worldDisplay.read=saved.worldRead
    images.forEach(texture=>gl.deleteTexture(texture))
  }
}
