const assert=require('assert')
const {compactRegionSteps,regionCompactionBytes}=require('../../sdk/js/terrain/region_compaction')
const {compactRegions:reference}=require('./reference/compact_regions_reference')
const {grid}=require('./reference/compaction_fixture')
const {regionError}=require('../../sdk/js/terrain/terra_surface_plan')
const {TASK_WAIT}=require('../../sdk/js/runtime/cooperative_task')

function drain(work) {let next;do{next=work.next()}while(!next.done);return next.value}
function triangleArea(p) {return Math.abs((p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[1][1]-p[0][1])*(p[2][0]-p[0][0]))/2}
function freeze(value) {if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);Object.values(value).forEach(freeze)}return value}
function error(regions,cell) {
  return regions.reduce((maximum,r)=>r.uv.minimumU<cell.maximumU&&r.uv.maximumU>cell.minimumU&&
    r.uv.minimumV<cell.maximumV&&r.uv.maximumV>cell.minimumV?Math.max(maximum,regionError(r,cell)):maximum,0)
}

for(const mode of ['uniform','hole','varying','separated'])for(const dimension of [2,5,12])for(const duplicates of [false,true]) {
  const fixture=grid(dimension,mode,duplicates,true),input=freeze(fixture.regions)
  const expected=drain(reference(input)),actual=drain(compactRegionSteps(input))
  assert.deepStrictEqual(actual,expected,`${mode}/${dimension}/${duplicates} changed the accepted scalar cut`)
  assert(Math.abs(actual.reduce((n,r)=>n+triangleArea(r.triangle),0)-fixture.area)<1e-11,'Compaction filled a hole or lost UV area')
  for(let level=0;level<3;++level) {
    const size=2**level
    for(let y=0;y<size;++y)for(let x=0;x<size;++x) {
      const cell={minimumU:x/size,minimumV:y/size,maximumU:(x+1)/size,maximumV:(y+1)/size}
      assert(error(actual,cell)+1e-9>=error(input,cell),'Merged output understated a node-local texel error')
    }
  }
}

// Numeric signatures preserve the former string key's signed-zero identity,
// first-member density and unordered triangle identity.
const zeros=grid(4,'varying',true,true).regions
zeros[0].projection[0]=-0;zeros[0].triangle[0][0]=-0
zeros.push({...zeros[0],projection:zeros[0].projection.map(v=>v===0?0:v),triangle:zeros[0].triangle.slice().reverse(),pixelsPerUv:4096})
zeros.push({uv:{minimumU:0,minimumV:0,maximumU:1,maximumV:1},pixelsPerUv:16})
assert.deepStrictEqual(drain(compactRegionSteps(freeze(zeros))),drain(reference(zeros)))

// Extreme translations must conservatively fall back to the complete area
// test; a witness cannot turn shoelace roundoff into a different merge policy.
for(const [scale,origin] of [[1e-8,0],[1,1e9],[1e6,-1e12]]) {
  const values=grid(5,'hole',false,true).regions
  for(const region of values) {
    region.triangle=region.triangle.map(p=>p.map(v=>origin+scale*v))
    for(const key of Object.keys(region.uv))region.uv[key]=origin+scale*region.uv[key]
  }
  freeze(values)
  assert.deepStrictEqual(drain(compactRegionSteps(values)),drain(reference(values)))
}

const input=freeze(grid(32,'hole',true,true).regions)
let allocations=0,releases=0,held=0,capacity=0,required=0,buffer
const workspace={request(bytes) {
  required=bytes
  if(capacity<bytes)return null
  ++allocations;held=bytes
  const fresh=!buffer;buffer=buffer||new ArrayBuffer(bytes)
  return {buffer,fresh,release(){++releases;held=0}}
}}
let task=compactRegionSteps(input,workspace),next
do{next=task.next()}while(!next.done&&next.value!==TASK_WAIT)
assert.strictEqual(next.value,TASK_WAIT);assert.strictEqual(allocations,0)
capacity=required-1;assert.strictEqual(task.next().value,TASK_WAIT);assert.strictEqual(allocations,0)
capacity=required;assert(!task.next().done);assert.strictEqual(held,required)
task.return();task.return();assert.strictEqual(releases,1);assert.strictEqual(held,0)
assert.deepStrictEqual(drain(compactRegionSteps(input,workspace)),drain(reference(input)))
assert.strictEqual(releases,2);assert.strictEqual(held,0)
assert(regionCompactionBytes(input.length)>=required)

// Count source reads in each next(), independently of the implementation's
// operation counter. Large scalar hull/sort steps must be reproduced first.
function largestReadStep(factory,dimension=32) {
  let reads=0,maximum=0,yields=0
  const seen=new WeakMap(),wrap=value=>{
    if(!value||typeof value!=='object')return value
    if(seen.has(value))return seen.get(value)
    const proxy=new Proxy(value,{get(target,key,receiver){++reads;return wrap(Reflect.get(target,key,receiver))}})
    seen.set(value,proxy);return proxy
  }
  const work=factory(wrap(grid(dimension,'hole',false,true).regions))
  let next
  do{reads=0;next=work.next();maximum=Math.max(maximum,reads);++yields}while(!next.done)
  return {maximum,yields}
}
const before=largestReadStep(reference)
const sort=Array.prototype.sort
let after
try {
  Array.prototype.sort=function(...args){assert(this.length<=3,'Compaction used an unbounded built-in sort');return sort.apply(this,args)}
  after=largestReadStep(compactRegionSteps)
}finally{Array.prototype.sort=sort}
assert(before.maximum>16384,'The scalar unbounded step was not reproduced')
assert(after.maximum<16384,'A cooperative compaction step performed an unbounded source scan')
const smaller=largestReadStep(compactRegionSteps,16)
assert(after.yields<smaller.yields*12,'Dyadic CBDAM coordinates caused quadratic compaction work')
console.log('Projection compaction preserves scalar cuts, holes and node SSE; funded scratch, cancellation and bounded source work passed',JSON.stringify({before,after,smaller,requiredBytes:required}))
