'use strict'
// Explicit acquisition or live-image observation. The ordinary offline
// collector never starts this server. Terrain responses are preserved for
// replay; live images pass only through the fixed49 data-service route.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert')
const {Records}=require('../headless_scheduling/records')
async function main() {
  const output=path.resolve(process.argv[2]),port=Number(process.argv[3]),root=path.resolve(__dirname,'../../..')
  const {config,options}=JSON.parse(fs.readFileSync(path.join(output,'site/case.json')))
  const records=new Records(root,output,{...require('../../../testdata/benchmarks/taian-scheduling-v1.json'),
    target:config.view.target,viewport:config.viewport},
  {records:path.resolve(root,'testdata/benchmarks',config.terrain),upstream:options.terrainUpstream})
  const controller=new AbortController(),active=new Set(),errors=[],imageStatuses={}
  let server,closing=false
  const timer=setTimeout(()=>close().catch(fail),180000)
  async function close() {
    if(closing)return
    closing=true;clearTimeout(timer);controller.abort()
    if(server){server.close();server.closeAllConnections()}
    await Promise.allSettled([...active]);await records.close()
    const data=records.save()
    fs.writeFileSync(path.join(output,'capture.json'),JSON.stringify({data,errors,imageStatuses,network:records.network,
      cleanup:{activeRequests:records.network.active,sockets:records.sockets.size}},null,2)+'\n')
  }
  process.on('SIGINT',()=>close().catch(fail));process.on('SIGTERM',()=>close().catch(fail))
  function fail(error){console.error(error.message);process.exitCode=1}
  try {
    await records.connect(controller.signal)
    server=http.createServer((request,response)=>{
      const job=(async()=>{
        assert(request.method==='GET','Read-only acquisition server')
        const pathname=new URL(request.url,'http://localhost').pathname
        if(options.liveImagery&&/^\/terra\/v1\/imagery\/tianditu\/img-c\/\d+\/\d+\/\d+\.jpg$/.test(pathname)) {
          const cancelled=new AbortController()
          response.on('close',()=>cancelled.abort())
          const value=await records.request(new URL(pathname,'http://49.233.185.96'),2*1024*1024,
            AbortSignal.any([controller.signal,cancelled.signal]))
          imageStatuses[value.status]=(imageStatuses[value.status]||0)+1
          response.writeHead(value.status,{'Content-Type':'image/jpeg','Content-Length':value.bytes.length,
            'Cache-Control':'no-store'});response.end(value.bytes);return
        }
        const match=/^\/capture\/(root|detail)\/(-?\d+)\/(-?\d+)\/(-?\d+)$/.exec(pathname)
        if(match) {
          const kind=match[1]==='root'?1:2,key=[kind,...match.slice(2).map(Number)]
          await records.serve({type:'request',kind,key},controller.signal)
          const row=records.records.get(key.join('/'))
          const bytes=row.status===404?Buffer.from(JSON.stringify({error:{code:'patch_not_found'}})):
            fs.readFileSync(row.file).subarray(row.offset,row.offset+row.bytes)
          response.writeHead(row.status,{'Content-Length':bytes.length,'Cache-Control':'no-store'})
          response.end(bytes);return
        }
        const name=pathname==='/'?'index.html':pathname.slice(1)
        assert(/^[a-zA-Z0-9_.-]+$/.test(name),'Unexpected acquisition path')
        const bytes=fs.readFileSync(path.join(output,'site',name))
        const types={'.js':'application/javascript','.html':'text/html','.json':'application/json',
          '.wasm':'application/wasm','.png':'image/png'}
        response.writeHead(200,{'Content-Type':types[path.extname(name)]||'application/octet-stream',
          'Content-Length':bytes.length});response.end(bytes)
      })().catch(error=>{
        if(!closing&&!response.destroyed)errors.push(error.message)
        if(!response.destroyed){response.writeHead(500);response.end()}
      })
      active.add(job);job.finally(()=>active.delete(job))
    })
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
  }catch(error){await close();throw error}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1})
