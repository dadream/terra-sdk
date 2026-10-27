// Frozen bafee2e scalar compaction, retained only as a pre-upgrade equivalence oracle.
const {spectral2} = require('../../../sdk/js/math/projection')

function uvHull(uv, boundary) {
  return pointHull(Array.from(boundary, i => [uv[i * 2], uv[i * 2 + 1]]))
}

function pointHull(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) -
    (b[1] - a[1]) * (c[0] - a[0])
  const half = values => {
    const result = []
    values.forEach(point => {
      while (result.length > 1 &&
        cross(result[result.length - 2], result[result.length - 1], point) <= 0) result.pop()
      result.push(point)
    })
    result.pop()
    return result
  }
  return half(points).concat(half(points.slice().reverse()))
}

// Only merge a region when a lower bound on every contributing triangle's
// texel density proves the merged upper bound is tight. In particular, never
// combine the nearest depth of one triangle with another triangle's slope.
// Unmergeable regions retain their projective triangle for node-local clipping.
function* compactRegions(input) {
  const result = [], unique = new Map()
  let processed = 0
  for (const region of input) {
    if (!region.projection) result.push(region)
    else {
      const key = region.triangle.map(p => p.join(',')).sort().join(';') + ':' + region.projection.join(',')
      if (!unique.has(key)) unique.set(key, region)
    }
    if (++processed%64===0) yield
  }
  const items = []
  processed = 0
  for (const region of unique.values()) {
    const c = region.projection
    let minW = Infinity, maxW = 0, maxN = 0, deviation = 0, reference
    for (const [u,v] of region.triangle) {
      const x=c[0]+c[1]*u+c[2]*v, y=c[3]+c[4]*u+c[5]*v, w=c[6]+c[7]*u+c[8]*v
      const a=c[1]*w-x*c[7],b=c[2]*w-x*c[8],d=c[4]*w-y*c[7],e=c[5]*w-y*c[8]
      if (!reference) reference=[a,b,d,e]
      maxN=Math.max(maxN,spectral2(a,b,d,e))
      deviation=Math.max(deviation,spectral2(a-reference[0],b-reference[1],d-reference[2],e-reference[3]))
      minW=Math.min(minW,w);maxW=Math.max(maxW,w)
    }
    const lowerN=Math.max(0,spectral2(reference[0],reference[1],reference[2],reference[3])-deviation)
    const upper=Math.min(region.pixelsPerUv,minW>0?maxN/(minW*minW):Infinity)
    const p=region.triangle
    const area=Math.abs((p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[1][1]-p[0][1])*(p[2][0]-p[0][0]))/2
    items.push({region,upper,lower:maxW>0?lowerN/(maxW*maxW):0,area})
    if (++processed%64===0) yield
  }
  const pending = [items]
  while (pending.length) {
    const group = pending.pop()
    if (!group.length) continue
    const upper=group.reduce((v,item)=>Math.max(v,item.upper),0)
    const lower=group.reduce((v,item)=>Math.min(v,item.lower),Infinity)
    let merged=false
    if (group.length>2 && upper<=lower*1.25) {
      // Shared grid vertices occur in many triangles. Deduplicate coordinates
      // before sorting a hull; this does not change its convex envelope.
      const columns=new Map(),points=[]
      for(const item of group) for(const point of item.region.triangle) {
        let values=columns.get(point[0])
        if(!values){values=new Set();columns.set(point[0],values)}
        if(!values.has(point[1])){values.add(point[1]);points.push(point)}
      }
      const hull=pointHull(points)
      let area=0
      for(let i=0;i<hull.length;i++) {
        const a=hull[i],b=hull[(i+1)%hull.length]
        area+=a[0]*b[1]-a[1]*b[0]
      }
      const covered=group.reduce((v,item)=>v+item.area,0)
      // A convex envelope is admissible only when it adds no empty UV space.
      // Terrain UV triangles do not overlap; clipped triangles preserve this.
      if(hull.length>=3 && Math.abs(Math.abs(area)/2-covered)<=Math.max(1e-14,covered*1e-8)) {
        for(let i=1;i+1<hull.length;i++) {
          const triangle=[hull[0],hull[i],hull[i+1]]
          result.push({triangle,pixelsPerUv:upper,
            projection:[0,upper,0,0,0,upper,1,0,0],
            uv:{minimumU:Math.min(...triangle.map(p=>p[0])),maximumU:Math.max(...triangle.map(p=>p[0])),
              minimumV:Math.min(...triangle.map(p=>p[1])),maximumV:Math.max(...triangle.map(p=>p[1]))}})
        }
        merged=true
      }
    }
    if(!merged) {
      if(group.length<=4) result.push(...group.map(item=>item.region))
      else {
        const extent=axis=>{
          const lo=axis?'minimumV':'minimumU',hi=axis?'maximumV':'maximumU'
          return group.reduce((v,item)=>Math.max(v,item.region.uv[hi]),-Infinity)-
            group.reduce((v,item)=>Math.min(v,item.region.uv[lo]),Infinity)
        }
        const axis=extent(1)>extent(0),lo=axis?'minimumV':'minimumU',hi=axis?'maximumV':'maximumU'
        group.sort((a,b)=>(a.region.uv[lo]+a.region.uv[hi])-(b.region.uv[lo]+b.region.uv[hi]))
        const middle=Math.floor(group.length/2)
        pending.push(group.slice(0,middle),group.slice(middle))
      }
    }
    yield
  }
  return result
}

module.exports = {uvHull, compactRegions}
