// Independent frozen JS oracle for the persistent native compaction task.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert')
const {compactRegions}=require('./reference/compact_regions_reference')
const {grid}=require('./reference/compaction_fixture')
const drain=work=>{let r;do{r=work.next()}while(!r.done);return r.value}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
const output=process.argv[2]
assert(output,'A golden binary destination is required')
if(process.argv[3]==='--check') {
  const manifest=JSON.parse(fs.readFileSync(output.replace(/\.bin$/,'.json'),'utf8'))
  assert.strictEqual(hash(fs.readFileSync(output)),manifest.sha256,'Frozen binary changed')
  assert.strictEqual(hash(fs.readFileSync(__filename)),manifest.generatorSha256,'Golden generator changed without review')
  for(const [n,digest] of Object.entries(manifest.oracleSources))assert.strictEqual(hash(fs.readFileSync(path.resolve(__dirname,n))),digest,'Frozen oracle source changed: '+n)
  console.log('Frozen native compaction oracle integrity passed:',manifest.cases.length,'cases');process.exit(0)
}
const cases=[]
for(const mode of ['uniform','hole','varying','separated'])for(const duplicate of [false,true])
  cases.push({name:mode+(duplicate?'-duplicates':''),input:grid(16,mode,duplicate,true).regions})
for(const count of [1,2,3,4])cases.push({name:'small-'+count,input:grid(4,'varying').regions.slice(0,count)})
const scalar=()=>({uv:{minimumU:0,minimumV:0,maximumU:1,maximumV:1},pixelsPerUv:16})
cases.push({name:'empty',input:[]},{name:'scalar-only',input:[scalar(),scalar()]},
  {name:'mixed',input:[scalar(),...grid(4,'uniform',true,true).regions,scalar()]})
const slivers=[]
for(let i=0;i<12;++i) {
  const triangle=[0,0.1,0.2].map(d=>{const a=(i+d)*Math.PI/6;return [0.5+Math.cos(a)*1e-8,0.5+Math.sin(a)*1e-8]})
  slivers.push({triangle,projection:[0,128,0,0,0,128,1,0,0],pixelsPerUv:1024,
    uv:{minimumU:Math.min(...triangle.map(p=>p[0])),minimumV:Math.min(...triangle.map(p=>p[1])),maximumU:Math.max(...triangle.map(p=>p[0])),maximumV:Math.max(...triangle.map(p=>p[1]))}})
}
cases.push({name:'tiny-hull-expansion',input:slivers})
for(const [scale,origin] of [[1e-8,0],[1,1e9],[1e6,-1e12]]) {
  const input=grid(5,'hole',false,true).regions
  for(const r of input){r.triangle=r.triangle.map(p=>p.map(v=>origin+scale*v));for(const k of Object.keys(r.uv))r.uv[k]=origin+scale*r.uv[k]}
  cases.push({name:'translated-'+scale+'-'+origin,input})
}
const zeros=grid(4,'varying',true,true).regions
zeros[0].projection[0]=-0;zeros[0].triangle[0][0]=-0
zeros.push({...zeros[0],projection:zeros[0].projection.map(v=>v===0?0:v),triangle:zeros[0].triangle.slice().reverse(),pixelsPerUv:4096})
cases.push({name:'signed-zero',input:zeros})
for(const kind of ['zero-depth','crossing-depth','spectral-overflow']) {
  const input=grid(4,'varying',true,true).regions
  for(const r of input){r.pixelsPerUv=Infinity;r.projection=kind==='spectral-overflow'?[0,1e200,0,0,0,1e200,1,0,0]:[0,128,0,0,0,128,0,kind==='crossing-depth'?1:0,kind==='crossing-depth'?-1:0]}
  cases.push({name:kind,input})
}
function u32(n){const b=Buffer.alloc(4);b.writeUInt32LE(n);return b}
function row(r,domain) {
  const b=Buffer.alloc(176),uv=r.uv
  b.writeUInt32LE(Number(Boolean(r.projection))|Number(Boolean(r.triangle))<<1|Number(r.numeratorBound!==undefined)<<2,0)
  b.writeUInt32LE(domain,4)
  const values=[uv.minimumU,uv.minimumV,uv.maximumU,uv.maximumV,r.pixelsPerUv,
    ...(r.projection||new Array(9).fill(0)),...(r.triangle||[[0,0],[0,0],[0,0]]).flat(),r.numeratorBound===undefined?-1:r.numeratorBound]
  assert.strictEqual(values.length,21);values.forEach((v,i)=>b.writeDoubleLE(v,8+i*8));return b
}
const chunks=[Buffer.from('TERRARC1'),u32(cases.length)],manifest={format:'terra.region-compaction-golden.v1',cases:[]}
for(const c of cases) {
  const ids=new Map(c.input.map((r,i)=>[r,i+1000])),before=Buffer.concat(c.input.map(r=>row(r,ids.get(r))))
  const expected=drain(compactRegions(c.input))
  assert(before.equals(Buffer.concat(c.input.map(r=>row(r,ids.get(r))))),'Oracle mutated input')
  const name=Buffer.from(c.name)
  chunks.push(u32(name.length),name,u32(c.input.length),u32(expected.length),before,
    ...expected.map(r=>row(r,ids.has(r)?ids.get(r):0xffffffff)))
  manifest.cases.push({name:c.name,input:c.input.length,output:expected.length})
}
const binary=Buffer.concat(chunks);manifest.sha256=hash(binary)
manifest.generatorNode=process.version;manifest.generatorSha256=hash(fs.readFileSync(__filename))
manifest.oracleSources=Object.fromEntries(['reference/compact_regions_reference.js','reference/compaction_fixture.js','../../sdk/js/math/projection.js']
  .map(n=>[n,hash(fs.readFileSync(path.resolve(__dirname,n)))]))
fs.writeFileSync(output,binary);fs.writeFileSync(output.replace(/\.bin$/,'.json'),JSON.stringify(manifest,null,2)+'\n')
console.log('Frozen native compaction oracle:',cases.length,'cases,',binary.length,'bytes,',manifest.sha256)
