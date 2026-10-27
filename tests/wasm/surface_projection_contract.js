const assert=require('assert'),fs=require('fs'),path=require('path')
const loader=require('../../adapters/wasm/terra_wasm')
const {TerraAbi}=require('../../adapters/wasm/terra_abi')
const {preparedSurfaceBytes}=require('../../adapters/wasm/prepared_surface')
const {triangles}=require('../../sdk/js/terrain/surface_preparation')
const {projectTriangle,clipTriangle}=require('../../sdk/js/terrain/triangle_projection')
const {triangleDensity}=require('../../sdk/js/terrain/triangle_density')
const {backFacing}=require('../../sdk/js/terrain/surface_facing')
const {compactRegions}=require('../js/reference/compact_regions_reference')
const limit=16*1024*1024
function equal(a,b,label) {
  if(a===0&&b===0){assert(Object.is(a,b),label+' signed zero');return}
  assert(Object.is(a,b)||Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-10,Math.abs(a)*1e-10),label+': '+a+' / '+b)
}
function drain(work){let result;do{result=work.next()}while(!result.done);return result.value}
function reference(mesh,faces,origin,matrix,cull) {
  const context={matrix,sx:320,sy:180},input=[],density={uv:{}},summary=[0,0,0,0,0,Infinity]
  let visible=false
  for(let first=0;first<faces.length;first+=3) {
    const clip=projectTriangle(mesh.positions,mesh.textureUv,faces,first,origin,matrix)
    const polygon=cull&&backFacing(clip)?[]:clipTriangle(clip)
    if(polygon.length<3||!triangleDensity(mesh.positions,faces,first,clip,polygon,context,density))continue
    summary[5]=Math.min(summary[5],density.centerDistance)
    const uv=density.uv
    if(!(uv.maximumU>uv.minimumU&&uv.maximumV>uv.minimumV))continue
    const bounds=[uv.minimumU,uv.minimumV,uv.maximumU,uv.maximumV]
    for(let i=0;i<4;++i)summary[i]=!visible?bounds[i]:i<2?Math.min(summary[i],bounds[i]):Math.max(summary[i],bounds[i])
    visible=true;summary[4]=Math.max(summary[4],density.pixelsPerUv)
    const tex=clip.map(p=>p.slice(4)),u1=tex[1][0]-tex[0][0],v1=tex[1][1]-tex[0][1],u2=tex[2][0]-tex[0][0],v2=tex[2][1]-tex[0][1],det=u1*v2-u2*v1,projection=[]
    for(const [axis,scale] of [[0,320],[1,180],[3,1]]) {
      const a=clip[0][axis]*scale,b=clip[1][axis]*scale,c=clip[2][axis]*scale
      const du=((b-a)*v2-(c-a)*v1)/det,dv=((c-a)*u1-(b-a)*u2)/det
      projection.push(a-du*tex[0][0]-dv*tex[0][1],du,dv)
    }
    for(let j=1;j+1<polygon.length;++j) {
      const triangle=[polygon[0],polygon[j],polygon[j+1]].map(p=>p.slice(4,6))
      input.push({pixelsPerUv:density.pixelsPerUv,projection,triangle,uv:{
        minimumU:Math.min(...triangle.map(p=>p[0])),minimumV:Math.min(...triangle.map(p=>p[1])),
        maximumU:Math.max(...triangle.map(p=>p[0])),maximumV:Math.max(...triangle.map(p=>p[1]))}})
    }
  }
  return {visible,summary,raw:input.length,regions:drain(compactRegions(input))}
}
function values(r) {
  return [r.uv.minimumU,r.uv.minimumV,r.uv.maximumU,r.uv.maximumV,r.pixelsPerUv,...r.projection,...r.triangle.flat(),r.numeratorBound===undefined?-1:r.numeratorBound]
}
async function main() {
  const imports=loader.createTerraImports();let time=0
  imports.env.terra_monotonic_milliseconds=()=>++time
  const module=loader.initializeTerraInstance(await WebAssembly.instantiate(fs.readFileSync(process.argv[2]),imports),imports)
  const abi=new TerraAbi(module),pointers=new Set(),tasks=new Set(),alloc=n=>{const p=abi.alloc(n);pointers.add(p);return p},free=p=>{abi.free(p);pointers.delete(p)}
  const records=[]
  const info=alloc(36),out=alloc(256*176),summary=alloc(52)
  const call=(name,...args)=>module.call('test_projection_'+name,...args)
  const step=(task,n=4096,ms=0)=>{
    call('step',task,n,ms,info);const v=module.refreshMemory().dataView
    const p=Array.from({length:9},(_,i)=>v.getUint32(info+i*4,true))
    assert(p[1]<=n&&p[2]<10000000);return p
  }
  const destroy=task=>{call('destroy',task);tasks.delete(task)}
  let kernelCases=0,comparisons=0
  try {
    const golden=fs.readFileSync(process.argv[3]);let offset=8
    assert.strictEqual(golden.subarray(0,8).toString(),'TERRATP1')
    const integer=()=>{const n=golden.readUInt32LE(offset);offset+=4;return n}
    assert.strictEqual(integer(),65)
    const parameters=alloc(168),input=alloc(60),kernelOut=alloc(4+47*8)
    for(let i=0;i<65;++i) {
      const nameLength=integer(),name=golden.subarray(offset,offset+nameLength).toString();offset+=nameLength
      module.refreshMemory().bytes.set(golden.subarray(offset,offset+168),parameters);offset+=168
      const clip=integer(),cull=integer()
      module.refreshMemory().bytes.set(golden.subarray(offset,offset+60),input);offset+=60
      const count=integer(),expected=golden.subarray(offset,offset+(15+count*2)*8);offset+=expected.length
      assert.strictEqual(module.call('test_triangle_project',parameters,input,clip|cull<<1,kernelOut),1)
      const v=module.refreshMemory().dataView;assert.strictEqual(v.getUint32(kernelOut,true),count,name)
      for(let j=0;j<15+count*2;++j)equal(expected.readDoubleLE(j*8),v.getFloat64(kernelOut+4+j*8,true),name+' field '+j)
      ++kernelCases
    }
    assert.strictEqual(offset,golden.length);free(parameters);free(input);free(kernelOut)
    const manifest={formatVersion:1,patchDimension:64,transform:'cylindrical',heightScale:1/64,
      minimumU:-180,minimumV:-90,maximumU:180,maximumV:90,radius:6378000,
      texture:{kind:'global-geodetic',matrix_level_offset:0,minimum_level:0,maximum_level:8,
        tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]}}
    const fixtureRoot=path.join(__dirname,'../../testdata/miniprogram/golden')
    const recordTable=new Map(JSON.parse(fs.readFileSync(path.join(fixtureRoot,'terrain_wait_records.json')))
      .map(row=>[[row[0],...row.slice(1,5)].join('/'),row[5]]))
    const recordFor=request=>recordTable.get([request.kind,request.key.level,request.key.i,request.key.j,request.key.k].join('/'))
    const budget={maximumChangeCount:16,maximumPriorityUpdateCount:256,maximumElapsedMs:0}
    abi.loadManifest(manifest);abi.setViewport(640,360,Math.PI/6)
    abi.setGlobeTarget(-90,20);abi.setCamera({distance:18000000,tiltRadians:0,yawRadians:0})
    abi.updateStep(1,budget);for(const r of abi.getRequests()) {const name=recordFor(r);assert(name);abi.submitRecord(r.kind,r.key,fs.readFileSync(path.join(fixtureRoot,name)))}
    const packet=abi.prepareMeshFrame(1,budget),plan=packet.nativePlan.id,indices=abi.getIndices(),meshBefore=abi.meshPayloadBytes()
    const fixtures=[]
    for(const draw of new Map(packet.draws.map(d=>[d.resourceId,d])).values()) {
      const mesh=await abi.createPreparedSurfaceTask(plan,draw,preparedSurfaceBytes(draw)).run()
      const faces=triangles(indices,draw.firstIndex,draw.indexCount,draw.vertexCount)
      const expected=reference(mesh,faces,draw.origin,packet.frame.projectionView,true)
      let minimumHeight=Infinity,maximumHeight=-Infinity
      for(let i=0;i<mesh.positions.length;i+=3) {
        const h=Math.hypot(mesh.positions[i]+draw.origin[0],mesh.positions[i+1]+draw.origin[1],mesh.positions[i+2]+draw.origin[2])-manifest.radius
        minimumHeight=Math.min(minimumHeight,h);maximumHeight=Math.max(maximumHeight,h)
      }
      fixtures.push({draw,mesh,faces,expected,minimumHeight,maximumHeight})
    }
    assert(fixtures.some(f=>f.expected.visible),'No visible real CBDAM fixture')
    assert(fixtures.some(f=>f.expected.visible&&f.maximumHeight-f.minimumHeight>4),'Fixture did not load nonflat terrain')
    const create=(fixture,planId=plan,matrix=packet.frame.projectionView,cull=true)=>{
      const facePointer=alloc(fixture.faces.byteLength),matrixPointer=alloc(128)
      try {
        module.refreshMemory().bytes.set(new Uint8Array(fixture.faces.buffer,fixture.faces.byteOffset,fixture.faces.byteLength),facePointer)
        const v=module.refreshMemory().dataView;matrix.forEach((value,i)=>v.setFloat64(matrixPointer+i*8,value,true))
        const task=call('create',abi.context,planId,fixture.draw.resourceId,facePointer,fixture.faces.length,matrixPointer,320,180,1|Number(cull)<<1,limit)
        if(task)tasks.add(task);return task
      }finally{free(matrixPointer);free(facePointer)}
    }
    const finish=(task,expected,quantum,label,resident)=>{
      assert(task)
      let p=step(task,0),admissions=0,peakActual=p[6],peakAuthorized=p[7]
      while(p[0]!==5) {
        if(p[0]===0||p[0]===2) {
          {
            assert.strictEqual(call('block',task,limit-p[7]-p[3]+1),1)
            assert.strictEqual(call('admit',task,0),0);assert.strictEqual(step(task,quantum)[1],0)
            assert.strictEqual(call('block',task,0),1)
          }
          assert.strictEqual(call('admit',task,Number(admissions%2===1)),1);++admissions
        } else assert([1,3,4].includes(p[0]),'Unexpected pipeline status '+p[0])
        p=step(task,quantum);peakActual=Math.max(peakActual,p[6]);peakAuthorized=Math.max(peakAuthorized,p[7])
      }
      assert.strictEqual(p[8],resident,label+' source mode')
      records.push({label,quantum,resident:Boolean(p[8]),rawCount:p[4],outputCount:p[5],totalOperations:p[2],peakActualBytes:peakActual,peakAuthorizedBytes:peakAuthorized,finalAllocatedBytes:p[6]})
      assert.strictEqual(p[4],expected.raw);assert.strictEqual(p[5],expected.regions.length)
      assert.strictEqual(p[6],p[7],'Completed task retained unused compaction reservation')
      call('summary',task,summary);let v=module.refreshMemory().dataView
      assert.strictEqual(Boolean(v.getUint32(summary,true)),expected.visible)
      expected.summary.forEach((x,i)=>equal(x,v.getFloat64(summary+4+i*8,true),'summary '+i))
      for(let first=0;first<expected.regions.length;first+=256) {
        const count=call('read',task,first,256,out);assert.strictEqual(count,Math.min(256,expected.regions.length-first))
        v=module.refreshMemory().dataView
        for(let i=0;i<count;++i) {
          const p=out+i*176;assert.strictEqual(v.getUint32(p,true),3);assert.strictEqual(v.getUint32(p+4,true),0xffffffff)
          values(expected.regions[first+i]).forEach((x,j)=>equal(x,v.getFloat64(p+8+j*8,true),'region '+(first+i)+' field '+j))
        }
      }
      assert.strictEqual(call('read',task,0,257,out),-1)
      call('cancel',task);assert.strictEqual(step(task,1)[0],6);assert.strictEqual(step(task,1)[6],0);assert.strictEqual(step(task,1)[7],0)
      assert.strictEqual(call('read',task,0,1,out),-1);++comparisons
    }
    const visible=fixtures.filter(f=>f.expected.visible).sort((a,b)=>(b.maximumHeight-b.minimumHeight)-(a.maximumHeight-a.minimumHeight)).slice(0,2)
    assert(visible.length===2)
    // Hold exact input through background height work and Wasm memory growth.
    const held=create(visible[0]);assert.strictEqual(call('admit',held,0),1)
    const timed=step(held,1000000,1e-9);assert(timed[1]>0&&timed[1]<=64)
    module.exports.memory.grow(1)
    abi.setCamera({distance:3000000,tiltRadians:-0.7,yawRadians:0.3})
    let backgroundHeightBuilds=0,backgroundRevision=0
    for(let i=0;i<12;++i) {
      for(const r of abi.getRequests()) {
        const name=recordFor(r)
        if(name)abi.submitRecord(r.kind,r.key,fs.readFileSync(path.join(fixtureRoot,name)))
        else if(r.kind===2)abi.noDataRecord(r.key)
        else assert.fail('Missing root record fixture')
      }
      const progress=abi.advanceTerrain(0.005,budget);backgroundHeightBuilds+=progress.heightBuildCount;backgroundRevision=progress.modelRevision
    }
    assert(backgroundHeightBuilds>0&&backgroundRevision>packet.updateState.modelRevision,'Background did not actually refine heights/model')
    records.background={heightBuilds:backgroundHeightBuilds,modelRevisionBefore:packet.updateState.modelRevision,modelRevisionAfter:backgroundRevision}
    finish(held,visible[0].expected,7,'prepared-background',0);destroy(held)
    assert.strictEqual(abi.meshPayloadBytes(),meshBefore,'Measurement materialized candidate geometry')
    for(const f of visible)for(const quantum of [1,64,4096]) {
      const task=create(f);finish(task,f.expected,quantum,'prepared-'+f.draw.resourceId,0);destroy(task)
    }
    // An actual partially produced plan mixes resident and sampled input.
    const producer=abi.createMeshTask(packet);producer.maximumSteps=1
    assert.strictEqual(producer.step().done,false)
    const resident=fixtures.find(f=>module.call('terra_get_mesh_position_view',abi.context,f.draw.resourceId))
    const fresh=visible.find(f=>!module.call('terra_get_mesh_position_view',abi.context,f.draw.resourceId))
    assert(resident&&fresh,'No mixed resident/prepared fixture')
    for(const f of [resident,fresh]) {const task=create(f);finish(task,f.expected,64,'mixed-'+f.draw.resourceId,Number(f===resident));destroy(task)}
    await producer.run();abi.commitMeshFrame(packet)
    for(const f of visible) {
      const task=create(f,0);finish(task,f.expected,4096,'resident-'+f.draw.resourceId,1);destroy(task)
      assert.strictEqual(create(f,plan),0,'Stale plan reopened')
    }
    // A loan remains a real owner when the context drops its cache/registry;
    // this reads an old immutable snapshot, it does not adopt it as a new view.
    const old=create(visible[0],0);abi.loadManifest(manifest)
    finish(old,visible[0].expected,4096,'retired-source-loan',1);destroy(old)
    assert.strictEqual(call('handles'),0)
    records.inputHeightRanges=fixtures.map(f=>({resourceId:f.draw.resourceId,minimum:f.minimumHeight,maximum:f.maximumHeight}))
    console.log('Wasm fused exact faces:',kernelCases,'frozen kernels,',comparisons,'real CBDAM cases, mixed/frozen loans, joint grants, memory growth and cancellation passed')
  }finally{
    for(const task of tasks)call('destroy',task)
    for(const p of [...pointers])free(p)
    abi.destroy()
  }
  assert.strictEqual(module.call('test_projection_handles'),0);assert.strictEqual(abi.nativeAllocations.size,0)
  if(process.argv[4])fs.writeFileSync(process.argv[4],JSON.stringify({schema:'terra.native-exact-face-contract.v1',
    scope:'Selected exact-face core; already-owned sources/layout; excludes block selection, canonical imagery inputs/planning, host mirrors, Worker, GPU and network',
    kernelCases,comparisons,fixtureWorkLimit:limit,background:records.background,inputHeightRanges:records.inputHeightRanges,records,rawAbiAllocationsAfterDestroy:abi.nativeAllocations.size,
    workHandlesAfterDestroy:module.call('test_projection_handles')},null,2)+'\n')
}
main().catch(error=>{console.error(error);process.exitCode=1})
