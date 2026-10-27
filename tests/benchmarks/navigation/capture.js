'use strict'
// Acquisition only: Native terrain discovery and one extra refinement-input
// frontier. These timings and unconstrained logical cuts are not performance or
// joint-capacity results. Browser validation remains strictly offline.
const assert=require('assert'),fs=require('fs'),path=require('path'),{execFileSync}=require('child_process')
const {Records,digest}=require('../headless_scheduling/records')
const {commandFor}=require('../headless_scheduling/case')
const {runBackend}=require('../../../scripts/benchmark_headless_scheduling')
const {legs,zoomView}=require('./acceptance')
async function main() {
  assert([4,5].includes(process.argv.length),'Usage: capture.js <new-output> <upstream-origin> [oblique|zoom]')
  const root=path.resolve(__dirname,'../../..'),mount=path.join(root,'viewer_verify_output'),output=path.resolve(process.argv[2])
  execFileSync('mountpoint',['-q',mount]);assert(output.startsWith(mount+path.sep)&&!fs.existsSync(output))
  const cases={oblique:'beijing-oblique-flight-v1.json',zoom:'taian-rapid-zoom-v1.json'}
  assert(cases[process.argv[4]||'oblique'],'Unknown acquisition case')
  const sceneFile=path.join(root,'testdata/benchmarks',cases[process.argv[4]||'oblique']),scene=JSON.parse(fs.readFileSync(sceneFile))
  const source=path.resolve(path.dirname(sceneFile),scene.terrain)
  const binary=path.join(root,'workspace_old/build/cmake/tests/benchmarks/headless_scheduling/terra_benchmark_terrain')
  const config={...require('../../../testdata/benchmarks/taian-scheduling-v1.json'),target:scene.view.target,
    viewport:scene.viewport,verticalFovRadians:scene.verticalFovRadians,benchmarkMeshBytes:0}
  const poses=legs(scene).flatMap(leg=>{
    const degrees=leg.view.headingDegrees-leg.from.headingDegrees
    const count=leg.motion.kind==='log-zoom'?
      leg.motion.samples:Math.ceil(Math.abs(degrees))
    assert(count>0&&count<=180)
    return Array.from({length:count+1},(_,i)=>({...leg.motion.kind==='log-zoom'?
      zoomView(leg.from,leg.view,i/count):{...leg.from,headingDegrees:leg.from.headingDegrees+degrees*i/count},
      id:'leg-'+leg.index+'-pose-'+i}))
  })
  fs.mkdirSync(output);assert(fs.realpathSync(output).startsWith(fs.realpathSync(mount)+path.sep))
  const records=new Records(root,output,config,{records:source,upstream:process.argv[3]})
  const lifetime=new AbortController(),stop=()=>lifetime.abort(new Error('Bounded navigation acquisition stopped'))
  const timer=setTimeout(stop,180000);process.on('SIGINT',stop);process.on('SIGTERM',stop)
  const frontier=new Map(),report={schema:'terra.navigation-acquisition.v1',status:'running',
    sceneSha256:digest(fs.readFileSync(sceneFile)),binarySha256:digest(fs.readFileSync(binary)),
    programSha256:digest(fs.readFileSync(__filename)),poses,rows:[],scope:'Acquisition, not performance/capacity acceptance'}
  try {
    await records.connect(lifetime.signal)
    const result=await runBackend(binary,config,'sdk',poses.map(commandFor),records,lifetime.signal,event=>{
      assert.strictEqual(event.status,'ready')
      for(const key of event.resourceInput.availableDetails)frontier.set(key.join('/'),key)
      const id=event.id,status=event.status,sha256=digest(Buffer.from(JSON.stringify(event)))
      for(const key of Object.keys(event))if(!['type','id','status'].includes(key))delete event[key]
      report.rows.push({id,status,sha256})
      if(report.rows.length%24===0)console.log('Native poses '+report.rows.length+'/'+poses.length)
    })
    assert(result.complete&&result.nativeProcessClosed);report.nativeProcessClosed=true
    assert(frontier.size<=10000,'Navigation frontier capture limit exceeded')
    const keys=Array.from(frontier.values());let cursor=0
    const workers=await Promise.allSettled(Array.from({length:4},async()=>{
      try {while(cursor<keys.length)await records.serve({type:'request',kind:2,key:keys[cursor++]},lifetime.signal)}
      catch(error){lifetime.abort(error);throw error}
    }))
    const failure=workers.find(value=>value.status==='rejected');if(failure)throw failure.reason
    report.frontierKeys=keys.length;report.status='captured'
  } catch(error) {report.status='failed';report.error=error.message;process.exitCode=1}
  finally {
    lifetime.abort();clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)
    await records.close();report.data=records.save();report.network=records.network
    report.cleanup={activeRequests:records.network.active,sockets:records.sockets.size}
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n')
  }
  console.log(JSON.stringify({status:report.status,poses:report.rows.length,network:report.network,cleanup:report.cleanup}))
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1})
