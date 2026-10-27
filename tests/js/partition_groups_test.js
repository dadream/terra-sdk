const assert = require('assert')
const {PartitionGroups} = require('../../adapters/webgl/partition_groups')
const {PartitionPublication} = require('../../adapters/webgl/partition_publication')
const {ResourceCache} = require('../../sdk/js/resources/resource_cache')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {OutputTransaction} = require('../../sdk/js/resources/output_transaction')
const {MeshOutputPlan} = require('../../adapters/webgl/mesh_output_plan')
const {ImageryPresentation} = require('../../sdk/js/imagery/terra_imagery_presentation')
const {ImageryFootprintCache} = require('./reference/imagery_footprint_cache')
const {ImageryGroupAdmission} = require('../../sdk/js/imagery/imagery_group_admission')
const {imageryMembers} = require('../../adapters/webgl/imagery_candidate')
const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')
const {TerraWebGlRenderer} = require('../../adapters/webgl/terra_webgl_renderer')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const work = new Map()
const tick = async () => {
  const callbacks = Array.from(work.values()); work.clear()
  callbacks.forEach(callback=>callback())
  await new Promise(resolve=>setTimeout(resolve,0))
}

function fixture(limit) {
  const r = {resourceLedger: new ResourceLedger(limit), partitionQueue: [], partitionUploads: [], partitionGeneration: 1,
    geometryPinnedKeys: new Set(), partitionBytes: 0, partitionReservedBytes: 0, partitionCpuBytes: 0,
    partitionCapacityBytes: limit, options: {}, onDiagnostic(kind, value) { throw Error(kind + ': ' + value.message) },
    requestResources() {work.set(r,()=>groups.advanceSelection())}, pumpPartitionRequests() {}, prunePartitions() {},
    requestPartitionSet(geometry, cells) {
      const queued = this.partitionQueue.find(job => job.geometry === geometry)
      if (queued) cells.forEach(cell => { if (!queued.cells.some(c => c.key === cell.key)) queued.cells.push(cell) })
      else this.partitionQueue.push({geometry, cells, generation: this.partitionGeneration})
    },
    partitionCell(draw) { return {key: key(draw.texture)} },
    blockPartitionJob(row) { row.geometry.blocked = this.resourceLedger.availabilityRevision }
  }
  r.geometry = new ResourceCache({ledger: r.resourceLedger})
  r.textures = {cache: new ResourceCache({ledger: r.resourceLedger}), retainedTargets:new Map(),coverageKeys:new Set(),
    gpuReady(id) { return this.cache.has(id) }}
  r.partitionPublication = new PartitionPublication(id => r.geometry.get(id), id => r.textures.gpuReady(id), d => d.group)
  const groups = r.partitionGroups = new PartitionGroups(r), tasks = []
  r.options.createPartitionPlanTask = (id, cells) => {
    const task = {id, cells, cancelled: false, cancel() { this.cancelled = true }}
    task.promise = new Promise(resolve => { task.finish = () => resolve(cells.map(cell => ({key: cell.key, bytes: 12}))) })
    tasks.push(task); return task
  }
  const add = (id, group, count = 2) => {
    const geometry = {key: id, resourceId: id, partitions: new Map()}
    r.geometry.set(id, geometry, 0); r.geometryPinnedKeys.add(id)
    const draws = Array.from({length: count}, (_, column) => ({geometryKey: id, group,
      texture: {level: 1, matrix: 1, row: 0, column}, imageryClipCell: true,
      imageryTarget: {level: 0, matrix: 0, row: 0, column: 0}}))
    r.textures.cache.set(key(draws[0].imageryTarget), {}, 0)
    geometry.partitionPending = new Set(draws.map(draw => key(draw.texture)))
    r.partitionQueue.push({geometry, cells: draws.map(r.partitionCell), generation: r.partitionGeneration})
    return draws
  }
  const close = () => { groups.clear(); work.delete(r);if (r.imageryFootprints) r.imageryFootprints.clear(); r.geometry.clear(); r.textures.cache.clear(); assert.strictEqual(r.resourceLedger.bytes, 0) }
  return {r, groups, tasks, add, close}
}

