#!/usr/bin/env node
'use strict'

const fs = require('fs'), path = require('path'), {spawn} = require('child_process')
const root = path.resolve(__dirname, '..')
function argumentsMap(args) {
  const result = {}
  const allowed = new Set(['browser','url','output','longitude','latitude','height','max-level','timeout-ms','width','height-px'])
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2)
    if (!args[i].startsWith('--') || !allowed.has(key) || args[i+1] === undefined)
      throw new Error('Invalid option: ' + args[i])
    result[key] = args[i+1]
  }
  return result
}
function number(options, name, fallback, minimum, maximum, integer = false) {
  if (options[name] === undefined && fallback === undefined) return undefined
  const value = Number(options[name] === undefined ? fallback : options[name])
  if (!Number.isFinite(value) || value < minimum || value > maximum || integer && !Number.isInteger(value))
    throw new Error('Invalid --' + name)
  return value
}
function decodeHtml(text) {
  return text.replace(/&(lt|gt|amp|quot|#39);/g, (_, name) => ({lt:'<',gt:'>',amp:'&',quot:'"','#39':"'"})[name])
}
function csv(report) {
  const columns = ['direction','id','rangeMeters','status','durationMs','firstCoverageMs','terrainTargetMs','imageryTargetMs',
    'terrainNodes','terrainMeshes','imageryNodes','targetImages','presentedImages','terrainError','terrainThreshold',
    'imageryError','imageryThreshold','refinableMeasurements','workingMeshBytes','preferredMeshBytes',
    'capacityReductions','capacityRestorations','managedBytes','sampledPeakBytes',
    'lifetimeHighWaterBytes','maximumManagedBytes','textureEntries','textureBytes',
    'textureGrantedBytes','textureMaximumShareBytes','wasmBytes']
  const rows = (report.steps || []).map(row => {
    const value = {...(row.final && row.final.metrics), ...row}
    return columns.map(name => value[name] === undefined || value[name] === null ? '' : JSON.stringify(value[name])).join(',')
  })
  return [columns.join(','), ...rows].join('\n') + '\n'
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Usage: node scripts/benchmark_vertical_scale.js --browser /path/to/chromium [options]
  --url         Local demo URL (default http://127.0.0.1:18766/demo/globe/?imagery=tianditu-img-c)
  --longitude   Fixed longitude (default 116.56230)
  --latitude    Fixed latitude (default 40.74863)
  --height      Verified target ground height; omitted = bounded terrain query
  --max-level   Maximum INTERNAL texture level; omitted = source maximum
  --timeout-ms  Deadline per scale (default 30000)
  --width       Browser width (default 960)
  --height-px   Browser height (default 640)
  --output      New evidence directory (default viewer_verify_output/vertical_scale_<timestamp>)
Outputs report.json, steps.csv, progress.json, browser log and final DOM.
Down/up share exactly the same positions and preserve caches. No SDK budgets are changed.
Scale labels are nominal; actual selected terrain/imagery levels are recorded separately.
Capacity/data limits, diagnostic inconsistencies and timeouts are distinct outcomes.
Exit 0: all scales meet terrain and imagery targets; 2: completed with unmet targets;
1: collection/cleanup failed. Endpoint set differences are reported, not silently
accepted as hysteresis. A separate canonical target oracle is still required.`)
    return
  }
  const args = argumentsMap(process.argv.slice(2))
  const browser = args.browser || process.env.WEB_SDK_BROWSER_BIN || '/usr/bin/chromium'
  const url = new URL(args.url || 'http://127.0.0.1:18766/demo/globe/?imagery=tianditu-img-c')
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Benchmark URL must use HTTP(S)')
  const options = {longitude:number(args,'longitude',116.56230,-180,180),
    latitude:number(args,'latitude',40.74863,-89,89), height:number(args,'height',undefined,-12000,100000),
    maximumLevel:number(args,'max-level',undefined,0,27,true), timeoutMs:number(args,'timeout-ms',30000,1000,120000)}
  const width = number(args,'width',960,320,4096,true), height = number(args,'height-px',640,240,4096,true)
  const output = path.resolve(args.output || path.join(root,'viewer_verify_output','vertical_scale_' + Date.now()))
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Evidence directory must be new or empty')
  fs.mkdirSync(output, {recursive:true})
  const profile = fs.mkdtempSync(path.join(output,'browser-profile-'))
  const driver = path.join(output,'driver.js'), dom = path.join(output,'result.html')
  const source = ['vertical_scale.js','vertical_scale_probe.js','vertical_scale_driver.js']
    .map(name => fs.readFileSync(path.join(root,'tests/benchmarks',name),'utf8'))
  fs.writeFileSync(driver, 'window.terraScaleOptions=' + JSON.stringify(options) + ';\n' + source.join(';\n'))
  fs.writeFileSync(path.join(output,'invocation.json'), JSON.stringify({options, width, height,
    origin:url.origin, page:url.pathname, browser, startedAt:new Date().toISOString()}, null, 2))
  // Source maximum is discovered inside the page. Bound the owner process for
  // the largest supported ladder, plus initialization/ground-query/cleanup.
  const seconds = Math.ceil(((2 * ((options.maximumLevel === undefined ? 27 : options.maximumLevel) + 2) - 1) *
    (options.timeoutMs + 1000) + 90000) / 1000)
  const runnerArgs = [path.join(root,'scripts/run_chromium_evidence.js'), '--browser',browser,
    '--profile',profile,'--url',url.href,'--driver-file',driver,'--dom-output',dom,
    '--log-output',path.join(output,'browser.log'),'--progress-output',path.join(output,'progress.json'),
    '--progress-element','terra-scale-evidence','--timeout',String(seconds),'--width',String(width),'--height',String(height)]
  const child = spawn(process.execPath, runnerArgs, {stdio:'inherit'})
  let interrupted = false
  const interrupt = () => {interrupted = true; child.kill('SIGTERM')}
  process.on('SIGINT',interrupt); process.on('SIGTERM',interrupt)
  let code
  try {code = await new Promise((resolve,reject) => {child.once('error',reject); child.once('close',resolve)})}
  finally {process.removeListener('SIGINT',interrupt); process.removeListener('SIGTERM',interrupt)}
  let report
  if (fs.existsSync(dom)) {
    const found = /<pre\b[^>]*\bid="terra-scale-evidence"[^>]*>([\s\S]*?)<\/pre>/.exec(fs.readFileSync(dom,'utf8'))
    if (found) report = JSON.parse(decodeHtml(found[1]))
  }
  if (!report && fs.existsSync(path.join(output,'progress.json')))
    report = JSON.parse(fs.readFileSync(path.join(output,'progress.json'),'utf8'))
  if (!report) report = {schema:'terra.vertical-scale-benchmark.v1',status:'failed',steps:[],error:'No benchmark report'}
  const profileRemoved = !fs.existsSync(profile)
  report.cleanup = {runnerExitCode:code, runnerClosed:true, profileRemoved, interrupted}
  if (code !== 0 || !profileRemoved || interrupted || !report.viewerDestroyed) report.status = 'failed'
  fs.writeFileSync(path.join(output,'report.json'), JSON.stringify(report,null,2))
  fs.writeFileSync(path.join(output,'steps.csv'),csv(report))
  console.table((report.steps || []).map(row => ({direction:row.direction,scale:row.id,status:row.status,
    seconds:(row.durationMs/1000).toFixed(2), meshes:row.final && row.final.metrics.terrainMeshes,
    images:row.final && row.final.metrics.targetImages,
    MiB:row.final && (row.final.metrics.managedBytes/1048576).toFixed(2)})))
  console.log('Benchmark report: ' + path.join(output,'report.json'))
  process.exitCode = report.status !== 'complete' ? 1 : report.allTargetsMet ? 0 : 2
}
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1})
module.exports = {argumentsMap, decodeHtml, csv}
