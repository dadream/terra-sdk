const assert = require('assert')
const {projectTriangle, clipTriangle} = require('../../sdk/js/terrain/triangle_projection')

module.exports = function () {
  const matrix = [1,0.5,0,-6378000,0,1,0,0,0,0,0.5,0,0.2,0,0.1,2-0.2*6378000]
  const origin = [6378000,0,0], faces = new Uint16Array([2,0,1])
  const positions = new Float32Array([-1,-0.5,0.4, 0.7,0.2,-0.3, -0.2,0.8,0.6])
  const uv = new Float32Array([0,0,1,0,0,1])
  const projected = projectTriangle(positions,uv,faces,0,origin,matrix)
  for (let i=0;i<3;++i) {
    const index=faces[i], world=origin.map((value,axis)=>value+positions[index*3+axis])
    for (let row=0;row<4;++row) {
      const r=row*4
      assert.strictEqual(projected[i][row], matrix[r]*world[0]+matrix[r+1]*world[1]+
        matrix[r+2]*world[2]+matrix[r+3])
    }
    assert.deepStrictEqual(projected[i].slice(4), Array.from(uv.slice(index*2,index*2+2)))
  }
  // A left-plane crossing has independently known homogeneous intersections.
  const crossing = [[-2,0,0,1,0,0], [0,0,0,1,1,0], [0,1,0,1,0,1]]
  assert.deepStrictEqual(clipTriangle(crossing), [
    [-1,0,0,1,0.5,0], crossing[1], crossing[2], [-1,0.5,0,1,0,0.5]])
  // Every barycentric sample represents the same position before and after
  // clipping. In UV space the output polygon must contain exactly the samples
  // satisfying all six clip inequalities, including triangles behind the eye.
  let seed=79873, crossings=0, rejected=0, accepted=0
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
  const inFrustum=p=>p[3]>=Math.abs(p[0]) && p[3]>=Math.abs(p[1]) && p[3]>=Math.abs(p[2])
  const contains=(polygon,u,v)=>{
    if (polygon.length<3) return false
    let positive=false,negative=false
    for(let i=0;i<polygon.length;++i) {
      const a=polygon[i],b=polygon[(i+1)%polygon.length]
      const side=(b[4]-a[4])*(v-a[5])-(b[5]-a[5])*(u-a[4])
      if(side>1e-12)positive=true
      if(side< -1e-12)negative=true
    }
    return !(positive && negative)
  }
  for(let sample=0;sample<600;++sample) {
    const clip=[[0,0],[1,0],[0,1]].map(([u,v])=>[
      random()*6-3,random()*6-3,random()*6-3,random()*5-1,u,v])
    const original=JSON.stringify(clip), polygon=clipTriangle(clip)
    if(!polygon.length)++rejected
    else if(clip.every(inFrustum))++accepted
    else ++crossings
    for(const p of polygon) {
      for(let axis=0;axis<3;++axis) assert(p[3]+1e-12>=Math.abs(p[axis]))
      for(let axis=0;axis<4;++axis) assert(Math.abs(p[axis]-(clip[0][axis]+
        p[4]*(clip[1][axis]-clip[0][axis])+p[5]*(clip[2][axis]-clip[0][axis])))<1e-12,
      'Clipping changed homogeneous position/UV correspondence')
    }
    for(let i=0;i<40;++i) {
      let u=random(),v=random();if(u+v>1){u=1-u;v=1-v}
      const point=clip[0].map((value,axis)=>value+u*(clip[1][axis]-value)+v*(clip[2][axis]-value))
      assert.strictEqual(contains(polygon,u,v),inFrustum(point), 'Clip polygon lost or added visible coverage')
    }
    assert.strictEqual(JSON.stringify(clip),original,'Clipping mutated immutable input')
  }
  assert(crossings>100 && rejected>50 && accepted>0)
  console.log('Triangle projection, homogeneous boundary/UV continuity and sampled clip coverage passed')
}

if(require.main===module) module.exports()
