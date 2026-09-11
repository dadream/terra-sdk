// Camera-independent surface derivatives and UV partitions.
const EDGES = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]]
const PLANES = [p => p[3]+p[0], p => p[3]-p[0], p => p[3]+p[1],
  p => p[3]-p[1], p => p[3]+p[2], p => p[3]-p[2]]
function dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2] }
function spectral(a, b) {
  const aa=dot(a,a), bb=dot(b,b), ab=dot(a,b)
  return Math.sqrt(Math.max(0,(aa+bb+Math.hypot(aa-bb,2*ab))/2))
}
function corners(lo, hi) {
  return Array.from({length:8},(_,i)=>[i&1?hi[0]:lo[0],i&2?hi[1]:lo[1],i&4?hi[2]:lo[2]])
}
function transform(m,p) {
  return [0,4,8,12].map(i=>m[i]*p[0]+m[i+1]*p[1]+m[i+2]*p[2]+m[i+3])
}
function interpolate(a,b,t) { return a.map((v,i)=>v+(b[i]-v)*t) }
function clipSegment(a,b,planes) {
  let lo=0, hi=1
  for (const plane of planes) {
    const x=plane(a), y=plane(b)
    if(x<0 && y<0) return null
    if(x<0) lo=Math.max(lo,x/(x-y))
    if(y<0) hi=Math.min(hi,x/(x-y))
    if(lo>hi) return null
  }
  return [interpolate(a,b,lo),interpolate(a,b,hi)]
}
function projectionContext(frame,viewport,inverse) {
  const dpr=Math.max(1,viewport.devicePixelRatio||1)
  const world=inverse?corners([-1,-1,-1],[1,1,1]).map(p=>{
    const q=transform(inverse,p)
    return q.slice(0,3).map(v=>v/q[3])
  }):[]
  return {matrix:frame.projectionView,world,
    sx:Math.max(1,viewport.width||1)/dpr/2,sy:Math.max(1,viewport.height||1)/dpr/2}
}
function visibleBox(block,origin,context) {
  const lo=block.minimum.map((v,i)=>v+origin[i]), hi=block.maximum.map((v,i)=>v+origin[i])
  const points=corners(lo,hi).map(p=>transform(context.matrix,p))
  if(PLANES.some(plane=>points.every(p=>plane(p)<0))) return []
  if(PLANES.every(plane=>points.every(p=>plane(p)>=0))) return points
  const result=[]
  EDGES.forEach(([a,b])=>{
    const clipped=clipSegment(points[a],points[b],PLANES)
    if(clipped) result.push(...clipped)
  })
  // Both polyhedra's edges are necessary when the frustum is inside a box.
  if(context.world.length) {
    const planes=[]
    for(let i=0;i<3;++i) planes.push(p=>p[i]-lo[i],p=>hi[i]-p[i])
    EDGES.forEach(([a,b])=>{
      if(!context.world[a].every(Number.isFinite)||!context.world[b].every(Number.isFinite)) return
      const clipped=clipSegment(context.world[a],context.world[b],planes)
      if(clipped) result.push(...clipped.map(p=>transform(context.matrix,p)))
    })
  }
  return result
}
const topologyCache = new WeakMap()

function triangles(indices, first, count, vertexCount) {
  let cached = topologyCache.get(indices)
  if (!cached) {
    cached = new Map()
    topologyCache.set(indices, cached)
  }
  const key = first + '/' + count + '/' + vertexCount
  if (cached.has(key)) return cached.get(key)
  const values = []
  for (let i = 2; i < count; ++i) {
    const a = indices[first + i - 2], b = indices[first + i - 1]
    const c = indices[first + i]
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount ||
        a === b || b === c || a === c) continue
    if (i % 2) values.push(b, a, c)
    else values.push(a, b, c)
  }
  const result = new Uint16Array(values)
  const edges = new Map()
  for (let i = 0; i < result.length; i += 3) {
    for (let e = 0; e < 3; ++e) {
      const a = result[i + e], b = result[i + (e + 1) % 3]
      const edge = Math.min(a, b) * vertexCount + Math.max(a, b)
      edges.set(edge, (edges.get(edge) || 0) + 1)
    }
  }
  const boundary = new Set()
  edges.forEach((count, edge) => {
    if (count === 1) {
      boundary.add(Math.floor(edge / vertexCount))
      boundary.add(edge % vertexCount)
    }
  })
  result.boundary = Array.from(boundary)
  cached.set(key, result)
  return result
}


