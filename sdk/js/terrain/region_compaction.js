const {spectral2} = require('../math/projection')
const {TASK_WAIT} = require('../runtime/cooperative_task')
const {invariant} = require('../core/terra_globe_common')

const QUANTUM = 64
const same = (a, b) => a === b || a !== a && b !== b
const step = work => ++work.count % QUANTUM === 0

function layout(count, buffer) {
  let slots = 4, offset = 0
  while (slots < count * 2) slots *= 2
  const array = (Type, length) => {
    offset = Math.ceil(offset / Type.BYTES_PER_ELEMENT) * Type.BYTES_PER_ELEMENT
    const first = offset
    offset += length * Type.BYTES_PER_ELEMENT
    return buffer ? new Type(buffer, first, length) : null
  }
  const value = {table:array(Uint32Array, slots), generation:array(Uint32Array, slots),
    source:array(Uint32Array, count),
    order:array(Uint32Array, count), temporary:array(Uint32Array, count * 3),
    moments:array(Float64Array, count * 5), points:array(Uint32Array, count * 3),
    hull:array(Uint32Array, count * 6 + 2),
    pending:array(Uint32Array, (Math.ceil(Math.log2(Math.max(1, count))) + 2) * 2),
    number:array(Float64Array, 1)}
  invariant(Number.isSafeInteger(offset) && offset < 0xffffffff && count * 3 < 0xffffffff,
    'Projection compaction workspace exceeds its shape limit')
  value.bytes = offset; value.mask = slots - 1
  if (buffer) value.words = new Uint32Array(buffer, value.number.byteOffset, 2)
  return value
}

function regionCompactionBytes(count) {
  invariant(Number.isSafeInteger(count) && count >= 0, 'Invalid compaction region count')
  return count ? layout(count).bytes : 0
}

// Bottom-up stable merges use one explicitly priced scratch range. Both the
// merge and final copy have cursors; ties retain the scalar sort's input order.
function* sortSteps(values, first, count, temporary, compare, work) {
  let source=values,sourceFirst=first,destination=temporary,destinationFirst=0
  for(let width=1;width<count;width*=2) {
    for(let left=0;left<count;left+=width*2) {
      const middle=Math.min(count,left+width),end=Math.min(count,left+width*2)
      let a=left,b=middle
      for(let out=left;out<end;++out) {
        destination[destinationFirst+out]=b===end || a<middle &&
          !(compare(source[sourceFirst+a],source[sourceFirst+b])>0)
          ? source[sourceFirst+a++] : source[sourceFirst+b++]
        if(step(work))yield
      }
    }
    const previous=source,previousFirst=sourceFirst
    source=destination;sourceFirst=destinationFirst
    destination=previous;destinationFirst=previousFirst
  }
  if(source!==values)for(let i=0;i<count;++i) {
    values[first+i]=source[sourceFirst+i]
    if(step(work))yield
  }
}

function mix(value) {
  value=Math.imul(value^(value>>>16),0x7feb352d)
  value=Math.imul(value^(value>>>15),0x846ca68b)
  return (value^(value>>>16))>>>0
}

function numberHash(value, state) {
  // Number.toString, used by the former key, identifies both signed zeros and
  // every NaN payload. Preserve those identities without formatting doubles.
  if (value !== value) return 0x7fc00000
  state.number[0] = value === 0 ? 0 : value
  // Regular CBDAM UVs are dyadic. Their low words and low exponent bits are
  // often zero, so mix high bits before choosing a power-of-two table bucket.
  return mix(state.words[0]^Math.imul(state.words[1],0x9e3779b1))
}

function signature(region, state) {
  let hash = 2166136261, sum = 0, xor = 0
  for (let i = 0; i < 9; ++i) hash = Math.imul(hash ^ numberHash(region.projection[i], state), 16777619)
  for (const point of region.triangle) {
    const token = Math.imul(numberHash(point[0], state) ^ 0x9e3779b9, 16777619) ^ numberHash(point[1], state)
    sum = sum + token | 0; xor ^= token
  }
  return mix(Math.imul(hash ^ sum, 16777619) ^ xor)
}

function equalRegion(a, b) {
  for (let i = 0; i < 9; ++i) if (!same(a.projection[i], b.projection[i])) return false
  let matched = 0
  for (const point of a.triangle) {
    let found = false
    for (let i = 0; i < 3; ++i) if (!(matched & 1 << i) &&
        same(point[0], b.triangle[i][0]) && same(point[1], b.triangle[i][1])) {
      matched |= 1 << i; found = true; break
    }
    if (!found) return false
  }
  return true
}

