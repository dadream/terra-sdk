const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {NativeMeshBudget} = require('../../sdk/js/resources/native_mesh_budget')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')
const {ResourceCache} = require('../../sdk/js/resources/resource_cache')
const {TextureStore} = require('../../adapters/webgl/texture_store')
const tick = async () => {for(let i=0;i<12;++i)await Promise.resolve()}

async function verifyUnfundedScheduledPressure() {
  const {ProducedTextureStore} = require('../../adapters/webgl/produced_texture_store')
  const {RequestScheduler} = require('../../sdk/js/core/terra_globe_common')
  const ledger = new ResourceLedger(100), held = ledger.reserve('display',100)
  const store = Object.create(ProducedTextureStore.prototype), observed = []
  Object.assign(store,{generation:1,inputJobs:0,admissionBlocked:new Set(),preparations:new Map(),
    cache:new ResourceCache({ledger}),scheduler:new RequestScheduler(2),
    failed:new Map(),desired:new Map([['leaf',{}]]),currentRoots:new Set(['leaf']),
    inputBlocked:new Set(),preparationWaiting:new Set(),groupCapacityBlocked:new Set(),
    targetDesired:new Map([['leaf',{}]]),gpuReady:()=>false,
    renderer:{cameraVersion:1,plannedCameraVersion:1,
      current:{frame:{sequence:1},imageryPlan:{quality:{planningComplete:true}}},
      options:{onResourcePressure() {observed.push(store.scheduler.active.size);return true}}},
    reserveRequest() {
      this.capacityPressure={generation:1,camera:1,sequence:1,ownedBytes:100,shortfallBytes:20,keys:['leaf']}
      this.scheduleTerrainPressure()
      return null
    },
    requestAsset() {assert.fail('An unfunded request started network I/O')}
  })
  try {
    store.schedule('leaf',{},1)
    assert.strictEqual(store.scheduler.active.size,1)
    await tick()
    assert.deepStrictEqual(observed,[1],
      'A rejected admission occupied a scheduler slot and suppressed its own capacity recovery')
    assert.strictEqual(store.scheduler.active.size,0)
    assert.strictEqual(ledger.bytes,100,'Recovery notification refunded the live display')
  } finally {store.scheduler.clear();held.release()}
}

