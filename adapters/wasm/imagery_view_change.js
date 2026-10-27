const {PLANES, dot, spectral, transform} = require('../../sdk/js/math/projection')

// This is a scheduling hint, never an SSE acceptance test. Use actual terrain
// samples in both projections rather than orbit distance as a proxy for what
// changed near the horizon. Immutable geometry and all resident images survive
// a rebase; only camera-dependent work can become obsolete.
function projectedViewChange(draws,modelFor,before,after) {
  if(!before || !after || !before.projectionView || !after.projectionView) return null
  const ratios=[]
  let motion=0,visible=0,entered=0
  for(const draw of draws) {
    const model=modelFor(draw)
    if(!model || !model.blocks || !model.positions || !model.faces) continue
    for(const block of model.blocks) {
      if(!block.faces || !block.faces.length) continue
      const f=block.faces[0],point=[0,0,0]
      for(let j=0;j<3;j++) for(let axis=0;axis<3;axis++) {
        point[axis]+=model.positions[model.faces[f+j]*3+axis]/3
      }
      const p=point.map((v,i)=>v+(draw.origin || [0,0,0])[i])
      const sample=frame=>{
        const m=frame.projectionView,q=transform(m,p)
        if(!(q[3]>0) || !PLANES.every(plane=>plane(q)>=0)) return null
        const nx=q[0]/q[3],ny=q[1]/q[3]
        const x=[0,1,2].map(i=>(m[i]-nx*m[12+i])/q[3])
        const y=[0,1,2].map(i=>(m[4+i]-ny*m[12+i])/q[3])
        return {x:nx,y:ny,density:spectral([dot(x,block.du),dot(x,block.dv),0],
          [dot(y,block.du),dot(y,block.dv),0])}
      }
      const a=sample(before),b=sample(after)
      if(!b) continue
      ++visible
      if(!a) {++entered;continue}
      motion=Math.max(motion,Math.hypot(b.x-a.x,b.y-a.y))
      if(a.density>0 && b.density>0) ratios.push(b.density/a.density)
    }
  }
  if(!ratios.length) return visible ? {rebase:true,coarsening:null} : null
  ratios.sort((a,b)=>a-b)
  return {rebase:ratios[0]<0.5 || ratios[ratios.length-1]>2 || motion>0.5 || entered>visible/4,
    coarsening:ratios[Math.floor(ratios.length/2)]<0.9 && ratios[ratios.length-1]<=1.1}
}

module.exports = {projectedViewChange}
