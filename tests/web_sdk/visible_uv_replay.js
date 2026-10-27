// Offline oracle only: sample visibility at fixed dyadic UV cells against the
// original terrain depth. It must never be consumed as runtime culling proof.
window.probeVisibleUv = async function ({gl, draw, fence, draws, depth, bounds}) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 4) throw Error('UV probe depth must be 0..4')
  if (new Set(draws.map(d => d.resourceId)).size !== draws.length) throw Error('UV probe requires unique mesh instances')
  const started = performance.now(), live = new Set(), levels = []
  let count = 0, maximumLive = 0, program, rectangle, rectangleDepth
  const previousProgram=gl.getParameter(gl.CURRENT_PROGRAM),shaders=[]
  const key=cell=>[cell.id,cell.scale,cell.x,cell.y].join(':')
  const cells=bounds && new Map(bounds.levels.flatMap(level=>level.cells).map(cell=>[key(cell),cell.rectangles]))
  const source = new Map(draws.map(d => [d.resourceId, d]))
  let frontier = draws.map(d => ({id:d.resourceId, scale:d.imageryClipCell ? d.imageryCellScale : 1,
    x:d.imageryClipCell ? -d.imageryCellOffsetX : 0, y:d.imageryClipCell ? -d.imageryCellOffsetY : 0}))
  try {
    // A removed imagery region must not also remove its terrain occluder.
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.colorMask(false,false,false,false)
    gl.clear(gl.DEPTH_BUFFER_BIT)
    draw({id:1,draws})
    await fence()
    gl.depthMask(false)
    if(bounds) {
      if(bounds.depth<depth)throw Error('Incomplete conservative bounds')
      program=gl.createProgram()
      for(const [type,source] of [[gl.VERTEX_SHADER,`#version 300 es
        uniform vec4 rectangle;uniform float depth;
        void main(){vec2 p=vec2(gl_VertexID&1,(gl_VertexID>>1)&1);
          gl_Position=vec4(mix(rectangle.xy,rectangle.zw,p),depth,1.0);}`],
        [gl.FRAGMENT_SHADER,`#version 300 es
        precision highp float;out vec4 color;void main(){color=vec4(0.0);}`]]) {
        const shader=gl.createShader(type);shaders.push(shader)
        gl.shaderSource(shader,source);gl.compileShader(shader)
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader))
        gl.attachShader(program,shader)
      }
      gl.linkProgram(program)
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program))
      rectangle=gl.getUniformLocation(program,'rectangle');rectangleDepth=gl.getUniformLocation(program,'depth')
      gl.useProgram(program);gl.disable(gl.CULL_FACE)
    }
    for (let level = 0; level <= depth; ++level) {
      const visible = []
      for (let first = 0; first < frontier.length; first += 64) {
        if (performance.now()-started > 45000 || count + Math.min(64,frontier.length-first) > 32768)
          throw Error('UV probe work limit exceeded')
        const batch = frontier.slice(first,first+64)
        for (const cell of batch) {
          const rectangles=cells && cells.get(key(cell))
          if(cells && !rectangles) {visible.push({...cell});continue}
          if(rectangles && !rectangles.length)continue
          const query = gl.createQuery()
          if (!query) throw Error('UV query allocation failed')
          live.add(query); cell.query = query; ++count
          gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,query)
          try {
            if(rectangles) for(const r of rectangles) {
              gl.uniform4f(rectangle,...r.slice(0,4));gl.uniform1f(rectangleDepth,r[4])
              gl.drawArrays(gl.TRIANGLE_STRIP,0,4)
            } else draw({id:1,draws:[Object.assign({},source.get(cell.id),{
                imageryClipCell:true,imageryCellScale:cell.scale,
                imageryCellOffsetX:-cell.x,imageryCellOffsetY:-cell.y})]})
          } finally {gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE)}
        }
        maximumLive = Math.max(maximumLive,live.size)
        await fence()
        for (const cell of batch) {
          if(!cell.query)continue
          if (!gl.getQueryParameter(cell.query,gl.QUERY_RESULT_AVAILABLE)) throw Error('UV query receipt unavailable')
          if (gl.getQueryParameter(cell.query,gl.QUERY_RESULT)) visible.push({id:cell.id,scale:cell.scale,x:cell.x,y:cell.y})
          gl.deleteQuery(cell.query); live.delete(cell.query)
        }
      }
      levels.push({depth:level,queried:frontier.length,visible})
      frontier = visible.flatMap(cell => [0,1,2,3].map(i => ({id:cell.id,scale:cell.scale*2,
        x:cell.x*2+i%2,y:cell.y*2+Math.floor(i/2)})))
    }
    return {schema:'terra.offline-visible-uv.v1',levels,queries:count,maximumLive,conservativeBounds:Boolean(bounds),
      durationMs:performance.now()-started,
      scope:'Fixed geometry/view and raster samples; no image payload, motion, conservative runtime certificate or performance claim.'}
  } finally {
    live.forEach(query => gl.deleteQuery(query))
    gl.depthMask(true);gl.colorMask(true,true,true,true)
    gl.enable(gl.CULL_FACE);gl.useProgram(previousProgram)
    if(program)gl.deleteProgram(program)
    shaders.forEach(shader=>gl.deleteShader(shader))
  }
}
