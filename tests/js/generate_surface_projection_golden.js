const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert')
const {projectTriangle,clipTriangle}=require('../../sdk/js/terrain/triangle_projection')
const {triangleDensity}=require('../../sdk/js/terrain/triangle_density')
const {backFacing}=require('../../sdk/js/terrain/surface_facing')
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),output=process.argv[2]
assert(output,'A frozen destination is required')
if(process.argv[3]==='--check') {
  const m=JSON.parse(fs.readFileSync(output.replace(/\.bin$/,'.json')))
  assert.strictEqual(hash(fs.readFileSync(output)),m.sha256)
  assert.strictEqual(hash(fs.readFileSync(__filename)),m.generatorSha256)
  for(const [name,digest] of Object.entries(m.oracleSources))assert.strictEqual(hash(fs.readFileSync(path.resolve(__dirname,name))),digest,name)
  console.log('Frozen surface projection oracle integrity passed:',m.cases.length,'cases');process.exit(0)
}
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
const positions=[-0.8,-0.6,-0.3,0.8,-0.6,0.4,0,0.8,0.8],uv=[0,0,1,0,0.3,1],cases=[]
function add(name,changes={}) {
  const c=Object.assign({name,matrix:identity,origin:[0,0,0],sx:320,sy:180,clip:true,cull:false,positions,uv},changes)
  c.matrix=c.matrix.slice();c.origin=c.origin.slice()
  c.positions=Array.from(new Float32Array(c.positions));c.uv=Array.from(new Float32Array(c.uv));cases.push(c)
}
add('inside');add('cull-positive',{cull:true})
add('reverse-winding',{positions:[...positions.slice(6),...positions.slice(3,6),...positions.slice(0,3)],cull:true})
for(let axis=0;axis<3;++axis)for(const sign of [-1,1]) {
  const matrix=identity.slice();matrix[axis*4+3]=sign*0.8;add('cross-plane-'+axis+'-'+sign,{matrix})
  matrix[axis*4+3]=sign*4;add('outside-plane-'+axis+'-'+sign,{matrix:matrix.slice()})
}
add('not-clipped',{matrix:[1,0,0,2,0,1,0,-2,0,0,1,0,0,0,0,1],clip:false})
add('perspective-near',{matrix:[0.5,0,0,0,0,0.5,0,0,0,0,0.8,0.1,0,0,1,0]})
add('perspective-unclipped',{matrix:[0.5,0,0,0,0,0.5,0,0,0,0,0.8,0.1,0,0,1,0],clip:false})
add('zero-depth',{matrix:new Array(16).fill(0)})
add('almost-zero-depth',{matrix:[1e-12,0,0,0,0,1e-12,0,0,0,0,0,0,0,0,0,1e-12]})
add('tiny-uv-degenerate',{uv:[0,0,1e-9,0,0,1e-9]})
add('uv-signed-zero',{uv:[-0,-0,1,0,0,1]})
add('translated-origin',{origin:[10000000,-20000000,5000000],matrix:[1,0,0,-10000000,0,1,0,20000000,0,0,1,-5000000,0,0,0,1]})
add('unequal-pixel-scales',{sx:0.5,sy:4096})
add('collinear-screen',{positions:[-0.5,0,0,0,0,0,0.5,0,0]})
let seed=0x73fe0291
const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296}
for(let i=0;i<40;++i) {
  const p=Array.from({length:9},()=>random()*4-2)
  const matrix=identity.slice();matrix[12]=random()*0.4-0.2;matrix[13]=random()*0.4-0.2;matrix[14]=random()*0.4-0.2
  add('seeded-'+i,{positions:p,matrix,cull:Boolean(i%2),clip:Boolean(i%3),sx:2**(i%10),sy:2**(i%7)})
}
function expected(c) {
  const clip=projectTriangle(c.positions,c.uv,[0,1,2],0,c.origin,c.matrix)
  const polygon=c.cull&&backFacing(clip)?[]:c.clip?clipTriangle(clip):clip
  const density={uv:{}}
  if(polygon.length<3||!triangleDensity(c.positions,[0,1,2],0,clip,polygon,c,density))return {count:0,values:new Array(15).fill(0)}
  const tex=clip.map(p=>p.slice(4)),u1=tex[1][0]-tex[0][0],v1=tex[1][1]-tex[0][1],u2=tex[2][0]-tex[0][0],v2=tex[2][1]-tex[0][1],det=u1*v2-u2*v1,projection=[]
  for(const [axis,scale] of [[0,c.sx],[1,c.sy],[3,1]]) {
    const a=clip[0][axis]*scale,b=clip[1][axis]*scale,d=clip[2][axis]*scale
    const du=((b-a)*v2-(d-a)*v1)/det,dv=((d-a)*u1-(b-a)*u2)/det
    projection.push(a-du*tex[0][0]-dv*tex[0][1],du,dv)
  }
  return {count:polygon.length,values:[density.pixelsPerUv,density.centerDistance,density.uv.minimumU,density.uv.minimumV,density.uv.maximumU,density.uv.maximumV,...projection,...polygon.flatMap(p=>p.slice(4,6))]}
}
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b}
const f64=values=>{const b=Buffer.alloc(values.length*8);values.forEach((v,i)=>b.writeDoubleLE(v,i*8));return b}
const f32=values=>{const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeFloatLE(v,i*4));return b}
const chunks=[Buffer.from('TERRATP1'),u32(cases.length)],manifest={format:'terra.triangle-projection-golden.v1',cases:[]}
for(const c of cases) {
  const e=expected(c),name=Buffer.from(c.name);assert(e.count<=16)
  chunks.push(u32(name.length),name,f64([...c.matrix,...c.origin,c.sx,c.sy]),u32(Number(c.clip)),u32(Number(c.cull)),f32([...c.positions,...c.uv]),u32(e.count),f64(e.values))
  manifest.cases.push({name:c.name,vertices:e.count})
}
const binary=Buffer.concat(chunks);manifest.sha256=hash(binary);manifest.generatorSha256=hash(fs.readFileSync(__filename));manifest.generatorNode=process.version
manifest.oracleSources=Object.fromEntries(['triangle_projection','triangle_density','surface_facing'].map(n=>'../../sdk/js/terrain/'+n+'.js').concat(['../../sdk/js/math/projection.js']).map(n=>[n,hash(fs.readFileSync(path.resolve(__dirname,n)))]))
fs.writeFileSync(output,binary);fs.writeFileSync(output.replace(/\.bin$/,'.json'),JSON.stringify(manifest,null,2)+'\n')
console.log('Frozen triangle projection oracle:',cases.length,'cases,',binary.length,'bytes,',manifest.sha256)
