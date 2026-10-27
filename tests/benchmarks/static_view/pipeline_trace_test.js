'use strict'
const assert = require('assert')
const {installPipelineTrace} = require('./pipeline_trace')

async function main() {
  let time = 0, admitted = false, finish, uploaded, cancelled, rejectUpload = true
  const reservation = {}, asset = {blob:{}, input:{}}, entry = {value:asset}
  const request = {promise:new Promise(resolve => {finish = resolve}), abort() {return 'aborted'}}
  const store = {preparationWaiting:new Set(['tile']), inputBlocked:new Set(),
    targetDesired:new Map([['tile',{}]]),
    buildRequirementTree(draws) {this.targetDesired=new Map(draws.map(d=>[[d.texture.level,d.texture.matrix,d.texture.row,d.texture.column].join('/'),d.texture]))},
    scheduler:{active:new Map(), queued:new Map()}, cache:{entries:new Map([['tile',entry]])},
    pipelineBytes:() => 0, inputBytes:0, maximumInputBytes:100,maximumPipelineBytes:120,inputHighWaterBytes:10,
    reserveRequest() {return admitted ? reservation : null}, requestAsset() {return request},
    preparations:new Map(),
    prepareAsset(key, value) {this.preparations.set(value, {entry:value}); return false},
    finishPreparation(task) {this.preparations.delete(task.entry)}}
  const submissions = {batches:[], uploading:false,
    submit(batch) {this.batches.push(batch)},
    poll(callback) {callback(this.batches.shift()); return 'completed'}}
  const group = {future:new Map([['tile',{}]]),pending:new Map(),task:{}}
  const record = {goalRevision:1, aliases:new Set()}
  const world = {records:[record], stats:{builds:0}, now:() => time,
    signature:() => String(record.goalRevision), demandPrepared:() => Boolean(world.installed), targetState:() => 'waiting',
    start(value) {this.job = {record:value, draws:[{}], sourceDraws:[{}], stamp:this.signature()}; ++this.stats.builds; return true},
    advanceWork() {time += .25; return 'advanced'},
    install(job, result) {this.installed = result; return 'installed'}, closeJob() {this.job = null}}
  const renderer = {textures:store, submissions, presentedTextures:new Map(),
    advanceResources() {}, prepareResources() {return true}, renderDraws:[],
    cameraVersion:1, current:{frame:{sequence:1}},resourceLedger:{bytes:200,maximumBytes:1000},
    partitionBytes:30,partitionReservedBytes:40,partitionCpuBytes:10,partitionCapacityBytes:100,
    setImageryPlan(sequence, plan) {this.current.imageryPlan=plan;this.renderDraws=plan.draws;store.buildRequirementTree(plan.draws);return true},
    partitionQueue:[], partitionUploads:[], worldDisplay:world,
    partitionGroups:{prepareImagery() {this.refresh();world.targetState(new Map());this.current = group; return 'waiting'},
      refresh() {return 'refreshed'},release(value=this.current) {if(this.current===value)this.current=null;return 'released'},
      price() {return 'priced'}, fund(value) {
        if(value.refuseFunding)return 'refused'
        value.pool = {output:{bytes:30}}; return 'funded'
      }},
    uploadTexture(image, width, height, publish, cancel) {
      if (rejectUpload) {cancel(); return false}
      uploaded = publish; cancelled = cancel; return true
    }, renderSurface() {this.surfaceDrawn = true; return 'drawn'}}
  const originals = [store.reserveRequest, renderer.uploadTexture, submissions.poll]
  let bitmapReady
  const bitmap = new Promise(resolve => {bitmapReady = resolve})
  let headersReady
  const response = new Promise(resolve=>{headersReady=resolve})
  const host = {createImageBitmap() {return bitmap},fetch(){return response}}, originalBitmap = host.createImageBitmap,
    originalFetch=host.fetch
  const probe = installPipelineTrace(renderer, () => time, host)
  assert.strictEqual(host.fetch('/image?private=value'),response,'Transport tracing changed fetch identity')
  headersReady({status:200});await response
  assert.deepStrictEqual(probe.trace.transport,[{path:'/image',requestedMs:0,headersMs:0,status:200}])
  assert.strictEqual(store.reserveRequest('tile'), null)
  admitted = true; time = 1
  assert.strictEqual(store.reserveRequest('tile'), reservation)
  assert.strictEqual(store.requestAsset('url', reservation), request, 'Tracing replaced request/cancellation identity')
  time = 2; finish(asset); await request.promise
  time = 3; store.prepareAsset('tile', entry)
  assert.strictEqual(host.createImageBitmap(asset.blob), bitmap)
  time = 3.5; bitmapReady({}); await bitmap
  time = 4; asset.image = {}; store.finishPreparation(store.preparations.get(entry))
  let published = 0, rejected = 0
  time = 5
  assert.strictEqual(renderer.uploadTexture(asset.image, 1, 1, () => ++published, () => ++rejected), false)
  assert.strictEqual(probe.trace.images[0].uploadMs, undefined, 'Rejected admission was counted as an upload')
  rejectUpload = false; time = 6
  assert.strictEqual(renderer.uploadTexture(asset.image, 1, 1, () => ++published, () => ++rejected), true)
  const batch = {items:[{label:'imagery texture'}], budget:{bytes:10, objects:1}}
  submissions.submit(batch)
  time = 7; uploaded({}); asset.texture = {}
  let completion = 0
  assert.strictEqual(submissions.poll(() => ++completion), 'completed')
  time = 8; renderer.presentedTextures.set('tile', {})
  assert.strictEqual(renderer.renderSurface(), 'drawn')
  renderer.meshOutputPlan={accepted:false}
  assert.strictEqual(renderer.partitionGroups.prepareImagery(),'waiting')
  renderer.meshOutputPlan.accepted=true
  assert.strictEqual(renderer.partitionGroups.prepareImagery(),'waiting')
  renderer.partitionGroups.price(group); renderer.partitionGroups.fund(group)
  assert.strictEqual(renderer.prepareResources(),true)
  assert.strictEqual(world.start(record),true)
  assert.strictEqual(world.advanceWork(8),'advanced')
  ++record.goalRevision
  assert.strictEqual(world.install(world.job,{rows:[{},{}]}),'installed')
  world.closeJob(false)
  const a={geometryKey:'a',origin:[0,0,0],texture:{level:0,row:0,column:0}},b={...a,geometryKey:'b'}
  renderer.renderDraws=[a,b]
  assert.strictEqual(renderer.setImageryPlan(1,{draws:[b,a],quality:{measurementPending:true}}),true)
  probe.sample()
  assert.deepStrictEqual(probe.trace.images.map(row => [row.requestMs,row.bodyMs,row.decodeStartMs,
    row.decodedMs,row.uploadMs,row.gpuMs,row.displayMs]), [[1,2,3,4,6,7,8]])
  assert.deepStrictEqual([published,rejected,completion], [1,1,1])
  assert.strictEqual(probe.trace.batches[0].completedMs,7)
  assert.strictEqual(probe.trace.attempts[0].refused.preparation,1)
  assert.strictEqual(probe.trace.groups[0].fundedMs,8)
  assert.strictEqual(probe.trace.samples[0].gpu,1)
  assert.strictEqual(probe.trace.samples[0].meshOutputAccepted,true)
  assert.strictEqual(probe.trace.samples[0].managedMaximumBytes,1000)
  assert.strictEqual(probe.trace.samples[0].partitionCapacityBytes,100)
  assert.strictEqual(probe.trace.samples[0].inputHighWaterBytes,10)
  assert.strictEqual(probe.trace.samples[0].waitingBodies,0)
  assert.deepStrictEqual(probe.trace.samples[0].groupState,{kind:'imagery',phase:'pricing',funded:true,
    pendingOutputs:0,outputBytes:30,workspaceBytes:0,workspaceAvailableBytes:0})
  const admission=probe.trace.work['imageAdmission:0']
  assert.deepStrictEqual([admission.private_waiting,admission.handoff_waiting,admission.world_waiting],[1,1,2])
  assert.strictEqual(admission.waiting_with_imagery_pricing,1,'Observation must use the actual post-refresh group')
  assert.strictEqual(probe.trace.images[0].bitmapCalledMs,3)
  assert.strictEqual(probe.trace.images[0].bitmapObservedMs,3.5)
  assert.strictEqual(probe.trace.images[0].demandId,0)
  assert.strictEqual(probe.trace.images[0].target,true)
  assert.deepStrictEqual(probe.trace.demands[0].added,[['tile',0]])
  assert.strictEqual(probe.trace.demands[1].preview,true)
  assert.deepStrictEqual(probe.trace.demands[1].removed,['tile'])
  const observed=probe.trace.demands.length
  store.buildRequirementTree(renderer.renderDraws)
  assert.strictEqual(probe.trace.demands.length,observed,'Equivalent requirements created extra trace versions')
  // A fitted mesh can coexist with a preview on the same physical image.
  const fitted={...a,imageryDemandView:1,imageryPixelError:1.2}
  store.buildRequirementTree([fitted,b])
  assert.strictEqual(probe.trace.demands[2].added[0][1],3)
  probe.trace.demandKeyLimit=probe.trace.demandKeys
  store.buildRequirementTree([])
  assert(probe.trace.truncated,'Demand metadata was allowed to grow without a bound')
  assert.deepStrictEqual(probe.trace.worlds,[{startedMs:8,goalRevision:1,draws:1,sources:1,stamp:'1',
    installedMs:8.25,currentStamp:'2',currentGoalRevision:2,rows:2,closedMs:8.25,cancelled:false}])
  assert.strictEqual(probe.trace.work['world:0'].exhausted,1)
  assert.strictEqual(probe.trace.work['world:0'].wallMs,.25)
  assert.deepStrictEqual(probe.trace.goals,[{timeMs:8.25,before:2,after:2,added:0,removed:0,
    sameOrder:false,preview:true,complete:false}])
  assert.strictEqual(renderer.partitionGroups.release(group),'released')
  assert.strictEqual(probe.trace.groups[0].releaseRequestedMs,8.25)
  assert.strictEqual(probe.trace.groups[0].releasedMs,undefined,'Cancellation request was reported as an ownership receipt')
  group.task=null;time=8.5
  assert.strictEqual(renderer.partitionGroups.release(group),'released')
  assert.strictEqual(probe.trace.groups[0].releasedMs,8.5)
  const short={refuseFunding:true,pending:new Map([['mesh:uv',15]])}
  assert.strictEqual(renderer.partitionGroups.fund(short),'refused')
  assert.strictEqual(probe.trace.groups[1].partitionShortfallBytes,10,
    'Local output and minimum producer workspace must be included despite shared-budget headroom')
  assert.strictEqual(probe.trace.groups[1].unfunded,1)
  renderer.partitionCapacityBytes=200
  assert.strictEqual(renderer.partitionGroups.fund(short),'refused')
  assert.strictEqual(probe.trace.groups[1].partitionShortfallBytes,10,'A later attempt hid an earlier local shortage')
  probe.close(); probe.close()
  assert.deepStrictEqual([store.reserveRequest,renderer.uploadTexture,submissions.poll], originals)
  assert.strictEqual(host.createImageBitmap,originalBitmap)
  assert.strictEqual(host.fetch,originalFetch)
  time = 9; cancelled()
  assert.strictEqual(rejected,2, 'Closing observation suppressed an owned callback')
  assert.strictEqual(probe.trace.images[0].cancelledUploadMs,5, 'Closed observation still recorded work')
  console.log('Static pipeline trace preserves requests/callbacks, rejected upload semantics, timestamps and restoration')
}
main().catch(error => {console.error(error); process.exitCode = 1})
