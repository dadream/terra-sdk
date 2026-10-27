// Offline feasibility experiment, not a runtime integration or frame-latency
// benchmark. Inputs are already selected exact faces of one immutable mesh.
const assert=require('assert')
const fs=require('fs')
const path=require('path')
const crypto=require('crypto')
const {performance}=require('perf_hooks')
const {TerraAbi}=require('../../../adapters/wasm/terra_abi')
const loader=require('../../../adapters/wasm/terra_wasm')
const {ImageryAdapter}=require('../../../sdk/js/imagery/terra_imagery_adapter')
const {projectTriangle,clipTriangle}=require('../../../sdk/js/terrain/triangle_projection')
const {backFacing}=require('../../../sdk/js/terrain/surface_facing')
const {triangleDensity}=require('../../../sdk/js/terrain/triangle_density')
const {compactRegionSteps,regionCompactionBytes}=require('../../../sdk/js/terrain/region_compaction')
const {compactRegions:frozenCompaction}=require('../../js/reference/compact_regions_reference')
const {grid}=require('../../js/reference/compaction_fixture')
const {regionError}=require('../../../sdk/js/terrain/terra_surface_plan')

const descriptor={kind:'global-geodetic',matrix_level_offset:0,maximum_level:8,minimum_level:0,
  tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]}
const options={descriptor,targetPixelError:1.25,maximumTextures:214,maximumDraws:512,detached:true}
const manifest={formatVersion:1,patchDimension:8,transform:'cylindrical',heightScale:1,
  minimumU:-180,minimumV:-90,maximumU:180,maximumV:90,radius:6378000,texture:descriptor}
const drain=work=>{let next;do{next=work.next()}while(!next.done);return next.value}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
function near(a,b,label) {
  assert(a===b||Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-10,Math.abs(a)*1e-10),label+': '+a+' vs '+b)
}
function numbers(region) {
  const b=region.uv
  return [b.minimumU,b.minimumV,b.maximumU,b.maximumV,region.pixelsPerUv,
    ...(region.projection||new Array(9).fill(0)),...(region.triangle||[[0,0],[0,0],[0,0]]).flat(),
    region.numeratorBound===undefined?-1:region.numeratorBound]
}
function writeRegions(module,pointer,regions) {
  const out=module.refreshMemory().dataView
  regions.forEach((region,i)=>{
    numbers(region).forEach((value,j)=>out.setFloat64(pointer+i*176+j*8,value,true))
    out.setUint32(pointer+i*176+168,Number(Boolean(region.projection))|Number(Boolean(region.triangle))<<1|Number(region.numeratorBound!==undefined)<<2,true)
    out.setUint32(pointer+i*176+172,region.domain===undefined?0xffffffff:region.domain,true)
  })
}
function readRegions(module,pointer,count) {
  const view=module.refreshMemory().dataView
  return Array.from({length:count},(_,i)=>{
    const offset=pointer+i*176,a=Array.from({length:21},(_,j)=>view.getFloat64(offset+j*8,true)),flags=view.getUint32(offset+168,true)
    const row={uv:{minimumU:a[0],minimumV:a[1],maximumU:a[2],maximumV:a[3]},pixelsPerUv:a[4]}
    if(flags&1)row.projection=a.slice(5,14)
    if(flags&2)row.triangle=[a.slice(14,16),a.slice(16,18),a.slice(18,20)]
    if(flags&4)row.numeratorBound=a[20]
    return row
  })
}
function readCompact(module,input,count,workspace,outputCount) {
  const regions=[]
  for(let first=0;first<outputCount;first+=256) {
    const range=Math.min(256,outputCount-first),pointer=module.call('bench_copy_output',input,count,workspace,first,range)
    assert(pointer>0);regions.push(...readRegions(module,pointer,range))
  }
  return regions
}
function compareRegions(expected,actual,label) {
  assert.strictEqual(actual.length,expected.length,label+' region count')
  expected.forEach((region,i)=>numbers(region).forEach((v,j)=>near(v,numbers(actual[i])[j],label+' row '+i+' column '+j)))
  for(let y=0;y<8;++y)for(let x=0;x<8;++x) {
    const cell={minimumU:x/8,minimumV:y/8,maximumU:(x+1)/8,maximumV:(y+1)/8}
    const density=regions=>regions.reduce((value,region)=>Math.max(value,regionError(region,cell)),0)
    near(density(expected),density(actual),label+' local node SSE')
  }
}