async function verifyImageryPressureFeedback() {
  const {ProducedTextureStore} = require('../../adapters/webgl/produced_texture_store')
  const ledger = new ResourceLedger(100), held = ledger.reserve('display', 100)
  const notified = [], repriced = [], store = Object.create(ProducedTextureStore.prototype)
  Object.assign(store, {generation: 1, inputJobs: 0, admissionBlocked: new Set(), preparations: new Map(),
    scheduleAdvance() {repriced.push(true)}, cache: {ledger, reservations: new Map()},
    scheduler: {active: new Map()}, targetDesired: new Map([['leaf', {}]]), gpuReady: () => false,
    renderer: {cameraVersion: 1, plannedCameraVersion: 1,
      current: {frame: {sequence: 1}, imageryPlan: {quality: {planningComplete: true}}},
      options: {onResourcePressure(value) {notified.push(value.shortfallBytes); return true}}}})
  const pressure = () => ({generation: 1, camera: 1, ownedBytes: 100, shortfallBytes: 20, keys: ['leaf'], sequence: 1})
  store.capacityPressure = pressure(); store.inputJobs = 1
  store.scheduleTerrainPressure(); await tick()
  assert.strictEqual(notified.length, 0, 'A funded decoder forced terrain coarsening')
  store.inputJobs = 0; store.cache.reservations.set('funded',{})
  store.scheduleTerrainPressure(); await tick()
  assert.strictEqual(notified.length,0,'An owned image destination lost its production continuation')
  store.cache.reservations.clear(); store.renderer.cameraVersion = 2
  store.scheduleTerrainPressure(); await tick()
  assert.strictEqual(notified.length, 0, 'An obsolete image target forced terrain coarsening')
  store.renderer.cameraVersion = 1; store.renderer.current.frame.sequence = 2
  store.scheduleTerrainPressure(); await tick()
  assert.strictEqual(notified.length, 0, 'An obsolete mesh footprint forced terrain coarsening')
  assert.strictEqual(repriced.length, 1, 'A changed mesh never repriced its blocked imagery group')
  store.renderer.current.frame.sequence = 1
  store.capacityPressure = pressure()
  store.scheduleTerrainPressure()
  store.capacityPressure = {...pressure(), shortfallBytes: 25}
  store.scheduleTerrainPressure()
  assert.strictEqual(notified.length, 0, 'Pressure escaped before its cache receipt')
  await tick()
  assert.deepStrictEqual(notified, [25])
  assert.strictEqual(store.capacityPressure, null)
  assert.strictEqual(ledger.bytes, 100, 'Pressure feedback refunded displayed ownership')
  store.capacityPressure = pressure(); held.resize(90)
  store.scheduleTerrainPressure(); await tick()
  assert.deepStrictEqual(notified, [25, 10], 'A partial cache receipt lost the remaining shared deficit')
  const pending = store.capacityPressure = pressure()
  store.renderer.options.onResourcePressure = () => false
  store.scheduleTerrainPressure(); await tick()
  assert.strictEqual(store.capacityPressure, pending,
    'Deferred measurement discarded the only owner of an unchanged group refusal')
  store.renderer.options.onResourcePressure = () => true
  store.scheduleTerrainPressure(); await tick()
  assert.strictEqual(store.capacityPressure, null, 'Completed recovery did not consume its refusal')
  // A display-only fence does not own image production. Repeated redraws
  // cannot suppress a current capacity refusal indefinitely. Actual uploads,
  // including a batch queued behind that display, still own their continuation.
  const {SubmissionQueue} = require('../../adapters/webgl/submission_queue')
  const {GlSubmission} = require('../../adapters/webgl/gl_allocation')
  const gl = {SYNC_GPU_COMMANDS_COMPLETE:1,TIMEOUT_EXPIRED:2,ALREADY_SIGNALED:3,
    fenceSync:()=>({}),flush(){},clientWaitSync:()=>2,deleteSync(){}}
  const submissions = store.renderer.submissions = new SubmissionQueue()
  Object.defineProperty(store.renderer,'pendingSubmission',{get:()=>submissions.pending})
  let receipts = 0
  const display = new GlSubmission(gl); display.hold(()=>{++receipts})
  submissions.submit(display,true)
  store.renderer.options.onResourcePressure = value => {notified.push(value.shortfallBytes);return true}
  store.capacityPressure = pressure()
  store.scheduleTerrainPressure(); await tick()
  assert.deepStrictEqual(notified,[25,10,10], 'Display-only fences starved image capacity recovery')
  assert.strictEqual(receipts,0,'Pressure bypassed the pending display receipt')
  assert.strictEqual(ledger.bytes,90,'A pending display was refunded to manufacture recovery space')
  const upload = new GlSubmission(gl); upload.hold(()=>{++receipts})
  submissions.submit(upload)
  store.capacityPressure = pressure()
  store.scheduleTerrainPressure(); await tick()
  assert.strictEqual(notified.length,3,'Recovery ignored an upload behind the display fence')
  // Complete the display only: the remaining resource fence must also defer.
  display.poll=()=>true
  submissions.poll(()=>{})
  assert.strictEqual(receipts,1)
  store.scheduleTerrainPressure(); await tick()
  assert.strictEqual(notified.length,3,'Recovery ignored the active resource fence')
  upload.poll=()=>true;submissions.poll(()=>{})
  store.scheduleTerrainPressure(); await tick()
  assert.deepStrictEqual(notified,[25,10,10,10],'Actual upload completion did not reopen recovery')
  assert.strictEqual(receipts,2)
  assert.strictEqual(ledger.bytes,90)
  // The same distinction applies to retracting an optional image share. A
  // spent grant stays owned even after its future planning allowance shrinks.
  const {ResourceShare} = require('../../sdk/js/resources/resource_share')
  held.resize(70)
  const share=store.resourceShare=new ResourceShare(ledger,'image-share',30,60)
  assert(share.grow(20))
  const spent=share.fund(funding=>ledger.reserve('image-destination',20,[],[],funding))
  assert(spent && ledger.bytes===90 && share.workspace.bytes===0)
  let changed=0
  store.renderer.options.onImageryPlanningChange=()=>{++changed}
  store.renderer.requestRender=()=>{}
  store.applyShareLimit=()=>{}
  store.targetCapacity=()=>5;store.estimatedTileBytes=10;store.requestedMaximumBytes=50
  store.renderer.current.imageryPlan.quality.maximumTextureCount=5
  store.admissionBlocked.add('leaf');store.scheduler.queued=new Map()
  const drawing=new GlSubmission(gl);submissions.submit(drawing,true)
  const producing=new GlSubmission(gl);producing.hold(()=>{})
  submissions.submit(producing)
  store.capacityPressure={...pressure(),ownedBytes:90,maximumBytes:50}
  assert.strictEqual(store.resolveCapacityPressure(),false)
  assert.strictEqual(share.extraBytes,20,'A queued upload lost its planning allowance')
  drawing.poll=producing.poll=()=>true;submissions.poll(()=>{})
  const redraw=new GlSubmission(gl);submissions.submit(redraw,true)
  store.scheduler.queued.set('unfunded',{})
  assert.strictEqual(store.resolveCapacityPressure(),true,'A redraw starved optional share retraction')
  assert.strictEqual(changed,1)
  assert.strictEqual(share.extraBytes,0)
  assert.strictEqual(ledger.bytes,90,'Share retraction refunded a live image destination')
  submissions.cancel();spent.release();share.revoke()
  held.release()
}

