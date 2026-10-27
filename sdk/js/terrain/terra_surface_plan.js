const {PLANES, dot, spectral, transform} = require('../math/projection')
const {outsideFrustumBox} = require('./frustum_bounds')
const {projectTriangle, clipTriangle} = require('./triangle_projection')
const {triangleDensity} = require('./triangle_density')
const {compactRegions} = require('./surface_regions')
const {splitSurfaceBlock} = require('./surface_blocks')
const {triangles, prepareSurface, prepareSurfaceSteps, createSurfaceTask, attachSurface} = require('./surface_preparation')
const {measurementRoot, rememberDomain} = require('./measurement_domains')
const {facingContext, blockFacing, backFacing} = require('./surface_facing')
// Camera-independent surface derivatives and UV partitions.
const { textureCellTransform, parentTextureTile } = require('../imagery/terra_texture_tiles')
const { CooperativeTask } = require('../runtime/cooperative_task')
const EDGES = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]]
function corners(lo, hi) {
  return Array.from({length:8},(_,i)=>[i&1?hi[0]:lo[0],i&2?hi[1]:lo[1],i&4?hi[2]:lo[2]])
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
  const m=frame.projectionView,planes=[]
  for(let axis=0;axis<3;++axis) for(const sign of [-1,1]) {
    planes.push([0,1,2,3].map(i=>m[12+i]+sign*m[axis*4+i]))
  }
  return {matrix:m,world,planes,facing:facingContext(m),
    sx:Math.max(1,viewport.width||1)/dpr/2,sy:Math.max(1,viewport.height||1)/dpr/2}
}