// This is the production exact-triangle formula, assembled from its independent
// JS helpers. Block selection/preparation are outside this experiment's scope.
function projectSelected(input,context,cull) {
  const regions=[],density={uv:{},pixelsPerUv:0,centerDistance:Infinity},m=context.matrix
  for(let first=0;first<input.faces.length;first+=3) {
    const clip=projectTriangle(input.positions,input.uv,input.faces,first,input.origin,m)
    if(cull&&backFacing(clip))continue
    const polygon=clipTriangle(clip)
    if(polygon.length<3||!triangleDensity(input.positions,input.faces,first,clip,polygon,context,density))continue
    if(!(density.uv.maximumU>density.uv.minimumU&&density.uv.maximumV>density.uv.minimumV))continue
    const u1=clip[1][4]-clip[0][4],v1=clip[1][5]-clip[0][5],u2=clip[2][4]-clip[0][4],v2=clip[2][5]-clip[0][5],det=u1*v2-u2*v1,projection=[]
    for(const [axis,scale] of [[0,context.sx],[1,context.sy],[3,1]]) {
      const a=clip[0][axis]*scale,b=clip[1][axis]*scale,c=clip[2][axis]*scale
      const du=((b-a)*v2-(c-a)*v1)/det,dv=((c-a)*u1-(b-a)*u2)/det
      projection.push(a-du*clip[0][4]-dv*clip[0][5],du,dv)
    }
    for(let j=1;j+1<polygon.length;++j) {
      const triangle=[polygon[0],polygon[j],polygon[j+1]].map(p=>p.slice(4,6))
      regions.push({uv:{minimumU:Math.min(...triangle.map(p=>p[0])),minimumV:Math.min(...triangle.map(p=>p[1])),
        maximumU:Math.max(...triangle.map(p=>p[0])),maximumV:Math.max(...triangle.map(p=>p[1]))},
      pixelsPerUv:density.pixelsPerUv,projection,triangle})
    }
  }
  return regions
}
function mesh(dimension,mode) {
  const positions=[],uv=[],faces=[],holes=mode==='hole'
  for(let y=0;y<=dimension;++y)for(let x=0;x<=dimension;++x) {
    const u=x/dimension,v=y/dimension
    positions.push(u*6-3,v*6-3,mode==='folded'?Math.sin(x*1.7)*Math.cos(y*0.8)*0.8:Math.sin(u*9)*Math.cos(v*7)*0.2)
    uv.push(u,v)
  }
  for(let y=0;y<dimension;++y)for(let x=0;x<dimension;++x) {
    if(holes&&x>=dimension/3&&x<2*dimension/3&&y>=dimension/3&&y<2*dimension/3)continue
    const a=y*(dimension+1)+x,b=a+1,c=a+dimension+1,d=c+1
    if(mode==='folded'&&(x+y)%5===0)faces.push(a,b,d,a,d,c)
    else faces.push(a,d,b,a,c,d)
  }
  return {positions:new Float32Array(positions),uv:new Float32Array(uv),faces:new Uint16Array(faces),origin:[0.2,-0.15,0.1]}
}
function planSignature(plan) {
  return plan.draws.map(draw=>[draw.textureNode.level,draw.textureNode.root,draw.textureNode.row,
    draw.textureNode.column,draw.imageryPixelError]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||a[3]-b[3])
}
function comparePlans(expected,actual,label) {
  const a=planSignature(expected),b=planSignature(actual)
  assert.strictEqual(a.length,b.length,label+' plan draw count')
  a.forEach((row,i)=>row.forEach((v,j)=>j<4?assert.strictEqual(v,b[i][j],label+' selected node'):near(v,b[i][j],label+' node error')))
  assert.strictEqual(actual.quality.planningComplete,true)
  assert.strictEqual(actual.quality.meetsTarget,expected.quality.meetsTarget)
  assert.strictEqual(actual.quality.targetPixelError,1.25)
}

