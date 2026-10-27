const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {surfaceBlocks} = require('../../sdk/js/terrain/surface_blocks')
const {invertMatrix4} = require('../../sdk/js/math/matrix')

const drain = work => {let next; do {next = work.next()} while (!next.done); return next.value}
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]

module.exports = function () {
  const f = require('./reference/measurement_fixture')()
  const model = surface.prepareSurface(f.positions, f.uv, f.indices, 0, f.indices.length)
  const context = surface.projectionContext({projectionView:identity}, {width:400,height:400}, identity)
  const bounded = drain(surface.surfaceMeasurements(model, [0,0,0], context, true))
  // Analytic map: X slopes are 0.6/1.4, Y slope is 1. A 400px
  // orthographic viewport needs at most 280px/UV, regardless of face order.
  assert(Math.abs(bounded.pixelsPerUv - 280) < 0.001,
    'The derivative bound charges variation twice around the first face')
  const faces = []
  for (let i=model.faces.length-3;i>=0;i-=3) faces.push(...model.faces.slice(i,i+3))
  const reversed = surfaceBlocks(f.positions, f.uv, new Uint16Array(faces), model.bounds)
  const summary = blocks => blocks.map(({du,dv,duRadius,dvRadius,deviation}) => ({du,dv,duRadius,dvRadius,deviation}))
  assert.deepStrictEqual(summary(reversed), summary(model.blocks), 'Triangle order changed derivative bounds')

  // All derivative components must remain inside their intervals. The
  // projected upper bound must also dominate fully clipped triangle demand
  // across relief, rotation, perspective, near-plane clipping and globe origin.
  let compared = 0, visible = 0, finite = 0
  for (const n of [8,16,32]) {
    const grid = require('./reference/grid_surface_fixture')(n)
    const m = surface.prepareSurface(grid.positions, grid.uv, grid.indices, 0, grid.indices.length)
    for (const block of m.blocks) for (const first of block.faces) {
      const [a,b,c] = Array.from(m.faces.slice(first,first+3))
      const u1=m.uv[b*2]-m.uv[a*2],v1=m.uv[b*2+1]-m.uv[a*2+1]
      const u2=m.uv[c*2]-m.uv[a*2],v2=m.uv[c*2+1]-m.uv[a*2+1],det=u1*v2-u2*v1
      let squared = 0
      for (let axis=0;axis<3;++axis) {
        const p=m.positions[b*3+axis]-m.positions[a*3+axis], q=m.positions[c*3+axis]-m.positions[a*3+axis]
        const u=(p*v2-q*v1)/det, v=(q*u1-p*u2)/det
        assert(Math.abs(u-block.du[axis]) <= block.duRadius[axis]*(1+1e-12)+1e-12)
        assert(Math.abs(v-block.dv[axis]) <= block.dvRadius[axis]*(1+1e-12)+1e-12)
        squared += (u-block.du[axis])**2+(v-block.dv[axis])**2
      }
      assert(Math.sqrt(squared) <= block.deviation*(1+1e-12)+1e-12)
    }
    for (const angle of [0,0.3,1.2,2.4]) for (const slope of [0,0.6,1.4]) {
      const c=Math.cos(angle),s=Math.sin(angle)
      const matrix=[c,-s,0,-0.3,s,c,0,-0.2,0,0,0.2,0,slope,0.1,0.3,0.5]
      for (const offset of [0,6378000]) {
        const shifted=matrix.slice(),origin=[offset,0,0]
        for (let row=0;row<4;++row) shifted[row*4+3]-=matrix[row*4]*offset
        const view=surface.projectionContext({projectionView:shifted}, {width:800,height:600}, invertMatrix4(shifted))
        const fast=drain(surface.surfaceMeasurements(m,origin,view,true))
        const tight=drain(surface.surfaceMeasurements(m,origin,view,false,true))
        assert(!tight.visible || fast.visible, 'Interval culling lost a visible surface')
        assert(fast.pixelsPerUv >= tight.pixelsPerUv*(1-1e-8), 'Derivative bound underestimates triangle demand')
        ++compared; if(tight.visible) ++visible
        if(tight.visible && Number.isFinite(fast.pixelsPerUv)) ++finite
      }
    }
  }
  assert(compared===72 && visible>20 && finite>20)
}

if (require.main===module) {
  module.exports()
  console.log('Order-independent derivative bounds enclose analytic and clipped triangle demand')
}
