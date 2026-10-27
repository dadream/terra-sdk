const assert=require('assert'),fs=require('fs'),path=require('path')
const {MessageChannel,receiveMessageOnPort}=require('worker_threads')
const loader=require('../../adapters/wasm/terra_wasm')
const {TerraAbi}=require('../../adapters/wasm/terra_abi')
const {preparedSurfaceBytes}=require('../../adapters/wasm/prepared_surface')
const {NativeMeasurementRows}=require('../../adapters/wasm/native_surface_measurement')
const {MeasurementSender,MeasurementReceiver}=require('../../adapters/wasm/measurement_transport')
const {transferList}=require('../../adapters/wasm/terra_worker_host')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {MeasurementKernel,releaseMeasurements}=require('../../sdk/js/terrain/measurement_rows')
const {ImageryInputWorkspace}=require('../../sdk/js/resources/imagery_input_workspace')
const surface=require('../../sdk/js/terrain/terra_surface_plan')
const {invertMatrix4}=require('../../sdk/js/math/matrix')

function drain(iterator){let next;do{next=iterator.next()}while(!next.done);return next.value}
function equal(a,b,label) {
  assert(a===b||Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1e-8,Math.abs(a)*1e-9),label+': '+a+' / '+b)
}
module.exports=async function verifyNativeSurfaceMeasurements(module) {
  const abi=new TerraAbi(module),ledger=new ResourceLedger(128*1024*1024),records=[],models=[],measurements=[],snapshots=[]
  const sender=new MeasurementSender(),receiver=new MeasurementReceiver(ledger),kernel=new MeasurementKernel(ledger)
  const channel=new MessageChannel(),original=module.call,operations=[]
  const root=path.resolve(__dirname,'../../testdata/miniprogram/golden')
  const names=new Map(JSON.parse(fs.readFileSync(path.join(root,'terrain_wait_records.json'))).map(r=>[[r[0],...r.slice(1,5)].join('/'),r[5]]))
  const descriptor={kind:'global-geodetic',matrix_level_offset:0,minimum_level:0,maximum_level:8,
    tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]}
  const manifest={formatVersion:1,patchDimension:64,transform:'cylindrical',heightScale:1/64,
    minimumU:-180,minimumV:-90,maximumU:180,maximumV:90,radius:6378000,texture:descriptor}
  let cases=0,visibleOblique=0,projectiveCases=0,plan
  const refinement=[]
  module.call=function(name,...args){operations.push(name);return original.call(this,name,...args)}
  try {
    abi.loadManifest(manifest)
    abi.setViewport(640,360,Math.PI/6);abi.setGlobeTarget(-90,20);abi.setCamera({distance:18000000,tiltRadians:0,yawRadians:0})
    const budget={maximumChangeCount:16,maximumPriorityUpdateCount:256,maximumElapsedMs:0}
    abi.updateStep(1,budget)
    for(const r of abi.getRequests()) {
      const file=names.get([r.kind,r.key.level,r.key.i,r.key.j,r.key.k].join('/'));assert(file)
      abi.submitRecord(r.kind,r.key,fs.readFileSync(path.join(root,file)))
    }
    const packet=abi.prepareMeshFrame(1,budget);plan=packet.nativePlan.id
    abi.setResourceLedger(ledger)
    const indices=abi.getIndices(),fixtures=[],initialMesh=abi.meshPayloadBytes()
    for(const draw of new Map(packet.draws.map(d=>[d.resourceId,d])).values()) {
      const sample=await abi.createPreparedSurfaceTask(plan,draw,preparedSurfaceBytes(draw)).run()
      const model=surface.prepareSurface(sample.positions,sample.textureUv,indices,draw.firstIndex,draw.indexCount)
      const mid=(21*65-21*20/2+21)*3,world=draw.origin.map((v,i)=>v+sample.positions[mid+i])
      const target=[Math.atan2(world[0],world[2])*180/Math.PI,Math.atan2(world[1],Math.hypot(world[0],world[2]))*180/Math.PI]
      const context=surface.projectionContext(packet.frame,{width:640,height:360},invertMatrix4(packet.frame.projectionView))
      if(surface.measureSurface(model,draw.origin,context).visible)fixtures.push({draw,model,target})
    }
    assert(fixtures.length>=2)
    require('./native_measurement_production_contract')(abi,ledger,fixtures[0],
      surface.projectionContext(packet.frame,{width:640,height:360},invertMatrix4(packet.frame.projectionView)),plan)
    await require('./native_input_batch_contract')(abi,ledger,fixtures[0],
      surface.projectionContext(packet.frame,{width:640,height:360},invertMatrix4(packet.frame.projectionView)),plan)
    await require('./native_model_reuse_contract')(abi,ledger,fixtures,
      surface.projectionContext(packet.frame,{width:640,height:360},invertMatrix4(packet.frame.projectionView)),plan)
    await require('./native_measurement_capacity_contract')(abi,fixtures[0].draw,
      surface.projectionContext(packet.frame,{width:640,height:360},invertMatrix4(packet.frame.projectionView)),plan)
    for(const fixture of fixtures.slice(0,2)) {
      const native=await abi.createNativeSurfaceModelTask(fixture.draw,{planId:plan,maximumOperations:31,maximumMilliseconds:0}).run()
      models.push(native)
      for(const [label,distance,tilt,dpr] of [['global',18000000,0,1],['oblique',1000000,-1.2,1],
        ['grazing',100000,-1.49,1],['dpr',100000,-1.49,2]]) {
        abi.setGlobeTarget(...fixture.target);abi.setCamera({distance,tiltRadians:tilt,yawRadians:1.1})
        const frame=abi.getCameraSnapshot(),context=surface.projectionContext(frame,{width:640,height:360,devicePixelRatio:dpr},invertMatrix4(frame.projectionView))
        for(const tight of [false,true]) {
          const expected=drain(surface.surfaceMeasurements(fixture.model,fixture.draw.origin,context,false,tight))
          const actual=await abi.createNativeSurfaceMeasurementTask(native,context,{tight,viewRevision:cases+1,sourceRevision:7,
            maximumOperations:47,maximumMilliseconds:0}).run()
          measurements.push(actual.regions)
          assert(actual.regions instanceof NativeMeasurementRows)
          assert.strictEqual(actual.visible,expected.visible);assert.strictEqual(actual.refinable,expected.refinable)
          equal(actual.pixelsPerUv,expected.pixelsPerUv,'summary');assert.strictEqual(actual.viewRevision,cases+1)
          const work=sender.begin([{resourceId:fixture.draw.resourceId,...actual}],[fixture.draw.resourceId])
          const credit=ledger.reserve('fixture-mirror-wire',work.bytes);assert(credit)
          work.grant(work.bytes)
          while(!work.step(73).done){}
          const packet=work.packet();channel.port1.postMessage(packet,transferList(packet));work.commit()
          actual.regions.close() // Sender's explicit loan, not this initial result, now keeps production input alive.
          const values=receiver.receive(receiveMessageOnPort(channel.port2).message,credit);snapshots.push(values)
          const packed=values[0].regions
          assert.strictEqual(packed.length,expected.regions.length)
          for(let i=0;i<packed.length;++i) {
            const row=expected.regions[i],b=row.uv
            for(const cell of [b,{minimumU:b.minimumU,maximumU:(b.minimumU+b.maximumU)/2,
              minimumV:b.minimumV,maximumV:(b.minimumV+b.maximumV)/2}])
              equal(kernel.error(packed,i,cell),surface.regionError(row,cell),'local pixel density')
          }
          const draw=new (require('../../sdk/js/imagery/terra_imagery_adapter').ImageryAdapter)(descriptor).prepareDraw(fixture.draw)
          const options={descriptor,targetPixelError:1.25,maximumTextures:64,maximumDraws:512,detached:true}
          const before=operations.length
          const planned=abi.planImagery([draw],()=>actual,options)
          const calls=operations.slice(before)
          assert(calls.includes('terra_append_measured_imagery_surface'))
          assert(!calls.includes('terra_append_imagery_regions'),'Native canonical input was repacked through JS')
          const oracle=abi.createImageryPlanner()
          try {
            const reference=oracle.plan([draw],()=>({...expected,bounds:fixture.model.bounds,hull:fixture.model.hull}),options)
            const signature=p=>p.draws.map(d=>[d.texture.level,d.texture.row,d.texture.column].join('/')).sort()
            assert.deepStrictEqual(signature(planned),signature(reference),'Canonical handoff changed the imagery cut')
          }finally{oracle.destroy()}
          const projective=Array.from({length:packed.length},(_,i)=>Boolean(packed.flags(i)&1)).filter(Boolean).length
          if(label==='global'&&!tight) {
            const code=packed.domain(0)
            const selected=await abi.createNativeSurfaceMeasurementTask(native,context,{domains:[code],maximumOperations:17}).run()
            measurements.push(selected.regions)
            assert(selected.visible&&selected.regions.length===1,'Selected native root domain was not measured independently')
            const row=new Uint8Array(176);selected.regions.copyTo(row)
            assert.strictEqual(new DataView(row.buffer).getUint32(172,true),code)
            selected.regions.close()
            await assert.rejects(abi.createNativeSurfaceMeasurementTask(native,context,{domains:Array(257).fill(0)}).run(),
              /Invalid native measurement domains/)
          }
          if(['oblique','grazing'].includes(label)&&actual.visible&&packed.length)++visibleOblique
          if(projective)++projectiveCases
          records.push({label,tight,regions:packed.length,projective,visible:actual.visible,imageryNodes:planned.draws.length})
          releaseMeasurements(values);receiver.clear();sender.clear();actual.regions.close();abi.resetImagery()
          ++cases
        }
      }
      refinement.push(...await require('./native_surface_refinement_contract')(abi,fixture,native,plan,
        fixtures.find(value=>value!==fixture).draw,descriptor,ledger))
      native.close()
    }
    assert(visibleOblique>0,'No actually visible grazing terrain was compared')
    assert(projectiveCases>0,'Native wire/normalization compared only scalar bounds')
    assert.strictEqual(abi.meshPayloadBytes(),initialMesh,'Native measurement materialized candidate XYZ/UV')
    // The remote-credit lane advertises every metadata/arena/page stage before
    // allocation. A cancelled grant which was not consumed is still receipted.
    let current,id=0
    const stages=[],grants=new Map()
    const workspace=()=>{current=new ImageryInputWorkspace(++id);stages.push(current);return current}
    function finishStages() {
      for(const stage of stages)if(stage.finished&&grants.has(stage.id)) {
        abi.imageryInputBudget.finish(grants.get(stage.id));grants.delete(stage.id)
      }
    }
    function grantStage() {
      const quote=current.quote();assert(quote)
      const held=abi.imageryInputBudget.begin(quote.bytes);assert(held);grants.set(current.id,held)
      current.grant(quote)
    }
    function runRemote(task) {
      task.maximumSteps=1
      for(let turn=0;turn<10000;++turn) {
        const result=task.step();finishStages()
        if(result.done){assert(!grants.size);return result.value}
        if(result.waiting)grantStage()
      }
      assert.fail('Remote native production did not converge')
    }
    const remoteModel=runRemote(abi.createNativeSurfaceModelTask(fixtures[0].draw,
      {planId:plan,inputWorkspace:workspace,maximumOperations:19}));models.push(remoteModel)
    abi.setGlobeTarget(...fixtures[0].target);abi.setCamera({distance:1000000,tiltRadians:-1.2,yawRadians:1.1})
    const remoteFrame=abi.getCameraSnapshot(),remoteContext=surface.projectionContext(remoteFrame,
      {width:640,height:360},invertMatrix4(remoteFrame.projectionView)),firstStage=stages.length
    const remoteResult=runRemote(abi.createNativeSurfaceMeasurementTask(remoteModel,remoteContext,
      {inputWorkspace:workspace,maximumOperations:37}));measurements.push(remoteResult.regions)
    assert(remoteResult.visible&&remoteResult.regions.length&&stages.length-firstStage>=4,
      'Remote measurement did not fund projection and canonical input separately')
    remoteResult.regions.close()
    const cancelledWork=abi.createNativeSurfaceMeasurementTask(remoteModel,remoteContext,{inputWorkspace:workspace})
    cancelledWork.maximumSteps=1
    assert(cancelledWork.step().waiting);grantStage()
    assert(cancelledWork.step().waiting);finishStages();grantStage()
    cancelledWork.cancel();assert(current.finished);finishStages();assert(!grants.size)
    remoteModel.close()
    const cancelled=abi.createNativeSurfaceModelTask(fixtures[0].draw,{planId:plan,inputWorkspace:workspace})
    assert(cancelled.step().waiting);const quote=current.quote(),held=abi.imageryInputBudget.begin(quote.bytes)
    current.grant(quote);cancelled.cancel();assert(current.finished)
    abi.imageryInputBudget.finish(held)
    // The ready model owns frozen sampling; discarding the candidate does not
    // turn it into a live-current lookup. Sealed numbers subsequently outlive it.
    const frozen=await abi.createNativeSurfaceModelTask(fixtures[0].draw,{planId:plan}).run();models.push(frozen)
    abi.discardMeshPlan({id:plan});plan=null
    abi.setGlobeTarget(...fixtures[0].target);abi.setCamera({distance:1000000,tiltRadians:-1.2,yawRadians:1.1})
    const frame=abi.getCameraSnapshot(),context=surface.projectionContext(frame,{width:640,height:360},invertMatrix4(frame.projectionView))
    const frozenResult=await abi.createNativeSurfaceMeasurementTask(frozen,context).run();measurements.push(frozenResult.regions)
    const expected=drain(surface.surfaceMeasurements(fixtures[0].model,fixtures[0].draw.origin,context))
    assert(frozenResult.visible&&frozenResult.regions.length,'Discarded candidate tested only invisible sampling')
    assert.strictEqual(frozenResult.visible,expected.visible);assert.strictEqual(frozenResult.regions.length,expected.regions.length)
    frozen.close()
    if(frozenResult.regions.length)frozenResult.regions.copyTo(new Uint8Array(176),0,0,1)
    abi.loadManifest(manifest)
    assert.throws(()=>frozenResult.regions.copyTo(new Uint8Array(176),0,0,Math.min(1,frozenResult.regions.length)),
      /Native measurement loan has ended/)
    assert.strictEqual(abi.nativeSurfaceOwners.size,0,'Manifest reset retained native production owners')
  }finally {
    for(const values of snapshots)releaseMeasurements(values)
    receiver.clear();sender.clear();for(const rows of measurements)rows.close();for(const model of models)model.close()
    kernel.close();channel.port1.close();channel.port2.close()
    if(plan)abi.discardMeshPlan({id:plan})
    abi.destroy();module.call=original
  }
  assert.strictEqual(abi.nativeAllocations.size,0);assert.strictEqual(abi.nativeSurfaceOwners.size,0)
  assert.strictEqual(ledger.bytes,0,JSON.stringify(ledger.stats().owners))
  console.log('Wasm native measurement production: canonical loans, direct planning, packed transfer, visible oblique parity and remote stage receipts passed',JSON.stringify({cases,visibleOblique,projectiveCases}))
  console.log('Native selective refinement: complete scalar/projective/bounds merging, exact identity, no-copy projective reuse and loans passed',JSON.stringify(refinement))
  await require('./native_planar_preparation_contract')(module)
  await require('./native_request_lifetime_contract')(module)
  return {cases,visibleOblique,projectiveCases,records,refinement}
}
if(require.main===module)(async()=>{
  const wasm=await loader.instantiateTerraWasmBytes(fs.readFileSync(process.argv[2]))
  const result=await module.exports(wasm)
  if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n')
  return result
})().catch(error=>{console.error(error.stack);process.exitCode=1})
