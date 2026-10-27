const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto')
const {createRequire}=require('module')
const loader=require('../../adapters/wasm/terra_wasm'),{TerraAbi}=require('../../adapters/wasm/terra_abi')
const {preparedSurfaceBytes}=require('../../adapters/wasm/prepared_surface')
const {prepareSurface}=require('../../sdk/js/terrain/surface_preparation')
const {splitSurfaceBlock}=require('../../sdk/js/terrain/surface_blocks')
const {invertMatrix4:inverse}=require('../../sdk/js/math/matrix')
const {compactRegions}=require('../js/reference/compact_regions_reference')
const limit=32*1024*1024
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function drain(work){let p;do{p=work.next()}while(!p.done);return p.value}
function equal(a,b,label) {
  if(a===0&&b===0){assert(Object.is(a,b),label+' signed zero');return}
  assert(Object.is(a,b)||Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-10,Math.abs(a)*1e-10),label+': '+a+' / '+b)
}
function code(root,path){return root*21+(path.length===0?0:path.length===1?1+path[0]*5:2+path[0]*5+path[1])}
// Execute the actual JS selection/math with private provenance instrumentation
// and the frozen compactor. This shim changes no numeric or visibility rule.
function referenceModule() {
  const file=path.resolve(__dirname,'../../sdk/js/terrain/terra_surface_plan.js'),localRequire=createRequire(file)
  const provenance=new WeakMap(),roots=new WeakMap(),output={exports:{}};let rawCount=0
  function requireReference(name) {
    if(name==='./measurement_domains')return {
      measurementRoot:block=>roots.get(block),
      rememberDomain:(region,root,child)=>{assert(root);provenance.set(region,code(root.root,root.path.concat(child)));return region}}
    if(name==='./surface_regions')return Object.assign({},localRequire(name),{
      compactRegions:function*(rows){rawCount=rows.length;return yield* compactRegions(rows)}})
    return localRequire(name)
  }
  vm.runInThisContext('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',{filename:file})(requireReference,output,output.exports)
  return {api:output.exports,provenance,roots,measure(model,origin,context,bounds,tight){
    rawCount=0;const value=drain(output.exports.surfaceMeasurements(model,origin,context,bounds,tight));
    return {value,raw:bounds?value.regions.length:rawCount}
  }}
}
async function main() {
  const reference=referenceModule(),imports=loader.createTerraImports();let time=0
  imports.env.terra_monotonic_milliseconds=()=>++time
  const module=loader.initializeTerraInstance(await WebAssembly.instantiate(fs.readFileSync(process.argv[2]),imports),imports)
  const abi=new TerraAbi(module),pointers=new Set(),models=new Set(),records=[],fixtures=[]
  const alloc=n=>{const p=abi.alloc(n);pointers.add(p);return p},free=p=>{abi.free(p);pointers.delete(p)}
  const call=(name,...args)=>module.call('test_model_'+name,...args)
  const info=alloc(64),out=alloc(256*208),summary=alloc(56),matrixPointer=alloc(128)
  const integers=n=>{const v=module.refreshMemory().dataView;return Array.from({length:n},(_,i)=>v.getUint32(info+i*4,true))}
  const modelStep=(task,n=4096,ms=0)=>{call('step',task,n,ms,info);const p=integers(12);assert(p[1]<=n&&p[2]<10000000);return p}
  const measureStep=(task,n=4096,ms=0)=>{call('measure_step',task,n,ms,info);const p=integers(10);assert(p[1]<=n&&p[2]<10000000);return p}
  const destroy=task=>{call('destroy',task);models.delete(task)}
  const fixtureRoot=path.resolve(__dirname,'../../testdata/miniprogram/golden')
  const table=new Map(JSON.parse(fs.readFileSync(path.join(fixtureRoot,'terrain_wait_records.json'))).map(r=>[[r[0],...r.slice(1,5)].join('/'),r[5]]))
  const recordFor=r=>table.get([r.kind,r.key.level,r.key.i,r.key.j,r.key.k].join('/'))
  const manifest={formatVersion:1,patchDimension:64,transform:'cylindrical',heightScale:1/64,
    minimumU:-180,minimumV:-90,maximumU:180,maximumV:90,radius:6378000,
    texture:{kind:'global-geodetic',matrix_level_offset:0,minimum_level:0,maximum_level:8,
      tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]}}
  const budget={maximumChangeCount:16,maximumPriorityUpdateCount:256,maximumElapsedMs:0}
  let backgroundHeightBuilds=0,subdivisionCases=0,coarseCases=0,selectiveCases=0
  try {
    abi.loadManifest(manifest);abi.setViewport(640,360,Math.PI/6)
    abi.setGlobeTarget(-90,20);abi.setCamera({distance:18000000,tiltRadians:0,yawRadians:0})
    abi.updateStep(1,budget)
    for(const r of abi.getRequests()){const file=recordFor(r);assert(file);abi.submitRecord(r.kind,r.key,fs.readFileSync(path.join(fixtureRoot,file)))}
    const packet=abi.prepareMeshFrame(1,budget),plan=packet.nativePlan.id,indices=abi.getIndices(),meshBefore=abi.meshPayloadBytes()
    for(const draw of new Map(packet.draws.map(d=>[d.resourceId,d])).values()) {
      const mesh=await abi.createPreparedSurfaceTask(plan,draw,preparedSurfaceBytes(draw)).run()
      const model=prepareSurface(mesh.positions,mesh.textureUv,indices,draw.firstIndex,draw.indexCount)
      model.blocks.forEach((block,i)=>reference.roots.set(block,{root:i,path:[]}))
      let minimum=Infinity,maximum=-Infinity
      for(let i=0;i<mesh.positions.length;i+=3){const h=Math.hypot(mesh.positions[i]+draw.origin[0],mesh.positions[i+1]+draw.origin[1],mesh.positions[i+2]+draw.origin[2])-manifest.radius;minimum=Math.min(minimum,h);maximum=Math.max(maximum,h)}
      const centerIndex=(21*65-21*20/2+21)*3
      const center=Array.from({length:3},(_,i)=>mesh.positions[centerIndex+i]+draw.origin[i])
      const target=[Math.atan2(center[0],center[2])*180/Math.PI,Math.atan2(center[1],Math.hypot(center[0],center[2]))*180/Math.PI]
      fixtures.push({draw,model,minimum,maximum,target})
    }
    const visible=fixtures.filter(f=>reference.api.measureSurface(f.model,f.draw.origin,reference.api.projectionContext(packet.frame,{width:640,height:360},inverse(packet.frame.projectionView))).visible)
      .sort((a,b)=>(b.maximum-b.minimum)-(a.maximum-a.minimum)).slice(0,2)
    assert(visible.length===2&&visible.some(f=>f.maximum-f.minimum>4),'Nonflat real CBDAM input missing')
    const create=(f,planId=plan,reuse=0)=>{const task=call('create',abi.context,planId,f.draw.resourceId,limit,reuse);if(task)models.add(task);return task}
    const finishModel=(task,f,quantum,resident)=>{
      assert(task);let p=modelStep(task,0),quote=p[3]
      assert.strictEqual(call('block',task,limit-p[5]-p[6]-quote+1),1)
      assert.strictEqual(call('admit',task,0),0);assert.strictEqual(modelStep(task,quantum)[1],0);assert.strictEqual(call('block',task,0),1)
      assert.strictEqual(call('admit',task,0),1)
      const timed=modelStep(task,1000000,1e-9);assert(timed[1]>0&&timed[1]<=64)
      do{p=modelStep(task,quantum);assert([1,2].includes(p[0]),'Model status '+p[0])}while(p[0]!==2)
      assert.strictEqual(p[4],0);assert.strictEqual(p[5],0);assert(p[6]>0);assert.strictEqual(p[11],resident)
      assert.strictEqual(p[7]*3,f.model.faces.length);assert.strictEqual(p[8],f.model.blocks.reduce((n,b)=>n+b.faces.length,0))
      assert.strictEqual(p[9],f.model.blocks.length);assert.strictEqual(p[10],f.model.hull.length)
      for(let first=0;first<f.model.faces.length;first+=256){const count=call('read',task,0,first,256,out),v=module.refreshMemory().dataView
        assert.strictEqual(count,Math.min(256,f.model.faces.length-first));for(let i=0;i<count;++i)assert.strictEqual(v.getUint16(out+i*2,true),f.model.faces[first+i])}
      const expectedOrder=f.model.blocks.flatMap(b=>b.faces.map(x=>x/3))
      for(let first=0;first<expectedOrder.length;first+=256){const count=call('read',task,1,first,256,out),v=module.refreshMemory().dataView
        for(let i=0;i<count;++i)assert.strictEqual(v.getUint32(out+i*4,true),expectedOrder[first+i])}
      assert.strictEqual(call('read',task,2,0,256,out),f.model.hull.length);let v=module.refreshMemory().dataView
      f.model.hull.flat().forEach((x,i)=>equal(x,v.getFloat64(out+i*8,true),'hull '+i))
      assert.strictEqual(call('read',task,3,0,256,out),f.model.blocks.length);v=module.refreshMemory().dataView
      let first=0
      f.model.blocks.forEach((b,i)=>{const values=[b.uv.minimumU,b.uv.minimumV,b.uv.maximumU,b.uv.maximumV,first,b.faces.length,b.winding,
        ...b.minimum,...b.maximum,...b.du,...b.dv,...b.duRadius,...b.dvRadius,b.deviation];first+=b.faces.length
        values.forEach((x,j)=>equal(x,v.getFloat64(out+i*208+j*8,true),'block '+i+' field '+j))})
      return {operations:p[2],quote,residentBytes:p[6]}
    }
    const matrices=[]
    for(const [distance,tilt,yaw] of [[18000000,0,0],[6000000,0,0],[3000000,-1.2,0.3],[800000,-1.5,-0.6]]) {
      abi.setCamera({distance,tiltRadians:tilt,yawRadians:yaw});matrices.push({label:[distance,tilt,yaw].join('/'),matrix:abi.getCameraSnapshot().projectionView})
    }
    function measure(task,f,camera,tight,quantum,boundsOnly=false,domains=[]) {
      const matrix=camera.matrix;let v=module.refreshMemory().dataView;matrix.forEach((x,i)=>v.setFloat64(matrixPointer+i*8,x,true))
      const domainPointer=domains.length?alloc(domains.length*4):0
      try {
        if(domainPointer){v=module.refreshMemory().dataView;domains.forEach((x,i)=>v.setUint32(domainPointer+i*4,x,true))}
        assert.strictEqual(call('measure',task,matrixPointer,320,180,Number(tight)|Number(boundsOnly)<<1,domainPointer,domains.length),1)
      }finally{if(domainPointer)free(domainPointer)}
      let model=f.model
      if(domains.length) {
        const selected=domains.map(c=>{const root=Math.floor(c/21),local=c%21,path=local===0?[]:(local-1)%5===0?[Math.floor((local-1)/5)]:[Math.floor((local-2)/5),(local-2)%5]
          let block=model.blocks[root];for(const i of path)block=drain(splitSurfaceBlock(model,block))[i]
          reference.roots.set(block,{root,path});return block})
        model=Object.assign({},model,{blocks:selected})
      }
      const context=reference.api.projectionContext({projectionView:matrix},{width:640,height:360},inverse(matrix))
      const expected=reference.measure(model,f.draw.origin,context,boundsOnly,tight)
      let p=measureStep(task,0),subdivisions=0,peakActual=0,peakAuthorized=0
      while(p[0]!==5) {
        if(p[3]) {
          assert.strictEqual(call('block',task,limit-p[8]-p[9]-p[3]+1),1)
          assert.strictEqual(call('admit',task,1),0);assert.strictEqual(measureStep(task,quantum)[1],0);assert.strictEqual(call('block',task,0),1)
          if(p[0]===12)++subdivisions
          assert.strictEqual(call('admit',task,1),1)
        }else assert([1,3,4].includes(p[0]),'Measurement status '+p[0])
        p=measureStep(task,quantum);peakActual=Math.max(peakActual,p[6]);peakAuthorized=Math.max(peakAuthorized,p[7])
      }
      const e=expected.value;assert.strictEqual(p[4],expected.raw,'raw count');assert.strictEqual(p[5],e.regions.length,'compact count')
      if(camera.enforceVisible)assert(e.visible&&expected.raw>0&&e.regions.length>0,'Targeted camera missed actual terrain: '+camera.label)
      assert.strictEqual(p[6],p[7]);assert.strictEqual(p[8],p[7]);call('summary',task,summary);v=module.refreshMemory().dataView
      assert.strictEqual(Boolean(v.getUint32(summary,true)),e.visible);assert.strictEqual(Boolean(v.getUint32(summary+4,true)),e.refinable)
      equal(e.pixelsPerUv,v.getFloat64(summary+40,true),'pixelsPerUv');equal(e.centerDistance,v.getFloat64(summary+48,true),'centerDistance')
      if(e.visible&&e.regions.length)[e.uv.minimumU,e.uv.minimumV,e.uv.maximumU,e.uv.maximumV].forEach((x,i)=>equal(x,v.getFloat64(summary+8+i*8,true),'UV summary '+i))
      for(let first=0;first<e.regions.length;first+=256) {
        const count=call('measure_read',task,first,256,out);assert.strictEqual(count,Math.min(256,e.regions.length-first));v=module.refreshMemory().dataView
        for(let i=0;i<count;++i) {
          const row=e.regions[first+i],flags=(row.projection?1:0)|(row.triangle?2:0)|(row.numeratorBound===undefined?0:4),offset=out+i*176
          assert.strictEqual(v.getUint32(offset,true),flags,'flags');assert.strictEqual(v.getUint32(offset+4,true),reference.provenance.has(row)?reference.provenance.get(row):0xffffffff,'domain')
          const values=[row.uv.minimumU,row.uv.minimumV,row.uv.maximumU,row.uv.maximumV,row.pixelsPerUv,
            ...(row.projection||Array(9).fill(0)),...(row.triangle?row.triangle.flat():Array(6).fill(0)),row.numeratorBound===undefined?-1:row.numeratorBound]
          values.forEach((x,j)=>equal(x,v.getFloat64(offset+8+j*8,true),'region '+(first+i)+' field '+j))
        }
      }
      const scalarDomains=e.regions.filter(r=>reference.provenance.has(r)).map(r=>reference.provenance.get(r))
      assert.strictEqual(call('input',task),1,'Same-side canonical input, short grant, normalization and loan release')
      if(subdivisions)++subdivisionCases
      if(!tight&&!boundsOnly&&scalarDomains.length)++coarseCases
      if(domains.length)++selectiveCases
      records.push({resource:f.draw.resourceId,camera:camera.label,tight,boundsOnly,domains,quantum,subdivisions,operations:p[2],rawCount:p[4],outputCount:p[5],peakActualBytes:peakActual,peakAuthorizedBytes:peakAuthorized,canonicalInputVerified:true})
      call('measure_cancel',task);assert.strictEqual(measureStep(task,1)[0],6);assert.strictEqual(measureStep(task,1)[8],0)
      return scalarDomains
    }
    for(const f of visible) {
      const task=create(f);const stats=finishModel(task,f,7,0)
      const duplicate=create(f,plan,task);const reused=finishModel(duplicate,f,4096,0)
      assert.strictEqual(call('same_layout',task,duplicate),1);assert(reused.operations<stats.operations&&reused.quote<stats.quote)
      destroy(duplicate)
      for(const camera of matrices)for(const tight of [false,true]) {
        const domains=measure(task,f,camera,tight,64)
        if(!tight&&domains.length)measure(task,f,camera,true,7,false,domains.slice(0,2))
      }
      measure(task,f,matrices[0],false,4096,true)
      // Oblique/near cases must hit the mesh interior. A culled old root is a
      // useful negative case, but cannot prove grazing-view correctness.
      abi.setGlobeTarget(...f.target)
      for(const [distance,tilt] of [[1000000,-1.2],[100000,-1.49]]) {
        abi.setCamera({distance,tiltRadians:tilt,yawRadians:0.3})
        const camera={label:'targeted/'+distance+'/'+tilt,matrix:abi.getCameraSnapshot().projectionView,enforceVisible:true}
        for(const tight of [false,true])measure(task,f,camera,tight,64)
      }
      abi.setGlobeTarget(-90,20)
      module.exports.memory.grow(1)
      for(let i=0;i<6;++i) {
        for(const r of abi.getRequests()){const file=recordFor(r);if(file)abi.submitRecord(r.kind,r.key,fs.readFileSync(path.join(fixtureRoot,file)));else if(r.kind===2)abi.noDataRecord(r.key);else assert.fail('Missing root fixture')}
        backgroundHeightBuilds+=abi.advanceTerrain(0.005,budget).heightBuildCount
      }
      measure(task,f,matrices[0],true,1);destroy(task)
    }
    assert(backgroundHeightBuilds>0&&subdivisionCases>0&&coarseCases>0&&selectiveCases>0,'Missing actual difficult/coarse/selective/background branch')
    assert.strictEqual(abi.meshPayloadBytes(),meshBefore,'Model materialized candidate XYZ')
    const producer=abi.createMeshTask(packet);producer.maximumSteps=1;assert.strictEqual(producer.step().done,false)
    const resident=fixtures.find(f=>module.call('terra_get_mesh_position_view',abi.context,f.draw.resourceId)),sampled=visible.find(f=>!module.call('terra_get_mesh_position_view',abi.context,f.draw.resourceId))
    assert(resident&&sampled,'Missing actual mixed source')
    for(const f of [resident,sampled]){const task=create(f);finishModel(task,f,64,Number(f===resident));measure(task,f,matrices[2],true,4096);destroy(task)}
    await producer.run();abi.commitMeshFrame(packet)
    const old=create(visible[0],0);assert(old);assert.strictEqual(create(visible[0],plan),0)
    finishModel(old,visible[0],4096,1);abi.loadManifest(manifest);measure(old,visible[0],matrices[2],true,4096);destroy(old)
  }finally {
    for(const task of models)call('destroy',task)
    for(const pointer of [...pointers])free(pointer)
    abi.destroy()
  }
  assert.strictEqual(call('handles'),0);assert.strictEqual(abi.nativeAllocations.size,0)
  const report={schema:'terra.native-surface-model-contract.v1',scope:'Native model and whole selection/compaction, actual nonflat CBDAM; no product Web/Worker integration, GPU or live services',
    comparisons:records.length,subdivisionCases,coarseCases,selectiveCases,backgroundHeightBuilds,
    inputHeightRanges:fixtures.map(f=>({resourceId:f.draw.resourceId,minimum:f.minimum,maximum:f.maximum})),records,
    references:['../../sdk/js/terrain/terra_surface_plan.js','../../sdk/js/terrain/surface_preparation.js','../../sdk/js/terrain/surface_blocks.js','../js/reference/compact_regions_reference.js']
      .map(file=>({file,sha256:hash(path.resolve(__dirname,file))})),rawAbiAllocationsAfterDestroy:abi.nativeAllocations.size,workHandlesAfterDestroy:call('handles')}
  if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n')
  console.log('Wasm native surface model:',records.length,'actual whole-model comparisons, lazy/shallow/selective, UV reuse, real loans, grants and cancellation passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})