async function main() {
  // A global display dependency can outlive many GPU receipts. Each queued
  // image group must wait without rescanning the same terrain on every wake.
  {
    const f=fixture(65536),r=f.r,draws=f.add(1,'waiting',1)
    const tile=draws[0].texture,children=new Map([[key(tile),tile]])
    let state='waiting',lookups=0,reservations=0
    r.mode='texture';r.current={};r.renderDraws=draws
    r.textures.desired=children;r.textures.failed=new Set()
    r.worldDisplay={targetState:()=>state}
    const has=r.geometry.entries.has.bind(r.geometry.entries)
    r.geometry.entries.has=id=>{++lookups;return has(id)}
    const reserve=()=>{++reservations;return false}
    try {
      for(let i=0;i<128;++i)
        assert.strictEqual(f.groups.prepareImagery(children,reserve),state)
      assert.strictEqual(lookups,0,'Unprepared world demand repeatedly scanned terrain inputs')
      assert.strictEqual(reservations,0,'Unprepared world demand started image admission')
      state='blocked'
      assert.strictEqual(f.groups.prepareImagery(children,reserve),'blocked')
      assert.strictEqual(lookups,1)
      r.geometry.delete(1)
      assert.strictEqual(f.groups.prepareImagery(children,reserve),'waiting',
        'World capacity pressure misclassified a missing geometry dependency')
      state='ready'
      assert.strictEqual(f.groups.prepareImagery(children,reserve),'waiting')
      assert.strictEqual(lookups,3,'World readiness bypassed the group geometry dependency')
      assert.strictEqual(f.groups.pricing.footprintSelections,0)
      assert.strictEqual(reservations,0)
    } finally {f.close()}
  }
  // Independent image groups share a mesh's atomic UV footprint. A missing
  // image must delay its own publication, not geometry production or a ready
  // neighbour. Keep the complete output reservation and cleanup contract.
  {
    const f=fixture(60),r=f.r,draws=f.add(1,'ready'),resident=[]
    const missing={level:2,matrix:2,row:0,column:0}
    draws[1].group='waiting';draws[1].imageryTarget=missing
    try {
      r.partitionPublication.prepare(draws)
      f.groups.prepare()
      assert.strictEqual(f.tasks.length,1,'A missing image blocked independent UV production')
      const readyImage=key(draws[0].imageryTarget)
      r.textures.cache.delete(readyImage)
      assert(f.groups.valid(f.groups.current),'Image eviction invalidated a geometry-only UV task')
      f.tasks[0].finish();await tick()
      assert(!r.partitionPublication.ready('ready')&&!r.partitionPublication.ready('waiting'))
      const geometry=r.geometry.get(1)
      for(const cell of f.tasks[0].cells) {
        const value=f.groups.take(1,[cell]);assert(value)
        const lease=value.output.takeOutput(12);lease.mark('resident');resident.push(lease)
        r.partitionReservedBytes-=12;r.partitionBytes+=12
        geometry.partitions.set(cell.key,{byteSize:12,allocation:lease})
        geometry.partitionPending.delete(cell.key);value.output.release()
      }
      f.groups.release()
      assert(!r.partitionPublication.advance(),'UV completion published evicted images')
      r.textures.cache.set(readyImage,{},0)
      assert(r.partitionPublication.advance())
      assert(r.partitionPublication.ready('ready'),'The ready world group waited for an unrelated image')
      assert(!r.partitionPublication.ready('waiting'),'UV completion published a missing image')
      r.textures.cache.set(key(missing),{},0)
      assert(r.partitionPublication.advance()&&r.partitionPublication.ready('waiting'))
    }finally{resident.forEach(lease=>lease.release());f.close()}
  }

  // A retained handoff cell can share a mesh with an unrelated current cut.
  // An unadvanced publication group with no missing UVs must not price an
  // empty group repeatedly while the queued handoff cell never gets produced.
  const handoffOnly = fixture(1000), ho = handoffOnly.r
  const old = handoffOnly.add(1, 'current', 1)
  const ready = ho.textures.gpuReady
  ho.textures.gpuReady = () => false
  ho.partitionPublication.prepare(old.map(draw => Object.assign({}, draw, {imageryClipCell: false})))
  ho.textures.gpuReady = ready
  ho.partitionPublication.setHandoff(old)
  let pumping = 0
  ho.pumpPartitionRequests = () => { if (++pumping < 8) handoffOnly.groups.prepare() }
  handoffOnly.groups.prepare()
  await tick()
  assert.strictEqual(handoffOnly.tasks.length, 1, 'A queued handoff was replaced by repeated empty publication pricing')
  assert.strictEqual(pumping, 0, 'Pricing completion recursively entered another planner microtask')
  handoffOnly.tasks[0].finish(); await tick()
  assert.strictEqual(pumping, 0)
  assert(handoffOnly.groups.current.pending.has('1:' + key(old[0].texture)))
  handoffOnly.close()

  const obsolete = fixture(1000), o = obsolete.r
  o.partitionPublication.prepare(obsolete.add(1, 'old'))
  o.geometryPinnedKeys.clear()
  const availability = o.resourceLedger.availabilityRevision
  let repeated = 0, wakes = 0
  o.requestResources = () => { ++wakes }
  o.pumpPartitionRequests = () => { if (++repeated < 8) obsolete.groups.prepare() }
  obsolete.groups.prepare(); await tick()
  assert.strictEqual(repeated, 0, 'An invalid group kept repricing without an external state change')
  assert.strictEqual(obsolete.groups.current, null)
  assert.strictEqual(o.geometry.entries.get(1).holds || 0, 0)
  assert.strictEqual(o.resourceLedger.availabilityRevision, availability, 'Invalid metadata changed resource availability')
  assert.strictEqual(wakes, 0, 'An invalid candidate woke its own retry')
  obsolete.close()

  // Drop stale/completed queue entries before group pricing, retaining the
  // pending flags of a still-current independent producer.
  const queued = fixture(1000), qv = queued.r
  const queuedDraws = [1,2,3,4,5,6].flatMap(id => queued.add(id, 'group-' + id, 1))
  qv.partitionPublication.prepare(queuedDraws.slice(0,5))
  const original = qv.partitionQueue.map(job => job.geometry)
  qv.geometryPinnedKeys.delete(1)
  qv.partitionQueue[1].generation = 0
  qv.geometry.set(3, {key:3, partitions:new Map()}, 0)
  original[3].partitions.set(key(queuedDraws[3].texture), {byteSize:0})
  qv.prunePartitionRequests = TerraWebGlRenderer.prototype.prunePartitionRequests
  TerraWebGlRenderer.prototype.pumpPartitionRequests.call(qv)
  assert.deepStrictEqual(qv.partitionQueue.map(job => job.geometry.key), [5])
  for (const id of [1,2,3,4,6]) assert.strictEqual(original[id-1].partitionPending.size, 0)
  assert.strictEqual(original[4].partitionPending.size, 1)
  assert.deepStrictEqual(queued.tasks.map(task => task.id), [5])
  queued.tasks[0].finish(); await tick(); queued.close()

  // A complete world group is priced in one batch, but still reserves no
  // output until every mesh cost has arrived and the entire footprint fits.
  for (const capacity of [59, 100]) {
    const batched = fixture(capacity), b = batched.r
    b.partitionPublication.prepare([...batched.add(1, 'batch'), ...batched.add(2, 'batch')])
    let finish, calls = 0
    b.options.createPartitionGroupPlanTask = rows => {
      ++calls
      assert.strictEqual(rows.length, 2)
      return {cancel() {}, promise: new Promise(resolve => { finish = () => resolve(new Map(rows.map(row =>
        [row.geometry.key, row.cells.map(cell => ({key:cell.key, bytes:12}))]))) })}
    }
    batched.groups.prepare()
    assert.strictEqual(calls, 1, 'The complete group was not submitted in one batch')
    assert.strictEqual(b.resourceLedger.bytes, 0)
    finish(); await tick()
    assert.strictEqual(calls, 1)
    assert.strictEqual(batched.tasks.length, 0, 'Batch returned to the host for each mesh')
    assert.strictEqual(b.partitionReservedBytes, capacity === 59 ? 0 : 48)
    batched.close()
  }
  // A+C share a world group. Neither its first mesh nor its first cell may
  // consume output bytes when the complete destination cannot fit.
  for (const shared of [false, true]) {
    const f = fixture(shared ? 59 : 1000), {r, groups, tasks} = f
    r.partitionCapacityBytes = shared ? 1000 : 59
    r.partitionPublication.prepare([...f.add(1, 'together'), ...f.add(2, 'independent', 1), ...f.add(3, 'together')])
    assert.strictEqual(groups.prepare(), false)
    tasks[0].finish(); await tick()
    assert.deepStrictEqual(tasks.map(t => t.id), [1, 3])
    assert.strictEqual(r.partitionCpuBytes + r.partitionReservedBytes, 0)
    tasks[1].finish(); await tick()
    assert.strictEqual(r.resourceLedger.bytes, 0)
    assert.strictEqual(r.geometry.get(1).blocked, r.resourceLedger.availabilityRevision,
      'The rejected group recorded availability before releasing its own holds')
    assert.deepStrictEqual(r.partitionQueue.map(job => job.geometry.key), [2])
    groups.prepare(); tasks[2].finish(); await tick()
    assert(groups.rank(2, tasks[2].cells[0].key), 'An unaffordable world group blocked an independent group')
    assert.strictEqual(r.partitionReservedBytes, 12)
    f.close()
  }

  // Exactly all GPU outputs plus one CPU cell fits. Reuse that workspace;
  // competitors cannot consume a later sibling's guaranteed destination.
  const f = fixture(60), {r, groups, tasks} = f
  r.partitionPublication.prepare([...f.add(1, 'together'), ...f.add(3, 'together')])
  groups.prepare(); tasks[0].finish(); await tick(); tasks[1].finish(); await tick()
  assert.strictEqual(r.partitionReservedBytes, 48)
  assert.strictEqual(r.partitionCpuBytes, 12)
  assert.strictEqual(r.resourceLedger.reserve('competitor', 1), null)
  const resident = []
  for (const task of tasks) for (const cell of task.cells) {
    const remaining = task.cells.filter(cell => groups.rank(task.id, cell.key))
    assert.strictEqual(groups.count(task.id, remaining, remaining.length), 1)
    const value = groups.take(task.id, [cell])
    assert(value && value.bytes === 12)
    assert.strictEqual(r.partitionCpuBytes, 12)
    const lease = value.output.takeOutput(12)
    lease.mark('resident'); resident.push(lease)
    r.partitionReservedBytes -= 12; r.partitionBytes += 12
    value.output.release()
    assert.strictEqual(r.resourceLedger.bytes, 60)
  }
  groups.release()
  assert.strictEqual(r.partitionCpuBytes, 0)
  resident.forEach(lease => lease.release()); f.close()

  // A terrain handoff can independently complete a destination and replace
  // its old demand queue. The admitted group must not strand its remaining
  // credits or block every unrelated queued group forever.
  const handoff = fixture(1000), h = handoff.r
  h.partitionPublication.prepare(handoff.add(1, 'same'))
  handoff.groups.prepare(); handoff.tasks[0].finish(); await tick()
  const cells = handoff.tasks[0].cells, geometry = h.geometry.get(1)
  geometry.partitions.set(cells[0].key, {byteSize: 12})
  h.partitionQueue = []
  handoff.groups.refresh()
  assert.strictEqual(h.partitionReservedBytes, 12, 'Completed immutable destination kept duplicate GPU credit')
  assert.deepStrictEqual(h.partitionQueue[0].cells, [cells[1]], 'Admitted missing destination lost its producer')
  assert.strictEqual(handoff.groups.current.pending.size, 1)
  handoff.close()

  // A queued image group may borrow future UV credit from a terrain forecast.
  // Retiring that forecast must invalidate the dependency and allow repricing.
  const forecast = fixture(1000), fv = forecast.r
  const futureDraws = forecast.add(1, 'future')
  fv.partitionPublication.prepare(futureDraws)
  const futureKey = key(futureDraws[0].texture)
  const provider = fv.forecastOutputPlan = {closed:false, has(id, cell) {
    return !this.closed && id === 1 && cell === futureKey
  }, price:()=>12}
  fv.partitionQueue[0].cells.shift()
  forecast.groups.prepare()
  assert.strictEqual(forecast.tasks[0].cells.length,1,'Borrowed UV credit was priced twice')
  forecast.tasks[0].finish();await tick()
  assert.strictEqual(forecast.groups.current.borrowedOutputs.size,1)
  provider.closed=true
  forecast.groups.refresh()
  assert.strictEqual(forecast.groups.current,null,'An image group waited on a retired forecast')
  forecast.groups.prepare()
  assert.strictEqual(forecast.tasks[1].cells.length,2,'Retired forecast did not return its dependency to admission')
  forecast.tasks[1].finish();await tick();forecast.close()

  // A new terrain receipt can replace the forecast without changing the mesh
  // or its UV destination. Keep admitted image work on the funded successor,
  // including the interval after its producer has claimed the destination.
  const transfer = fixture(1000), tr = transfer.r
  const transferDraws = transfer.add(1, 'transfer'), cell = key(transferDraws[0].texture)
  tr.partitionPublication.prepare(transferDraws)
  const destination = () => ({closed:false, claimed:false,
    credit:tr.resourceLedger.reserve('forecast-test',24),
    has(id, requested) { return !this.closed && !this.claimed && id === 1 && requested === cell },
    price:()=>12,
    release() { this.closed = true; this.credit.release() }})
  const before = tr.forecastOutputPlan = destination()
  tr.partitionQueue[0].cells.shift()
  transfer.groups.prepare(); transfer.tasks[0].finish(); await tick()
  const admitted = transfer.groups.current, pool = admitted.pool
  const successor = tr.meshOutputPlan = destination()
  before.release(); tr.forecastOutputPlan = null
  const occupied = tr.resourceLedger.bytes
  transfer.groups.refresh()
  assert.strictEqual(transfer.groups.current, admitted,
    'An unchanged funded UV destination cancelled the admitted image group')
  assert.strictEqual(admitted.pool, pool, 'Ownership transfer repriced or replaced image credit')
  assert.strictEqual(tr.resourceLedger.bytes, occupied)
  assert.strictEqual(transfer.tasks.length, 1, 'Ownership transfer repeated UV pricing')
  successor.claimed = true
  transfer.groups.refresh()
  assert.strictEqual(transfer.groups.current, admitted,
    'Claiming successor output invalidated its image borrower before production')
  // Without either a live producer or a resident result, retry is necessary.
  successor.release(); tr.meshOutputPlan = null
  transfer.groups.refresh()
  assert.strictEqual(transfer.groups.current, null,
    'Unfunded output was accepted merely because its predecessor had the same cell')
  transfer.close()

  // A borrowed terrain destination can enter production while another cell's
  // asynchronous price is pending. take() removes it from pending, but its
  // real input/output leases still fund the same immutable destination.
  for (const replacement of [false, true]) {
    const f = fixture(60), r = f.r, draws = f.add(1, 'in-flight')
    const borrowedKey = key(draws[0].texture), ownKey = key(draws[1].texture)
    const diagnostics = [], producers = [], claims = []
    r.onDiagnostic = (kind, value) => diagnostics.push({kind, value})
    const producer = () => {
      const plan = Object.create(MeshOutputPlan.prototype)
      Object.assign(plan, {closed:false, pending:new Map([['1:' + borrowedKey,12]]),
        rows:new Map([[1,{prices:new Map([[borrowedKey,12]])}]]),
        pool:OutputTransaction.reserve(r.resourceLedger,12,12,'terrain-input','terrain-output')})
      assert(plan.pool); producers.push(plan); return plan
    }
    const initial = r.forecastOutputPlan = producer()
    r.partitionPublication.prepare(draws); r.partitionQueue[0].cells.shift()
    try {
      f.groups.prepare()
      assert.deepStrictEqual(f.tasks[0].cells.map(c => c.key), [ownKey])
      const group = f.groups.current
      let active = initial
      if (replacement) {
        active = r.meshOutputPlan = producer()
        initial.closed = true; initial.pool.release(); r.forecastOutputPlan = null
        assert(f.groups.valid(group), 'Funded successor did not inherit the borrowed destination')
      }
      const claimed = active.take(1,[{key:borrowedKey}]); claims.push(claimed.output)
      assert(!active.has(1,borrowedKey))
      assert.strictEqual(r.resourceLedger.bytes,24,'Taking output refunded its live producer')
      f.tasks[0].finish(); await tick()
      assert.deepStrictEqual(diagnostics,[], 'Claimed borrowed output lost its price during admission')
      assert.strictEqual(f.groups.current,group)
      assert(group.pool,'Independent UV output did not obtain its destination')
      assert.deepStrictEqual(Array.from(group.pending),[['1:' + ownKey,12]])
      assert.strictEqual(group.borrowedOutputs.get('1:' + borrowedKey).plan,active)
      assert.strictEqual(r.resourceLedger.bytes,48,'In-flight output was charged twice')
      // Retirement without a resident result invalidates the dependency, but
      // must not release the producer's separately claimed output early.
      active.closed = true; active.pool.release(); f.groups.refresh()
      assert.strictEqual(f.groups.current,null)
      assert.strictEqual(r.resourceLedger.bytes,24)
    } finally {
      producers.forEach(p => {p.closed=true;p.pool.release()})
      claims.forEach(output => output.release()); f.close()
    }
  }

  // Pricing uses borrowed native/host geometry. Cancellation and cache
  // deletion cannot release that memory before the actual task receipt.
  const late = fixture(1000), l = late.r
  l.partitionPublication.prepare(late.add(1, 'old'))
  const mesh = {positions: new Float32Array(3), textureUv: new Float32Array(2)}
  ownPayload(mesh, l.resourceLedger.reserve('mesh', 20), 20)
  l.geometry.get(1).resource = mesh
  late.groups.prepare()
  mesh.ownership.retire()
  l.geometry.clear(); l.textures.cache.clear()
  late.groups.refresh()
  assert(late.tasks[0].cancelled)
  assert.strictEqual(l.resourceLedger.bytes, 20)
  assert.strictEqual(late.groups.prepare(), false)
  assert.strictEqual(late.tasks.length, 1, 'Cancellation started a second planner before the first receipt')
  late.tasks[0].finish(); await tick()
  assert.strictEqual(late.groups.current, null)
  late.close()
  // Terrain anchored directly at a demanded image needs no new UV output.
  // Its admitted image destinations may overlap the next group's production;
  // a metadata-only UV lane must not serialize unrelated network/GPU receipts.
  const direct = fixture(1000), d = direct.r, store = d.textures
  Object.assign(d, {current: {draws: []}, displaySurface: {current: {draws: []}},
    renderDraws: [], partitionUploads: [], presentation: new ImageryPresentation(),
    presentedTextures: new Map(), presentationBridges: []})
  Object.assign(store, {desired: new Map(), targetDesired: new Map(), currentRoots: new Map(),
    availableKeys: new Set(), failed: new Set(), resourceGroups: () => [], requiresResident: () => true,
    directTargets: true, generation: 1, admissionBlocked: new Set()})
  const admission = new ImageryGroupAdmission(store.cache)
  store.releasePreparedGroup = children => children.forEach((_, id) => {
    const pending = admission.take(id); if (pending) pending.cancel()
  })
  for (let column = 0; column < 2; ++column) {
    const tile = {level: 1, matrix: 1, row: 0, column}, children = new Map([[key(tile), tile]])
    store.desired.set(key(tile), tile)
    assert.strictEqual(direct.groups.prepareImagery(children,
      outputs => admission.admit(children, 20, store.failed, null, 0, outputs)), 'waiting')
    await tick()
    assert(!direct.groups.current || direct.groups.complete(), 'A group without new UV output waited for image upload')
    assert.strictEqual(store.cache.reservedBytes, 20 * (column + 1),
      'An older displayed terrain blocked independent image destinations')
  }
  const region = new Map([['1/1/0/0', {level: 1, matrix: 1, row: 0, column: 0}]])
  const sources = [0,1].map(column => ({geometryKey: column, texture: {level: 0, matrix: 0, row: 0, column}}))
  const footprint = {future: region, sources: direct.groups.sources(sources, region), draws: sources}
  d.renderDraws = [sources[0], {...sources[1], geometryKey: 'unrelated-successor'}]
  assert(direct.groups.sameFootprint(footprint), 'An unrelated mesh replacement cancelled local UV preparation')
  d.renderDraws = [{...sources[0], geometryKey: 'participating-successor'}, sources[1]]
  assert(!direct.groups.sameFootprint(footprint), 'A new participating mesh reused another footprint cost')
  direct.groups.release()
  assert.strictEqual(store.cache.reservedBytes, 40)
  admission.retain(new Set(), new Map()); direct.close()
  // Two rejected probes may borrow and release geometry without creating any
  // capacity. They must not invalidate each other's refusal and spin forever.
  // The output callback deliberately refuses; leave real credit for the new
  // selector's numerical workspace so this tests rejection epochs, not OOM.
  const refused = fixture(65536), q = refused.r, images = q.textures
  q.geometry.canEvict = id => !q.geometryPinnedKeys.has(id)
  q.imageryFootprints = new ImageryFootprintCache(q.resourceLedger)
  Object.assign(q, {current: {draws: []}, renderDraws: [], partitionUploads: [],
    presentation: new ImageryPresentation(), presentedTextures: new Map(), presentationBridges: [],
    measureDraw: () => ({visible: true}), measureTextureDraw: () => 2,
    presentationGoal: draw => draw.texture})
  Object.assign(images, {desired: new Map(), targetDesired: new Map(), currentRoots: new Map(),
    availableKeys: new Set(), failed: new Set(), requiresResident: () => true,
    directTargets: true, generation: 1, admissionBlocked: new Set()})
  const children = [0, 1].map(column => {
    const tile = {level: 1, matrix: 1, row: 0, column}
    const group = new Map([[key(tile), tile]])
    images.desired.set(key(tile), tile); images.targetDesired.set(key(tile), tile)
    q.renderDraws.push({geometryKey: column, texture: tile})
    q.geometry.set(column, {key: column, partitions: new Map(), model: {hull: [[0,0],[1,0],[1,1],[0,1]]}}, 10)
    q.geometryPinnedKeys.add(column)
    return group
  })
  let attempts = 0
  const reject = () => {++attempts;return false}
  images.resourceGroups = () => children.map(group => ['root', group])
  for (const group of children) {
    assert.strictEqual(refused.groups.prepareImagery(group, reject), 'waiting')
    for(let turns=0;turns<200&&refused.groups.current;++turns)await tick()
    assert(!refused.groups.current,'A bounded quote did not finish its background turns')
  }
  for (const group of children) assert.strictEqual(refused.groups.prepareImagery(group,reject),'blocked')
  const settledAttempts=attempts
  for (let i = 0; i < 8; ++i) for (const group of children) {
    assert.strictEqual(refused.groups.prepareImagery(group, reject), 'blocked',
      'A failed borrowed-only probe restarted another rejected group')
  }
  assert.strictEqual(attempts,settledAttempts,'Rejected cached quotes woke each other without a capacity change')
  assert.strictEqual(refused.groups.pricing.groups, 2)
  // An unrelated reader can finish while a rejected candidate is parked. A
  // mesh still pinned by the display has gained no eviction eligibility; that
  // release must not reopen all rejected image groups.
  q.geometry.canEvict = id => !q.geometryPinnedKeys.has(id)
  const stillDisplayed = q.geometry.retain(0)
  stillDisplayed()
  for (const group of children) assert.strictEqual(
    refused.groups.prepareImagery(group, () => false), 'blocked',
    'Releasing a reader of a still-displayed mesh restarted refused image work')
  // A real limit/eligibility change must still allow a fresh attempt.
  q.resourceLedger.setLimit(131072)
  assert.strictEqual(refused.groups.prepareImagery(children[0], reject), 'blocked')
  assert.strictEqual(attempts,settledAttempts+1,'A real policy change did not retry destination admission')
  await tick()
  assert.strictEqual(refused.groups.pricing.groups, 2,'Capacity recovery repeated the immutable UV price')
  assert.strictEqual(refused.groups.prepareImagery(children[1], () => false), 'blocked')
  q.resourceLedger.setLimit(196608)
  await tick()
  assert.strictEqual(refused.groups.prepareImagery(children[0], () => false), 'blocked',
    'A concurrent external refund was hidden by the probe release')
  await tick()
  // Pressure recovery reprices a successor surface without necessarily
  // refunding GPU/native bytes (the meshes may be shared). A refusal from the
  // predecessor must not intercept that retry and leave all producers idle.
  q.current.frame = {sequence: 1}
  assert.strictEqual(refused.groups.prepareImagery(children[0], () => false), 'blocked',
    'A successor surface inherited an obsolete complete-group refusal')
  await tick()
  assert.strictEqual(refused.groups.prepareImagery(children[0], () => false), 'blocked')
  q.current.frame.sequence = 2
  assert.strictEqual(refused.groups.prepareImagery(children[0], () => false), 'blocked',
    'An unchanged ledger hid a changed surface from image admission')
  await tick()
  images.requestedMaximumBytes = 500
  assert.strictEqual(refused.groups.prepareImagery(children[0], () => false), 'blocked',
    'An imagery share change inherited its previous local-capacity refusal')
  await tick()
  assert.strictEqual(refused.groups.prepareImagery(children[0], () => false), 'blocked')
  images.protectionRevision = 1
  assert.strictEqual(refused.groups.prepareImagery(children[0], () => false), 'blocked',
    'Changed cache victim eligibility inherited an obsolete refusal')
  await tick()
  assert.strictEqual(refused.groups.prepareImagery(children[0], () => false), 'blocked')
  refused.close()
  console.log('Complete UV groups, shared workspace, independent admission and late cancellation passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
