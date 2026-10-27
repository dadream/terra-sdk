const assert = require('assert')
const {triangleDensity} = require('../../sdk/js/terrain/triangle_density')
const {projectTriangle, clipTriangle} = require('../../sdk/js/terrain/triangle_projection')
const {dot, spectral} = require('../../sdk/js/math/projection')

// Vector-form oracle retained independently of the scalar hot loop. Compare
// the whole visible UV envelope as well as the error and ordering hint.
function reference(positions, faces, clip, polygon, context) {
  const p = Array.from(faces, i => Array.from(positions.slice(i*3, i*3+3)))
  const tex = clip.map(v => v.slice(4)), a = p[1].map((v,i) => v-p[0][i]), b = p[2].map((v,i) => v-p[0][i])
  const u1=tex[1][0]-tex[0][0], v1=tex[1][1]-tex[0][1]
  const u2=tex[2][0]-tex[0][0], v2=tex[2][1]-tex[0][1], det=u1*v2-u2*v1
  if (!(Math.abs(det)>=1e-16)) return null
  const du=a.map((v,i)=>(v*v2-b[i]*v1)/det), dv=a.map((v,i)=>(b[i]*u1-v*u2)/det)
  const depth=Math.min(...polygon.map(v=>v[3])), m=context.matrix
  const rx=m.slice(0,3), ry=m.slice(4,7), rw=m.slice(12,15)
  const result={uv:{minimumU:Infinity,minimumV:Infinity,maximumU:-Infinity,maximumV:-Infinity},
    pixelsPerUv:0,centerDistance:Infinity}
  polygon.forEach(p=>{
    result.uv.minimumU=Math.min(result.uv.minimumU,p[4]);result.uv.maximumU=Math.max(result.uv.maximumU,p[4])
    result.uv.minimumV=Math.min(result.uv.minimumV,p[5]);result.uv.maximumV=Math.max(result.uv.maximumV,p[5])
    const nx=p[0]/p[3],ny=p[1]/p[3]
    result.centerDistance=Math.min(result.centerDistance,Math.hypot(nx,ny))
    const x=rx.map((v,i)=>context.sx*(v-nx*rw[i])),y=ry.map((v,i)=>context.sy*(v-ny*rw[i]))
    result.pixelsPerUv=Math.max(result.pixelsPerUv,depth>1e-9
      ?spectral([dot(x,du),dot(x,dv),0],[dot(y,du),dot(y,dv),0])/depth:Infinity)
  })
  return result
}

module.exports = function () {
  let seed=60317, compared=0, clipped=0
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
  const result={uv:{},pixelsPerUv:0,centerDistance:Infinity}
  for(let i=0;i<1000;++i) {
    const positions=new Float32Array(Array.from({length:9},()=>random()*6-3))
    const uv=new Float32Array(Array.from({length:6},()=>random()))
    const faces=new Uint16Array(i%2?[2,0,1]:[1,0,2]), origin=i%3?[0,0,0]:[6378000,0,0]
    const matrix=[1,0.2,0,-origin[0],0,0.7,0.3,0,0,0,0.1,0,0.6,0.1,0.2,1-origin[0]*0.6]
    const context={matrix,sx:640,sy:360}
    const clip=projectTriangle(positions,uv,faces,0,origin,matrix), polygon=clipTriangle(clip)
    if(polygon.length<3) continue
    if(polygon!==clip) ++clipped
    const before=JSON.stringify([positions,faces,clip,polygon])
    const expected=reference(positions,faces,clip,polygon,context)
    assert(triangleDensity(positions,faces,0,clip,polygon,context,result))
    assert.deepStrictEqual(result,expected,'Scalar projection changed the conservative texel demand')
    assert.strictEqual(JSON.stringify([positions,faces,clip,polygon]),before,'Density mutated immutable geometry')
    ++compared
  }
  assert(compared>500 && clipped>400)
  // Analytic affine map: an orthographic rotation preserves singular values.
  // Scale in U is 2, in V is 3; square 400px viewport gives 600px/UV.
  const positions=new Float32Array([0,0,0,2,0,0,0,3,0]), uv=new Float32Array([0,0,1,0,0,1])
  const faces=new Uint16Array([0,1,2])
  for(const angle of [0,0.3,1.7]) {
    const c=Math.cos(angle),s=Math.sin(angle),matrix=[c,-s,0,0,s,c,0,0,0,0,1,0,0,0,0,1]
    const clip=projectTriangle(positions,uv,faces,0,[0,0,0],matrix), polygon=clipTriangle(clip)
    assert(triangleDensity(positions,faces,0,clip,polygon,{matrix,sx:200,sy:200},result))
    assert(Math.abs(result.pixelsPerUv-600)<1e-10)
  }
  const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
  for(const invalidUv of [new Float32Array(6),new Float32Array([0,0,NaN,0,0,1])]) {
    const clip=projectTriangle(positions,invalidUv,faces,0,[0,0,0],identity), before=JSON.stringify(result)
    assert(!triangleDensity(positions,faces,0,clip,clip,{matrix:identity,sx:200,sy:200},result))
    assert.strictEqual(JSON.stringify(result),before,'Degenerate domain overwrote scratch output')
  }
  console.log('Scalar triangle density preserves clipped demand, globe offsets, rotation and immutable input')
}

if(require.main===module) module.exports()
