const assert = require('assert')

module.exports = function ({Renderer, AsyncGl, FakeCanvas, publishFrame, frame, draw}) {
  const gl = new AsyncGl(), observations = []
  let destroyed = 0
  const renderer = new Renderer(new FakeCanvas(gl), {mode: 'height', urlForTile: () => 'unused',
    createTerrainVisibility() { return {
      snapshot() { return null }, hidden() { return true }, publicationGuard() { return null },
      observe(surface, stencil, submitted) {
        observations.push({submitted: submitted.slice(),
          drawsBefore: gl.calls.filter(c => c.name === 'drawElements').length})
      }, destroy() { ++destroyed }
    } }
  })
  try {
    const fine=draw(0), coverage={...draw(1),fragment:1,flags:1,firstVertex:3}
    publishFrame(renderer, {...frame(),coverageComplete:true}, [fine,coverage],
      new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,-1, 1,0,-1, 0,1,-1]),
      new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),new Uint16Array([0,1,2]))
    for(let i=0;i<8;i++){gl.complete();renderer.render()}
    gl.complete();gl.calls.length=0;observations.length=0
    renderer.plannedCameraVersion=-1
    renderer.render()
    assert.strictEqual(observations.length,1)
    assert(observations[0].submitted.length>0,'Imagery occlusion incorrectly removed terrain geometry')
    assert(observations[0].submitted.every(([d])=>!(d.flags&1)),'Coarse coverage polluted visibility depth')
    assert(gl.calls.filter(c=>c.name==='drawElements').length>observations[0].drawsBefore,
      'Fixture did not draw coarse coverage after visibility')
    let advances = 0
    renderer.visibility.advance = () => { ++advances }
    renderer.requestResources()
    renderer.render(false)
    assert.strictEqual(advances, 0, 'Visibility reused display depth before its completion receipt')
    gl.complete(); renderer.render(false)
    assert.strictEqual(advances, 1, 'Pipelined uploads consumed the pending visibility wake')
  } finally {renderer.destroy()}
  assert.strictEqual(destroyed,1,'Visibility lifetime was not owned by renderer')
}
