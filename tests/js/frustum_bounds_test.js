const assert = require('assert')
const {outsideFrustumBox} = require('../../sdk/js/terrain/frustum_bounds')
const {projectionContext} = require('../../sdk/js/terrain/terra_surface_plan')
const {PLANES, transform, spectral2} = require('../../sdk/js/math/projection')

module.exports = function () {
  let seed = 1234567
  const random = () => {seed = (Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
  let rejected = 0, retained = 0
  for (const shift of [0, 6378000]) for (let sample=0;sample<400;++sample) {
    const slope = sample%3 ? 0.8 : 0
    const matrix = [1,0,0,-shift,0,1,0,0,0,0,0.5,0,slope,0,0,2-slope*shift]
    const origin = [shift,0,0]
    const minimum = [0,1,2].map(()=>random()*8-4)
    const maximum = minimum.map(v=>v+random())
    const context = projectionContext({projectionView:matrix},{width:640,height:360},null)
    const points = Array.from({length:8},(_,i)=>transform(matrix,
      [0,1,2].map(axis=>(i&(1<<axis)?maximum[axis]:minimum[axis])+origin[axis])))
    if (outsideFrustumBox(minimum,maximum,origin,context.planes)) {
      ++rejected
      assert(PLANES.some(plane=>points.every(p=>plane(p)<0)), 'Interval rejection discarded an intersecting box')
    } else ++retained
  }
  assert(rejected>100 && retained>100)
  const matrix = [1,0,0,-6378000,0,1,0,0,0,0,1,0,0,0,0,1]
  const context = projectionContext({projectionView:matrix},{},null), origin=[6378000,0,0]
  assert(!outsideFrustumBox([-1-1e-8,0,0],[-1-5e-9,0.1,0.1],origin,context.planes),
    'Globe-coordinate cancellation lost its conservative boundary margin')
  assert(outsideFrustumBox([-2,0,0],[-1.1,0.1,0.1],origin,context.planes))
  assert(!outsideFrustumBox([0,0,0],[1,1,1],origin,null))
  // Rotate an anisotropic map in both domains. Its maximum stretch remains 7.
  for (let i=0;i<80;++i) {
    const a=random()*Math.PI*2,b=random()*Math.PI*2,c=Math.cos(a),s=Math.sin(a),u=Math.cos(b),v=Math.sin(b)
    const values=[3*c*u-7*s*v,-3*c*v-7*s*u,3*s*u+7*c*v,-3*s*v+7*c*u]
    assert(Math.abs(spectral2(...values)-7)<1e-12)
  }
  console.log('Frustum interval rejection, globe rounding margin and rotated maximum stretch passed')
}
