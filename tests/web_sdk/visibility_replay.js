// Standalone offline diagnostic, excluded from the SDK distribution.
// GPU feedback here is evidence, not a production visibility certificate.
void (async()=>{
 const report={schema:'terra.offline-terrain-visibility.v1',passed:false,errors:[]},canvas=document.querySelector('canvas'),out=document.querySelector('pre')
 let gl,program,sync
 const buffers=[],shaders=[],queries=[]
 const wait=()=>new Promise(resolve=>setTimeout(resolve,1))
 try {
  const input=await (await fetch(new URLSearchParams(location.search).get('control') === '1' ? 'control.json' : 'replay.json')).json(),s=input.snapshot
  report.snapshotSha256=input.snapshotSha256;report.wasmSha256=input.wasmSha256;report.view=s.view;report.capacities=input.capacities
  canvas.width=s.budget.physicalWidth;canvas.height=s.budget.physicalHeight
  gl=canvas.getContext('webgl2',{antialias:false,alpha:false,preserveDrawingBuffer:true})
  if(!gl)throw new Error('WebGL2 unavailable')
  report.viewport={width:canvas.width,height:canvas.height};report.renderer=gl.getParameter(gl.RENDERER)
  const shader=(type,source)=>{const x=gl.createShader(type);shaders.push(x);gl.shaderSource(x,source);gl.compileShader(x);if(!gl.getShaderParameter(x,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(x));return x}
  program=gl.createProgram()
  gl.attachShader(program,shader(gl.VERTEX_SHADER,`#version 300 es
  precision highp float;
  layout(location=0) in vec3 position;layout(location=1) in vec2 uv;
  uniform mat4 matrix;uniform vec3 origin;out vec2 localUv;
  void main(){localUv=uv;gl_Position=matrix*vec4(position+origin,1.0);}`))
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`#version 300 es
  precision highp float;
  in vec2 localUv;uniform vec3 cell;uniform vec3 color;uniform bool clipCell;out vec4 pixel;
  void main(){vec2 p=localUv*cell.x+cell.yz;
   if(clipCell&&(p.x<0.0||p.y<0.0||p.x>1.0||p.y>1.0))discard;
   pixel=vec4(color,1.0);}`))
  gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program))
  const names=['matrix','origin','cell','color','clipCell'],u=Object.fromEntries(names.map(n=>[n,gl.getUniformLocation(program,n)]))
  gl.useProgram(program);gl.uniformMatrix4fv(u.matrix,false,input.matrix)
  const decoded=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0))
  const upload=(target,bytes)=>{const b=gl.createBuffer();buffers.push(b);gl.bindBuffer(target,b);gl.bufferData(target,bytes,gl.STATIC_DRAW);return b}
  upload(gl.ELEMENT_ARRAY_BUFFER,decoded(s.indices))
  const meshes=new Map(s.meshes.map(m=>[m.id,{positions:upload(gl.ARRAY_BUFFER,decoded(m.positions)),uv:upload(gl.ARRAY_BUFFER,decoded(m.uv))}]))
  const groups=new Map()
  for(const d of input.draws){if(d.flags&1)throw new Error('Coverage mixed with demand');const key=[d.texture.level,d.texture.column,d.texture.row].join('/');if(!groups.has(key))groups.set(key,{key,tile:d.texture,id:groups.size+1,draws:[]});groups.get(key).draws.push(d)}
  gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,1);gl.clearDepth(1)
  gl.disable(gl.DITHER);gl.disable(gl.BLEND);gl.disable(gl.STENCIL_TEST)
  gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);gl.frontFace(gl.CW);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL)
  gl.enableVertexAttribArray(0);gl.enableVertexAttribArray(1)
  const draw=group=>{
   const id=group.id;gl.uniform3f(u.color,(id&255)/255,((id>>8)&255)/255,((id>>16)&255)/255)
   for(const d of group.draws){const m=meshes.get(d.resourceId)
    gl.bindBuffer(gl.ARRAY_BUFFER,m.positions);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0)
    gl.bindBuffer(gl.ARRAY_BUFFER,m.uv);gl.vertexAttribPointer(1,2,gl.FLOAT,false,0,0)
    gl.uniform3f(u.origin,d.origin[0]-input.camera[0],d.origin[1]-input.camera[1],d.origin[2]-input.camera[2])
    gl.uniform3f(u.cell,d.imageryCellScale||1,d.imageryCellOffsetX||0,d.imageryCellOffsetY||0)
    gl.uniform1i(u.clipCell,d.imageryClipCell?1:0)
    gl.drawElements(gl.TRIANGLE_STRIP,d.indexCount,gl.UNSIGNED_SHORT,d.firstIndex*2)
   }
  }
  gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT)
  for(const g of groups.values())draw(g)
  const fence=async()=>{
   sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();const start=performance.now()
   while(true){const status=gl.clientWaitSync(sync,0,0);if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)break;if(status!==gl.TIMEOUT_EXPIRED||performance.now()-start>30000)throw new Error('Offline fence deadline');await wait()}
   gl.deleteSync(sync);sync=null
  }
  await fence()
  const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
  const counts=new Uint32Array(groups.size+1)
  for(let i=0;i<pixels.length;i+=4){const id=pixels[i]+pixels[i+1]*256+pixels[i+2]*65536;if(id>groups.size)throw new Error('Invalid tile pixel ID');counts[id]++}
  gl.colorMask(false,false,false,false);gl.depthMask(false)
  const queueQueries=kind=>{for(const g of groups.values()){const q=gl.createQuery();queries.push(q);g[kind]=q;gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,q);draw(g);gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE)}}
  queueQueries('depthQuery');gl.disable(gl.DEPTH_TEST);queueQueries('projectedQuery');await fence()
  const start=performance.now();while(queries.some(q=>!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE))){if(performance.now()-start>10000)throw new Error('Query receipt deadline');await wait()}
  report.tiles=Array.from(groups.values(),g=>({key:g.key,tile:g.tile,drawCount:g.draws.length,pixels:counts[g.id],projected:!!gl.getQueryParameter(g.projectedQuery,gl.QUERY_RESULT),depthVisible:!!gl.getQueryParameter(g.depthQuery,gl.QUERY_RESULT)}))
  const rows=report.tiles,byteCost=input.tileGpuBytes
  report.summary={planned:rows.length,projected:rows.filter(t=>t.projected).length,depthVisible:rows.filter(t=>t.depthVisible).length,
   pixelVisible:rows.filter(t=>t.pixels).length,fullyOccluded:rows.filter(t=>t.projected&&!t.depthVisible).length,
   noProjectedSamples:rows.filter(t=>!t.projected).length,visiblePixels:pixels.length/4-counts[0],backgroundPixels:counts[0],
   plannedGpuBytes:rows.length*byteCost,depthVisibleGpuBytes:rows.filter(t=>t.depthVisible).length*byteCost}
  if(!report.summary.visiblePixels||rows.some(t=>(t.pixels&&!t.depthVisible)||(t.depthVisible&&!t.projected)))throw new Error('Visibility consistency failure')
  if (input.expected) {
   for (const [key,value] of Object.entries(input.expected.summary)) {
    if (report.summary[key] !== value) throw new Error('Control mismatch: '+key)
   }
   for (const [key,expected] of Object.entries(input.expected.tiles)) {
    const tile=rows.find(t=>t.key===key)
    if (!tile || tile.projected!==expected[0] || tile.depthVisible!==expected[1]) throw new Error('Control tile mismatch: '+key)
   }
   const front=rows.find(t=>t.key==='0/0/0'),clipped=rows.find(t=>t.key==='1/1/1')
   const ratio=clipped.pixels/front.pixels
   if (ratio<0.2 || ratio>0.3) throw new Error('Cell clipping control failed')
   report.controlPassed=true
  }
  const uvDepth=new URLSearchParams(location.search).get('uvDepth')
  if(uvDepth!==null) {
   if(new URLSearchParams(location.search).get('conservative')==='1' && new URLSearchParams(location.search).get('triangles')==='1')
    throw Error('Choose one conservative experiment; each must compare with the original raster oracle')
   const draws=input.sourceDraws||input.draws
   report.visibleUv=await window.probeVisibleUv({gl,draw,fence,draws,depth:Number(uvDepth)})
   if(input.expected) {
    for(const level of report.visibleUv.levels) {
     if(level.visible.length!==2*Math.pow(4,level.depth)||
       level.visible.some(cell=>cell.id!==1&&cell.id!==5)||
       level.visible.some(cell=>cell.id===5&&(cell.x/cell.scale<.5||cell.y/cell.scale<.5)))
      throw Error('UV probe admitted occluded, offscreen, backfacing or out-of-domain cells')
    }
    report.visibleUv.controlPassed=true
   }
   if(new URLSearchParams(location.search).get('conservative')==='1') {
    if(!input.uvBounds)throw Error('Conservative bounds were not staged')
    const oracle=report.visibleUv
    report.visibleUv=await window.probeVisibleUv({gl,draw,fence,draws,depth:Number(uvDepth),bounds:input.uvBounds})
    for(let i=0;i<oracle.levels.length;++i) {
     const key=c=>[c.id,c.scale,c.x,c.y].join(':')
     const retained=new Set(report.visibleUv.levels[i].visible.map(key))
     if(oracle.levels[i].visible.some(c=>!retained.has(key(c))))throw Error('Conservative bounds lost an oracle-visible cell')
    }
    report.visibleUv.oracleSuperset=true
    report.visibleUv.preparation={steps:input.uvBounds.steps,durationMs:input.uvBounds.durationMs}
    if(input.expected)report.visibleUv.controlPassed=true
   }
   if(new URLSearchParams(location.search).get('triangles')==='1') {
    const oracle=report.visibleUv
    report.visibleUv=await window.probeTriangleVisibility({gl,draw,fence,input,depth:Number(uvDepth)})
    for(let i=0;i<oracle.levels.length;++i) {
     const key=c=>[c.id,c.scale,c.x,c.y].join(':')
     const retained=new Set(report.visibleUv.levels[i].visible.map(key))
     if(oracle.levels[i].visible.some(c=>!retained.has(key(c))))throw Error('Triangle bounds lost an oracle-visible cell')
    }
    report.visibleUv.oracleSuperset=true
    if(input.expected)report.visibleUv.controlPassed=true
   }
  }
  report.glError=gl.getError();if(report.glError!==gl.NO_ERROR)throw new Error('GL error '+report.glError)
  report.scope='Frozen native target geometry; CW/backface, full viewport, perspective UV cells, depth LEQUAL; excludes coarse coverage, actual textures, camera motion and production partition rounding. Conservative raster queries are diagnostic, not a culling certificate.'
  report.passed=true
 }catch(e){report.errors.push(e.stack||e.message)}finally{
  if(gl){if(sync)gl.deleteSync(sync);for(const q of queries)gl.deleteQuery(q);for(const b of buffers)gl.deleteBuffer(b);if(program)gl.deleteProgram(program);for(const s of shaders)gl.deleteShader(s);gl.getExtension('WEBGL_lose_context')?.loseContext()}
  out.textContent=JSON.stringify(report)
  document.documentElement.dataset.terraStatus=report.passed?'passed':'failed'
  document.documentElement.dataset.terraEvidenceStatus=document.documentElement.dataset.terraStatus
 }
})()