// Live-camera visibility needs no triangle walk or SSE solve. Each immutable
// UV block contains all of its triangles, so a separating frustum plane can
// safely reject it. Intersections remain unknown; they never accept a texel
// error or authorize coarsening. Tolerance retains near-plane boundary cases.
function previewSurface(surface,origin,context) {
  const unknown={pixelsPerUv:Infinity,visible:true,centerDistance:0}
  if(!surface || !surface.blocks || !surface.blocks.length || !context || !context.planes) return unknown
  if(surface.blocks.reduce((n,b)=>n+(b.faces ? b.faces.length*3 : 0),0)!==surface.faces.length) return unknown
  origin=origin || [0,0,0]
  const regions=[]
  for(const block of surface.blocks) {
    if(blockFacing(block,origin,context)>0) continue
    const outside=outsideFrustumBox(block.minimum,block.maximum,origin,context.planes)
    if(!outside) regions.push({uv:block.uv,pixelsPerUv:Infinity})
  }
  return {pixelsPerUv:regions.length?Infinity:0,visible:regions.length>0,centerDistance:0,regions}
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
function intersectsCell(hull, minimumU, minimumV, maximumU, maximumV) {
  if (!hull || hull.length < 3) return true
  let loU = Infinity, loV = Infinity, hiU = -Infinity, hiV = -Infinity
  for (let i = 0; i < hull.length; ++i) {
    const a = hull[i], b = hull[(i + 1) % hull.length]
    loU = Math.min(loU, a[0]); hiU = Math.max(hiU, a[0])
    loV = Math.min(loV, a[1]); hiV = Math.max(hiV, a[1])
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const u = dy > 0 ? minimumU : maximumU
    const v = dx > 0 ? maximumV : minimumV
    if (dx * (v - a[1]) - dy * (u - a[0]) <= 0) return false
  }
  // SAT also needs the rectangle's edge normals. Without these axes, a large
  // cell beside a triangular hull can pass every hull edge and draw the whole
  // mesh despite having no UV overlap. Boundary-only contact has no area.
  return hiU > minimumU && loU < maximumU && hiV > minimumV && loV < maximumV
}

const measurementTrees = new WeakMap()
function* faceTree(surface, faces, first = 0, count = faces.length) {
  const node = {minimum: [Infinity,Infinity,Infinity], maximum: [-Infinity,-Infinity,-Infinity]}
  if (count <= 64) {
    // Each vertex is visited once. Parent bounds are unions of completed
    // children, instead of rescanning all faces at every tree depth.
    const positions = surface.positions, indices = surface.faces
    for (let i = first; i < first + count; ++i) {
      const f = faces[i]
      for (let j = 0; j < 3; ++j) for (let axis = 0; axis < 3; ++axis) {
        const value = positions[indices[f + j] * 3 + axis]
        node.minimum[axis] = Math.min(node.minimum[axis], value)
        node.maximum[axis] = Math.max(node.maximum[axis], value)
      }
    }
    node.faces = faces.slice(first, first + count)
    yield
  } else {
    const middle = Math.floor(count / 2)
    node.children = [yield* faceTree(surface, faces, first, middle),
      yield* faceTree(surface, faces, first + middle, count - middle)]
    for (const child of node.children) for (let axis = 0; axis < 3; ++axis) {
      node.minimum[axis] = Math.min(node.minimum[axis], child.minimum[axis])
      node.maximum[axis] = Math.max(node.maximum[axis], child.maximum[axis])
    }
  }
  return node
}
function* visibleFaces(surface, block, origin, context) {
  if (!measurementTrees.has(block)) {
    const tree = yield* faceTree(surface, block.faces)
    measurementTrees.set(block, tree)
  }
  const pending = [measurementTrees.get(block)]
  while (pending.length) {
    const node = pending.pop()
    if (outsideFrustumBox(node.minimum, node.maximum, origin, context.planes)) continue
    if (node.children) pending.push(...node.children)
    else yield* node.faces
  }
}

function* surfaceMeasurements(surface,origin,context,boundsOnly=false,tight=false) {
  const m=context.matrix,rx=Array.from(m.slice(0,3)),ry=Array.from(m.slice(4,7)),rw=Array.from(m.slice(12,15))
  const faces=surface.faces
  if(surface.faces.length && !surface.blocks.length) {
    return {pixelsPerUv:Infinity,visible:true,centerDistance:0}
  }
  let pixelsPerUv=0,visible=false,centerDistance=Infinity,refinable=false
  const inputRegions=[]
  const density={uv:{},pixelsPerUv:0,centerDistance:Infinity}
  const addRegion=region=>inputRegions.push(region)
  const uv={minimumU:Infinity,minimumV:Infinity,maximumU:-Infinity,maximumV:-Infinity}
  const pending = surface.blocks.map(block => ({block, root:measurementRoot(block), path:[]})).reverse()
  while (pending.length) {
    const {block, root, path} = pending.pop(), depth = path.length
    const addBlockRegion = region => addRegion(rememberDomain(region, root, path))
    const facing=blockFacing(block,origin,context)
    if(facing>0) continue
    const points=visibleBox(block,origin,context)
    if(!points.length) continue
    // A box may intersect the near plane through empty space. Only a fully
    // visible, shallow box can safely provide an economical whole-block bound.
    const complete=corners(block.minimum,block.maximum).every(p=>{
      const q=transform(m,p.map((v,i)=>v+origin[i]))
      return PLANES.every(plane=>plane(q)>=0)
    })
    const minDepth=Math.min(...points.map(p=>p[3]))
    const maxDepth=Math.max(...points.map(p=>p[3]))
    const shallow=complete && minDepth>0 && maxDepth<=minDepth*1.2
    // Refine only difficult measurement domains. Whole shallow descendants
    // retain the existing conservative/precise bound; clipped leaves still use
    // exact triangles. Two levels and a 64-face threshold bound task metadata.
    if (!boundsOnly && !shallow && depth < 2 && block.faces && block.faces.length > 64) {
      const children = yield* splitSurfaceBlock(surface, block)
      if (children) {
        for (let i=children.length-1; i>=0; --i) pending.push({block:children[i], root, path:path.concat(i)})
        yield
        continue
      }
    }
    if (!boundsOnly && block.faces && (!shallow || tight)) {
      let index=0,blockError=0,positionValues,textureValues
      for (const f of shallow ? block.faces : visibleFaces(surface,block,origin,context)) {
        if (f === undefined) { yield; continue }
        // Native memory can grow in a terrain/control turn after a yield.
        // Acquire once per synchronous batch, never once per triangle; the
        // borrowed getters validate ownership and refresh the Wasm memory view.
        if(index%64===0) {
          positionValues=surface.positions;textureValues=surface.uv
        }
        const clip=projectTriangle(positionValues,textureValues,faces,f,origin,m)
        let polygon=facing===0 && backFacing(clip) ? [] : clip
        if(!shallow && polygon.length) polygon=clipTriangle(polygon)
        if(polygon.length>=3) {
          if(triangleDensity(positionValues,faces,f,clip,polygon,context,density)) {
            const region=density
            centerDistance=Math.min(centerDistance,density.centerDistance)
            if(region.uv.maximumU>region.uv.minimumU && region.uv.maximumV>region.uv.minimumV) {
              visible=true
              if(shallow) blockError=Math.max(blockError,region.pixelsPerUv)
              else {
                const tex=clip.map(p=>[p[4],p[5]])
                const u1=tex[1][0]-tex[0][0],v1=tex[1][1]-tex[0][1]
                const u2=tex[2][0]-tex[0][0],v2=tex[2][1]-tex[0][1],det=u1*v2-u2*v1
                const projection=[]
                ;[[0,context.sx],[1,context.sy],[3,1]].forEach(([axis,scale])=>{
                  const a=clip[0][axis]*scale,b=clip[1][axis]*scale,c=clip[2][axis]*scale
                  const du=((b-a)*v2-(c-a)*v1)/det,dv=((c-a)*u1-(b-a)*u2)/det
                  projection.push(a-du*tex[0][0]-dv*tex[0][1],du,dv)
                })
                for(let j=1;j+1<polygon.length;++j) {
                  const triangle=[polygon[0],polygon[j],polygon[j+1]].map(p=>p.slice(4,6))
                  addRegion({uv:{minimumU:Math.min(...triangle.map(p=>p[0])),maximumU:Math.max(...triangle.map(p=>p[0])),
                    minimumV:Math.min(...triangle.map(p=>p[1])),maximumV:Math.max(...triangle.map(p=>p[1]))},
                    pixelsPerUv:region.pixelsPerUv,projection,triangle})
                }
              }
              pixelsPerUv=Math.max(pixelsPerUv,region.pixelsPerUv)
              Object.keys(uv).forEach(key=>{uv[key]=key.startsWith('minimum')
                ?Math.min(uv[key],region.uv[key]):Math.max(uv[key],region.uv[key])})
            }
          }
        }
        if(++index%64===0) yield
      }
      // Keep the shallow block's conservative UV envelope even when facing is
      // mixed. Only surviving faces contribute density. Exporting every front
      // triangle here explodes active planning memory in folded terrain.
      // Partially clipped/deep blocks still retain local projective data.
      if(shallow && blockError>0) addBlockRegion({uv:block.uv,pixelsPerUv:blockError})
      yield
      continue
    }
    refinable=refinable || !tight && Boolean(block.faces && block.faces.length)
    visible=true
    Object.keys(uv).forEach(key=>{
      uv[key]=key.startsWith('minimum')?Math.min(uv[key],block.uv[key]):Math.max(uv[key],block.uv[key])
    })
    const region={uv:block.uv,pixelsPerUv:0}
    const minW=Math.min(...points.map(p=>p[3]))
    if(!(minW>1e-9)) {pixelsPerUv=region.pixelsPerUv=Infinity;addBlockRegion(region);continue}
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
    addBlockRegion(region)
    yield
  }
  const regions=boundsOnly?inputRegions:yield* compactRegions(inputRegions,context.compactionWorkspace)
  return {pixelsPerUv,visible,uv,centerDistance,regions,refinable}
}

function measurementRefinements(plan,measure,pressure=false) {
  if(plan.quality.planningComplete===false || !pressure && plan.quality.meetsTarget!==false) return []
  const possible=plan.draws.filter(draw=>(measure(draw)||{}).refinable)
  // A passing conservative cut can still crowd terrain out of the shared
  // working set. Verify its cost before reducing either quality target.
  if(pressure) return possible
  const urgent=possible.filter(draw=>draw.imageryPixelError>plan.quality.targetPixelError)
  // A bound that already passes can still occupy another region's quota.
  return urgent.length?urgent:possible
}
function regionError(region,cell) {
  const c=region.projection
  if(!c) return region.pixelsPerUv
  if(region.numeratorBound>=0) {
    const u0=Math.max(cell.minimumU,region.uv.minimumU),u1=Math.min(cell.maximumU,region.uv.maximumU)
    const v0=Math.max(cell.minimumV,region.uv.minimumV),v1=Math.min(cell.maximumV,region.uv.maximumV)
    if(u0>=u1 || v0>=v1) return 0
    const w=c[6]+Math.min(c[7]*u0,c[7]*u1)+Math.min(c[8]*v0,c[8]*v1)
    return Math.min(region.pixelsPerUv,w>0?region.numeratorBound/(w*w):Infinity)
  }
  let polygon=region.triangle
  const bounds=[cell.minimumU,cell.maximumU,cell.minimumV,cell.maximumV]
  for(let edge=0;edge<4 && polygon.length;++edge) {
    const axis=Math.floor(edge/2),sign=edge%2?-1:1,bound=bounds[edge],out=[]
    for(let i=0;i<polygon.length;++i) {
      const a=polygon[i],b=polygon[(i+1)%polygon.length],da=sign*(a[axis]-bound),db=sign*(b[axis]-bound)
      if(da>=0) out.push(a)
      if((da<0)!==(db<0)) {const t=da/(da-db);out.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])])}
    }
    polygon=out
  }
  let minimumW=Infinity,maximum=0
  const samples=[]
  for(const [u,v] of polygon) {
    const x=c[0]+c[1]*u+c[2]*v,y=c[3]+c[4]*u+c[5]*v,w=c[6]+c[7]*u+c[8]*v
    minimumW=Math.min(minimumW,w)
    const numerator=spectral([c[1]*w-x*c[7],c[2]*w-x*c[8],0],
      [c[4]*w-y*c[7],c[5]*w-y*c[8],0])
    samples.push([w,numerator])
    if(w>0) maximum=Math.max(maximum,numerator/(w*w))
  }
  let area=0
  for(let i=1;i+1<polygon.length;i++) {
    const a=polygon[0],b=polygon[i],c=polygon[i+1]
    area+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))
  }
  if(!area) return 0
  if(!(minimumW>0)) return Infinity
  // N(u,v) is affine and its spectral norm is convex. At a given W, the
  // largest convex combination of vertex norms uses at most two vertices.
  // Maximise (a*W+b)/W^2 on every such segment, including interior extrema.
  // This preserves the correlation of numerator and depth without sampling
  // away a peak or combining a far numerator with an unrelated near depth.
  for(let i=0;i<samples.length;i++) for(let j=i+1;j<samples.length;j++) {
    const [w,n]=samples[i],[otherW,otherN]=samples[j]
    const dw=otherW-w,dn=otherN-n
    if(dw===0 || dn/dw<=0) continue
    const critical=2*(w-n*dw/dn)
    if(critical>Math.min(w,otherW) && critical<Math.max(w,otherW)) {
      const t=(critical-w)/dw
      maximum=Math.max(maximum,(n+t*dn)/(critical*critical))
    }
  }
  return maximum
}

