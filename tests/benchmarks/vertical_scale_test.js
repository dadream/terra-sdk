const assert = require('assert')
const bench = require('./vertical_scale')
const {csv, decodeHtml, argumentsMap} = require('../../scripts/benchmark_vertical_scale')
const {read:readProbe} = require('./vertical_scale_probe')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ResourceShare} = require('../../sdk/js/resources/resource_share')

function verifyShareProbe() {
  const ledger=new ResourceLedger(1000), share=new ResourceShare(ledger,'imagery',100,500)
  const runtime={manifest:{texture:{kind:'global-geodetic',level_zero_columns:2,level_zero_rows:1,maximum_level:17,tile_size:256}},
    rangeLimits:()=>({minimum:1,maximum:1000}),renderer:{presentedTextures:new Map()}}
  const state={budget:{physicalHeight:600,devicePixelRatio:1,textureCacheBytes:100},radiusMeters:100,
    terrainSelection:{},resourceMemory:{},performance:{},renderer:{quality:{},textures:{},performance:{textureCapacityBytes:100},transition:{}}}
  const viewer={runtime,getState:()=>state}
  const sample=()=>{state.renderer.textures.resourceShare=share.stats();return readProbe(viewer)}
  const initial=sample()
  assert(share.grow(100))
  const expanded=sample()
  assert.deepStrictEqual(initial.configuration,expanded.configuration,'A live grant changed the fixed benchmark configuration')
  assert.strictEqual(initial.metrics.textureGrantedBytes,100)
  assert.strictEqual(expanded.metrics.textureGrantedBytes,200)
  assert.strictEqual(expanded.metrics.textureMaximumShareBytes,500)
  share.revoke()
  assert.strictEqual(sample().metrics.textureGrantedBytes,100,'Probe retained revoked capacity')
  state.renderer.textures.resourceShare=null
  assert.strictEqual(readProbe(viewer).metrics.textureMaximumShareBytes,100,'Fixed cache limit became optional growth')
  assert.strictEqual(ledger.bytes,0)
}

function fixture(kind = 'ready') {
  let clock = 0, changedAt = 0, view, reads = 0
  const calls = []
  const configuration = {datasetId:'fixture', imageryId:'fixture'}
  const target = {longitudeDegrees:116.56230, latitudeDegrees:40.74863, heightMeters:750}
  const samples = [{id:'global',level:null,rangeMeters:1000}, {id:'level-0',level:0,rangeMeters:100},
    {id:'level-1',level:1,rangeMeters:50}]
  const viewer = {camera:{cancelAnimation() {}, setView(value) {view = value; changedAt = clock; calls.push(value)}},
    diagnostics:{snapshot() {return {runtime:{lodUpdate:{count:reads,averageMs:2,maximumMs:2}}}}}}
  const read = () => {
    ++reads
    const ready = clock - changedAt >= 100, capacity = kind === 'capacity', data = kind === 'data'
    const resource = {achievedLodError:capacity ? 2 : 1, requestedLodThreshold:1,
      limitedByCapacity:capacity, pendingMeshGroups:kind === 'timeout' ? 1 : 0}
    const q = {cameraCurrent:ready, terrainSelectionCurrent:ready, geometryTargetComplete:!capacity,
      resolvedMaxPixelError:data ? 2 : 1, targetPixelError:1.25, targetMet:!data,
      covered:ready, missingCount:0, settled:ready && !data && !capacity,
      limitationReasons:capacity ? ['terrain-budget'] : data ? ['source-level'] : []}
    return {configuration, metrics:{managedBytes:123,wasmBytes:1000,workingMeshBytes:100,terrainMeshes:1},
      sets:{terrain:['0/1/2/3/0'],imagery:['0/0/0/0'],targetImages:['0/0/0/0'],presentedImages:['0/0/0/0']},
      state:{view, resources:resource, terrain:{active:0,queued:0},
        terrainSelection:{desiredViewRevision:calls.length,preparedViewRevision:calls.length,
          presentedViewRevision:calls.length,presentedSequence:calls.length,presentedModelRevision:calls.length},
        renderer:{quality:q,draws:{submitted:1},textures:{active:0,queued:0},
          transition:{gpuSubmission:{pending:false},handoff:{phase:'presented'},partitions:{}}},
        performance:{frameCoordinator:{}}}}
  }
  return {viewer, calls, read, options:{read,configuration,target,samples,timeoutMs:1000,stableMs:200,intervalMs:100,
    now:() => clock, sleep:async ms => {clock += ms}}}
}

