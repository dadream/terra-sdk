#!/usr/bin/env node
'use strict'
const fs=require('fs'),path=require('path'),os=require('os')
const {spawn,execFileSync}=require('child_process'),{createInterface}=require('readline')
const {validate,route,argumentsFor,commandFor}=require('../tests/benchmarks/headless_scheduling/case')
const {compare,roundtrip}=require('../tests/benchmarks/headless_scheduling/compare')
const {Records,digest,datasetIdentity}=require('../tests/benchmarks/headless_scheduling/records')
const {deriveFrameBudget,terrainResourceBudget}=require('../sdk/js/core/terra_globe_common')
const {createResourcePolicy}=require('../sdk/js/resources/resource_policy')
const imagery=require('../tests/benchmarks/headless_scheduling/imagery')
const {verifyReferenceCamera}=require('../tests/benchmarks/headless_scheduling/camera')
const root=path.resolve(__dirname,'..')
const assert=(value,message)=>{if(!value)throw new Error(message)}

function fingerprint(binary,caseFile) {
  const files=new Set(['CMakeLists.txt','cmake/CompilerOptions.cmake',path.relative(root,caseFile),
    'scripts/benchmark_headless_scheduling.js','scripts/verify_baseline.sh'])
  files.add('testdata/benchmarks/taian-terrain-v2.json')
  files.add('testdata/benchmarks/taian-oblique-camera-v1.json')
  const visit=directory=>{
    for(const entry of fs.readdirSync(path.join(root,directory),{withFileTypes:true})) {
      const file=path.join(directory,entry.name)
      if(entry.isDirectory())visit(file)
      else if(entry.isFile()&&/\.(?:cpp|hpp|h|c|js|txt|cmake)$/.test(entry.name))files.add(file)
    }
  }
  for(const directory of ['cmake','sdk','tests/benchmarks','adapters/wasm','spacelib/src/sl',
    'ratman/ratman/src/vic/cbdam/base'])visit(directory)
  const rows=[...files].sort().map(file=>({file,sha256:digest(fs.readFileSync(path.join(root,file)))}))
  return {sourceSha256:digest(Buffer.from(JSON.stringify(rows))),files:rows,binarySha256:digest(fs.readFileSync(binary))}
}

async function runBackend(binary,config,backend,commands,records,signal,onResult) {
  signal.throwIfAborted()
  const child=spawn(binary,argumentsFor(config,backend),{stdio:['pipe','pipe','pipe']})
  let startupError,stderr='',ready=false,complete=false,index=0,timer,terminationTimer
  const rows=[],closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})))
  child.once('error',error=>{startupError=error})
  child.stdin.on('error',()=>{})
  child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-32768)})
  const stop=()=>{
    child.kill('SIGTERM')
    terminationTimer=setTimeout(()=>child.kill('SIGKILL'),1000)
  }
  const abort=()=>stop()
  signal.addEventListener('abort',abort,{once:true})
  const send=()=>{
    clearTimeout(timer)
    // Bounds fixture acquisition too; CPU scheduling has its own 30s active
    // watchdog. This is not a relaxation of the real Web scene acceptance gate.
    timer=setTimeout(()=>stop(),records.upstream?180000:60000)
    child.stdin.write(index<commands.length?commands[index]:'end\n')
  }
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity})
  try {
    timer=setTimeout(()=>stop(),60000)
    for await(const line of lines) {
      signal.throwIfAborted()
      const event=JSON.parse(line)
      if(event.type==='request') {child.stdin.write(await records.serve(event,signal));continue}
      if(event.type==='ready') {assert(!ready,'Duplicate ready event');ready=true;send();continue}
      assert(ready,'Native output preceded initialization')
      if(event.type==='result'||event.type==='ground'||event.type==='camera'||event.type==='frozen') {
        assert(index<commands.length,'Unexpected native result')
        rows.push(event);++index
        if(onResult)await onResult(event)
        if(event.type!=='result'||event.status==='ready')send()
        continue
      }
      if(event.type==='complete') {
        assert(index===commands.length&&event.stages===index,'Incomplete native route')
        complete=true;child.stdin.end();continue
      }
      throw new Error('Unknown native protocol event')
    }
    const exit=await closed
    if(startupError)throw startupError
    signal.throwIfAborted()
    assert((exit.code===0&&complete)||(exit.code===2&&rows.length&&rows.at(-1).status!=='ready'),
      stderr||'Native benchmark did not complete')
    return {backend,rows,exit,complete,stderr,nativeProcessClosed:true}
  } catch(error) {error.partialRows=rows;error.nativeStderr=stderr;throw error}
  finally {
    clearTimeout(timer);signal.removeEventListener('abort',abort)
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
    await closed;clearTimeout(terminationTimer);lines.close()
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy()
  }
}

