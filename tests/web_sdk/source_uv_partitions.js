// Compare production shaders and selected source indices with unpartitioned
// source strips. No service access; every GL object belongs to this fixture.
window.verifySourceUvPartitions = async function (sdk) {
  const results=[]
  for (const type of ['webgl2','webgl']) for (const precision of [23,0]) {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=128
    const gl=canvas.getContext(type,{alpha:false,antialias:true,depth:true,preserveDrawingBuffer:true})
    if(!gl)throw Error('Missing '+type)
    const getPrecision=gl.getShaderPrecisionFormat.bind(gl)
    if(precision===0) gl.getShaderPrecisionFormat=()=>({precision:0})
    let renderer
    const buffers=[],textures=[]
    try {
      renderer=new sdk.webgl.TerraWebGlRenderer(canvas,{gl,mode:'height',urlForTile:()=>{throw Error('Unexpected network')}})
      renderer.textures.scheduler.pause()
      const canonical=type==='webgl2' && precision===23
      if(renderer.sourceUvPartitions!==canonical)throw Error('Fragment precision capability mismatch')
      const u=renderer.uniforms,a=renderer.attributes
      const positions=new Float32Array([-1,-1,-.2,1,-1,.3,-1,1,.4,1,1,-.1])
      const uv=new Float32Array([0,0,1,0,0,1,1,1]),indices=new Uint16Array([1,0,3,2])
      const model=sdk.testSurface.prepareSurface(positions,uv,indices,0,4)
      const cells=Array.from({length:64},(_,i)=>({key:String(i),sourceUv:canonical,bounds:{
        minimumU:(i%8)/8,maximumU:(i%8+1)/8,minimumV:(i>>3)/8,maximumV:((i>>3)+1)/8}}))
      const parts=await sdk.testSurface.createPartitionTask(model,cells).run()
      const buffer=(target,data)=>{const b=gl.createBuffer();buffers.push(b);gl.bindBuffer(target,b);gl.bufferData(target,data,gl.STATIC_DRAW);return b}
      const positionBuffer=buffer(gl.ARRAY_BUFFER,positions),uvBuffer=buffer(gl.ARRAY_BUFFER,uv)
      const indexBuffer=buffer(gl.ELEMENT_ARRAY_BUFFER,indices)
      const ready=parts.map(p=>({...p,indexBuffer:buffer(gl.ELEMENT_ARRAY_BUFFER,p.indices),
        positionBuffer:p.positions.length?buffer(gl.ARRAY_BUFFER,p.positions):null,
        uvBuffer:p.uv.length?buffer(gl.ARRAY_BUFFER,p.uv):null}))
      const texture=(data,width=1)=>{
        const t=gl.createTexture();textures.push(t);gl.bindTexture(gl.TEXTURE_2D,t)
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,width,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(data));return t
      }
      const pattern=[]
      for(let y=0;y<32;++y)for(let x=0;x<32;++x)pattern.push(40+x*5,40+y*5,100,255)
      const gradient=texture(pattern,32),colors=cells.map((c,i)=>texture([40+i*3,100,200,255]))
      const bind=(p=positionBuffer,v=uvBuffer)=>{
        gl.bindBuffer(gl.ARRAY_BUFFER,p);gl.vertexAttribPointer(a.position,3,gl.FLOAT,false,0,0)
        gl.bindBuffer(gl.ARRAY_BUFFER,v);gl.vertexAttribPointer(a.uv,2,gl.FLOAT,false,0,0)
      }
      gl.useProgram(renderer.program);gl.enableVertexAttribArray(a.position);gl.enableVertexAttribArray(a.uv)
      gl.uniform3f(u.origin,0,0,0);gl.uniform1f(u.heightOrigin,0)
      gl.uniform1f(u.renderMode,0);gl.uniform1f(u.textureMix,1);gl.uniform1f(u.debugMode,0)
      gl.uniform1f(u.textureState,0);gl.uniform1f(u.fogDensity,0);gl.uniform3f(u.fogColor,0,0,0)
      gl.uniform2f(u.heightRange,-1,1);gl.uniform1i(u.texture,0);gl.uniform1i(u.oldTexture,0)
      gl.uniform2f(u.oldUvScale,1,1);gl.uniform2f(u.oldUvOffset,0,0)
      gl.viewport(0,0,128,128);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL)
      gl.enable(gl.CULL_FACE);gl.frontFace(gl.CW);gl.cullFace(gl.BACK)
      gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.clearColor(0,0,0,1)
      const read=()=>{const p=new Uint8Array(128*128*4);gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,p);return p}
      const draw=(selected,reference=false,colored=false,clear=true)=>{
        if(clear)gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT)
        for(const p of selected) {
          const i=Number(p.cell.key),x=i%8,y=i>>3
          bind();gl.uniform2f(u.cellUvScale,8,8);gl.uniform2f(u.cellUvOffset,-x,-y)
          gl.uniform2f(u.uvScale,colored?1:1/8,colored?1:1/8)
          gl.uniform2f(u.uvOffset,colored?0:x/8,colored?0:y/8)
          gl.bindTexture(gl.TEXTURE_2D,colored?colors[i]:gradient)
          if(canonical)gl.uniform1i(u.clipCell,p.cell.sourceUv?1:0)
          if(reference){gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);gl.drawElements(gl.TRIANGLE_STRIP,4,gl.UNSIGNED_SHORT,0)}
          else {
            if(p.indices.length){gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,p.indexBuffer);gl.drawElements(gl.TRIANGLES,p.indices.length,gl.UNSIGNED_SHORT,0)}
            if(p.positions.length){bind(p.positionBuffer,p.uvBuffer);gl.drawArrays(gl.TRIANGLES,0,p.positions.length/3)}
          }
        }
        return read()
      }
      let checks=0,maximumBytes=0
      for(const matrix of [
        [0.8,0,0,0,0,0.8,0,0,0,0,0.5,0,1/128,1/128,0,1],
        [0.8,0.2,0,0.2,-0.2,0.6,0,0.5,0,0,0.5,0,0,0,0,1.1],
        [0.6,0,0,0,0,0.6,0,0.7,0,0,2,0,0,0,-0.5,1]
      ]) {
        gl.uniformMatrix4fv(u.projectionView,false,new Float32Array(matrix))
        if(canonical) {
          gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);bind()
          gl.uniform1i(u.clipCell,0);gl.uniform2f(u.cellUvScale,1,1);gl.uniform2f(u.cellUvOffset,0,0)
          gl.uniform2f(u.uvScale,1,1);gl.uniform2f(u.uvOffset,0,0);gl.bindTexture(gl.TEXTURE_2D,gradient)
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer);gl.drawElements(gl.TRIANGLE_STRIP,4,gl.UNSIGNED_SHORT,0)
          const whole=read(),textured=draw(ready,false,false)
          if(textured.some((v,i)=>i%4===0&&Boolean(v)!==Boolean(whole[i])))throw Error('Partition union changed source silhouette coverage')
          const expected=draw(ready,true,true),actual=draw(ready,false,true)
          if(!expected.some((v,i)=>i%4===0&&v))throw Error('Empty source UV fixture')
          if(!actual.every((v,i)=>v===expected[i]))throw Error(type+' source indices changed clipped strip pixels')
          if(!draw(ready.slice().reverse(),false,true).every((v,i)=>v===actual[i]))throw Error('Cell boundary ownership depends on draw order')
          const even=ready.filter((_,i)=>i%2===0),partial=draw(even,true,true)
          if(!draw(even,false,true).every((v,i)=>v===partial[i]))throw Error('Sparse source UV coverage differs')
          draw(ready,true,false)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.depthFunc(gl.EQUAL)
          const equal=draw(ready,false,true,false)
          gl.depthFunc(gl.LEQUAL)
          if(!equal.every((v,i)=>v===expected[i]))throw Error('Source UV changed depth or sampled UV')
          checks+=6
        } else {
          const actual=draw(ready,false,false)
          if(!actual.some((v,i)=>i%4===0&&v))throw Error('Low precision clipped rendering is empty')
          ++checks
        }
        maximumBytes=Math.max(maximumBytes,parts.reduce((n,p)=>n+p.indices.byteLength+p.positions.byteLength+p.uv.byteLength,0))
      }
      if(canonical) {
        // A multisampled sliver can cover samples while missing the pixel
        // centre. Default interpolation extrapolates UV across an unrelated
        // cell; centroid interpolation keeps its source-face selection valid.
        const narrowUv=new Float32Array([.49,0,.496,0,.49,1,.496,1])
        gl.bindBuffer(gl.ARRAY_BUFFER,uvBuffer);gl.bufferData(gl.ARRAY_BUFFER,narrowUv,gl.STATIC_DRAW)
        gl.uniformMatrix4fv(u.projectionView,false,new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]))
        for(let phase=0;phase<8;++phase) {
          const left=(32+phase/16)/64-1,right=left+.25/64
          const narrowPositions=new Float32Array([left,-.75,0,right,-.75,0,left,.75,0,right,.75,0])
          gl.bindBuffer(gl.ARRAY_BUFFER,positionBuffer);gl.bufferData(gl.ARRAY_BUFFER,narrowPositions,gl.STATIC_DRAW)
          const thin=sdk.testSurface.prepareSurface(narrowPositions,narrowUv,indices,0,4)
          const selected=(await sdk.testSurface.createPartitionTask(thin,cells).run()).map(p=>({...p,
            indexBuffer:buffer(gl.ELEMENT_ARRAY_BUFFER,p.indices)}))
          const expected=draw(ready,true,true),actual=draw(selected,false,true)
          if(!actual.every((v,i)=>v===expected[i]))throw Error('MSAA sliver escaped source cell selection at phase '+phase)
          ++checks
        }
        // A very deep cell needs interpolation in its normalized UV domain;
        // interpolating source UV first would quantize a 32-texel gradient.
        const scale=2**20,low=.5,high=low+1/scale
        const deep=renderer.partitionCell({texture:{level:20,matrix:0,row:0,column:0},
          imageryCellScale:scale,imageryCellOffsetX:-scale/2,imageryCellOffsetY:-scale/2})
        if(deep.sourceUv)throw Error('Deep cell exceeded source UV precision')
        gl.bindBuffer(gl.ARRAY_BUFFER,positionBuffer)
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),gl.STATIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER,uvBuffer)
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([low,low,high,low,low,high,high,high]),gl.STATIC_DRAW)
        bind();gl.uniform1i(u.clipCell,deep.sourceUv?1:0)
        gl.uniform2f(u.cellUvScale,scale,scale);gl.uniform2f(u.cellUvOffset,-scale/2,-scale/2)
        gl.uniform2f(u.uvScale,1,1);gl.uniform2f(u.uvOffset,0,0)
        gl.bindTexture(gl.TEXTURE_2D,gradient);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indexBuffer)
        gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.drawElements(gl.TRIANGLE_STRIP,4,gl.UNSIGNED_SHORT,0)
        const deepPixels=read()
        for(let y=1;y<127;++y)for(let x=1;x<127;++x) {
          const i=(y*128+x)*4
          if(deepPixels[i]!==40+Math.floor(x/4)*5||deepPixels[i+1]!==40+Math.floor(y/4)*5)
            throw Error('Deep normalized cell UV lost texel precision')
        }
        ++checks
      }
      if(gl.getError()!==gl.NO_ERROR)throw Error('Source UV fixture GL error')
      results.push({type,canonical,checks,partitionBytes:maximumBytes,samples:gl.getParameter(gl.SAMPLES)})
    } finally {
      for(const b of buffers)gl.deleteBuffer(b)
      for(const t of textures)gl.deleteTexture(t)
      if(renderer)renderer.destroy()
      gl.getShaderPrecisionFormat=getPrecision
      gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.remove()
      if(renderer&&renderer.resourceLedger.bytes)throw Error('Source UV fixture retained resources')
    }
  }
  return results
}
