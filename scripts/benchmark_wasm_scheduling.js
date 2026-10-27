#!/usr/bin/env node
'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os')
const {execFileSync}=require('child_process')
const {run}=require('../tests/benchmarks/headless_scheduling/execution')
const {Records,digest,datasetIdentity}=require('../tests/benchmarks/headless_scheduling/records')
const {validate,route}=require('../tests/benchmarks/headless_scheduling/case')
const {fingerprint}=require('./benchmark_headless_scheduling')
const {verifyReferenceCamera}=require('../tests/benchmarks/headless_scheduling/camera')
const {compareExecution,resourceReader}=require('../tests/benchmarks/headless_scheduling/execution_comparison')
const root=path.resolve(__dirname,'..')

async function main(argv=process.argv.slice(2)) {
  if(argv.includes('--help')) {
    console.log(`Usage: node scripts/benchmark_wasm_scheduling.js --output <new-directory> --reference <native-report.json>
  --backend both | direct | worker             Default both, sequential instances.
  --case <shared-case>                         Default reference case; global-contract also supported.
  --wasm <path>                               Default workspace_old/build/wasm/terra_sdk.wasm.
  --records <records.json>                    Default versioned v4 offline pack; must contain v2 inputs.
  --upstream <origin>                         Explicit bounded acquisition, not a timing sample.
  --terrain-mesh-bytes <bytes>                Instance terrain selection/record ceiling; height is twice this.
  --managed-bytes <bytes>                     Shared allocation ceiling; defaults to production policy.

Real Wasm/Direct/Worker execution, actual mesh ownership and native surface model
cache; explicit CPU logical-cut consumer. No renderer, FakeGL, downloads, decoder
or GPU. Imagery target demand uses generous diagnostic guards. Terrain records
arrive progressively from the verified offline pack; this is NOT the frozen
Native target input profile. Defaults to 16MiB terrain mesh/168MiB ledger; the
instance capacity also governs record/height storage and derived topology limits.
Reference supplies measured ground and poses. No allocation ceiling is bypassed.
Terrain outputs are compared with both Native discovery (progressive inputs)
and its frozen measurement target; these input profiles are reported separately.
Process CPU includes Worker/host/fixture overhead; async call wall time includes
cooperative yields. Neither is a frame time or the longest native call.
Exit 2 collects precision/capacity limits; exit 1 is driver/data/cleanup failure.
Overrides use the same production policy as the public runtime. They do not
change the case, error target or allocation accounting. Production visual
acceptance and the joint GPU budget remain separate.`)
    return
  }
  const options={},allowed=new Set(['output','reference','backend','case','wasm','records','upstream','terrain-mesh-bytes','managed-bytes'])
  for(let i=0;i<argv.length;i+=2) {
    assert(argv[i].startsWith('--')&&allowed.has(argv[i].slice(2))&&argv[i+1],'Invalid option')
    const key=argv[i].slice(2);assert(!(key in options),'Duplicate option');options[key]=argv[i+1]
  }
  assert(options.output&&options.reference,'--output and --reference are required')
  const mount=path.join(root,'viewer_verify_output');execFileSync('mountpoint',['-q',mount])
  const output=path.resolve(options.output)
  assert(output.startsWith(mount+path.sep),'Output must use the data mount')
  if(fs.existsSync(output))assert(!fs.readdirSync(output).length,'Output must be empty')
  fs.mkdirSync(output,{recursive:true})
  assert(fs.realpathSync(output).startsWith(fs.realpathSync(mount)+path.sep),'Output leaves data mount')
  const referenceBytes=fs.readFileSync(path.resolve(options.reference)),reference=JSON.parse(referenceBytes)
  assert(reference.sdkResourceMode==='fixed'&&reference.cores?.sdk?.complete&&
    reference.cores.sdk.discoveryRows?.length===reference.poses?.length,
    'A complete Native reference with progressive discovery and frozen measurement is required')
  const config=validate(JSON.parse(fs.readFileSync(path.join(root,'testdata/benchmarks/taian-scheduling-v1.json'))))
  for(const key of Object.keys(config))assert.deepStrictEqual(reference.configuration[key],config[key],
    'Native case configuration differs: '+key)
  const fixture=JSON.parse(fs.readFileSync(path.join(root,'testdata/benchmarks/taian-terrain-v2.json')))
  const catalogue=path.join(root,fixture.directory,fixture.catalogue),pack=JSON.parse(fs.readFileSync(catalogue))
  assert.strictEqual(datasetIdentity(pack),fixture.datasetSha256)
  assert.strictEqual(reference.data.datasetSha256,fixture.datasetSha256,'Reference uses a different dataset')
  const executionFixture=JSON.parse(fs.readFileSync(path.join(root,'testdata/benchmarks/taian-terrain-v4.json')))
  const inputCatalogue=options.records?path.resolve(options.records):
    path.join(root,executionFixture.directory,executionFixture.catalogue)
  {
    const extra=JSON.parse(fs.readFileSync(inputCatalogue)),rows=new Map(extra.records.map(row=>[row.key.join('/'),row]))
    if(!options.records)assert.strictEqual(datasetIdentity(extra),executionFixture.datasetSha256,'Default execution data changed')
    assert.strictEqual(extra.manifestSha256,pack.manifestSha256,'Supplemental metadata differs')
    for(const row of pack.records) {
      const other=rows.get(row.key.join('/'))
      assert(other&&other.status===row.status&&other.bytes===row.bytes&&other.sha256===row.sha256,
        'Supplemental pack changed or omitted a v2 input')
    }
  }
  const name=options.case||reference.case
  const poses=route(config,name,reference.ground.heightMeters)
  const referenceCameraChecks=[]
  for(const [backend,core] of Object.entries(reference.cores))for(const pose of reference.poses)
    referenceCameraChecks.push({backend,...verifyReferenceCamera(config,pose,core.rows.find(row=>row.id===pose.id))})
  if(name===reference.case)assert.deepStrictEqual(poses,reference.poses,'Reference poses differ')
  const backend=options.backend||'both',capacity='production'
  const resourceOptions={}
  if(options['terrain-mesh-bytes'])resourceOptions.maximumTerrainMeshBytes=Number(options['terrain-mesh-bytes'])
  if(options['managed-bytes'])resourceOptions.maximumResourceBytes=Number(options['managed-bytes'])
  assert(['direct','worker','both'].includes(backend))
  const wasmFile=path.resolve(options.wasm||path.join(root,'workspace_old/build/wasm/terra_sdk.wasm'))
  const source=()=>{
    const value=fingerprint(wasmFile,path.join(root,'testdata/benchmarks/taian-scheduling-v1.json'))
    // The older Native fingerprint deliberately lists only its own entrypoint.
    value.executionDriverSha256=digest(Buffer.concat([fs.readFileSync(__filename),
      fs.readFileSync(path.join(root,'tests/wasm/support/terrain_owner.js')),
      fs.readFileSync(path.join(root,'testdata/benchmarks/taian-terrain-v4.json'))]));return value
  }
  const before=source(),wasm=fs.readFileSync(wasmFile)
  const report={schema:'terra.wasm-scheduling.v1',status:'running',case:name,configuration:config,poses,
    reference:{file:path.relative(root,path.resolve(options.reference)),sha256:digest(referenceBytes)},
    sourceSha256:before.sourceSha256,executionDriverSha256:before.executionDriverSha256,
    wasmSha256:before.binarySha256,fixture,executionFixture,capacity,resourceOptions,referenceCameraChecks,backends:[],
    acquisition:Boolean(options.upstream),timingEligible:!options.upstream,
    scope:'Progressive offline real executors, CPU logical consumer, nominal imagery demand; no GPU or visual acceptance',
    environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model},
    fullBenchmarkComplete:false,sdkProductAccepted:false,startedAt:new Date().toISOString()}
  const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
  fs.writeFileSync(path.join(output,'sources.json'),JSON.stringify(before,null,2))
  const lifetime=new AbortController(),abort=()=>lifetime.abort(new Error('Benchmark interrupted'))
  const watchdog=setTimeout(()=>lifetime.abort(new Error('Route exceeded 20 minutes')),20*60*1000)
  process.once('SIGINT',abort);process.once('SIGTERM',abort)
  let records
  try {
    records=new Records(root,output,config,{records:inputCatalogue,upstream:options.upstream});await records.connect(lifetime.signal)
    for(const worker of backend==='both'?[false,true]:[backend==='worker']) {
      const result=await run({wasm,worker,config,poses,records,signal:lifetime.signal,capacity,resourceOptions,
        onStage:(stage,current)=>{
          report.current=current;save()
          console.log(`${current.backend} ${stage.id}: ${stage.status}, ${stage.turns} turns, ${stage.wallMs.toFixed(1)}ms`)
        }})
      report.backends.push(result);delete report.current;save()
    }
    const stages=report.backends.flatMap(value=>value.stages)
    if(name===reference.case&&report.backends.every(value=>value.complete))
      report.referenceComparisons=compareExecution(reference,report,resourceReader(path.dirname(path.resolve(options.reference))))
    report.comparisons=report.backends.length===2?report.backends[0].stages.map(first=>{
      const second=report.backends[1].stages.find(value=>value.id===first.id)
      return {id:first.id,sameTerrain:Boolean(second&&first.terrainKeys&&second.terrainKeys&&
        JSON.stringify(first.terrainKeys)===JSON.stringify(second.terrainKeys)),
      sameImagery:Boolean(second&&first.imageryKeys&&second.imageryKeys&&
        JSON.stringify(first.imageryKeys)===JSON.stringify(second.imageryKeys))}
    }):null
    report.summary=report.backends.map(value=>({backend:value.backend,complete:value.complete,
      statusCounts:value.stages.reduce((counts,s)=>{counts[s.status]=(counts[s.status]||0)+1;return counts},{}),
      totalWallMs:value.stages.reduce((sum,s)=>sum+s.wallMs,0),
      totalProcessCpuMs:value.stages.reduce((sum,s)=>sum+s.processCpuMs,0),
      maximumManagedBytes:Math.max(...value.stages.map(s=>s.resources.highWaterBytes)),
      maximumWasmHeapBytes:Math.max(...value.stages.map(s=>s.wasmHeapBytes)),
      nativeMeasurements:value.stages.at(-1)?.planning?.work.nativeMeasurements,
      modelSourceAttempts:value.stages.at(-1)?.modelSourceAttempts}))
    report.status=stages.some(stage=>stage.status==='failed')?'failed':
      report.backends.some(value=>!value.complete)||stages.some(stage=>stage.status!=='ready')||
      report.referenceComparisons?.rows.some(row=>row.classification==='unexplained')||
      report.comparisons&&report.comparisons.some(row=>!row.sameTerrain||!row.sameImagery)?'diagnostic':'collected'
    process.exitCode=report.status==='failed'?1:report.status==='diagnostic'?2:0
  } catch(error) {report.status='failed';report.error=error.stack;process.exitCode=1}
  finally {
    clearTimeout(watchdog);process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort)
    if(records) {
      await records.close()
      report.data=records.save()
      report.cleanup={activeRequests:records.network.active,liveSockets:records.sockets.size,networkRequests:records.network.requests}
    }
    const after=source()
    report.inputsUnchanged=before.sourceSha256===after.sourceSha256&&before.binarySha256===after.binarySha256&&
      before.executionDriverSha256===after.executionDriverSha256
    if(!report.inputsUnchanged){report.status='failed';report.error='Sources changed during execution';process.exitCode=1}
    report.finishedAt=new Date().toISOString();save()
  }
  console.log(path.join(output,'report.json'),report.status)
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1})
module.exports={main}