function measureSurface(surface,origin,context,tight=false) {
  const work=surfaceMeasurements(surface,origin,context,false,tight)
  let result
  do { result=work.next() } while(!result.done)
  return result.value
}
function drain(work) {
  let result
  do { result = work.next() } while (!result.done)
  return result.value
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
const partitionCaches = new WeakMap(), partitionTemplates = new Map(), partitionLru = new Map()
let partitionCacheBytes = 0, partitionCacheHits = 0
const PARTITION_CACHE_LIMIT = 2 * 1024 * 1024
const indexedPartitionFaces = new WeakMap()
function* partitionFaces(surface, bounds) {
  if (surface.uvBlocks) {
    const blocks = surface.uvBlocks
    for (let i = 0; i < blocks.length; i += 4) {
      if (blocks[i+2] <= bounds.minimumU || blocks[i] >= bounds.maximumU ||
          blocks[i+3] <= bounds.minimumV || blocks[i+1] >= bounds.maximumV) continue
      const first = i / 4 * 192, end = Math.min(first + 192, surface.faces.length)
      for (let f = first; f < end; f += 3) yield f
    }
    return
  }
  if (!indexedPartitionFaces.has(surface)) indexedPartitionFaces.set(surface,
    !!surface.blocks && surface.blocks.every(b => b.faces) &&
    surface.blocks.reduce((count, b) => count + b.faces.length, 0) * 3 === surface.faces.length)
  if (!indexedPartitionFaces.get(surface)) {
    for (let f = 0; f < surface.faces.length; f += 3) yield f
    return
  }
  const faces = []
  for (const block of surface.blocks) {
    const uv = block.uv
    if (uv.maximumU > bounds.minimumU && uv.minimumU < bounds.maximumU &&
        uv.maximumV > bounds.minimumV && uv.minimumV < bounds.maximumV) faces.push(...block.faces)
  }
  faces.sort((a, b) => a - b)
  yield* faces
}
function partitionEntry(surface, cell) {
  let cache = partitionCaches.get(surface)
  if (!cache || !cache.active) {
    let hash = 2166136261
    for (const value of surface.uv) hash = Math.imul(hash ^ (value * 16777216), 16777619)
    for (const value of surface.faces) hash = Math.imul(hash ^ value, 16777619)
    const key = [surface.uv.length, surface.faces.length, hash].join('/')
    let templates = partitionTemplates.get(key)
    if (!templates) { templates = []; partitionTemplates.set(key, templates) }
    const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
    cache = templates.find(c => equal(c.template.uv, surface.uv) && equal(c.template.faces, surface.faces))
    if (!cache) {
      cache = new Map(); cache.active = true
      cache.template = { cache, key, uv: surface.uv.slice(), faces: surface.faces,
        bytes: 128 + key.length * 2 + surface.uv.byteLength + (surface.faces.byteLength || surface.faces.length * 8) }
      templates.push(cache); partitionCacheBytes += cache.template.bytes
    }
    partitionCaches.set(surface, cache)
  }
  partitionLru.delete(cache.template); partitionLru.set(cache.template, true)
  const b = cell.bounds, key = [!!cell.sourceUv, b.minimumU, b.maximumU, b.minimumV, b.maximumV].join('/')
  let entry = cache.get(key)
  if (!entry) {
    entry = { owner: cache, key, bytes: 96 + key.length * 2 }
    cache.set(key, entry); partitionCacheBytes += entry.bytes
  }
  partitionLru.delete(entry); partitionLru.set(entry, true)
  return entry
}
function trimPartitions() {
  while (partitionCacheBytes > PARTITION_CACHE_LIMIT && partitionLru.size) {
    const entry = partitionLru.keys().next().value
    partitionLru.delete(entry); partitionCacheBytes -= entry.bytes
    if (entry.cache) {
      const cache = entry.cache, templates = partitionTemplates.get(entry.key)
      cache.active = false
      templates.splice(templates.indexOf(cache), 1)
      if (!templates.length) partitionTemplates.delete(entry.key)
      cache.forEach(value => { partitionLru.delete(value); partitionCacheBytes -= value.bytes })
      cache.clear()
    } else entry.owner.delete(entry.key)
  }
}
// Both pricing and production consume the same UV selection. Source-UV draws
// keep original vertices, including boundary contact and interpolation roundoff.
// Low-precision fragment platforms still receive geometrically clipped pieces.
function* partitionPieces(surface, cell) {
  const faces = surface.faces, b = cell.bounds
  const margin = cell.sourceUv ? 2 ** -20 : 0
  const bounds = {minimumU:b.minimumU-margin, maximumU:b.maximumU+margin,
    minimumV:b.minimumV-margin, maximumV:b.maximumV+margin}
  let processed = 0
  for (const f of partitionFaces(surface, bounds)) {
    const uv = surface.uv
    const ids = [faces[f], faces[f+1], faces[f+2]]
    let minU=Infinity,minV=Infinity,maxU=-Infinity,maxV=-Infinity
    for (const id of ids) {
      const u=uv[id*2],v=uv[id*2+1]
      minU=Math.min(minU,u);maxU=Math.max(maxU,u);minV=Math.min(minV,v);maxV=Math.max(maxV,v)
    }
    if (maxU>bounds.minimumU && minU<bounds.maximumU && maxV>bounds.minimumV && minV<bounds.maximumV) {
      if (cell.sourceUv || minU>=b.minimumU && maxU<=b.maximumU && minV>=b.minimumV && maxV<=b.maximumV) yield {ids}
      else {
        const polygon=ids.map((id,j)=>[uv[id*2],uv[id*2+1],+(j===0),+(j===1),+(j===2)])
        let clipped=clipPolygon(polygon,0,b.minimumU,true)
        clipped=clipPolygon(clipped,0,b.maximumU,false)
        clipped=clipPolygon(clipped,1,b.minimumV,true)
        clipped=clipPolygon(clipped,1,b.maximumV,false)
        for (let i=2;i<clipped.length;++i) {
          const p=clipped[0],q=clipped[i-1],r=clipped[i]
          if (Math.abs((q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]))>=1e-16) yield {ids,points:[p,q,r]}
        }
      }
    }
    if (++processed % 64 === 0) yield null
  }
}
function* partitionTopology(surface, cell, entry) {
  if (entry.topology) { ++partitionCacheHits; return entry.topology }
  const indices = [], texture = [], anchors = [], weights = []
  for (const piece of partitionPieces(surface, cell)) {
    if (!piece) { yield; continue }
    if (!piece.points) indices.push(...piece.ids)
    else for (const p of piece.points) {
      texture.push(p[0],p[1]); anchors.push(...piece.ids); weights.push(p[2],p[3],p[4])
    }
  }
  const topology = { indices: new Uint16Array(indices), uv: new Float32Array(texture),
    anchors: new Uint16Array(anchors), weights: new Float64Array(weights) }
  entry.topology = topology
  const bytes = topology.indices.byteLength + topology.uv.byteLength + topology.anchors.byteLength + topology.weights.byteLength
  if (partitionLru.has(entry)) { entry.bytes += bytes; partitionCacheBytes += bytes }
  entry.cost = topology.indices.byteLength + topology.uv.length * 10
  trimPartitions()
  return topology
}
function* partitionSteps(surface, cells, maximumBytes = Infinity) {
  // The caller grants transfer/output capacity before this producer runs.
  // Price every cell before allocating output or clipped-topology arrays.
  const requiredBytes = yield* partitionCost(surface, cells)
  if (requiredBytes > maximumBytes) return {limited: true, requiredBytes}
  const output = []
  for (const cell of cells) {
    const entry = partitionEntry(surface, cell), topology = yield* partitionTopology(surface, cell, entry)
    const positions = new Float32Array(topology.uv.length / 2 * 3)
    for (let v = 0; v < topology.uv.length / 2; ++v) {
      for (let axis = 0; axis < 3; ++axis) {
        let value = 0
        for (let j = 0; j < 3; ++j) value += topology.weights[v * 3 + j] * surface.positions[topology.anchors[v * 3 + j] * 3 + axis]
        positions[v * 3 + axis] = value
      }
      if (v % 192 === 191) yield
    }
    if (positions.length || topology.indices.length) output.push({ cell, positions,
      uv: topology.uv.slice(), indices: topology.indices.slice() })
  }
  return output
}
function createPartitionTask(surface, cells, maximumBytes) { return new CooperativeTask(partitionSteps(surface, cells, maximumBytes)) }
// Count the same clipped topology without allocating position/UV buffers.
// This cost belongs to the whole imagery cut, before requests or GPU staging.
function* partitionCost(surface, cells, cache = true) {
  let bytes = 0
  for (const cell of cells) {
    const entry = cache ? partitionEntry(surface, cell) : {}
    if (entry.cost !== undefined) { bytes += entry.cost; ++partitionCacheHits; continue }
    let cost = 0
    for (const piece of partitionPieces(surface, cell)) {
      if (!piece) yield
      else cost += piece.points ? 60 : 6
    }
    entry.cost=cost; bytes+=cost; if (cache) trimPartitions()
  }
  return bytes
}
function* partitionPlanSteps(surface, cells, cache = true) {
  const plan = []
  for (const cell of cells) {
    plan.push({key: cell.key, bytes: yield* partitionCost(surface, [cell], cache)})
    yield
  }
  return plan
}
// Cost steps yield per small face block or cached cell. Use the same operation
// ceiling as prepared UV sampling while retaining CooperativeTask's 4ms limit;
// eight such steps otherwise pay repeated timer/RPC turns for very little work.
function createPartitionPlanTask(surface, cells) { return new CooperativeTask(partitionPlanSteps(surface, cells), 64) }
// Prepared UV scratch belongs to the caller. Never retain it in the topology
// cache beyond this task, including cancellation. No positions are required.
function* uvPartitionSteps(uv, faces, cells) {
  // CBDAM strips have local face order. Fixed blocks reject unrelated cells
  // without a persistent cache or one full triangle scan per imagery tile.
  const blocks = new Float64Array(Math.ceil(faces.length / 192) * 4)
  for (let first = 0; first < faces.length; first += 192) {
    let loU = Infinity, loV = Infinity, hiU = -Infinity, hiV = -Infinity
    for (let f = first; f < Math.min(first + 192, faces.length); ++f) {
      const index = faces[f] * 2, u = uv[index], v = uv[index + 1]
      loU = Math.min(loU, u); hiU = Math.max(hiU, u)
      loV = Math.min(loV, v); hiV = Math.max(hiV, v)
    }
    blocks.set([loU, loV, hiU, hiV], first / 192 * 4)
    yield
  }
  return yield* partitionPlanSteps({uv, faces, uvBlocks: blocks}, cells, false)
}
function createUvPartitionPlanTask(uv, faces, cells) {
  return new CooperativeTask(uvPartitionSteps(uv, faces, cells))
}
function* fitPartitionSteps(initial, options, modelFor) {
  if (!(options.maximumPartitionBytes > 0)) return initial
  const requested = options.targetPixelError || 1.25
  // Keep scalar estimates for this fit even when the shared topology cache
  // evicts a model. Coarsening one sibling group must not rescan every other
  // triangle in a large cut. No topology or GPU buffers are retained here.
  const estimates = new WeakMap()
  const cost = function* (plan) {
    const groups = new Map()
    plan.draws.forEach(draw => {
      const source = draw.sourceTexture || draw.texture
      if (draw.texture.level <= source.level) return
      const id = draw.resourceId || draw.geometryKey
      if (!groups.has(id)) groups.set(id, { model: modelFor(draw), cells: new Map() })
      const t = textureCellTransform(source, draw.texture)
      const key = `${draw.texture.level}/${draw.texture.matrix}/${draw.texture.row}/${draw.texture.column}`
      groups.get(id).cells.set(key, { sourceUv: t.scale <= options.sourceUvScale, bounds: {
        minimumU: -t.offsetX / t.scale, maximumU: (1 - t.offsetX) / t.scale,
        minimumV: -t.offsetY / t.scale, maximumV: (1 - t.offsetY) / t.scale } })
    })
    let bytes = 0
    for (const group of groups.values()) {
      if (!estimates.has(group.model)) estimates.set(group.model, new Map())
      const known = estimates.get(group.model)
      for (const cell of group.cells.values()) {
        const b = cell.bounds
        const key = [b.minimumU, b.maximumU, b.minimumV, b.maximumV].join('/')
        if (!known.has(key)) known.set(key, yield* partitionCost(group.model, [cell]))
        bytes += known.get(key)
      }
    }
    return bytes
  }
  const result = Object.assign({}, initial, { draws: initial.draws.slice(), quality: Object.assign({}, initial.quality) })
  let bytes = yield* cost(result), limited = false
  // Capacity admission is local to a sibling group. Never replace the original
  // SSE demand with a whole-view target or clear the native refinement history.
  while (bytes > options.maximumPartitionBytes) {
    const parents = new Map()
    result.draws.forEach(draw => {
      const parent = parentTextureTile(draw.texture)
      if (!parent) return
      const key = `${parent.level}/${parent.matrix}/${parent.row}/${parent.column}`
      if (!parents.has(key)) parents.set(key, { tile: parent, error: 0, items: [] })
      const group = parents.get(key)
      group.error = Math.max(group.error, draw.imageryPixelError * 2)
      group.items.push(draw)
    })
    const groups = Array.from(parents.values()).sort((a,b)=>a.error-b.error ||
      a.tile.level-b.tile.level || a.tile.row-b.tile.row || a.tile.column-b.tile.column)
    let admitted = false
    for (const group of groups) {
      // A parent can replace only a complete visible sibling cut, including
      // descendants already split more deeply in another part of that region.
      const inside = tile => tile.matrix-tile.level === group.tile.matrix-group.tile.level &&
        tile.level >= group.tile.level &&
        Math.floor(tile.row / Math.pow(2,tile.level-group.tile.level)) === group.tile.row &&
        Math.floor(tile.column / Math.pow(2,tile.level-group.tile.level)) === group.tile.column
      if (result.draws.some(draw=>inside(draw.texture) && draw.texture.level>group.tile.level+1)) continue
      const merged = new Map()
      group.items.forEach(draw=>{
        const id = draw.resourceId || draw.geometryKey || draw.key && JSON.stringify(draw.key)
        const source = draw.sourceTexture || draw.texture, t=textureCellTransform(source,group.tile)
        if (!merged.has(id)) merged.set(id,Object.assign({},draw,{
          texture:group.tile,sourceTexture:source,imageryCellScale:t.scale,
          imageryCellOffsetX:t.offsetX,imageryCellOffsetY:t.offsetY,
          imageryClipCell:group.tile.level>source.level,imageryPixelError:group.error,
          imageryPriority:group.error,imageryDesiredLevel:group.tile.level,imageryCapacityCoarsened:true }))
      })
      const old=result.draws
      const items=new Set(group.items)
      result.draws=old.filter(draw=>!items.has(draw)).concat(Array.from(merged.values()))
      const next=yield* cost(result)
      if(next<=bytes) { bytes=next;admitted=true;limited=true;break }
      result.draws=old
    }
    if(!admitted) throw new Error('Imagery base partition exceeds capacity')
  }
  const keys=new Set(result.draws.map(draw=>`${draw.texture.level}/${draw.texture.matrix}/${draw.texture.row}/${draw.texture.column}`))
  const levels=result.draws.map(draw=>draw.texture.level)
  const error=result.draws.reduce((maximum,draw)=>Math.max(maximum,draw.imageryPixelError),0)
  Object.assign(result.quality,{
    targetPixelError:requested,feasiblePixelError:Math.max(requested,error),measuredMaxPixelError:error,
    limitedByPartitionBudget:limited || initial.quality.limitedByPartitionBudget,limitedByBudget:result.quality.limitedByBudget||limited,
    partitionBytes:bytes,selectedTextureCount:keys.size,desiredTextureCount:keys.size,
    renderedDrawCount:result.draws.length,desiredDrawCount:result.draws.length,
    selectedLevelMinimum:levels.length?Math.min(...levels):null,
    selectedLevelMaximum:levels.length?Math.max(...levels):null,meetsTarget:error<=requested*1.001 })

  return result
}
function fitImageryPartitionBudget(initial, options, modelFor) { return drain(fitPartitionSteps(initial, options, modelFor)) }
function partitionCacheStats() { return { bytes: partitionCacheBytes, hits: partitionCacheHits, entries: partitionLru.size } }
module.exports = { triangles, regionError, prepareSurface, prepareSurfaceSteps, createSurfaceTask, attachSurface, previewSurface, measureSurface, surfaceMeasurements, measurementRefinements, projectionContext, createPartitionPlanTask, createUvPartitionPlanTask, createPartitionTask, partitionCacheStats, fitImageryPartitionBudget, fitPartitionSteps, intersectsCell }
