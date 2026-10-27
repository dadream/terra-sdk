#!/usr/bin/env node
'use strict'
const fs = require('fs'), path = require('path'), {spawn} = require('child_process')
const root = path.resolve(__dirname,'..')

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Usage: node scripts/benchmark_imagery_reference.js --report <terrain-reference/report.json> --output <new-directory>
  --sample <id>  Optional single scale.
  --wasm <path>  Default workspace_old/package/miniprogram/wasm/terra_sdk.wasm.
First capture terrain using benchmark_terrain_reference.js --surfaces.
Uses exact captured meshes, production projection and the native imagery planner,
without production cache/transition quotas. No image downloads or GPU rendering.
Each scale has a fresh bounded process. Safety limits and data-level limits are
reported separately from achieving the requested precision. Exit 0 means the
reference meets precision; 2 means precision is unmet; 1 means collection failed.
Initial texture preference is reported only as a comparison: actual granted
capacity must be measured in production and joined by compare_vertical_capacity.js.
This reference alone does not prove shared-memory or transition feasibility.`)
    return
  }
  const options = {}, allowed = new Set(['report','output','sample','wasm'])
  for (let i=2;i<process.argv.length;i+=2) {
    const key=process.argv[i].slice(2)
    if (!process.argv[i].startsWith('--') || !allowed.has(key) || !process.argv[i+1]) throw new Error('Invalid option')
    options[key]=process.argv[i+1]
  }
  if (!options.report || !options.output) throw new Error('--report and --output are required')
  const input=JSON.parse(fs.readFileSync(options.report)), output=path.resolve(options.output)
  if (input.schema!=='terra.terrain-reference.v1' || input.status!=='complete') throw new Error('Completed terrain reference required')
  const samples=input.samples.filter(row=>!options.sample || row.id===options.sample)
  if (!samples.length || samples.some(row=>!row.targetMet || !row.surfaceSnapshot))
    throw new Error('Each reference scale must meet the terrain target and contain exact surfaces')
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Output must be new or empty')
  fs.mkdirSync(output,{recursive:true})
  const report={schema:'terra.imagery-demand-reference.v1',status:'running',configuration:input.configuration,
    target:input.target,terrain:input.terrain,terrainBinarySha256:input.binarySha256,samples:[],
    poseTimeoutMs:120000,networkRequests:0}
  let child, closed, cancelled=false, timer
  const stop=()=>{cancelled=true;if(child)child.kill('SIGKILL')}
  process.on('SIGINT',stop);process.on('SIGTERM',stop)
  const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
  try {
    for (const sample of samples) {
      if (cancelled) throw new Error('Imagery reference cancelled')
      const name=String(report.samples.length), request=path.join(output,name+'-input.json'), result=path.join(output,name+'-result.json')
      fs.writeFileSync(request,JSON.stringify({configuration:input.configuration,terrain:input.terrain,sample,
        wasm:path.resolve(options.wasm || path.join(root,'workspace_old/package/miniprogram/wasm/terra_sdk.wasm'))}))
      let stderr='', startupError, expired=false
      child=spawn(process.execPath,['--max-old-space-size=512',path.join(root,'tests/benchmarks/imagery_reference.js'),request,result],
        {stdio:['ignore','ignore','pipe']})
      closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})))
      child.once('error',error=>{startupError=error})
      child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-8192)})
      timer=setTimeout(()=>{expired=true;child.kill('SIGKILL')},report.poseTimeoutMs)
      const exit=await closed;clearTimeout(timer);child=null
      const value=fs.existsSync(result)?JSON.parse(fs.readFileSync(result)):null
      if (cancelled || expired || startupError || exit.code!==0)
        throw new Error(cancelled?'Imagery reference cancelled':expired?'Imagery reference safety deadline':
          startupError?.message || value?.error || stderr || 'Imagery reference failed: '+JSON.stringify(exit))
      if (!value) throw new Error('Imagery reference produced no result')
      if (!value.cleanup.nativeContextDestroyed) throw new Error('Native imagery context remains')
      const configured = input.configuration.initialBudgets?.textureCacheBytes
      const known = Number.isSafeInteger(configured) && configured > 0
      const initialTextureShare = {configuredBytes:known ? configured : null, referenceBytes:value.imageBytesWithRoots,
        fitsReference:known ? value.imageBytesWithRoots <= configured : null,
        shortfallBytes:known ? Math.max(0,value.imageBytesWithRoots-configured) : null}
      report.samples.push({id:sample.id,level:sample.level,rangeMeters:sample.rangeMeters,view:sample.view,...value,
        initialTextureShare})
      save();console.log(sample.id,'target='+value.targetMet,'images='+value.sourceImages.length,
        'imageMiB='+(value.imageBytesWithRoots/1048576).toFixed(2),'planMs='+value.timing.planningMs.toFixed(2))
    }
    report.status='complete';report.allImageryTargetsMet=report.samples.every(row=>row.targetMet)
    report.allReferenceImagesFitInitialPreference = report.samples.some(row=>row.initialTextureShare.fitsReference===false)
      ? false : report.samples.some(row=>row.initialTextureShare.fitsReference===null) ? null : true
    report.capacityScope='Initial preference is not a hard capacity. Production grants and joint transition peaks are not measured by this reference.'
    process.exitCode=report.allImageryTargetsMet?0:2
  } catch(error) {report.status='failed';report.error=error.message;process.exitCode=1}
  finally {
    clearTimeout(timer);if(child){child.kill('SIGKILL');await closed}
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)
    report.cleanup={childProcessesClosed:true};save()
    console.log('Imagery reference report: '+path.join(output,'report.json'))
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
