'use strict'
// Explicit, bounded acquisition of the refinement-input closure, independent of
// a timed desktop replay. A record missing from a pack is never assumed absent.
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process')
const {Records,digest}=require('./records')
const assert=(value,message)=>{if(!value)throw new Error(message)}
async function main() {
  assert(process.argv.length===6,'Usage: capture_inputs.js <nadir-directory> <oblique-directory> <new-output> <upstream-origin>')
  const root=path.resolve(__dirname,'../../..'),mount=path.join(root,'viewer_verify_output')
  execFileSync('mountpoint',['-q',mount])
  const directories=process.argv.slice(2,4).map(value=>path.resolve(value)),output=path.resolve(process.argv[4])
  assert(output.startsWith(mount+path.sep)&&!fs.existsSync(output),'Output must be new and on the test data mount')
  fs.mkdirSync(output,{recursive:true})
  assert(fs.realpathSync(output).startsWith(fs.realpathSync(mount)+path.sep),'Output leaves the mount')
  const keys=new Map(),inputs=[],reports=directories.map(directory=>{
    const bytes=fs.readFileSync(path.join(directory,'report.json')),r=JSON.parse(bytes)
    assert(r.schema==='terra.headless-scheduling.v1'&&r.status==='complete'&&r.inputsUnchanged&&
      r.sdkResourceMode==='fixed'&&r.cores.sdk.complete&&r.cores.sdk.rows.length===r.poses.length,
      'Incomplete SDK discovery input')
    const row=r.cores.sdk.rows[0]
    assert(r.cores.sdk.rows.every(value=>value.resourceInput.sha256===row.resourceInput.sha256),'Mutable resource input')
    const file=path.resolve(directory,row.resourceInput.file)
    assert(file.startsWith(directory+path.sep),'Input leaves report directory')
    const data=fs.readFileSync(file)
    assert(digest(data)===row.resourceInput.sha256,'Changed resource snapshot')
    for(const key of JSON.parse(data).availableDetails) {
      assert(key.length===4&&key.every(Number.isInteger)&&key[0]>=0&&key[0]<=40&&
        key.slice(1).every(value=>Math.abs(value)<=268435456),'Invalid refinement key')
      keys.set(key.slice(1).join('/'),key)
    }
    inputs.push({directory,reportSha256:digest(bytes),resourceSha256:row.resourceInput.sha256})
    return r
  })
  assert(reports[0].data.datasetSha256===reports[1].data.datasetSha256&&
    JSON.stringify(reports[0].configuration)===JSON.stringify(reports[1].configuration),'Input datasets/configurations differ')
  assert(keys.size>0&&keys.size<=10000,'Refinement closure safety limit')
  const records=new Records(root,output,reports[0].configuration,{records:path.join(directories[0],'records.json'),
    upstream:process.argv[5]})
  const controller=new AbortController(),stop=()=>controller.abort(new Error('Capture interrupted'))
  const deadline=setTimeout(()=>controller.abort(new Error('Capture deadline exceeded')),180000)
  process.on('SIGINT',stop);process.on('SIGTERM',stop)
  const report={schema:'terra.refinement-input-capture.v1',inputs,keys:[...keys.values()],
    programSha256:digest(fs.readFileSync(__filename)),concurrency:4,status:'running'}
  try {
    await records.connect(controller.signal)
    const pending=[...keys.values()];let cursor=0
    const workers=Array.from({length:4},async()=>{
      try {
        while(cursor<pending.length)await records.serve({type:'request',kind:2,key:pending[cursor++]},controller.signal)
      } catch(error) {controller.abort(error);throw error}
    })
    const settled=await Promise.allSettled(workers),failure=settled.find(result=>result.status==='rejected')
    if(failure)throw failure.reason
    report.status='captured'
  } catch(error) {report.status='failed';report.error=error.message;process.exitCode=1}
  finally {
    controller.abort();clearTimeout(deadline);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)
    await records.close();report.data=records.save();report.network=records.network
    report.cleanup={activeRequests:records.network.active,sockets:records.sockets.size,testBrowsers:0,testServices:0}
    fs.writeFileSync(path.join(output,'capture.json'),JSON.stringify(report,null,2))
  }
  console.log(report.status,'closure='+keys.size,'requests='+records.network.requests,'dataset='+report.data.datasetSha256)
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1})