async function main(argv=process.argv.slice(2)) {
  if(argv.includes('--help')) {
    console.log(`Usage: node scripts/benchmark_headless_scheduling.js --output <new-directory> [options]
  --case taian-nadir-roundtrip-v1 | taian-oblique-fixed-v1 | global-contract | global-coarsening-contract
  --case-file <json>  Default testdata/benchmarks/taian-scheduling-v1.json.
  --backend both | desktop | sdk   Default both; a single backend is diagnostic only.
  --desktop-mode runtime | target  Default runtime preserves extract_cut unchanged.
      Target completes cached-return coarse candidates using the original coarsen
      operation, at most 32 per continuation. It is a target-set reference adapter,
      not the desktop runtime or a desktop performance measurement.
  --resource-mode fixed | progressive   SDK fixed (default) discovers this route
      once, freezes exact LOD resource inputs, then measures a new persistent core.
      New required input stops with input-incomplete. Progressive measures data
      discovery too and reports changed input identities; it is a separate profile.
  --terrain-capacity demand | production  Default demand measures the cut without
      production mesh admission. Production requires SDK fixed mode and applies
      the actual current SDK mesh quota after discovery; capacity-limited stops.
  --imagery demand               Also run original desktop texture tree and SDK
      projection/planner after each measured terrain cut; fixed inputs required.
      Offline all-available nominal Tianditu grid, no image downloads or GPU.
      This measures target demand, not production admission or source availability.
  --records <records.json>        Verified supplemental captured terrain records.
  --upstream <origin>             Explicit bounded acquisition of missing terrain records.
  --binary <path>                 Default workspace_old/build/cmake/tests/benchmarks/headless_scheduling/terra_benchmark_terrain.

Terrain-core implementation stage: persistent original desktop CBDAM vs actual SDK
LOD, same projection/effective geometric error and encoded terrain. No window, GL
context, image scheduling or rendering. Desktop keeps its original recursive update
and periodic coarsening; its no-texture accessors retain a logical cut across each
update and are replaced after new accessors are acquired, without a GPU receipt.
SDK keeps 32 topology changes/256 priority updates per step.
CPU counters exclude host IPC wait; desktop data decoding is separated from total
call CPU. Maximum call CPU includes its inline decode. Wall time includes fixture
transport. Acquisition runs are not performance samples. Data ownership is fixture
and core accounting, not a production joint-memory proof. Texture/image and
Wasm/Worker stages remain separate required work.

Default is offline. An uncaptured record fails. Full Tai'an routes first sample real
ground height from the versioned data-disk fixture reference. --records overrides
that pack explicitly; --upstream starts an explicitly requested acquisition.
The requested ground spacing is 10m; actual source spacing/reasons are recorded.
No guessed/clamped camera height. Global
contract uses height zero solely for driver validation. A non-ready stage stops the
route and retains its block diagnostics. Exit 0 requires both backends, complete
routes, targets met and exact terrain/roundtrip sets; 2 means collected differences
or diagnostic-only; 1 means driver/data failure. No browser or service is started.`)
    return
  }
  const options={},allowed=new Set(['output','case','case-file','backend','desktop-mode','resource-mode','terrain-capacity','imagery','records','upstream','binary'])
  for(let i=0;i<argv.length;i+=2) {
    assert(argv[i].startsWith('--')&&allowed.has(argv[i].slice(2))&&argv[i+1], 'Invalid benchmark option')
    const key=argv[i].slice(2);assert(!(key in options),'Duplicate benchmark option');options[key]=argv[i+1]
  }
  assert(options.output,'--output is required')
  const mount=path.join(root,'viewer_verify_output')
  execFileSync('mountpoint',['-q',mount])
  const output=path.resolve(options.output)
  assert(output.startsWith(mount+path.sep),'Output must use the mounted viewer_verify_output directory')
  if(fs.existsSync(output))assert(!fs.readdirSync(output).length,'Output must be new or empty')
  fs.mkdirSync(output,{recursive:true})
  assert(fs.realpathSync(path.dirname(output)).startsWith(fs.realpathSync(mount)), 'Output leaves the data mount')
  const caseFile=path.resolve(options['case-file']||path.join(root,'testdata/benchmarks/taian-scheduling-v1.json'))
  const config=validate(JSON.parse(fs.readFileSync(caseFile)))
  const binary=path.resolve(options.binary||path.join(root,'workspace_old/build/cmake/tests/benchmarks/headless_scheduling/terra_benchmark_terrain'))
  fs.accessSync(binary,fs.constants.X_OK)
  const name=options.case||'taian-nadir-roundtrip-v1',backend=options.backend||'both'
  assert(['both','desktop','sdk'].includes(backend),'Invalid backend')
  const desktopMode=options['desktop-mode']||'runtime'
  assert(['runtime','target'].includes(desktopMode),'Invalid desktop mode')
  assert(backend!=='sdk'||desktopMode==='runtime','Desktop target mode requires a desktop backend')
  const resourceMode=options['resource-mode']||'fixed'
  assert(['fixed','progressive'].includes(resourceMode),'Invalid resource mode')
  const capacityProfile=options['terrain-capacity']||'demand'
  assert(['demand','production'].includes(capacityProfile),'Invalid terrain capacity profile')
  assert(capacityProfile==='demand'||backend==='sdk'&&resourceMode==='fixed',
    'Production capacity profile requires SDK fixed inputs')
  if(options.imagery)assert(options.imagery==='demand'&&resourceMode==='fixed'&&capacityProfile==='demand',
    'Imagery demand requires fixed terrain inputs and demand capacity')
  config.benchmarkImagery=Boolean(options.imagery)
  const imageryProfile=config.benchmarkImagery?imagery.profile(config):null
  const frameBudget=deriveFrameBudget({width:config.viewport.width,height:config.viewport.height,
    devicePixelRatio:config.viewport.devicePixelRatio},{maxTextureSize:2048},
    {terrainPixelError:config.terrainPixelError,verticalFovRadians:config.verticalFovRadians})
  // The versioned case owns its historical capacity; changing SDK defaults
  // must not silently rewrite that reference or prevent replaying it.
  const policy=createResourcePolicy({maximumResourceBytes:config.maximumManagedBytes},frameBudget)
  const terrainBudget=terrainResourceBudget(config.patchDimension,{...frameBudget,...policy},{})
  assert(policy.maximumResourceBytes===config.maximumManagedBytes,'Case shared capacity differs from SDK policy')
  config.benchmarkMeshBytes=capacityProfile==='production'?terrainBudget.meshBudgetBytes:0
  let fixtureReference
  const driverContract=['global-contract','global-coarsening-contract'].includes(name)
  if(!options.records&&!options.upstream&&!driverContract) {
    fixtureReference=JSON.parse(fs.readFileSync(path.join(root,'testdata/benchmarks/taian-terrain-v2.json')))
    assert(fixtureReference.schema==='terra.scheduling-fixture.v1','Invalid default fixture reference')
    options.records=path.join(root,fixtureReference.directory,fixtureReference.catalogue)
    assert(fs.existsSync(options.records),'Captured Tai\'an data is missing; use an explicit --upstream acquisition or --records pack')
    const pack=JSON.parse(fs.readFileSync(options.records))
    assert(datasetIdentity(pack)===fixtureReference.datasetSha256&&
      pack.fixtureSha256===fixtureReference.fixtureSha256&&pack.manifestSha256===fixtureReference.manifestSha256,
      'Default Tai\'an fixture differs from its versioned identity')
  }
  const frozen=fingerprint(binary,caseFile)
  fs.writeFileSync(path.join(output,'source-state.json'),JSON.stringify(frozen,null,2))
  fs.copyFileSync(caseFile,path.join(output,'case-input.json'))
  const report={schema:'terra.headless-scheduling.v1',status:'running',case:name,configuration:config,
    implementedScope:imageryProfile?'Terrain and imagery native target demand; executor/visualization not covered':
      'Terrain core only; imagery/controller, executor and visualization layers are not covered',
    imageryProfile,imageryComparisons:[],imageryRoundtrips:{},
    acquisition:Boolean(options.upstream),sourceSha256:frozen.sourceSha256,binarySha256:frozen.binarySha256,binaryPath:binary,
    sdkResourceMode:resourceMode,desktopResourceMode:'Original synchronous fixture discovery; no scheduler-state override; original no-texture accessors consume every changed cut',
    desktopMode,desktopTimingEligible:desktopMode==='runtime',
    capacityProfile,productionResourcePolicy:policy,productionTerrainMeshBytes:terrainBudget.meshBudgetBytes,
    fixtureReference,
    environment:{node:process.version,kernel:os.release(),architecture:os.arch(),cpu:os.cpus()[0]?.model},
    timingScope:'Child process CPU; data decode separated; maximumCallCpu includes inline desktop decode; wall includes fixture IPC/online acquisition',
    capacityScope:'Active height payload and desktop cache vectors; fixture decode retention is not production ownership; total joint capacity unknown',
    cores:{},comparisons:[],roundtrips:{},startedAt:new Date().toISOString()}
  const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
  const lifetime=new AbortController(),interrupt=()=>lifetime.abort(new Error('Benchmark interrupted'))
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt)
  const deadline=setTimeout(()=>lifetime.abort(new Error('Benchmark lifetime exceeded')),15*60*1000)
  let records
  try {
    records=new Records(root,output,config,options)
    await records.connect(lifetime.signal)
    if(driverContract)report.ground={heightMeters:0,scope:'Global driver contract only; not a local ground-height fixture'}
    else {
      const ground=await runBackend(binary,config,'height',[
        'sample '+config.target.longitudeDegrees+' '+config.target.latitudeDegrees+'\n'],records,lifetime.signal)
      report.ground=ground.rows[0]
      fs.writeFileSync(path.join(output,'ground.json'),JSON.stringify(report.ground,null,2))
    }
    const poses=route(config,name,report.ground.heightMeters)
    report.poses=poses;save()
    const cameraInputs=await runBackend(binary,config,'camera',poses.map(commandFor),records,lifetime.signal)
    fs.writeFileSync(path.join(output,'camera-inputs.json'),JSON.stringify(cameraInputs.rows,null,2))
    report.publicViewCameraChecks=poses.map((pose,index)=>verifyReferenceCamera(config,pose,cameraInputs.rows[index]))
    report.cameraValidation=[]
    if(name==='taian-oblique-fixed-v1') {
      const positions=cameraInputs.rows.map(row=>{
        const [x,y,z]=row.position
        return {longitudeDegrees:Math.atan2(x,z)*180/Math.PI,
          latitudeDegrees:Math.atan2(y,Math.hypot(x,z))*180/Math.PI,
          heightMeters:Math.hypot(x,y,z)-config.radiusMeters}
      })
      const unique=[...new Map(positions.map(p=>[p.longitudeDegrees.toFixed(8)+'/'+p.latitudeDegrees.toFixed(8),p])).entries()]
      const ground=await runBackend(binary,config,'height',unique.map(([,p])=>
        'sample '+p.longitudeDegrees+' '+p.latitudeDegrees+'\n'),records,lifetime.signal)
      const samples=new Map(unique.map(([key],index)=>[key,ground.rows[index]]))
      report.cameraValidation=positions.map((position,index)=>{
        const sample=samples.get(position.longitudeDegrees.toFixed(8)+'/'+position.latitudeDegrees.toFixed(8))
        return {id:poses[index].id,position,sample,clearanceMeters:position.heightMeters-sample.heightMeters}
      })
      assert(report.cameraValidation.every(row=>row.clearanceMeters>1),'Case eye intersects the captured DEM; no camera clamping is allowed')
    }
    fs.mkdirSync(path.join(output,'terrain-inputs'))
    for(const selected of backend==='both'?['desktop','sdk']:[backend]) {
      const progress=[]
      const discovery=[]
      const fixed=selected==='sdk'&&resourceMode==='fixed'
      let phase=fixed?'discovery':'measurement',receipt
      const commands=poses.map(commandFor)
      report.cores[selected]={status:'running',rows:progress,discoveryRows:discovery}
      const nativeBackend=selected==='desktop'&&desktopMode==='target'?'desktop-target':selected
      const result=await runBackend(binary,config,nativeBackend,fixed?commands.concat('freeze\n',commands):commands,records,lifetime.signal,event=>{
        if(event.type==='frozen') {receipt=event;phase='measurement';return}
        const destination=phase==='discovery'?discovery:progress,index=destination.length
        assert(event.id===poses[index].id,'Result pose identity differs')
        const expected=cameraInputs.rows[index]
        assert(JSON.stringify([event.view,event.projection,event.position])===
          JSON.stringify([expected.view,expected.projection,expected.position]),'Measured camera differs from its validated input')
        if(event.resourceInput) {
          const file=path.join('terrain-inputs',selected+'-'+phase+'-'+index+'.json')
          const bytes=Buffer.from(JSON.stringify(event.resourceInput))
          fs.writeFileSync(path.join(output,file),bytes)
          event.resourceInput={file,sha256:digest(bytes)}
        }
        if(event.terrainObservation) {
          const file=path.join('terrain-inputs',selected+'-'+phase+'-'+index+'-observation.json')
          const bytes=Buffer.from(JSON.stringify(event.terrainObservation))
          fs.writeFileSync(path.join(output,file),bytes)
          event.terrainObservation={file,sha256:digest(bytes)}
        }
        if(event.imagery) {
          imagery.validate(event.imagery,config)
          const file=path.join('terrain-inputs',selected+'-'+phase+'-'+index+'-imagery.json')
          const bytes=Buffer.from(JSON.stringify(event.imagery))
          fs.writeFileSync(path.join(output,file),bytes)
          event.imageryObservation={file,sha256:digest(bytes)}
        }
        if(config.benchmarkImagery&&phase==='measurement'&&event.status==='ready')
          assert(event.imagery,'Measured stage omitted imagery')
        if(event.meshPayload)event.terrainCapacity={configuredBytes:terrainBudget.meshBudgetBytes,
          fitsSelection:event.meshPayload.selectionBytes<=terrainBudget.meshBudgetBytes,
          shortfallBytes:Math.max(0,event.meshPayload.selectionBytes-terrainBudget.meshBudgetBytes),
          scope:'One selected position copy plus unique certified UV layouts and persistent roots; shared strip separate; not joint CPU/GPU/transition capacity'}
        destination.push(event);save()
        console.log(selected,phase,event.id,event.status,'fragments='+event.visibleKeys.length,
          'cpuMs='+event.coreCpuMs.toFixed(2),'pending='+event.pendingRefines+'/'+event.pendingCoarsens)
      })
      report.cores[selected]={...result,rows:progress,discoveryRows:discovery,frozenInputReceipt:receipt,
        status:result.complete?'complete':'stopped'}
      report.roundtrips[selected]=roundtrip(progress,poses)
      if(config.benchmarkImagery&&result.complete)report.imageryRoundtrips[selected]=
        roundtrip(progress.map(row=>({...row.imagery,id:row.id})),poses)
      if(fixed&&result.complete) {
        const inputs=new Set(progress.map(row=>row.resourceInput?.sha256))
        assert(inputs.size===1&&!inputs.has(undefined),'Fixed SDK resource inputs changed within the measured route')
      }
      save()
      if(!result.complete) {
        const row=[...discovery,...progress].find(row=>row.status!=='ready')
        report.firstBlocker=row&&{backend:selected,id:row.id,status:row.status,
          phase:progress.includes(row)?'measurement':'discovery',pendingCoarsenKeys:row.pendingCoarsenKeys,
          cachedUpdateReturns:row.cachedUpdateReturns,cachedUpdateReturnEligible:row.cachedUpdateReturnEligible,
          missingInputKeys:row.missingInputKeys,resourceInput:row.resourceInput}
        break
      }
    }
    const first=report.cores.desktop,second=report.cores.sdk
    if(first&&second)for(let i=0;i<Math.min(first.rows.length,second.rows.length);++i)
      report.comparisons.push(compare(first.rows[i],second.rows[i]))
    if(config.benchmarkImagery&&first&&second)
      for(let i=0;i<Math.min(first.rows.length,second.rows.length);++i)
        if(first.rows[i].imagery&&second.rows[i].imagery)report.imageryComparisons.push({
          id:first.rows[i].id,...imagery.compare(first.rows[i].imagery,second.rows[i].imagery)})
    report.completeBoth=Boolean(first?.complete&&second?.complete)
    report.selectedBackendTargetsMet=Object.values(report.cores).every(core=>core.complete&&
      core.rows.length===poses.length&&core.rows.every(row=>row.status==='ready'&&row.targetMet))
    report.allTargetsMet=report.completeBoth&&report.comparisons.every(row=>row.bothReady&&row.bothTargetsMet)
    report.sameBackendSets=report.completeBoth&&report.comparisons.every(row=>row.sameSets)
    report.sameRoundtripSets=Object.values(report.cores).every(core=>core.complete)?
      Object.values(report.roundtrips).every(rows=>rows.every(row=>row.sameSets)):null
    report.allImageryTargetsMet=config.benchmarkImagery?report.completeBoth&&
      report.imageryComparisons.length===poses.length&&report.imageryComparisons.every(row=>row.bothTargetsMet):null
    report.sameImageryRoundtripSets=config.benchmarkImagery?
      Object.values(report.cores).every(core=>core.complete)&&
      Object.values(report.imageryRoundtrips).every(rows=>rows.every(row=>row.sameSets)):null
    if(name==='taian-oblique-fixed-v1') {
      report.reliefQualification=Object.fromEntries(Object.entries(report.cores).map(([key,value])=>[key,
        value.complete?value.rows.some((row,index)=>poses[index].tiltDegrees>0&&row.terrainRelief.inFrustumVertices>0&&
          row.terrainRelief.maximumMeters-row.terrainRelief.minimumMeters>=config.obliqueMinimumReliefMeters):null]))
      assert(!Object.values(report.reliefQualification).includes(false),'Oblique case does not show the required DEM relief')
    }
    report.status='complete'
    process.exitCode=report.allTargetsMet&&report.sameBackendSets&&report.sameRoundtripSets&&
      (!config.benchmarkImagery||report.allImageryTargetsMet&&report.sameImageryRoundtripSets)?0:2
  } catch(error) {
    report.status=lifetime.signal.aborted?'cancelled':'failed';report.error=error.message
    if(error.nativeStderr)report.nativeStderr=error.nativeStderr
    if(error.partialRows)report.partialRows=error.partialRows
    process.exitCode=1
  } finally {
    lifetime.abort();clearTimeout(deadline)
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt)
    try {
      if(records) {
        await records.close();report.data=records.save();report.network=records.network
        report.cleanup={nativeProcessesClosed:true,activeRequests:records.network.active,liveSockets:records.sockets.size,
          testBrowsers:0,testServices:0}
      } else report.cleanup={nativeProcessesClosed:true,activeRequests:0,liveSockets:0,testBrowsers:0,testServices:0}
      const after=fingerprint(binary,caseFile)
      report.inputsUnchanged=after.sourceSha256===frozen.sourceSha256&&after.binarySha256===frozen.binarySha256
      assert(report.inputsUnchanged,'Benchmark sources/binary changed during execution')
    } catch(error) {report.status='failed';report.finalizationError=error.message;process.exitCode=1}
    report.finishedAt=new Date().toISOString();save()
  }
  console.log('Headless terrain report:',path.join(output,'report.json'),'status='+report.status)
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1})
module.exports={runBackend,fingerprint,main}