function* mayCoverHull(first, end, order, regionAt, covered, work) {
  let loSum=Infinity,hiSum=-Infinity,loDifference=Infinity,hiDifference=-Infinity,magnitude=0
  let a,b,c,d
  for(let i=first;i<end;++i)for(const point of regionAt(order[i]).triangle) {
    const sum=point[0]+point[1],difference=point[0]-point[1]
    if(sum<loSum){loSum=sum;a=point}
    if(sum>hiSum){hiSum=sum;b=point}
    if(difference<loDifference){loDifference=difference;c=point}
    if(difference>hiDifference){hiDifference=difference;d=point}
    magnitude=Math.max(magnitude,Math.abs(point[0]),Math.abs(point[1]))
    if(step(work))yield
  }
  if(!a||!b||!c||!d)return true
  const area=(p,q,r)=>Math.abs((q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]))/2
  const x=area(a,b,c),y=area(a,b,d),z=area(a,c,d)
  // One of the three two-triangle decompositions is inside the four-point
  // hull. Their minimum is therefore a lower bound on the complete hull area.
  // Include both witness and full shoelace accumulation rounding; uncertain
  // cases keep the original hull test, including large/nonfinite coordinates.
  const lower=Math.min(x+y,x+z,y+z)
  const count=end-first
  const rounding=256*Number.EPSILON*Math.max(1,magnitude*magnitude)*count*count
  return !(lower>covered+Math.max(1e-14,covered*1e-8)+rounding)
}

