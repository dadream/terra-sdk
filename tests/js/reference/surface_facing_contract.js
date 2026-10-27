const assert = require('assert')
const {PLANES, transform} = require('../../../sdk/js/math/projection')

// Independent reference: clip first, then measure the signed projected polygon.
// This intentionally does not use the homogeneous orientation predicate.
function area(clip) {
  let polygon=clip
  for (const plane of PLANES) {
    const out=[]
    for(let i=0;i<polygon.length;++i) {
      const a=polygon[i],b=polygon[(i+1)%polygon.length],da=plane(a),db=plane(b)
      if(da>=0) out.push(a)
      if((da<0)!==(db<0)) out.push(a.map((v,j)=>v+(b[j]-v)*da/(da-db)))
    }
    polygon=out
  }
  if(polygon.length<3) return 0
  return polygon.reduce((sum,a,i)=>{
    const b=polygon[(i+1)%polygon.length]
    return sum+(a[0]*b[1]-a[1]*b[0])/(a[3]*b[3])
  },0)
}

function verify(model, origin, context, facing) {
  const counts={front:0,back:0,proven:0}
  for(const block of model.blocks) {
    const verdict=facing.blockFacing(block,origin,context)
    if(verdict) ++counts.proven
    for(const f of block.faces) {
      const clip=[0,1,2].map(j=>{
        const id=model.faces[f+j]*3
        return transform(context.matrix,[0,1,2].map(i=>model.positions[id+i]+origin[i]))
      })
      const signed=area(clip)
      if(signed < -1e-12) {
        ++counts.front
        assert(verdict<=0,'Block proof rejected a visible clockwise face')
        assert(!facing.backFacing(clip),'Triangle proof rejected a visible clockwise face')
      } else if(signed > 1e-12) {
        ++counts.back
        assert(verdict>=0,'Block proof accepted a counterclockwise face as entirely front-facing')
      }
    }
  }
  return counts
}

module.exports={area,verify}