async function main() {
  require('./imagery_continuation_demand_contract')()
  require('./imagery_demand_stability_contract')()
  await verifyUnfundedScheduledPressure()
  await verifyImageryPressureFeedback()
  // A fully admitted spatial cut can continue terrain before its final imagery
  // refinement. Mere previews and receipts from another view/source/frame cannot.
  {
    const {TerrainDemand} = require('../../sdk/js/terrain/terrain_demand')
    const {TerraWebGlRenderer} = require('../../adapters/webgl/terra_webgl_renderer')
    for (const invalidation of ['camera', 'source', 'frame']) {
      const ledger = new ResourceLedger(2000), gate = new TerrainDemand()
      const plan = {quality: {planningComplete:false, cameraCurrent:true}}
      const renderer = {resourceLedger:ledger, canvas:{}, options:{}, requestResources(){}, requestRender(){},
        mode:'texture', cameraVersion:2, plannedCameraVersion:2,
        current:{frame:{sequence:1}, imageryPlan:plan}}
      const store = renderer.textures = new TextureStore(renderer, {urlForTile:()=>'', maximumBytes:2000})
      store.estimatedTileBytes=100;store.minimumWorkspaceBytes=()=>40
      const quote = () => TerraWebGlRenderer.prototype.terrainRefinementDemand.call(renderer)
      const reserve = demand => TerraWebGlRenderer.prototype.reserveImageryDemand.call(renderer,demand)
      try {
        gate.expect('view',1)
        assert(gate.update('view',quote(),reserve), 'An unpriced preview authorized topology')
        const candidate=store.reserveCandidateDemand([{texture:{level:2,matrix:2,row:0,column:0}}])
        assert.strictEqual(candidate.quote(),null,'A private reservation authorized published topology')
        TerraWebGlRenderer.prototype.acceptCandidateImagery.call(renderer, renderer.current.frame, plan,
          {acceptImageryDemand:candidate.accept,imageryDemand:candidate.quote})
        const admitted=quote()
        assert(admitted && admitted.admission && admitted.requiredBytes===240)
        assert.strictEqual(gate.update('view',admitted,reserve),false,
          'Admitted complete coverage waited for the whole final precision job')
        assert.strictEqual(plan.quality.planningComplete,false,'Admission forged final precision readiness')
        if (invalidation==='camera') ++renderer.cameraVersion
        if (invalidation==='frame') ++renderer.current.frame.sequence
        if (invalidation==='source') store.setSource(()=>'',[])
        assert.strictEqual(quote(),null,'An obsolete '+invalidation+' receipt authorized topology')
        assert.strictEqual(reserve(admitted),false,'An obsolete '+invalidation+' quote acquired credit')
      } finally {store.destroy()}
      assert.strictEqual(ledger.bytes,0,'Admission receipt retained resources after teardown')
    }
  }
  {
    const {ResourceShare} = require('../../sdk/js/resources/resource_share')
    const {TerraWebGlRenderer} = require('../../adapters/webgl/terra_webgl_renderer')
    const ledger = new ResourceLedger(2000), renderer = {resourceLedger: ledger, canvas: {}, options: {},
      requestResources() {}, mode: 'texture', cameraVersion: 2, plannedCameraVersion: 2,
      current: {frame: {sequence: 1}, imageryPlan: {quality: {planningComplete: true}}}}
    const store = renderer.textures = new TextureStore(renderer, {urlForTile: () => '', maximumBytes: 2000})
    store.estimatedTileBytes = 100; store.minimumWorkspaceBytes = () => 40
    store.currentRoots.set('root', {})
    for (const id of ['root', 'running', 'missing', 'staged']) store.targetDesired.set(id, {})
    store.cache.set('root', {}, 100); store.cache.set('staged', {}, 100)
    const running = store.cache.reserve('running', 100)
    store.resourceShare = new ResourceShare(ledger, 'imagery-share', 400, 1000)
    assert(store.resourceShare.grow(30))
    try {
      const quote = store.resourceDemand()
      assert.strictEqual(quote.bytes, 110, 'Targets, grants or the serial input lane were mispriced')
      assert.strictEqual(quote.keep.length, 3)
      assert.strictEqual(ledger.bytes, 330, 'Forecast produced resources or evicted old data')
      assert(ledger.canReserve(1800))
      assert(!ledger.canReserve(1800, [], quote.keep), 'A staged target self-funded competing terrain')
      const demand = () => TerraWebGlRenderer.prototype.terrainRefinementDemand.call(renderer)
      assert.strictEqual(demand().bytes, 110)
      renderer.current.imageryPlan.quality.refinableMeasurementCount = 2
      assert.strictEqual(demand().refinable, true)
      let remeasure = 0
      renderer.requestRender = () => {}
      renderer.options.onImageryPlanningChange = () => {++remeasure}
      const tighten = () => TerraWebGlRenderer.prototype.refineImageryDemand.call(renderer)
      assert(tighten()); assert(!tighten())
      assert.strictEqual(remeasure, 1, 'Unchanged pressure restarted its measurement job')
      renderer.cameraVersion = 3
      assert(tighten()); assert.strictEqual(remeasure, 2)
      renderer.cameraVersion = 2
      renderer.current.imageryPlan.quality.refinableMeasurementCount = 0
      assert.strictEqual(demand().refinable, false)
      const reserve = quote => TerraWebGlRenderer.prototype.reserveImageryDemand.call(renderer, quote)
      assert.strictEqual(reserve({...demand(), sequence: 0}), false, 'Old terrain acquired current-view credit')
      assert.strictEqual(reserve({...demand(), cameraVersion: 1}), false, 'Old camera quote acquired new-view credit')
      assert.strictEqual(reserve({...demand(), sourceGeneration: -1}), false, 'Old source quote acquired new-source credit')
      assert(reserve(demand()))
      assert.strictEqual(store.demandCredit.bytes, 140)
      assert.strictEqual(store.resourceShare.workspace.availableBytes, 0)
      assert.strictEqual(demand().bytes, 0)
      renderer.plannedCameraVersion = 1
      assert.strictEqual(reserve({...quote, sequence: 1}), false, 'Old camera acquired demand credit')
      store.releaseDemand()
      // The old share's credit was transferred and then retired, not restored
      // as another grant when the camera stopped needing it.
      assert(store.resourceShare.grow(30))
      assert.strictEqual(demand(), null, 'Old-view targets authorized terrain refinement')
      renderer.plannedCameraVersion = 2; renderer.current.imageryPlan.quality.planningComplete = false
      assert.strictEqual(demand(), null, 'Incomplete target planning authorized terrain refinement')
      renderer.mode = 'terrain'
      assert.deepStrictEqual(demand(), {bytes: 0, keep: []})
      running.cancel()
      assert.strictEqual(store.resourceDemand().bytes, 210, 'Cancellation forgot still-desired output')
      store.failed.set('missing', {})
      assert.strictEqual(store.resourceDemand().bytes, 110, 'A parked image failure blocked independent terrain')
      store.failed.clear()
      assert.strictEqual(store.resourceDemand().bytes, 210, 'Retry did not restore future image demand')
    } finally {running.cancel(); store.destroy()}
    assert.strictEqual(ledger.bytes, 0)
  }
  // Ownership can change between UV pricing and destination admission. The
  // final group must report its remaining deficit without spending its offer.
  {
    const {MeshOutputPlan} = require('../../adapters/webgl/mesh_output_plan')
    const {ResourceWorkspace} = require('../../sdk/js/resources/resource_workspace')
    const ledger = new ResourceLedger(100), held = ledger.reserve('display', 90)
    const workspace = new ResourceWorkspace('mesh-preparation')
    workspace.accept(ledger.reserve('mesh-preparation', 10))
    const plan = Object.create(MeshOutputPlan.prototype)
    Object.assign(plan, {valid: () => true, attempt: {}, preparationWorkspace: workspace,
      requirements: () => ({missing: new Map(), reused: new Map(), bytes: 0}),
      renderer: {geometry: new ResourceCache({ledger}), textures: {}, partitionCapacityBytes: 100,
        indices: {quote: () => 0, fund: outputs => outputs},
        partitionBytes: 0, partitionReservedBytes: 0, partitionCpuBytes: 0, prunePartitions() {}}})
    assert.strictEqual(plan.fund({draws: []}, 20), null)
    assert.strictEqual(plan.capacityShortfallBytes, 10)
    assert.strictEqual(workspace.bytes, 10, 'Refused destination spent the pricing envelope')
    held.resize(80)
    const outputs = plan.fund({draws: []}, 20)
    assert(outputs && outputs.valid())
    assert.strictEqual(plan.capacityShortfallBytes, 0)
    assert.strictEqual(ledger.bytes, 100)
    // The fixture has no renderer lifecycle; release its actual owners.
    outputs.credit.release(); plan.pool.release(); workspace.retire(); held.release()
    assert.strictEqual(ledger.bytes, 0)
  }
  // Synchronous victims cannot be partially evicted to speculate on a remote
  // refund. Pressure alone owns no destination and grants no credit.
  const ledger=new ResourceLedger(100), replies=[], calls=[]
  let client, revision=1, nativeBytes=80, held=50
  const worker={terminate(){},postMessage(message){
    assert.strictEqual(message.type,'trim-native')
    calls.push(message)
    replies.push(()=>{
      const released=Math.min(message.needed,nativeBytes-held)
      nativeBytes-=released
      client.receive({id:message.id,value:released,nativeBytes,recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision:revision})
    })
  }}
  client=new TerrainWorkerClient(worker,{workerTimeoutMs:1000})
  client.nativeBytes=nativeBytes;client.nativeRevision=revision;client.setResourceLedger(ledger)
  let discarded=0
  const cache=new ResourceCache({ledger,maximumBytes:100,dispose(){++discarded}})
  cache.set('idle',{},10)
  const blocked=()=>cache.reserveBatch([['image-a',20],['image-b',20]],10,'image-and-UV')
  let images
  try {
    assert.strictEqual(cache.canReserveBatch([['image-a',20],['image-b',20]],10),false)
    assert.strictEqual(ledger.bytes,90,'A feasibility query credited an unacknowledged refund')
    assert.strictEqual(cache.reservations.size,0)
    assert.strictEqual(blocked(),null)
    assert.strictEqual(discarded,0,'Rejected group evicted only its synchronous victims')
    assert(ledger.reclamation.pending)
    // Only the 30-byte deficit after the planned idle victim needs trimming.
    for(let i=0;i<50;++i)assert.strictEqual(blocked(),null)
    await tick()
    assert.strictEqual(calls.length,1)
    assert.strictEqual(calls[0].needed,30)
    assert.strictEqual(ledger.bytes,90,'Unacknowledged reclaim funded another producer')
    const renderer={resourceLedger:ledger,canvas:{},options:{},requestResources(){}}
    const textures=new TextureStore(renderer,{urlForTile:()=>'',maximumBytes:100})
    textures.requestBlocked('waiting')
    assert(!textures.blockedByCapacity && !textures.admissionBlocked.size,
      'An unacknowledged reclaim coarsened the old display')
    for(let i=0;i<50;++i)assert.strictEqual(blocked(),null)
    const pending=ledger.reclamation.pending
    replies.shift()();await pending
    assert.strictEqual(calls.length,1,'Equivalent in-flight failures caused duplicate trims')
    assert.strictEqual(ledger.bytes,60)
    assert(cache.canReserveBatch([['image-a',20],['image-b',20]],10))
    assert.strictEqual(discarded,0,'Feasibility evicted its planned synchronous victim')
    assert.strictEqual(ledger.bytes,60)
    images=blocked();assert(images)
    assert.strictEqual(discarded,1)
    assert.strictEqual(ledger.bytes,100)
    assert.strictEqual(ledger.reserve('extra',1),null);await tick()
    assert.strictEqual(calls.length,2)
    replies.shift()();await ledger.reclamation.pending
    // The display holds all remaining native payload. Unrelated JS cache
    // churn must not scan the same native ownership state indefinitely.
    for(let i=0;i<50;++i){assert.strictEqual(ledger.reserve('extra',1),null);await tick()}
    assert.strictEqual(calls.length,2)
    textures.requestBlocked('exhausted')
    assert(textures.blockedByCapacity)
    assert.strictEqual(ledger.reclamation.stats().reclaimedBytes,30)
    // A real receipt can release native references without changing payload.
    ++revision;client.nativeRevision=revision;held=40
    assert.strictEqual(ledger.reserve('extra',1),null);await tick()
    assert.strictEqual(calls.length,3)
    replies.shift()();await ledger.reclamation.pending
    const extra=ledger.reserve('extra',1);assert(extra);extra.release()
    textures.destroy()
  } finally {
    if(images){images.release();images.credit.release()}
    cache.clear();client.destroy()
  }
  assert.strictEqual(ledger.bytes,0)
  assert.strictEqual(ledger.reclamation.stats().owners,0)

  // Independent asynchronous owners share one shortfall instead of each
  // flushing the entire deficit. Disposal cancels jobs not yet dispatched.
  const shared=new ResourceLedger(100), first=shared.reserve('first',50),second=shared.reserve('second',50)
  let one=0,two=0
  shared.reclamation.register({revision:()=>0,reclaim:async needed=>{
    ++one;const bytes=Math.min(10,needed);first.resize(first.bytes-bytes);return bytes
  }})
  const stop=shared.reclamation.register({revision:()=>0,reclaim:async needed=>{
    ++two;assert.strictEqual(needed,10);second.resize(second.bytes-needed);return needed
  }})
  assert.strictEqual(shared.reserve('images',20),null)
  await shared.reclamation.pending
  assert.strictEqual(one,1);assert.strictEqual(two,1);assert.strictEqual(shared.bytes,80)
  const claimant=shared.reserve('images',20);assert(claimant)
  assert.strictEqual(shared.reserve('cancelled',20),null);stop()
  await shared.reclamation.pending
  assert.strictEqual(two,1,'Disposed provider was invoked from a queued request')
  claimant.release();first.release();second.release()

  const failing=new ResourceLedger(10), faults=[]
  const owned=new NativeMeshBudget(failing,10,{revision:()=>0,trim:async()=>{throw Error('failed reclaim')},failed:error=>faults.push(error)})
  assert.strictEqual(failing.reserve('image',1),null)
  await failing.reclamation.pending
  assert.strictEqual(failing.bytes,10,'A failed reclaim refunded live ownership')
  assert.strictEqual(faults.length,1)
  assert.strictEqual(failing.reserve('image',1),null);await tick()
  assert.strictEqual(faults.length,1)
  owned.close()
  assert.strictEqual(failing.bytes,0)
  console.log('Shared asynchronous pressure, actual receipts, partial trimming, no-op epochs and cancellation passed')
}
const deadline=setTimeout(()=>{console.error('Resource pressure contract timed out');process.exit(1)},10000)
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>clearTimeout(deadline))