// Same conservative density/area merge as the scalar reference. The numeric
// workspace has a known shape before allocation, every scan/sort/hull retains
// a cursor, and no group-sized JS maps, point arrays or recursive slices exist.
function* compactRegionSteps(input, workspace) {
  const result = [], work = {count:0}
  let count = 0
  for (const region of input) {
    if (region.projection) ++count
    else result.push(region)
    if (step(work)) yield
  }
  if (!count) return result
  const bytes = regionCompactionBytes(count)
  let claim
  try {
    if (workspace) while (!(claim = workspace.request(bytes))) yield TASK_WAIT
    else claim = {buffer:new ArrayBuffer(bytes), fresh:true, release() {}}
    invariant(claim.buffer instanceof ArrayBuffer && claim.buffer.byteLength >= bytes,
      'Compaction scratch is not funded')
    const state = layout(count, claim.buffer)
    const {table, generation, source, order, temporary, moments, points, hull, pending} = state
    if (!claim.fresh) for (let i = 0; i < generation.length; ++i) {
      generation[i] = 0
      if (step(work)) yield
    }
    let unique = 0
    for (let index = 0; index < input.length; ++index) {
      const region = input[index]
      if (region.projection) {
        invariant(region.projection.length === 9 && region.triangle.length === 3,
          'Invalid projective compaction region')
        let slot = signature(region, state) & state.mask
        while (generation[slot] === 1 && !equalRegion(input[source[table[slot] - 1]], region)) {
          slot = slot + 1 & state.mask
          if (step(work)) yield
        }
        if (generation[slot] !== 1) {
          generation[slot] = 1
          table[slot] = unique + 1; source[unique] = index; order[unique] = unique; ++unique
        }
      }
      if (step(work)) yield
    }
    const regionAt = index => input[source[index]]
    const pointAt = code => regionAt(Math.floor(code / 3)).triangle[code % 3]
    for (let index = 0; index < unique; ++index) {
      const region = regionAt(index), c = region.projection
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
      moments[index*5]=Math.min(region.pixelsPerUv,minW>0?maxN/(minW*minW):Infinity)
      moments[index*5+1]=maxW>0?lowerN/(maxW*maxW):0
      const p=region.triangle
      moments[index*5+2]=Math.abs((p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[1][1]-p[0][1])*(p[2][0]-p[0][0]))/2
      moments[index*5+3]=region.uv.minimumU+region.uv.maximumU
      moments[index*5+4]=region.uv.minimumV+region.uv.maximumV
      if (step(work)) yield
    }
    let stack = 0, epoch = 1
    pending[stack++] = 0; pending[stack++] = unique
    const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    while (stack) {
      const length = pending[--stack], first = pending[--stack], end = first + length
      if (!length) continue
      let upper = 0, lower = Infinity, covered = 0, merged = false
      let loU=Infinity,hiU=-Infinity,loV=Infinity,hiV=-Infinity
      for (let i=first;i<end;++i) {
        const index=order[i],uv=regionAt(index).uv
        upper=Math.max(upper,moments[index*5]);lower=Math.min(lower,moments[index*5+1])
        covered+=moments[index*5+2]
        loU=Math.min(loU,uv.minimumU);hiU=Math.max(hiU,uv.maximumU)
        loV=Math.min(loV,uv.minimumV);hiV=Math.max(hiV,uv.maximumV)
        if (step(work)) yield
      }
      if (length>2 && upper<=lower*1.25 &&
          (yield* mayCoverHull(first,end,order,regionAt,covered,work))) {
        let size = 0, raw = false
        ++epoch
        for (let i=first;i<end;++i) {
          const index=order[i]
          for(let j=0;j<3;++j) {
            const code=index*3+j,p=pointAt(code)
            if(raw) points[size++]=code
            else {
              let slot=(Math.imul(numberHash(p[0],state)^0x9e3779b9,16777619)^numberHash(p[1],state))&state.mask
              while(generation[slot]===epoch) {
                const q=pointAt(table[slot]-1)
                if(same(p[0],q[0])&&same(p[1],q[1]))break
                slot=slot+1&state.mask
                if(step(work))yield
              }
              if(generation[slot]!==epoch) {
                generation[slot]=epoch;table[slot]=code+1;points[size++]=code
                // Disconnected triangles can have three unique points each.
                // Keep the hash sparse; sort/deduplicate the remaining suffix
                // if it exceeds the reused region table's useful occupancy.
                if(size>=table.length/2)raw=true
              }
            }
            if(step(work))yield
          }
        }
        yield* sortSteps(points,0,size,temporary,(a,b)=>{
          const p=pointAt(a),q=pointAt(b)
          return p[0]-q[0] || p[1]-q[1]
        },work)
        let distinct=0
        for(let i=0;i<size;++i) {
          const p=pointAt(points[i]),previous=distinct && pointAt(points[distinct-1])
          if(!previous || !same(p[0],previous[0]) || !same(p[1],previous[1])) points[distinct++]=points[i]
          if(step(work)) yield
        }
        let hullSize=0
        for(let half=0;half<2;++half) {
          const start=hullSize
          for(let i=0;i<distinct;++i) {
            const code=points[half?distinct-1-i:i],p=pointAt(code)
            while(hullSize>=start+2 && cross(pointAt(hull[hullSize-2]),pointAt(hull[hullSize-1]),p)<=0) {
              --hullSize
              if(step(work)) yield
            }
            hull[hullSize++]=code
            if(step(work)) yield
          }
          if(hullSize>start)--hullSize
        }
        let area=0
        for(let i=0;i<hullSize;++i) {
          const a=pointAt(hull[i]),b=pointAt(hull[(i+1)%hullSize])
          area+=a[0]*b[1]-a[1]*b[0]
          if(step(work)) yield
        }
        if(hullSize>=3 && Math.abs(Math.abs(area)/2-covered)<=Math.max(1e-14,covered*1e-8)) {
          for(let i=1;i+1<hullSize;++i) {
            const a=pointAt(hull[0]),b=pointAt(hull[i]),c=pointAt(hull[i+1])
            result.push({triangle:[a,b,c],pixelsPerUv:upper,projection:[0,upper,0,0,0,upper,1,0,0],
              uv:{minimumU:Math.min(a[0],b[0],c[0]),maximumU:Math.max(a[0],b[0],c[0]),
                minimumV:Math.min(a[1],b[1],c[1]),maximumV:Math.max(a[1],b[1],c[1])}})
            if(step(work)) yield
          }
          merged=true
        }
      }
      if(!merged) {
        if(length<=4) for(let i=first;i<end;++i) {
          result.push(regionAt(order[i]))
          if(step(work)) yield
        }
        else {
          const axis=hiV-loV>hiU-loU,centre=axis?4:3
          yield* sortSteps(order,first,length,temporary,(a,b)=>moments[a*5+centre]-moments[b*5+centre],work)
          const middle=Math.floor(length/2)
          pending[stack++]=first;pending[stack++]=middle
          pending[stack++]=first+middle;pending[stack++]=length-middle
          invariant(stack<=pending.length,'Compaction frontier exceeds its depth bound')
        }
      }
      if(step(work)) yield
    }
    return result
  } finally {if(claim)claim.release()}
}

module.exports={compactRegionSteps,regionCompactionBytes}
