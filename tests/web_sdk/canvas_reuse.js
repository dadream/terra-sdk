// Recreating a viewer on its existing canvas reuses the WebGL context. Exercise
// the first sky draw before any new terrain binds its position/UV inputs.
window.verifyCanvasReuse = async function (sdk) {
  const results = []
  for (const type of ['webgl', 'webgl2']) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const gl = canvas.getContext(type, {alpha:false, depth:true, stencil:true})
    if (!gl) throw Error('Canvas reuse fixture requires ' + type)
    const check = label => {
      const error = gl.getError()
      if (error !== gl.NO_ERROR) throw Error(`${type} ${label}: WebGL error ${error}`)
    }
    const create = () => {
      const value = new sdk.webgl.TerraWebGlRenderer(canvas, {
        gl, mode:'height', atmosphereCapable:true, atmosphereEnabled:true, planetRadius:1,
        urlForTile:() => { throw Error('Unexpected canvas reuse fixture network') },
        requestResources() {}, requestRender() {}
      })
      value.textures.scheduler.pause()
      return value
    }
    const frame = {sequence:1, coverageComplete:true,
      projectionView:new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]), cameraPosition:[0,0,2]}
    const publish = async renderer => {
      const draw = {resourceId:1, textureResourceId:1, key:{level:0,i:0,j:0,k:0},
        textureNode:{level:0,root:0,row:0,column:0}, texture:{level:0,matrix:0,row:0,column:0},
        origin:[0,0,0], firstIndex:0, indexCount:3, vertexCount:3, firstVertex:0}
      const resource = {resourceId:1,
        positions:new Float32Array([-.5,-.5,0,0,.5,0,.5,-.5,0]),
        textureUv:new Float32Array([0,0,.5,1,1,0])}
      renderer.setMeshFrame(frame, [draw], new Map([[1,resource]]), new Uint16Array([0,1,2]),
        {workerGeneration:1,modelRevision:1}, null, [], {selectionCurrent:true,camera:{}})
      const deadline = performance.now() + 5000
      while (renderer.submittedSequence !== 1) {
        renderer.advanceResources(); renderer.render(false)
        if (performance.now() > deadline) throw Error(type + ' canvas reuse terrain deadline')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      check('terrain submission')
    }
    let renderer
    try {
      renderer = create()
      await publish(renderer)
      renderer.destroy(); renderer = null
      check('destroyed renderer')
      renderer = create()
      check('recreated renderer')
      renderer.renderAtmosphere(new Float32Array(frame.projectionView), frame.cameraPosition)
      check('first sky on reused canvas')
      await publish(renderer)
      results.push({context:type, recreated:true, skyDraw:true, terrainSubmitted:true})
    } finally {
      if (renderer) renderer.destroy()
      const lose = gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
    }
  }
  return results
}
