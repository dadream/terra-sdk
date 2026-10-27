// Real SDK shaders, ordinary homogeneous clipping, large perspective triangles,
// overlays and the occlusion-query encoding. No network or terrain scheduler.
window.verifyDepthEncoding = async function(sdk) {
  const results = [], check = (value, message) => { if (!value) throw Error(message) }
  for (const type of ['webgl2','webgl']) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128
    const gl = canvas.getContext(type,{alpha:false,depth:true,stencil:true,preserveDrawingBuffer:true})
    check(gl, 'Missing depth fixture context')
    const r = new sdk.webgl.TerraWebGlRenderer(canvas,{gl,mode:'height',urlForTile:()=>{throw Error('Unexpected network')}})
    r.textures.scheduler.pause()
    const buffers = [], images = [], queries = []
    let observer
    const near=.1, far=2e6
    const frame = {cameraPosition:[0,0,0], projectionView:new Float64Array([
      1,0,0,0,0,1,0,0,0,0,-(far+near)/(far-near),-2*far*near/(far-near),0,0,-1,0])}
    const matrix = sdk.common.rowMajorToWebGlMatrix(frame.projectionView)
    const buffer = (target, data) => { const value=gl.createBuffer();buffers.push(value)
      gl.bindBuffer(target,value);gl.bufferData(target,data,gl.STATIC_DRAW);return value }
    const image = color => {const value=gl.createTexture();images.push(value);gl.bindTexture(gl.TEXTURE_2D,value)
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(color))
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);return value}
    const pixel = (x=64) => {const p=new Uint8Array(4);gl.readPixels(x,64,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p)}
    const red = p => p[0]>200 && p[2]<20, blue = p => p[2]>200 && p[0]<20
    const bind = logarithmic => {
      const selected=r.surfacePrograms[logarithmic?1:0], u=selected.uniforms
      gl.useProgram(selected.program)
      gl.uniformMatrix4fv(u.projectionView,false,matrix);gl.uniform3f(u.origin,0,0,0)
      gl.uniform1f(u.heightOrigin,0);gl.uniform1f(u.renderMode,0);gl.uniform1f(u.textureMix,1)
      gl.uniform1f(u.debugMode,0);gl.uniform1f(u.textureState,0);gl.uniform1f(u.fogDensity,0)
      gl.uniform3f(u.fogColor,0,0,0);gl.uniform2f(u.heightRange,0,1)
      for(const name of ['cellUvScale','uvScale','oldUvScale'])gl.uniform2f(u[name],1,1)
      for(const name of ['cellUvOffset','uvOffset','oldUvOffset'])gl.uniform2f(u[name],0,0)
      gl.uniform1i(u.texture,0);gl.uniform1i(u.oldTexture,0)
      if(r.sourceUvPartitions)gl.uniform1i(u.clipCell,0)
      if(logarithmic)gl.uniform1f(u.logDepth,r.depthState.factor)
      return selected.attributes
    }
    try {
      sdk.testDepth.selectDepthPrograms(r,frame)
      check(r.depthState.mode==='logarithmic','Fragment-depth support missing on '+type)
      const positions=buffer(gl.ARRAY_BUFFER,new Float32Array(12))
      const uv=buffer(gl.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,1,1]))
      buffer(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([1,0,3,2]))
      const foreground=image([255,0,0,255]), background=image([0,0,255,255])
      const draw = (left,right,texture,log=true) => {
        const a=bind(log)
        gl.bindBuffer(gl.ARRAY_BUFFER,positions)
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-.95*left,-.95*left,-left,
          .95*right,-.95*right,-right,-.95*left,.95*left,-left,.95*right,.95*right,-right]),gl.STATIC_DRAW)
        gl.enableVertexAttribArray(a.position);gl.vertexAttribPointer(a.position,3,gl.FLOAT,false,0,0)
        gl.bindBuffer(gl.ARRAY_BUFFER,uv);gl.enableVertexAttribArray(a.uv);gl.vertexAttribPointer(a.uv,2,gl.FLOAT,false,0,0)
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture)
        gl.drawElements(gl.TRIANGLE_STRIP,4,gl.UNSIGNED_SHORT,0)
      }
      gl.viewport(0,0,128,128);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL)
      gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.clearColor(0,0,0,1)
      const clear=()=>gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT)
      const rows=[];let ordinaryFailures=0
      for(const distance of [1000,10000,100000]) {
        const back=distance*1.00001
        clear();draw(distance,distance,foreground);draw(back,back,background)
        const forward=pixel();check(red(forward),'Log depth lost front terrain at '+distance)
        clear();draw(back,back,background);draw(distance,distance,foreground)
        check(red(pixel()),'Log depth depended on draw order')
        clear();draw(distance,distance,foreground,false);draw(back,back,background,false)
        const ordinary=pixel();if(!red(ordinary))++ordinaryFailures
        rows.push({distance,gap:back-distance,log:forward,ordinary})
      }
      check(ordinaryFailures>0,'Depth fixture failed to expose ordinary-buffer precision loss')
      clear();draw(.05,.05,foreground)
      check(pixel().slice(0,3).every(v=>v===0),'Log encoding bypassed near clipping')
      draw(.2,.2,foreground);check(red(pixel()),'Visible near terrain was clipped')
      clear();draw(.05,10,foreground)
      check(pixel(32).slice(0,3).every(v=>v===0)&&red(pixel(96)),
        'A near-plane crossing primitive did not retain its visible part')
      clear();draw(100,1000000,foreground);draw(300,300,background)
      check(red(pixel(32))&&blue(pixel(96)),'Large triangle depth was interpolated in log space')
      clear();draw(1000,1000,foreground)
      const overlay = distance => {
        const a=r.overlayAttributes,u=r.overlayUniforms
        gl.useProgram(r.overlayProgram);gl.uniformMatrix4fv(u.projectionView,false,matrix)
        gl.uniform3f(u.origin,0,0,0);gl.uniform1f(u.pointSize,12);gl.uniform4f(u.color,0,1,1,1)
        gl.uniform1f(u.logDepth,r.depthState.factor)
        gl.bindBuffer(gl.ARRAY_BUFFER,positions);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,-distance]),gl.STATIC_DRAW)
        gl.enableVertexAttribArray(a.position);gl.vertexAttribPointer(a.position,3,gl.FLOAT,false,0,0)
        gl.drawArrays(gl.POINTS,0,1)
      }
      overlay(1100);check(red(pixel()),'Overlay used a different depth encoding behind terrain')
      overlay(900);check(pixel()[1]>200 && pixel()[2]>200,'Visible overlay disappeared')
      if(type==='webgl2') {
        clear();draw(1000,1000,foreground)
        observer=new sdk.testVisibility.TerrainVisibility(r)
        for(const distance of [500,1500]) {
          const model={faces:[0,1,2],blocks:[{minimum:[-10,-10,-distance],maximum:[10,10,-distance],faces:[0]}]}
          const bounds=sdk.testBounds.visibilityBounds(model,{origin:[0,0,0]},frame,{width:128,height:128},r.depthState)[0]
          gl.useProgram(observer.program);gl.uniform4f(observer.rectangle,...bounds.slice(0,4));gl.uniform1f(observer.depth,bounds[4])
          gl.colorMask(false,false,false,false);gl.depthMask(false)
          const q=gl.createQuery();queries.push(q);gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,q)
          gl.drawArrays(gl.TRIANGLE_STRIP,0,4);gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);gl.flush()
          const deadline=performance.now()+3000
          while(!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)&&performance.now()<deadline)
            await new Promise(resolve=>setTimeout(resolve,10))
          check(gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE),'Depth query timed out')
          check(Boolean(gl.getQueryParameter(q,gl.QUERY_RESULT))===(distance<1000),'Visibility query disagreed with log terrain')
          gl.depthMask(true);gl.colorMask(true,true,true,true)
        }
      }
      check(gl.getError()===gl.NO_ERROR,'Depth fixture WebGL error')
      results.push({type,rows,ordinaryFailures,nearClip:true,largeTriangle:true,overlays:true,queries:type==='webgl2'})
    } finally {
      if(observer)observer.destroy()
      queries.forEach(q=>gl.deleteQuery(q));buffers.forEach(b=>gl.deleteBuffer(b));images.forEach(t=>gl.deleteTexture(t))
      r.destroy();check(r.resourceLedger.bytes===0,'Depth fixture retained SDK resources')
      const loss=gl.getExtension('WEBGL_lose_context');if(loss)loss.loseContext();canvas.remove()
    }
  }
  return results
}