async function main() {
  verifyShareProbe()
  const config = {radiusMeters:6378000,cssHeight:600,tileSize:256,imageryPixelError:1.25,
    fovRadians:Math.PI/4,globalRangeMeters:6378000*4,minimumRangeMeters:0.1,maximumInternalLevel:17}
  const scales = bench.scales(config)
  assert.strictEqual(scales[0].id,'global')
  assert.strictEqual(scales[scales.length - 1].level,17)
  for (let i=2; i<scales.length; ++i) assert.strictEqual(scales[i-1].rangeMeters / scales[i].rangeMeters,2)
  assert.throws(() => bench.scales(config,18),/maximum level/)
  assert.throws(() => bench.scales({...config,minimumRangeMeters:1000}),/Finest sample/)
  const smallerGlobal = bench.scales({...config,globalRangeMeters:6378000})
  assert(smallerGlobal[1].level > 0, 'Levels outside global range must be disclosed by the actual sample table')

  const f = fixture(), report = await bench.run(f.viewer,f.options)
  assert(report.allTargetsMet && report.sameEndpointSets && report.status === 'complete')
  assert.deepStrictEqual(report.steps.map(row => row.id), ['global','level-0','level-1','level-0','global'])
  assert.deepStrictEqual(f.calls[0],f.calls[4]); assert.deepStrictEqual(f.calls[1],f.calls[3])
  assert(f.calls.every(view => view.tiltDegrees === 0 && view.headingDegrees === 0 && view.target.heightMeters === 750))
  for (const row of report.steps) {
    assert.strictEqual(row.firstCoverageMs,100)
    assert.strictEqual(row.durationMs,300)
    assert.strictEqual(row.sampledPeakBytes,123)
    assert(row.timings['runtime.lodUpdate'].instrumentedElapsedMs > 0)
  }
  for (const [kind,status] of [['capacity','capacity-limited'],['data','data-limited'],['timeout','timeout']]) {
    const f = fixture(kind), result = await bench.run(f.viewer,f.options)
    assert.strictEqual(result.status,'complete')
    assert.strictEqual(result.allTargetsMet,false)
    assert(result.steps.every(row => row.status === status))
    if (kind === 'capacity') assert(result.steps.every(row => row.terrainTargetMs === null))
    if (kind === 'timeout') assert(result.steps.every(row => row.durationMs === 1000))
  }
  // An idle SDK flag cannot substitute for independently checked numerical SSE.
  const invalid = fixture(), read = invalid.read
  invalid.options.read = () => {const result=read();result.state.resources.achievedLodError=4;return result}
  const invalidResult = await bench.run(invalid.viewer,invalid.options)
  assert(invalidResult.steps.every(row => row.status === 'timeout' && row.terrainTargetMs === null))
  const measuring = fixture('capacity')
  measuring.options.read = () => {
    const result = measuring.read(); result.state.renderer.quality.measurementPending = true; return result
  }
  assert((await bench.run(measuring.viewer,measuring.options)).steps.every(row =>
    row.status === 'timeout' && row.quality.busy.includes('imagery')),
  'Unfinished measurement was accepted as a terminal capacity result')
  // A historical failure counter is not evidence that current imagery failed.
  const stale = fixture()
  stale.options.read = () => {
    const result = stale.read(), r = result.state.renderer
    r.textures.failed = 41; r.textures.blockedByFailure = false
    r.quality.resourceStable = true; r.quality.settled = false
    return result
  }
  const staleResult = await bench.run(stale.viewer,stale.options)
  assert(staleResult.steps.every(row => row.status === 'diagnostic-inconsistent' &&
    row.quality.terrainMet && row.quality.imageryMet && !row.quality.reasons.includes('image-failure')))
  const failed = fixture()
  failed.options.read = () => {
    const result = failed.read(), r = result.state.renderer
    r.textures.failed = 1; r.textures.blockedByFailure = true
    r.quality.settled = false
    return result
  }
  assert((await bench.run(failed.viewer,failed.options)).steps.every(row =>
    row.status === 'data-limited' && row.quality.reasons.includes('image-failure')))
  const moved = fixture()
  moved.options.read = () => {const result=moved.read(); result.state.view={...result.state.view,rangeMeters:5};return result}
  await assert.rejects(bench.run(moved.viewer,moved.options),error => error.report.status === 'failed' && /camera/.test(error.message))
  const reconfigured = fixture()
  reconfigured.options.read = () => ({...reconfigured.read(),configuration:{datasetId:'changed'}})
  await assert.rejects(bench.run(reconfigured.viewer,reconfigured.options),/configuration changed/)
  const cancelled = fixture(), controller = new AbortController()
  cancelled.options.signal = controller.signal
  cancelled.options.sleep = async () => controller.abort()
  await assert.rejects(bench.run(cancelled.viewer,cancelled.options),error => error.report.status === 'cancelled')
  const a = report.steps[0], b = JSON.parse(JSON.stringify(a)); b.final.sets.terrain = ['0/9/9/9/0']
  const comparison = bench.compare(a,b)
  assert(!comparison.sameSets && comparison.sets.terrain.down === comparison.sets.terrain.up)
  assert.deepStrictEqual(comparison.sets.terrain.onlyDown,['0/1/2/3/0'])
  assert.strictEqual(csv(report).split('\n').length,7)
  assert.strictEqual(decodeHtml('&lt;&amp;&gt;&quot;&#39;'),'<&>"\'')
  assert.throws(() => argumentsMap(['--unexpected','value']),/Invalid option/)
  console.log('Vertical scale benchmark: fixed reverse poses, numerical quality, limited/timeout distinction, cancellation and membership comparison passed')
}
main().catch(error => {console.error(error);process.exitCode=1})