function uvHull(uv, boundary) {
  const points = Array.from(boundary, i => [uv[i * 2], uv[i * 2 + 1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
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

function intersectsCell(hull, minimumU, minimumV, maximumU, maximumV) {
  if (!hull || hull.length < 3) return true
  for (let i = 0; i < hull.length; ++i) {
    const a = hull[i], b = hull[(i + 1) % hull.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const u = dy > 0 ? minimumU : maximumU
    const v = dx > 0 ? maximumV : minimumV
    if (dx * (v - a[1]) - dy * (u - a[0]) <= 0) return false
  }
  return true
}

function prepareSurface(positions, uv, indices, firstIndex, indexCount) {
  const faces = triangles(indices, firstIndex, indexCount, positions.length / 3)
  const blocks = new Array(16)
  const bounds = { minimumU: Infinity, minimumV: Infinity,
    maximumU: -Infinity, maximumV: -Infinity }
  for (let i = 0; i < uv.length; i += 2) {
    bounds.minimumU = Math.min(bounds.minimumU, uv[i])
    bounds.maximumU = Math.max(bounds.maximumU, uv[i])
    bounds.minimumV = Math.min(bounds.minimumV, uv[i + 1])
    bounds.maximumV = Math.max(bounds.maximumV, uv[i + 1])
  }
  const scaleU = 4 / Math.max(1e-12, bounds.maximumU - bounds.minimumU)
  const scaleV = 4 / Math.max(1e-12, bounds.maximumV - bounds.minimumV)
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f], b = faces[f + 1], c = faces[f + 2]
    const u0 = uv[a * 2], v0 = uv[a * 2 + 1]
    const u1 = uv[b * 2], v1 = uv[b * 2 + 1]
    const u2 = uv[c * 2], v2 = uv[c * 2 + 1]
    const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0
    const det = du1 * dv2 - du2 * dv1
    if (Math.abs(det) < 1e-16) continue
    const x0 = positions[a * 3], y0 = positions[a * 3 + 1], z0 = positions[a * 3 + 2]
    const x1 = positions[b * 3], y1 = positions[b * 3 + 1], z1 = positions[b * 3 + 2]
    const x2 = positions[c * 3], y2 = positions[c * 3 + 1], z2 = positions[c * 3 + 2]
    const ux = ((x1 - x0) * dv2 - (x2 - x0) * dv1) / det
    const uy = ((y1 - y0) * dv2 - (y2 - y0) * dv1) / det
    const uz = ((z1 - z0) * dv2 - (z2 - z0) * dv1) / det
    const vx = ((x2 - x0) * du1 - (x1 - x0) * du2) / det
    const vy = ((y2 - y0) * du1 - (y1 - y0) * du2) / det
    const vz = ((z2 - z0) * du1 - (z1 - z0) * du2) / det
    const column = Math.max(0, Math.min(3, Math.floor(((u0 + u1 + u2) / 3 - bounds.minimumU) * scaleU)))
    const row = Math.max(0, Math.min(3, Math.floor(((v0 + v1 + v2) / 3 - bounds.minimumV) * scaleV)))
    const key = row * 4 + column
    let block = blocks[key]
    if (!block) {
      block = { minimum: [Infinity, Infinity, Infinity],
        maximum: [-Infinity, -Infinity, -Infinity],
        du: [ux, uy, uz], dv: [vx, vy, vz], deviation: 0,
        duRadius: [0, 0, 0], dvRadius: [0, 0, 0],
        uv: { minimumU: Infinity, minimumV: Infinity, maximumU: -Infinity, maximumV: -Infinity } }
      blocks[key] = block
    }
    const dx = ux - block.du[0], dy = uy - block.du[1], dz = uz - block.du[2]
    const ex = vx - block.dv[0], ey = vy - block.dv[1], ez = vz - block.dv[2]
    ;[dx, dy, dz].forEach((v, i) => { block.duRadius[i] = Math.max(block.duRadius[i], Math.abs(v)) })
    ;[ex, ey, ez].forEach((v, i) => { block.dvRadius[i] = Math.max(block.dvRadius[i], Math.abs(v)) })
    block.deviation = Math.max(block.deviation,
      Math.sqrt(dx * dx + dy * dy + dz * dz + ex * ex + ey * ey + ez * ez))
    block.minimum[0] = Math.min(block.minimum[0], x0, x1, x2)
    block.minimum[1] = Math.min(block.minimum[1], y0, y1, y2)
    block.minimum[2] = Math.min(block.minimum[2], z0, z1, z2)
    block.maximum[0] = Math.max(block.maximum[0], x0, x1, x2)
    block.maximum[1] = Math.max(block.maximum[1], y0, y1, y2)
    block.maximum[2] = Math.max(block.maximum[2], z0, z1, z2)
    block.uv.minimumU = Math.min(block.uv.minimumU, u0, u1, u2)
    block.uv.maximumU = Math.max(block.uv.maximumU, u0, u1, u2)
    block.uv.minimumV = Math.min(block.uv.minimumV, v0, v1, v2)
    block.uv.maximumV = Math.max(block.uv.maximumV, v0, v1, v2)
  }
  return { positions, uv, faces, blocks: blocks.filter(Boolean), bounds,
    hull: uvHull(uv, faces.boundary) }
}
function measureSurface(surface,origin,context) {
  const m=context.matrix,rx=Array.from(m.slice(0,3)),ry=Array.from(m.slice(4,7)),rw=Array.from(m.slice(12,15))
  if(surface.faces.length && !surface.blocks.length) {
    return {pixelsPerUv:Infinity,visible:true,centerDistance:0}
  }
  let pixelsPerUv=0,visible=false,centerDistance=Infinity
  const regions=[]
  const uv={minimumU:Infinity,minimumV:Infinity,maximumU:-Infinity,maximumV:-Infinity}
  surface.blocks.forEach(block=>{
    const points=visibleBox(block,origin,context)
    if(!points.length) return
    visible=true
    Object.keys(uv).forEach(key=>{
      uv[key]=key.startsWith('minimum')?Math.min(uv[key],block.uv[key]):Math.max(uv[key],block.uv[key])
    })
    const region={uv:block.uv,pixelsPerUv:0}
    regions.push(region)
    const minW=Math.min(...points.map(p=>p[3]))
    if(!(minW>1e-9)) {pixelsPerUv=region.pixelsPerUv=Infinity;return}
    points.forEach(p=>{
      const nx=p[0]/p[3],ny=p[1]/p[3]
      centerDistance=Math.min(centerDistance,Math.hypot(nx,ny))
      const x=rx.map((v,i)=>context.sx*(v-nx*rw[i])),y=ry.map((v,i)=>context.sy*(v-ny*rw[i]))
      // A norm is convex in projected position. Intersection vertices and the
      // minimum visible w bound the block, including the cached slope residual.
      const derivative=spectral([dot(x,block.du),dot(x,block.dv),0],[dot(y,block.du),dot(y,block.dv),0])
      // Project derivative intervals before bounding their residual. Depth-only
      // variation must not be charged as a full screen-space slope change.
      const radius=(row,r)=>row.reduce((sum,v,i)=>sum+Math.abs(v)*r[i],0)
      const residual=Math.min(spectral(x,y)*block.deviation,
        Math.hypot(radius(x,block.duRadius),radius(x,block.dvRadius),
          radius(y,block.duRadius),radius(y,block.dvRadius)))
      region.pixelsPerUv=Math.max(region.pixelsPerUv,(derivative+residual)/minW)
    })
    pixelsPerUv=Math.max(pixelsPerUv,region.pixelsPerUv)
  })
  return {pixelsPerUv,visible,uv,centerDistance,regions}
}
function clipPolygon(polygon,axis,boundary,greater) {
  const result=[]
  for(let i=0;i<polygon.length;++i) {
    const a=polygon[i],b=polygon[(i+1)%polygon.length]
    const da=(a[axis]-boundary)*(greater?1:-1),db=(b[axis]-boundary)*(greater?1:-1)
    if(da>=0) result.push(a)
    if((da<0)!==(db<0)) {
      const point=interpolate(a,b,da/(da-db));point[axis]=boundary;result.push(point)
    }
  }
  return result
}
function partitionSurface(surface, cells) {
  const output = cells.map(cell => ({ cell, positions: [], uv: [], indices: [] }))
  const faces = surface.faces, uv = surface.uv, positions = surface.positions
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f], b = faces[f + 1], c = faces[f + 2]
    const u0 = uv[a * 2], v0 = uv[a * 2 + 1], u1 = uv[b * 2], v1 = uv[b * 2 + 1]
    const u2 = uv[c * 2], v2 = uv[c * 2 + 1]
    const minU = Math.min(u0, u1, u2), maxU = Math.max(u0, u1, u2)
    const minV = Math.min(v0, v1, v2), maxV = Math.max(v0, v1, v2)
    let original = null
    for (const item of output) {
      const bounds = item.cell.bounds
      if (maxU <= bounds.minimumU || minU >= bounds.maximumU ||
          maxV <= bounds.minimumV || minV >= bounds.maximumV) continue
      if (minU >= bounds.minimumU && maxU <= bounds.maximumU &&
          minV >= bounds.minimumV && maxV <= bounds.maximumV) {
        item.indices.push(a, b, c)
        continue
      }
      if (!original) original = [a, b, c].map(i => [uv[i * 2], uv[i * 2 + 1],
        positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]])
      let polygon = clipPolygon(original, 0, bounds.minimumU, true)
      polygon = clipPolygon(polygon, 0, bounds.maximumU, false)
      polygon = clipPolygon(polygon, 1, bounds.minimumV, true)
      polygon = clipPolygon(polygon, 1, bounds.maximumV, false)
      for (let i = 2; i < polygon.length; ++i) {
        const p = polygon[0], q = polygon[i - 1], r = polygon[i]
        if (Math.abs((q[0] - p[0]) * (r[1] - p[1]) -
            (q[1] - p[1]) * (r[0] - p[0])) < 1e-16) continue
        item.uv.push(p[0], p[1], q[0], q[1], r[0], r[1])
        item.positions.push(p[2], p[3], p[4], q[2], q[3], q[4], r[2], r[3], r[4])
      }
    }
  }
  return output.filter(item => item.positions.length || item.indices.length).map(item => ({
    cell: item.cell, positions: new Float32Array(item.positions),
    uv: new Float32Array(item.uv), indices: new Uint16Array(item.indices)
  }))
}
module.exports = { prepareSurface, measureSurface, projectionContext, partitionSurface, intersectsCell }
