// Raster oracle for actual CBDAM geometry. The shader matches the terrain
// renderer's camera-relative float transform, CW front face and back culling.
// Removing every face rejected by measurement must leave identical pixels.
window.verifySurfaceFacing = async function (sdk, module, manifest) {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128
  const gl=canvas.getContext('webgl',{antialias:false,alpha:false})
  const abi=new sdk.runtime.TerraAbi(module),buffers=[],shaders=[]
  const program=gl.createProgram(),surface=sdk.testSurface,facing=sdk.testFacing
  let removed=0,covered=0,comparisons=0
  try {
    for(const [type,source] of [
      [gl.VERTEX_SHADER,'attribute vec3 p; uniform vec3 origin; uniform mat4 matrix; void main(){gl_Position=matrix*vec4(p+origin,1.0);}'],
      [gl.FRAGMENT_SHADER,'precision mediump float; void main(){gl_FragColor=vec4(1.0);}']]) {
      const shader=gl.createShader(type);shaders.push(shader)
      gl.shaderSource(shader,source);gl.compileShader(shader)
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader))
      gl.attachShader(program,shader)
    }
    gl.linkProgram(program)
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program))
    gl.useProgram(program)
    const attribute=gl.getAttribLocation(program,'p'),origin=gl.getUniformLocation(program,'origin')
    const matrix=gl.getUniformLocation(program,'matrix')
    for(let i=0;i<2;++i)buffers.push(gl.createBuffer())
    gl.enableVertexAttribArray(attribute);gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);gl.frontFace(gl.CW)
    gl.clearColor(0,0,0,1)
    abi.loadManifest(manifest);abi.setViewport(128,128,.6)
    const response=await fetch('fixtures/globe_root_0_record.bin')
    if(!response.ok)throw Error('Missing local terrain fixture')
    const root=new Uint8Array(await response.arrayBuffer())
    const budget={maximumChangeCount:8,maximumPriorityUpdateCount:64,maximumElapsedMs:0}
    abi.updateStep(1,budget)
    for(const request of abi.getRequests())if(request.kind===sdk.runtime.REQUEST_ROOT)
      abi.submitRecord(request.kind,request.key,root)
    abi.updateStep(1,budget)
    const indices=abi.getIndices()
    const models=abi.getMeshResources().map(draw=>{
      const mesh=abi.copyMeshResource(draw)
      return {draw,model:surface.prepareSurface(mesh.positions,mesh.textureUv,indices,draw.firstIndex,draw.indexCount)}
    })
    const transform=(m,p)=>[0,1,2,3].map(r=>m[r*4]*p[0]+m[r*4+1]*p[1]+m[r*4+2]*p[2]+m[r*4+3])
    for(const [lon,lat,distance,tilt,yaw] of [[0,0,2e7,0,0],[116,40,2e7,-1.2,.4],
      [116,40,2e5,-1.5,1],[116,40,2000,-1.535,2],[-170,-55,2e7,-.5,-1]]) {
      abi.setGlobeTarget(lon,lat)
      abi.setCamera({distance,tiltRadians:tilt,yawRadians:yaw})
      const frame=abi.getCameraSnapshot(),context=surface.projectionContext(frame,{width:128,height:128},
        sdk.testMatrix.invertMatrix4(frame.projectionView))
      gl.uniformMatrix4fv(matrix,false,sdk.common.rowMajorToWebGlMatrix(
        sdk.common.relativeProjectionView(frame.projectionView,frame.cameraPosition)))
      const selections=models.map(({draw,model})=>{
        const keep=[]
        for(const block of model.blocks) {
          const verdict=facing.blockFacing(block,draw.origin,context)
          for(const f of block.faces) {
            const ids=Array.from(model.faces.slice(f,f+3))
            const clip=ids.map(id=>transform(frame.projectionView,
              [0,1,2].map(k=>model.positions[id*3+k]+draw.origin[k])))
            if(verdict>0 || verdict===0 && facing.backFacing(clip))++removed
            else keep.push(...ids)
          }
        }
        const work=surface.surfaceMeasurements(model,draw.origin,context,false,true)
        let result;do{result=work.next()}while(!result.done)
        return result.value.visible ? new Uint16Array(keep) : new Uint16Array(0)
      })
      const render=filtered=>{
        gl.clear(gl.COLOR_BUFFER_BIT)
        models.forEach(({draw,model},i)=>{
          gl.uniform3fv(origin,new Float32Array(draw.origin.map((v,k)=>v-frame.cameraPosition[k])))
          gl.bindBuffer(gl.ARRAY_BUFFER,buffers[0]);gl.bufferData(gl.ARRAY_BUFFER,model.positions,gl.STREAM_DRAW)
          gl.vertexAttribPointer(attribute,3,gl.FLOAT,false,0,0)
          const faces=filtered?selections[i]:model.faces
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,buffers[1]);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,faces,gl.STREAM_DRAW)
          gl.drawElements(gl.TRIANGLES,faces.length,gl.UNSIGNED_SHORT,0)
        })
        const pixels=new Uint8Array(128*128*4)
        gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
        if(gl.getError()!==gl.NO_ERROR)throw Error('Facing raster GL error')
        return pixels
      }
      const before=render(false),after=render(true)
      if(before.some((v,i)=>v!==after[i]))throw Error('Measurement discarded visible GPU terrain')
      for(let i=0;i<before.length;i+=4)if(before[i])++covered
      ++comparisons
    }
    if(!covered || !removed || !models.length)throw Error('Facing raster fixture did not exercise coverage/culling: '+
      JSON.stringify({covered,removed,meshes:models.length}))
    return {comparisons,coveredPixels:covered,rejectedFaces:removed,meshes:models.length}
  } finally {
    abi.destroy();buffers.forEach(b=>gl.deleteBuffer(b));shaders.forEach(s=>gl.deleteShader(s));gl.deleteProgram(program)
    const lose=gl.getExtension('WEBGL_lose_context');if(lose)lose.loseContext()
    canvas.remove()
  }
}
