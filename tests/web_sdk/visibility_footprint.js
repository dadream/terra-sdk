window.verifyVisibilityFootprint = async function (sdk) {
  const canvas=document.createElement('canvas'),buffers=[],shaders=[]
  canvas.width=canvas.height=128
  const gl=canvas.getContext('webgl2',{antialias:true,preserveDrawingBuffer:true})
  if(!gl)throw Error('Footprint fixture requires WebGL2')
  const check=(value,message)=>{if(!value)throw Error(message)}
  let program
  try {
    program=gl.createProgram()
    for(const [type,source]of [[gl.VERTEX_SHADER,`#version 300 es
      precision highp float;layout(location=0)in vec3 position;layout(location=1)in vec2 uv;
      uniform mat4 matrix;uniform vec3 origin;centroid out vec2 sourceUv;
      void main(){sourceUv=uv;gl_Position=matrix*vec4(position+origin,1.0);}`],
      [gl.FRAGMENT_SHADER,`#version 300 es
      precision highp float;centroid in vec2 sourceUv;uniform vec3 cell;out vec4 pixel;
      void main(){vec2 lo=-cell.yz/cell.x,hi=(1.0-cell.yz)/cell.x;
        if((lo.x>0.0&&sourceUv.x<lo.x)||(lo.y>0.0&&sourceUv.y<lo.y)||
          (hi.x<1.0&&sourceUv.x>=hi.x)||(hi.y<1.0&&sourceUv.y>=hi.y))discard;
        pixel=vec4(1.0);}`]]) {
      const shader=gl.createShader(type);shaders.push(shader)
      gl.shaderSource(shader,source);gl.compileShader(shader)
      check(gl.getShaderParameter(shader,gl.COMPILE_STATUS),gl.getShaderInfoLog(shader))
      gl.attachShader(program,shader)
    }
    gl.linkProgram(program);check(gl.getProgramParameter(program,gl.LINK_STATUS),gl.getProgramInfoLog(program))
    gl.useProgram(program);gl.disable(gl.CULL_FACE);gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND)
    gl.viewport(0,0,128,128);gl.clearColor(0,0,0,1)
    const u=Object.fromEntries(['matrix','origin','cell'].map(n=>[n,gl.getUniformLocation(program,n)]))
    for(const location of [0,1]) {
      const b=gl.createBuffer();buffers.push(b);gl.bindBuffer(gl.ARRAY_BUFFER,b)
      gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,location?2:3,gl.FLOAT,false,0,0)
    }
    const uv=new Float32Array([0,0,1,0,0,1]),faces=new Uint16Array([0,1,2])
    gl.bindBuffer(gl.ARRAY_BUFFER,buffers[1]);gl.bufferData(gl.ARRAY_BUFFER,uv,gl.STATIC_DRAW)
    const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],pixels=new Uint8Array(128*128*4)
    const triangles=[[-.8,-.8,0,.8,-.8,0,0,.8,0],[.8,2,0,2,.8,0,2,2,0],
      [-.8,-.8,-2,.8,-.8,0,0,.8,0],[-.8,-.8,-2,.8,-.8,-2,0,.8,-2],
      [0,-.5,0,3,-.5,0,0,.5,0],[1.001,-.1,0,1.005,-.1,0,1.001,.1,0]]
    let proved=0,visible=0,total=0
    for(const world of [0,6378000,-6378000])for(const values of triangles)for(const cell of
      [{x:0,y:0,scale:1},{x:0,y:0,scale:2},{x:1,y:0,scale:2},{x:0,y:1,scale:8}]) {
      const positions=new Float32Array(values),camera=[world,world,world]
      const frame={cameraPosition:camera,projectionView:identity.map((v,i)=>[3,7,11].includes(i)?-world:v)}
      const draw={origin:camera},matrix=sdk.common.rowMajorToWebGlMatrix(sdk.common.relativeProjectionView(frame.projectionView,camera))
      gl.uniformMatrix4fv(u.matrix,false,matrix);gl.uniform3f(u.origin,0,0,0);gl.uniform3f(u.cell,cell.scale,-cell.x,-cell.y)
      gl.bindBuffer(gl.ARRAY_BUFFER,buffers[0]);gl.bufferData(gl.ARRAY_BUFFER,positions,gl.STATIC_DRAW)
      gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3)
      gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
      const hasPixel=pixels.some((value,i)=>i%4===0&&value>0)
      const work=sdk.testFootprint.offscreenCell({positions,uv,faces},draw,frame,{width:128,height:128},cell)
      let result;do{result=work.next()}while(!result.done)
      check(!result.value||!hasPixel,'Offscreen certificate removed a rounded GPU sample')
      if(result.value)++proved
      if(hasPixel)++visible
      ++total
    }
    check(proved>0&&visible>0,'Footprint fixture lacked positive and negative controls')
    check(gl.getError()===gl.NO_ERROR,'Footprint fixture generated a GL error')
    return {total,proved,visible,samples:gl.getParameter(gl.SAMPLES)}
  } finally {
    buffers.forEach(b=>gl.deleteBuffer(b));shaders.forEach(s=>gl.deleteShader(s))
    if(program)gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context').loseContext()
    canvas.remove();canvas.width=canvas.height=0
  }
}