async function main() {
  const wasmPath=process.argv[2],output=process.argv[3]
  assert(wasmPath&&output,'Usage: node benchmark.js <experimental.wasm> <report.json>')
  const bytes=fs.readFileSync(wasmPath),module=await loader.instantiateTerraWasmBytes(bytes),abi=new TerraAbi(module)
  const report={schema:'terra.fused-measurement-experiment.v1',scope:'Offline fixed selected exact faces: projection, count/fill, compaction, actual native imagery staging/planning and same JS plan readback; excludes block/model preparation, worker transfer, UV fitting, GPU, network and industrial latency',
    productIntegration:false,sourceCommit:process.env.TERRA_EXPERIMENT_COMMIT||null,wasmSha256:hash(bytes),node:process.version,compactionCases:[],cases:[],rows:[]}
  try {
    abi.loadManifest(manifest)
    const compactionInputs=[]
    for(const mode of ['uniform','hole','varying','separated'])for(const duplicate of [false,true])
      compactionInputs.push({mode,duplicate,input:grid(16,mode,duplicate,true).regions})
    for(const count of [1,2,3,4])compactionInputs.push({mode:'small-'+count,duplicate:false,input:grid(4,'varying').regions.slice(0,count)})
    const slivers=[]
    for(let i=0;i<12;++i) {
      const triangle=[0,0.1,0.2].map(d=>{const a=(i+d)*Math.PI/6;return [0.5+Math.cos(a)*1e-8,0.5+Math.sin(a)*1e-8]})
      slivers.push({triangle,projection:[0,128,0,0,0,128,1,0,0],pixelsPerUv:1024,
        uv:{minimumU:Math.min(...triangle.map(p=>p[0])),minimumV:Math.min(...triangle.map(p=>p[1])),maximumU:Math.max(...triangle.map(p=>p[0])),maximumV:Math.max(...triangle.map(p=>p[1]))}})
    }
    compactionInputs.push({mode:'tiny-area-hull-expansion',duplicate:false,input:slivers})
    for(const {mode,duplicate,input} of compactionInputs) {
      const expected=drain(frozenCompaction(input))
      const raw=abi.alloc(input.length*176),quote=module.call('bench_region_bytes',input.length)>>>0,work=abi.alloc(quote)
      try {
        writeRegions(module,raw,input)
        assert.strictEqual(module.call('bench_compact',raw,input.length,work,quote-1)>>>0,0xffffffff)
        module.exports.memory.grow(1)
        const count=module.call('bench_compact',raw,input.length,work,quote)>>>0
        assert.notStrictEqual(count,0xffffffff)
        if(mode==='tiny-area-hull-expansion')assert(count>input.length,'Fixture did not exercise output expansion')
        assert.strictEqual(module.call('bench_copy_output',raw,input.length,work,0,257),0)
        assert.strictEqual(module.call('bench_copy_output',raw,input.length,work,input.length*3,1),0)
        compareRegions(expected,readCompact(module,raw,input.length,work,count),mode+' '+duplicate)
        report.compactionCases.push({mode,duplicate,inputRegions:input.length,outputRegions:count,workBytes:quote})
      }finally{abi.free(work);abi.free(raw)}
    }
    const context={matrix:[1,0.1,0,0,0,1,0.05,0,0,0,1,0,0.05,0,0.2,1.5],sx:200,sy:180}
    const dimensions=(process.env.TERRA_EXPERIMENT_DIMENSIONS||'32,96,180').split(',').map(Number)
    assert(dimensions.every(n=>Number.isInteger(n)&&n>0&&n<=180),'Invalid experimental dimensions')
    const policies=[{name:'default',options},{name:'expanded',options:{...options,
      maximumTextures:4096,maximumDraws:8192}}]
    report.policies=policies.map(p=>({name:p.name,descriptor:p.options.descriptor,
      maximumTextures:p.options.maximumTextures,maximumDraws:p.options.maximumDraws,targetPixelError:p.options.targetPixelError}))
    for(const dimension of dimensions)for(const mode of ['relief','hole','folded'])for(const cull of [false,true])for(const policy of policies) {
      const policyOptions=policy.options,adapter=new ImageryAdapter(policyOptions.descriptor)
      const input=mesh(dimension,mode),pointers=[]
      const alloc=bytes=>{const p=abi.alloc(bytes);pointers.push(p);return p}
      const settings=alloc(176),positions=alloc(input.positions.byteLength),uv=alloc(input.uv.byteLength),faces=alloc(input.faces.byteLength),optionPointer=alloc(48),metrics=alloc(8)
      const copy=(pointer,values)=>module.refreshMemory().bytes.set(new Uint8Array(values.buffer,values.byteOffset,values.byteLength),pointer)
      copy(positions,input.positions);copy(uv,input.uv);copy(faces,input.faces)
      let view=module.refreshMemory().dataView
      ;[...context.matrix,...input.origin,context.sx,context.sy].forEach((v,i)=>view.setFloat64(settings+i*8,v,true))
      view.setUint32(settings+168,1,true);view.setUint32(settings+172,cull?1:0,true)
      ;[[0,48],[4,loader.TERRA_ABI_VERSION],[8,256],[12,adapter.maximumDepth],[24,policyOptions.maximumTextures],[28,policyOptions.maximumDraws+1],
        [32,2],[36,1],[40,policyOptions.descriptor.maximum_level],[44,0]].forEach(([offset,v])=>view.setUint32(optionPointer+offset,v,true))
      view.setFloat64(optionPointer+16,1.25,true)
      const faceCount=input.faces.length/3,rawCount=module.call('bench_count',settings,positions,uv,faces,faceCount)>>>0
      assert(rawCount>0&&rawCount!==0xffffffff)
      const raw=abi.alloc(rawCount*176),workBytes=module.call('bench_region_bytes',rawCount)>>>0,work=abi.alloc(workBytes)
      const draw=adapter.prepareDraw({resourceId:0,textureNode:{level:0,root:0,row:0,column:0}})
      const js=()=>{
        const start=performance.now(),rawRegions=projectSelected(input,context,cull),projected=performance.now()
        const regions=drain(compactRegionSteps(rawRegions)),compacted=performance.now()
        const planner=abi.createImageryPlanner()
        try {
          const result=planner.plan([draw],()=>({visible:true,pixelsPerUv:1,regions}),policyOptions)
          return {result,regions,rawCount:rawRegions.length,phases:{projectionMs:projected-start,
            compactionMs:compacted-projected,inputPlanReadbackMs:performance.now()-compacted}}
        }finally{planner.destroy()}
      }
      const fused=()=>{
        // Include both count pass and exact-size caller-owned allocation in the
        // timed path. Geometry is pre-owned equally by the two routes.
        const start=performance.now(),count=module.call('bench_count',settings,positions,uv,faces,faceCount)>>>0,counted=performance.now()
        assert.strictEqual(count,rawCount)
        const rawPointer=abi.alloc(count*176),workspace=abi.alloc(workBytes),planner=abi.createImageryPlanner()
        try {
          const allocated=performance.now(),compacted=module.call('bench_project',settings,positions,uv,faces,faceCount,rawPointer,count,workspace,workBytes)>>>0,projected=performance.now()
          assert(compacted!==0xffffffff)
          const nativeCredit=module.call('terra_imagery_input_work_bytes',1,1,compacted,0)>>>0
          const status=module.call('bench_stage',abi.context,planner.id,rawPointer,count,workspace,compacted,optionPointer,nativeCredit,metrics)
          const planned=performance.now()
          assert.strictEqual(status,0,'Native fused input/planning rejected')
          planner.adapter=new ImageryAdapter(policyOptions.descriptor);planner.sourceDrawCount=1
          const result=drain(planner.readPlanSteps([draw],policyOptions))
          const metric=new Uint32Array(module.refreshMemory().bytes.buffer,metrics,2)
          return {result,rawCount:count,compacted,steps:metric[0],nativePeakBytes:metric[1],nativeCredit,
            temporaryPayloadBytes:count*176+workBytes,phases:{countMs:counted-start,allocationMs:allocated-counted,
              projectionCompactionMs:projected-allocated,inputPlanMs:planned-projected,readbackMs:performance.now()-planned}}
        }finally{planner.destroy();abi.free(workspace);abi.free(rawPointer)}
      }
      try {
        const before=js()
        assert.strictEqual(before.rawCount,rawCount)
        assert.strictEqual(module.call('bench_project',settings,positions,uv,faces,faceCount,raw,rawCount,work,workBytes-1)>>>0,0xffffffff)
        const compacted=module.call('bench_project',settings,positions,uv,faces,faceCount,raw,rawCount,work,workBytes)>>>0
        compareRegions(before.regions,readCompact(module,raw,rawCount,work,compacted),mode+' projection')
        const refusal=abi.createImageryPlanner()
        try {
          const credit=module.call('terra_imagery_input_work_bytes',1,1,compacted,0)>>>0
          const nativeBefore=abi.imageryPayloadBytes()
          assert.strictEqual(module.call('bench_stage',abi.context,refusal.id,raw,rawCount,work,compacted,optionPointer,credit-1,metrics),5)
          assert.strictEqual(abi.imageryPayloadBytes(),nativeBefore,'Refused input changed native ownership')
        }finally{refusal.destroy()}
        module.exports.memory.grow(1)
        const after=fused();comparePlans(before.result,after.result,mode+' fused')
        const quality={targetMet:after.result.quality.meetsTarget,targetPixelError:after.result.quality.targetPixelError,
          maximumPixelError:after.result.quality.measuredMaxPixelError,limitedByBudget:after.result.quality.limitedByBudget,
          limitedByLevel:after.result.quality.limitedByLevel,limitedByProjection:after.result.quality.limitedByProjection,
          limitedByTextureBudget:after.result.quality.limitedByTextureBudget,limitedByPartitionBudget:after.result.quality.limitedByPartitionBudget,
          selectedLevelMinimum:after.result.quality.selectedLevelMinimum,selectedLevelMaximum:after.result.quality.selectedLevelMaximum,
          draws:after.result.draws.length}
        console.log(JSON.stringify({phase:'validated',dimension,mode,cull,profile:policy.name,quality}))
        delete after.result;delete after.phases
        report.cases.push({dimension,mode,cull,profile:policy.name,quality,faceCount,geometryBytes:input.positions.byteLength+input.uv.byteLength+input.faces.byteLength,
          jsCompactionScratchBytes:regionCompactionBytes(rawCount),...after,compacted:before.regions.length})
        abi.free(work);abi.free(raw)
        for(let i=0;i<2;++i){js();fused()}
        for(let repetition=0;repetition<5;++repetition)for(const name of repetition%2?['fused','js']:['js','fused']) {
          const start=performance.now(),value=(name==='js'?js:fused)(),ms=performance.now()-start
          report.rows.push({dimension,mode,cull,profile:policy.name,repetition,path:name,ms,draws:value.result.draws.length,
            checksum:value.result.draws.reduce((sum,d)=>sum+d.imageryPixelError,0),phases:value.phases})
        }
      }finally{for(const p of pointers.reverse())abi.free(p)}
    }
    assert.strictEqual(abi.nativeAllocations.size,0)
  }finally{abi.destroy()}
  report.rawAbiAllocationsAfterDestroy=abi.nativeAllocations.size
  report.nativeContextAfterDestroy=abi.context
  report.sources=Object.fromEntries(['benchmark.js','experiment.cpp','compact_regions.cpp','compact_regions.hpp','triangle_projection.cpp','triangle_projection.hpp','CMakeLists.txt']
    .map(name=>[name,hash(fs.readFileSync(path.join(__dirname,name)))]))
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n')
  for(const scene of report.cases) {
    const means=Object.fromEntries(['js','fused'].map(name=>{const rows=report.rows.filter(r=>r.dimension===scene.dimension&&r.mode===scene.mode&&r.cull===scene.cull&&r.profile===scene.profile&&r.path===name);return[name,rows.reduce((n,r)=>n+r.ms,0)/rows.length]}))
    console.log(JSON.stringify({...scene,meanMs:means}))
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
