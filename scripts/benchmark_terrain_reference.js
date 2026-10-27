#!/usr/bin/env node
'use strict'

const fs = require('fs'), path = require('path'), crypto = require('crypto')
const {spawn} = require('child_process'), {createInterface} = require('readline')
const {maximumEncodedRecordBytes, isMissingTerrainRecord} = require('../sdk/js/terrain/terrain_record')
const root = path.resolve(__dirname, '..')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function posesFromReport(report) {
  if (!report.configuration || report.configuration.datasetId !== 'globe') throw new Error('Globe configuration required')
  let poses
  if (report.schema === 'terra.vertical-scale-benchmark.v1') {
    poses = report.samples.map(sample => {
      const observed = report.steps.find(row => row.id === sample.id && row.direction === 'down')
      return {...sample, view:{schema:'terra.view-state.v2',mode:'globe',target:report.target,
        rangeMeters:sample.rangeMeters,headingDegrees:0,tiltDegrees:0},
        terrainThreshold:observed && observed.final.metrics.terrainThreshold}
    })
  } else if (report.schema === 'terra.demand-poses.v1') {
    poses = report.poses.map(pose => ({...pose,rangeMeters:pose.view.rangeMeters}))
  } else throw new Error('Vertical-scale report or terra.demand-poses.v1 required')
  const seen=new Set()
  for (const pose of poses) {
    const v=pose.view,t=v.target
    if (!pose.id || seen.has(pose.id) || v.schema!=='terra.view-state.v2' || v.mode!=='globe' ||
        ![v.rangeMeters,v.headingDegrees,v.tiltDegrees,t.longitudeDegrees,t.latitudeDegrees,t.heightMeters,
          pose.terrainThreshold].every(Number.isFinite) || v.rangeMeters<=0 || pose.terrainThreshold<=0 ||
        Math.abs(t.longitudeDegrees)>180 || Math.abs(t.latitudeDegrees)>90 || v.tiltDegrees<0 || v.tiltDegrees>=90)
      throw new Error('Invalid reference pose: '+pose.id)
    seen.add(pose.id)
  }
  return poses
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`Usage: node scripts/benchmark_terrain_reference.js --report <report.json> --output <new-directory>
  --upstream <origin>  Optional terrain data origin; omitted = captured fixture only.
  --sample <id>       Optional single sample (global, level-1, ...).
  --records <path>    Reuse verified supplemental records from an earlier run.
  --binary <path>     Default workspace_old/build/cmake/sdk/tests/terra_sdk_terrain_reference.
  --surfaces         Capture exact visible meshes and projection for offline imagery demand measurement.
Build the terra_sdk_terrain_reference CMake target first.
Input is a vertical-scale report or terra.demand-poses.v1 with configuration and
poses:[{id,view:terra.view-state.v2,terrainThreshold}]. Explicit poses retain tilt,
heading and target height; the vertical-scale benchmark remains fixed nadir.
Each pose starts a fresh native CBDAM controller. Real records and height reconstruction
are used; absent detail inherits coarser heights exactly as in the SDK. An uncaptured
record is a failure, never treated as no-data. Encoded records are cached between poses.
The core's fixed error, level-40 and 65536-node safety limits remain explicit. Production
8/16 MiB mesh, record/height cache and transition quotas are excluded. This is terrain
demand evidence, not an independent algorithm oracle or a full imagery/GPU capacity test.
The resulting cut is compared with initialBudgets.maximumTerrainMeshBytes. Missing
capacity is unknown, not a fit. Exit 0 requires precision and this local capacity
check; 2 means collected but unmet/unverified; 1 means collection failed. A fit
does not prove the global minimum, shared-memory feasibility or transition peaks.
All requests are bounded and the native process is stopped on failure/interruption.`)
    return
  }
  const options = {}, allowed = new Set(['report','output','upstream','sample','binary','records'])
  for (let i = 2; i < process.argv.length;) {
    const name = process.argv[i].slice(2)
    if (process.argv[i] === '--surfaces') {options.surfaces = true; ++i; continue}
    if (!process.argv[i].startsWith('--') || !allowed.has(name) || !process.argv[i+1]) throw new Error('Invalid option')
    options[name] = process.argv[i+1]
    i += 2
  }
  if (!options.report || !options.output) throw new Error('--report and --output are required')
  const baseline = JSON.parse(fs.readFileSync(options.report)), config = baseline.configuration
  const poses = posesFromReport(baseline)
  const output = path.resolve(options.output)
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Output must be new or empty')
  fs.mkdirSync(path.join(output, 'records'), {recursive:true})
  const binary = path.resolve(options.binary || path.join(root,'workspace_old/build/cmake/sdk/tests/terra_sdk_terrain_reference'))
  fs.accessSync(binary, fs.constants.X_OK)
  const fixture = path.join(root,'testdata/miniprogram/navigation_terrain')
  const catalogue = JSON.parse(fs.readFileSync(path.join(fixture,'terrain-records.json')))
  const fixtureBytes = fs.readFileSync(path.join(fixture,'terrain-records.bin'))
  if (hash(fixtureBytes) !== catalogue.sha256) throw new Error('Captured terrain fixture hash mismatch')
  const records = new Map(catalogue.records.map(row => [row.key.join('/'), {
    ...row, file:path.join(fixture,'terrain-records.bin'), origin:'fixture'
  }]))
  if (options.records) {
    const capture = JSON.parse(fs.readFileSync(options.records))
    if (capture.fixtureSha256 !== catalogue.sha256) throw new Error('Supplemental fixture identity mismatch')
    for (const row of capture.records) {
      if (![200,404].includes(row.status) || row.status === 404 && row.key[0] !== 2)
        throw new Error('Invalid supplemental record status')
      if (row.status === 200) {
        const bytes = fs.readFileSync(row.file).subarray(row.offset,row.offset+row.bytes)
        if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error('Supplemental record hash mismatch')
      }
      const key = row.key.join('/'), previous = records.get(key)
      if (previous && (previous.status !== row.status || previous.sha256 !== row.sha256))
        throw new Error('Conflicting supplemental terrain record')
      records.set(key,{...row,origin:'capture'})
    }
  }
  const lifetime = new AbortController()
  const interrupt = () => lifetime.abort(new Error('Reference cancelled'))
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  let child, closed, timeout, activeFetches = 0
  const report = {schema:'terra.terrain-reference.v1', status:'running', baselineAssets:baseline.assets,
    configuration:config, target:baseline.target, samples:[], network:{requests:0,bytes:0},
    referenceScope:'Fresh native core per pose, actual decoded heights; no production mesh/cache/transition quotas; same selection algorithm, not an independent oracle',
    memoryScope:'Unique generated geometry arrays incl. roots; retained reference decode/height arrays are not production minimum or transition peak',
    limits:{maximumLevel:40,maximumNodes:65536,maximumDataBytes:512*1024*1024,maximumIterations:20000,poseTimeoutMs:120000},
    binarySha256:hash(fs.readFileSync(binary))}
  const save = () => fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
  const request = async (url, maximumBytes) => {
    ++activeFetches; ++report.network.requests
    const controller = new AbortController(), abort = () => controller.abort(lifetime.signal.reason)
    lifetime.signal.addEventListener('abort',abort,{once:true})
    const timer = setTimeout(() => controller.abort(new Error('Terrain request timed out')),10000)
    try {
      lifetime.signal.throwIfAborted()
      const response = await fetch(url,{signal:controller.signal,redirect:'error'})
      const parts = []; let length = 0
      for await (const part of response.body) {
        length += part.byteLength
        if (length > maximumBytes) {controller.abort(); throw new Error('Terrain response too large')}
        parts.push(part)
      }
      const bytes = Buffer.concat(parts); report.network.bytes += bytes.byteLength
      return {status:response.status, bytes}
    } finally {
      clearTimeout(timer); lifetime.signal.removeEventListener('abort',abort); --activeFetches
    }
  }
  let upstream, endpoints
  try {
    let dimension = 64, heightScale = catalogue.heightScale
    if (options.upstream) {
      upstream = new URL(options.upstream)
      if (!['http:','https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search)
        throw new Error('Upstream must be an HTTP(S) origin without credentials')
      const response = await request(new URL('/terra/v1/datasets/globe/manifest',upstream),1024*1024)
      if (response.status !== 200) throw new Error('Terrain manifest unavailable')
      const manifest = JSON.parse(response.bytes)
      if (manifest.dataset_id !== config.datasetId || manifest.transform.kind !== 'cylindrical' ||
          manifest.transform.radius !== config.radiusMeters || manifest.height_scale !== catalogue.heightScale ||
          manifest.patch_dim !== 64) throw new Error('Terrain metadata differs from captured fixture')
      dimension = manifest.patch_dim; heightScale = manifest.height_scale; endpoints = manifest.endpoints
      // Validate a live root before combining captured and newly fetched bytes.
      // Every other fixture record remains identified by the committed fixture hash.
      const rootRecord = catalogue.records.find(row => row.key[0] === 1 && row.status === 200)
      const rootUrl = endpoints.root.replace('{i}',rootRecord.key[1]).replace('{j}',rootRecord.key[2]).replace('{k}',rootRecord.key[3])
      const live = await request(new URL(rootUrl,upstream),maximumEncodedRecordBytes(dimension,1))
      if (live.status !== 200 || hash(live.bytes) !== rootRecord.sha256) throw new Error('Live root differs from fixture')
    }
    report.terrain = {patchDimension:dimension,heightScale,fixtureSha256:catalogue.sha256,
      supplementalRecordsSha256:options.records ? hash(fs.readFileSync(options.records)) : null,
      sourcePolicy:upstream ? 'Captured fixture plus live missing records; metadata and one live root checked, no atomic server dataset version available'
        : 'Captured fixtures only; missing records fail'}
    const samples = poses.filter(sample => !options.sample || sample.id === options.sample)
    if (!samples.length) throw new Error('Unknown sample')
    for (const sample of samples) {
      lifetime.signal.throwIfAborted()
      const target = sample.view.target, threshold = sample.terrainThreshold
      const args = [config.radiusMeters,dimension,heightScale,config.viewport.physicalWidth,config.viewport.physicalHeight,
        config.fovRadians,target.longitudeDegrees,target.latitudeDegrees,target.heightMeters,sample.rangeMeters,
        threshold,sample.view.headingDegrees,sample.view.tiltDegrees].map(String)
      const surfaceFile = path.join(output, 'surface-' + report.samples.length + '.bin')
      if (options.surfaces) args.push(surfaceFile)
      child = spawn(binary,args,{stdio:['pipe','pipe','pipe']})
      closed = new Promise(resolve => child.once('close',(code,signal) => resolve({code,signal})))
      let startupError, stderr = '', result
      child.once('error',error => {startupError=error})
      child.stderr.on('data',bytes => {stderr=(stderr+bytes).slice(-8192)})
      child.stdin.on('error',() => {})
      const stop = () => child.kill('SIGTERM')
      lifetime.signal.addEventListener('abort',stop,{once:true})
      timeout = setTimeout(() => lifetime.abort(new Error('Reference pose deadline exceeded')),report.limits.poseTimeoutMs)
      try {
        for await (const line of createInterface({input:child.stdout,crlfDelay:Infinity})) {
          lifetime.signal.throwIfAborted()
          const event = JSON.parse(line)
          if (event.type === 'result') {result=event; continue}
          if (event.type !== 'request' || ![1,2].includes(event.kind)) throw new Error('Invalid native protocol')
          const [,i,j,k] = event.key, key = [event.kind,i,j,k].join('/')
          let record = records.get(key)
          if (!record && upstream) {
            const template = event.kind === 1 ? endpoints.root : endpoints.detail
            const url = new URL(template.replace('{i}',i).replace('{j}',j).replace('{k}',k),upstream)
            if (url.origin !== upstream.origin) throw new Error('Terrain endpoint changed origin')
            const response = await request(url,maximumEncodedRecordBytes(dimension,event.kind))
            const noData = response.status === 404 && event.kind === 2 && isMissingTerrainRecord(response.bytes)
            if (response.status !== 200 && !noData) throw new Error('Terrain request failed: HTTP '+response.status)
            record = {key:[event.kind,i,j,k],status:noData?404:200,offset:0,bytes:response.bytes.length,
              sha256:hash(response.bytes),origin:'live',file:path.join(output,'records',key.replaceAll('/','_')+'.bin')}
            if (!noData) fs.writeFileSync(record.file,response.bytes)
            records.set(key,record)
          }
          if (!record) throw new Error('Uncaptured terrain record: '+key)
          child.stdin.write(record.status === 404 ? '404\n' :
            '200 '+JSON.stringify(record.file)+' '+record.offset+' '+record.bytes+'\n')
        }
        const exit = await closed
        if (startupError || exit.code !== 0 || !result) throw startupError || new Error(stderr || 'Native reference failed')
        lifetime.signal.throwIfAborted()
        if (options.surfaces) {
          const bytes = fs.readFileSync(surfaceFile)
          if (!result.surfaceSnapshot || result.surfaceSnapshot.bytes !== bytes.length ||
              result.surfaceSnapshot.meshes.length !== result.visibleMeshes)
            throw new Error('Incomplete visible surface capture')
          Object.assign(result.surfaceSnapshot, {file:surfaceFile, sha256:hash(bytes)})
        }
        const comparisons = (baseline.steps || []).filter(row => row.id === sample.id).map(row => ({direction:row.direction,
          status:row.status,actualWorkingMeshBytes:row.final.metrics.workingMeshBytes,
          actualMeshes:row.final.metrics.terrainMeshes,actualError:row.final.metrics.terrainError,
          referenceMeshBytes:result.meshBytesWithRoots,
          workingCapacityFitsReference:row.final.metrics.workingMeshBytes >= result.meshBytesWithRoots}))
        const configuredMeshBytes = config.initialBudgets && config.initialBudgets.maximumTerrainMeshBytes
        const knownCapacity = Number.isSafeInteger(configuredMeshBytes) && configuredMeshBytes > 0
        const meshCapacity = {configuredBytes:knownCapacity ? configuredMeshBytes : null,
          referenceBytes:result.meshBytesWithRoots,
          fitsReference:knownCapacity ? result.meshBytesWithRoots <= configuredMeshBytes : null,
          shortfallBytes:knownCapacity ? Math.max(0,result.meshBytesWithRoots-configuredMeshBytes) : null}
        report.samples.push({...sample,...result,meshCapacity,comparisons}); save()
        console.log(sample.id, 'target='+result.targetMet, 'meshes='+result.visibleMeshes,
          'meshMiB='+(result.meshBytesWithRoots/1048576).toFixed(2),
          'configuredCapacityFits='+meshCapacity.fitsReference, 'LODms='+result.lodMs.toFixed(2))
      } finally {
        clearTimeout(timeout); lifetime.signal.removeEventListener('abort',stop)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await closed; child = null
      }
    }
    report.status = 'complete'; report.allTerrainTargetsMet = report.samples.every(row => row.targetMet)
    report.allReferenceCutsFitConfiguredMeshCapacity = report.samples.some(row => row.meshCapacity.fitsReference === false)
      ? false : report.samples.some(row => row.meshCapacity.fitsReference === null) ? null : true
    process.exitCode = report.allTerrainTargetsMet && report.allReferenceCutsFitConfiguredMeshCapacity === true ? 0 : 2
  } catch (error) {
    report.status='failed'; report.error=error.message; process.exitCode=1
  } finally {
    lifetime.abort(); clearTimeout(timeout)
    if (child) {child.kill('SIGKILL'); await closed}
    process.removeListener('SIGINT',interrupt); process.removeListener('SIGTERM',interrupt)
    report.cleanup={nativeProcessClosed:true,activeFetches};
    fs.writeFileSync(path.join(output,'records.json'),JSON.stringify({fixtureSha256:catalogue.sha256,
      records:[...records.values()].filter(row=>row.origin!=='fixture')},null,2))
    save(); console.log('Reference report: '+path.join(output,'report.json'))
  }
}
if (require.main === module) main().catch(error => {console.error(error);process.exitCode=1})
module.exports = {posesFromReport}
