const assert = require('assert')
const { EncodedTextureStore } = require('../../adapters/browser/encoded_texture_store')
const { ResourceLedger } = require('../../sdk/js/resources/resource_ledger')
const { textureByteSize } = require('../../adapters/webgl/texture_store')
const {globalCoverageTextureTiles} = require('../../sdk/js/imagery/terra_texture_tiles')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function main() {
  const saved = {Blob: global.Blob, AbortController: global.AbortController, createImageBitmap: global.createImageBitmap}
  if (!global.Blob) global.Blob = class { constructor(chunks) { this.size = chunks.reduce((n,c) => n+c.byteLength,0) } }
  if (!global.AbortController) global.AbortController = class {
    constructor() {
      this.listeners = new Set()
      this.signal = {aborted: false,
        addEventListener: (type, listener) => { if (type === 'abort') this.listeners.add(listener) },
        removeEventListener: (type, listener) => { if (type === 'abort') this.listeners.delete(listener) }}
    }
    abort() {
      if (this.signal.aborted) return
      this.signal.aborted = true
      for (const listener of this.listeners) listener()
      this.listeners.clear()
    }
  }
  const decodes = [], images = [], stores = [], uploads = []
  let requests = 0, cancelledBodies = 0, oversized = false, wakeups = 0, bodyBytes = 100
  global.createImageBitmap = blob => new Promise((resolve, reject) => {
    assert(blob && blob.size > 0)
    decodes.push({resolve: (size = 16) => {
      const image = {width: size, height: size, closed: 0, close() { assert.strictEqual(this.closed++, 0, 'Bitmap closed twice') }}
      images.push(image); resolve(image)
    }, reject})
  })
  const completeDecode = async (fail, size) => {
    const pending = decodes.shift(); assert(pending, 'Decoder did not start')
    if (fail) pending.reject(new Error('Decoder rejected the retained source'))
    else pending.resolve(size)
    await tick(); await tick()
  }
  const response = () => {
    let read = false
    return {ok: true, headers: {get: () => 'image/png'}, body: {cancel: async () => { ++cancelledBodies }, getReader: () => ({
      read: async () => read ? {done: true} : (read = true, {done: false, value: new Uint8Array(oversized ? 65537 : bodyBytes)}),
      cancel: async () => { ++cancelledBodies }, releaseLock() {}
    })}}
  }
  const makeStore = (options = {}) => {
    let busy = false
    const renderer = {canvas: {ownerDocument: {}}, gl: {deleteTexture() {}}, presentedTextures: new Map(),
      resourceLedger: new ResourceLedger(options.sharedMaximumBytes || options.maximumBytes || 400000),
      options: {managedResources: true, textureDescriptor: {tile_size: options.tileSize || 16},
        fetchTextures: async () => {
          assert(store.cache.reservedBytes >= store.requestBytes(), 'I/O began without encoded/GPU staging credit')
          assert(store.pipelineBytes() >= store.inputBytes && store.inputJobs > 0,
            'I/O began without owned shared production space')
          ++requests; return response()
        }},
      requestResources() { ++wakeups }, requestRender() {},
      uploadTexture(image, width, height, commit, cancel) {
        assert(image && !image.closed)
        assert(!uploads.some(upload => upload.image === image), 'Image staged again before its upload receipt')
        if (busy) { cancel(); return false }
        busy = true
        uploads.push({image, commit: texture => {busy=false; return commit(texture)}, cancel: () => {busy=false; cancel()}})
        return true
      }}
    const store = new EncodedTextureStore(renderer, Object.assign({urlForTile: tile => 'https://imagery.invalid/' + tile.column,
      maximumEntries: 16, maximumBytes: 400000, maximumConcurrent: 1, maximumRetries: 0,
      prefetchAncestors: false, directTargets: true}, options))
    stores.push(store)
    return store
  }
  const tile = {level: 0, matrix: 0, row: 0, column: 0}, key = '0/0/0/0'
  const gpu = textureByteSize(16,16)
  try {
    require('./imagery_request_selection_contract')(makeStore)
    await require('./imagery_admission_wait_contract')(makeStore,tick)
    await require('./encoded_source_overlap_contract')(makeStore,tick)
    await require('./sparse_coverage_ladder_contract')(makeStore,tick)
    await require('./resource_wait_queue_test')()
    await require('./encoded_input_stages_test')()
    await require('./imagery_share_progress_contract')(makeStore, tile, gpu, tick)
    require('./imagery_share_pressure_contract')(makeStore)
    require('./imagery_demand_reservation_contract')(makeStore)
    require('./imagery_capacity_before_mapping_contract')(makeStore, gpu)
    // A larger SDK preference does not allocate that pool or override an
    // application's smaller imagery ceiling, even with ample shared credit.
    const explicitLimit = 2 * 65536 + 8 * gpu
    const explicitCeiling = makeStore({maximumBytes: 96 * 1024 * 1024,
      maximumShareBytes: explicitLimit, sharedMaximumBytes: 512 * 1024 * 1024,
      maximumEntries: 100})
    assert.strictEqual(explicitCeiling.resourceShare.bytes, explicitLimit)
    assert.strictEqual(explicitCeiling.cache.maximumBytes, explicitLimit)
    assert.strictEqual(explicitCeiling.renderer.resourceLedger.bytes, 0,
      'A preferred imagery quota eagerly allocated resident images')
    assert.strictEqual(explicitCeiling.resourceShare.grow(gpu), false,
      'The larger shared envelope bypassed the explicit imagery ceiling')
    explicitCeiling.destroy()

    // Growth is a funded response to a complete, capacity-limited plan. It
    // must not repeatedly grow from a stale plan or while a terrain group owns
    // preparation, and a smaller application ceiling still wins.
    const preferred = 2 * 65536 + 8 * gpu
    const adaptive = makeStore({maximumBytes: preferred, maximumShareBytes: preferred + 4 * gpu,
      sharedMaximumBytes: preferred + 10 * gpu, maximumEntries: 100})
    const ar = adaptive.renderer
    let replans = 0
    ar.options.onImageryPlanningChange = () => ++replans
    ar.cameraVersion = ar.plannedCameraVersion = 1
    ar.current = {imageryPlan: {quality: {planningComplete: true, cameraCurrent: true,
      limitedByTextureBudget: true, maximumTextureCount: adaptive.targetCapacity()}}}
    ar.meshOutputPlan = {}
    assert.strictEqual(adaptive.growShare(), false)
    ar.meshOutputPlan = null
    assert(adaptive.growShare())
    assert.strictEqual(replans, 1)
    assert.strictEqual(adaptive.resourceShare.stats().unusedBytes, gpu)
    assert.strictEqual(adaptive.growShare(), false, 'The unchanged plan grew another grant')
    assert.strictEqual(ar.resourceLedger.maximumBytes, preferred + 10 * gpu)
    adaptive.setPaused(true)
    assert.strictEqual(ar.resourceLedger.bytes, 0, 'Pause kept unused expansion credit')
    adaptive.destroy()

    const entryBound = makeStore({maximumBytes: preferred, maximumShareBytes: preferred + 4 * gpu,
      sharedMaximumBytes: preferred + 10 * gpu, maximumEntries: 2})
    const er = entryBound.renderer
    er.options.onImageryPlanningChange = () => assert.fail('Entry-limited share requested replanning')
    er.current = {imageryPlan: {quality: {planningComplete: true, cameraCurrent: true,
      limitedByTextureBudget: true, maximumTextureCount: entryBound.targetCapacity()}}}
    assert.strictEqual(entryBound.growShare(), false,
      'An entry ceiling consumed global credit without increasing target capacity')
    assert.strictEqual(er.resourceLedger.bytes, 0)
    assert.strictEqual(entryBound.resourceShare.stats().attempts, 0)
    entryBound.destroy()

    // Source cancellation after two different funding pools have contributed
    // must keep accepted GPU/UV ownership until its own completion receipt.
    const shared = makeStore({maximumBytes: preferred, maximumShareBytes: preferred + 4 * gpu,
      sharedMaximumBytes: preferred + 4 * gpu})
    assert(shared.resourceShare.grow(4 * gpu))
    const sharedTargets = new Map([[key, tile]])
    let sharedOutput
    assert(shared.admitGroup(sharedTargets, shared.minimumWorkspaceBytes(),
      {bytes: gpu, keep: [], accept: credit => { sharedOutput = credit }}))
    assert.strictEqual(shared.resourceShare.stats().unusedBytes, 0)
    const sharedInput = shared.reserveRequest(key)
    assert(sharedInput)
    assert(shared.startInput(sharedInput.input))
    shared.setSource(() => 'https://replacement.invalid', [])
    assert.strictEqual(shared.resourceShare.bytes, preferred)
    assert.strictEqual(shared.renderer.resourceLedger.bytes, 2 * gpu + shared.inputEnvelopeBytes)
    sharedInput.cancel(); sharedOutput.release(); shared.destroy()
    assert.strictEqual(shared.renderer.resourceLedger.bytes, 0)

    const extending = makeStore(), sibling = {level: 0, matrix: 0, row: 0, column: 1}
    assert(extending.admitGroup(new Map([[key, tile]])))
    extending.requestGroups.set(key, new Map([[key, tile], ['0/0/0/1', sibling]]))
    const ownedInput = extending.reserveRequest(key)
    assert(ownedInput)
    assert(!extending.cache.reservations.has('0/0/0/1'),
      'An already admitted input funded a new sibling without preparing its display footprint')
    ownedInput.cancel(); extending.destroy()
    assert.strictEqual(extending.renderer.resourceLedger.bytes, 0)

    // Reuse a previous parallel envelope for a complete successor group. The
    // active input still needs its bitmap, so its decoder lane is not surplus.
    const transferSerial = 2 * 65536, transferDecode = 16 * 16 * 4
    const transferLimit = gpu + 2 * transferSerial + transferDecode
    const transferring = makeStore({maximumBytes: transferLimit})
    const transferLedger = transferring.renderer.resourceLedger
    assert(transferring.admitGroup(new Map([[key, tile]]), 2 * transferSerial + transferDecode))
    const transferInput = transferring.reserveRequest(key)
    assert(transferInput)
    assert(transferring.startInput(transferInput.input))
    const transferChildren = new Map(Array.from({length: 4}, (_, i) => ['next-' + i, sibling]))
    let transferOutput
    const transferOutputs = {bytes: transferSerial - 4 * gpu + 1, keep: [],
      accept: credit => { transferOutput = credit }}
    assert.strictEqual(transferring.admitGroup(transferChildren, transferSerial, transferOutputs), false,
      'A transfer funded new detail by stealing the active decoder lane')
    assert.strictEqual(transferring.workspace.bytes, 2 * transferSerial + transferDecode)
    assert.strictEqual(transferring.cache.reservations.size, 1)
    assert.strictEqual(transferOutput, undefined)
    --transferOutputs.bytes
    const transferRevision = transferLedger.availabilityRevision
    assert(transferring.admitGroup(transferChildren, transferSerial, transferOutputs),
      'Idle pipeline credit was unavailable to the complete GPU/UV group')
    assert.strictEqual(transferLedger.bytes, transferLimit)
    assert.strictEqual(transferLedger.maximumBytes, transferLimit)
    assert.strictEqual(transferLedger.availabilityRevision, transferRevision)
    assert.strictEqual(transferring.workspace.bytes, transferSerial + transferDecode)
    assert.strictEqual(transferring.workspace.availableBytes, transferDecode)
    const transferBitmap = transferring.workspace.take(transferDecode)
    assert(transferBitmap, 'The already admitted input could not decode after transfer')
    transferring.setSource(() => 'https://replacement.invalid', [])
    assert.strictEqual(transferLedger.bytes, gpu + transferSerial + transferDecode + transferOutputs.bytes,
      'Source replacement refunded active input, decoder or accepted output ownership')
    transferInput.cancel(); transferBitmap.release(); transferOutput.release(); transferring.destroy()
    assert.strictEqual(transferLedger.bytes, 0)
    assert.strictEqual(transferLedger.leases.size, 0)

    const coverage = globalCoverageTextureTiles({kind:'global-geodetic', maximum_level:17,
      matrix_level_offset:0, level_zero_columns:2, level_zero_rows:1})
    const keyOf = tile => `${tile.level}/${tile.matrix}/${tile.row}/${tile.column}`
    // Optional coarse history may yield under pressure, but actual display
    // references survive until the replacement submission is acknowledged.
    const history = makeStore({tileSize:256, prefetchAncestors:true, coverageTiles:coverage,
      maximumBytes:8*textureByteSize(256,256)})
    const displayed = {level:1,matrix:1,row:0,column:0}
    const unused = {level:1,matrix:1,row:1,column:3}
    const next = {level:2,matrix:2,row:0,column:4}
    for (const tile of coverage.concat(unused, displayed, next)) {
      assert(history.cache.set(keyOf(tile), {texture:{},width:256,height:256}, history.requestBytes()))
      history.availableKeys.add(keyOf(tile))
    }
    history.renderer.presentedTextures.set(keyOf(displayed), displayed)
    history.buildRequirementTree([{texture:next}], [])
    history.recomputeAvailability(); history.refreshProtection()
    assert(history.coarseCoverageReady())
    assert(!history.desired.has(keyOf(unused)), 'Idle level-one prefetch became mandatory demand')
    assert(history.protectedKeys.has(keyOf(displayed)))
    const pressure = () => history.renderer.resourceLedger.reserve('competing-owner',
      history.renderer.resourceLedger.maximumBytes - history.renderer.resourceLedger.bytes + history.requestBytes())
    let credit = pressure()
    assert(credit)
    assert(!history.cache.has(keyOf(unused)), 'Unused coarse history could not yield its bytes')
    assert(history.cache.has(keyOf(displayed)), 'Pressure discarded the unacknowledged old display')
    assert(coverage.every(tile => history.gpuReady(keyOf(tile))), 'Pressure discarded global root fallback')
    credit.release()
    history.renderer.presentedTextures.clear()
    history.renderer.presentedTextures.set(keyOf(next), next)
    history.refreshProtection()
    credit = pressure()
    assert(credit)
    assert(!history.cache.has(keyOf(displayed)), 'Acknowledged coarse history remained permanently pinned')
    assert(history.gpuReady(keyOf(next)) && history.coarseCoverageReady())
    credit.release(); history.destroy()
    assert.strictEqual(history.renderer.resourceLedger.bytes,0)

    const imageBytes = textureByteSize(256,256), uvBytes = 65536
    const steadyBytes = 96*1024*1024, sharedBytes = steadyBytes + 4*imageBytes + uvBytes
    const capacityStore = makeStore({maximumEntries:0, maximumBytes:steadyBytes,
      sharedMaximumBytes:sharedBytes, tileSize:256, prefetchAncestors:true, coverageTiles:coverage})
    assert.strictEqual(capacityStore.targetCapacity(), 283, 'A count/fraction cap discarded byte-admissible physical images')
    const plan = capacityStore.capacityPlan()
    assert.strictEqual(plan.replacement, 4)
    assert(plan.completeGroupFits)
    assert.strictEqual(plan.replacementHeadroomBytes, 4*imageBytes)
    assert((plan.targets+coverage.length)*imageBytes+plan.workspaceBytes <= steadyBytes,
      'Steady targets consumed replacement credit or lost their serial workspace')
    const resident = coverage.concat(Array.from({length:plan.targets}, (_,column) =>
      ({level:8,matrix:8,row:0,column})))
    resident.forEach(tile => {
      const key = keyOf(tile)
      assert(capacityStore.cache.set(key, {texture:{},width:256,height:256}, imageBytes))
      capacityStore.protectedKeys.add(key)
    })
    const group = new Map(Array.from({length:4}, (_,i) => {
      const tile = {level:9,matrix:9,row:i>>1,column:i%2}
      return [keyOf(tile),tile]
    }))
    let uvCredit = null
    const outputs = {bytes:uvBytes, keep:[], accept(credit) { assert(!uvCredit); uvCredit=credit }}
    const extra = capacityStore.renderer.resourceLedger.reserve('competing-owner',
      sharedBytes - (resident.length+4)*imageBytes - plan.workspaceBytes - uvBytes + 1)
    assert(extra)
    assert.strictEqual(capacityStore.admitGroup(group, plan.workspaceBytes, outputs), false,
      'A competing owner was ignored when admitting the complete replacement')
    assert.strictEqual(capacityStore.cache.reservations.size,0)
    assert.strictEqual(capacityStore.pipelineBytes(),0)
    assert.strictEqual(uvCredit, null, 'Rejected group funded a partial UV output')
    extra.release()
    assert(capacityStore.admitGroup(group, plan.workspaceBytes, outputs), 'Advertised headroom could not prepare a full sibling group')
    assert.strictEqual(capacityStore.cache.reservations.size,4)
    assert.strictEqual(capacityStore.pipelineBytes(),plan.workspaceBytes)
    assert.strictEqual(capacityStore.cache.entries.size,resident.length, 'Admission evicted displayed images')
    assert(capacityStore.renderer.resourceLedger.bytes <= sharedBytes)
    assert.strictEqual(capacityStore.renderer.resourceLedger.maximumBytes, sharedBytes,
      'Imagery borrowing enlarged the shared envelope')
    assert.strictEqual(uvCredit.bytes, uvBytes)
    assert(capacityStore.stats().replacementBorrowedBytes > 0)
    // Extra groups cannot multiply the local peak even if the ledger has room.
    capacityStore.renderer.resourceLedger.setLimit(sharedBytes + 8*imageBytes)
    assert.strictEqual(capacityStore.admitGroup(new Map([['extra',tile]])), false)
    assert.strictEqual(capacityStore.cache.reservations.size, 4)
    capacityStore.renderer.resourceLedger.setLimit(sharedBytes)
    assert.strictEqual(requests,0, 'Capacity planning started network production')
    resident.forEach(tile => capacityStore.renderer.presentedTextures.set(keyOf(tile),tile))
    bodyBytes = capacityStore.encodedLimit
    capacityStore.sync(Array.from(group.values(),texture => ({texture})), [])
    for (let i=0; i<40 && !Array.from(group.keys()).every(key => capacityStore.gpuReady(key)); ++i) {
      capacityStore.processUploads(Infinity)
      await tick()
      if (decodes.length) await completeDecode(false,256)
      capacityStore.processUploads(Infinity)
      while (uploads.length) uploads.shift().commit({id:'admitted-sibling'})
      await tick()
      assert(capacityStore.renderer.resourceLedger.bytes <= sharedBytes)
    }
    assert(Array.from(group.keys()).every(key => capacityStore.gpuReady(key)),
      'The admitted serial path stalled behind its own destination/workspace holds')
    assert(resident.every(tile => capacityStore.cache.has(keyOf(tile))),
      'Production discarded old display before a replacement receipt')
    assert.strictEqual(capacityStore.inputBytes,0)
    assert.strictEqual(capacityStore.cache.reservations.size,0)
    assert.strictEqual(uvCredit.bytes, uvBytes, 'Image completion refunded consumer-owned UV credit')
    uvCredit.release()
    // A replacement receipt releases the old display. Idle peak residency
    // yields back to the steady limit rather than permanently growing cache.
    capacityStore.renderer.presentedTextures.clear()
    group.forEach((tile,key)=>capacityStore.renderer.presentedTextures.set(key,tile))
    capacityStore.refreshProtection()
    assert.strictEqual(capacityStore.stats().replacementBorrowedBytes, 0)
    assert(capacityStore.cache.bytes <= steadyBytes)
    assert(Array.from(group.keys()).every(key=>capacityStore.gpuReady(key)))
    bodyBytes = 100
    capacityStore.renderer.options.textureDescriptor.tile_size = 512
    capacityStore.setSource(() => 'https://replacement.invalid',coverage)
    assert.strictEqual(capacityStore.targetCapacity(),67,
      'Source replacement retained the previous image/workspace byte cost')
    capacityStore.requestedMaximumEntries = 20
    assert.strictEqual(capacityStore.targetCapacity(),14, 'An explicit resource count limit was ignored')
    capacityStore.destroy()
    assert.strictEqual(capacityStore.renderer.resourceLedger.bytes,0)

    const store = makeStore()
    store.sync([{texture: tile}], [])
    await tick()
    assert.strictEqual(decodes.length, 0, 'Network completion decoded without an upload consumer')
    const entry = store.cache.entries.get(key)
    assert(entry && entry.value.blob)
    assert.strictEqual(entry.byteSize, gpu, 'GPU residency double-counted the shared production space')
    assert.strictEqual(store.pipelineBytes(), store.encodedLimit * 2)
    assert(store.workspace.availableBytes >= 1024, 'Fetch completion lost the next decoder destination')
    const competitor = store.renderer.resourceLedger.reserve('competing-producer',
      store.renderer.resourceLedger.maximumBytes - store.renderer.resourceLedger.bytes)
    assert(competitor)
    store.prepareUploads(); await tick()
    for (let i = 0; i < 5; ++i) store.prepareUploads()
    assert.strictEqual(decodes.length, 1, 'Preparation started more than one decode without a GPU consumer')
    await completeDecode()
    for (let i = 0; i < 5; ++i) store.prepareUploads()
    assert.strictEqual(uploads.length, 0, 'CPU preparation submitted a GPU upload')
    assert.strictEqual(decodes.length, 0, 'A ready image failed to hold the decode slot')
    assert.strictEqual(entry.byteSize, gpu, 'Decode charged CPU pixels to the GPU destination')
    store.processUploads(Infinity)
    assert.strictEqual(entry.value.image.closed, 0, 'CPU pixels were freed before GPU completion')
    uploads.shift().commit({id: 1})
    competitor.release()
    assert.strictEqual(entry.value.image, null)
    assert.strictEqual(entry.byteSize, gpu)
    assert.strictEqual(entry.value.blob, null)
    assert.strictEqual(store.inputBytes, 0)
    assert.strictEqual(store.cache.bytes, gpu)
    assert.strictEqual(store.renderer.resourceLedger.bytes, gpu)
    store.renderer.presentedTextures.set(key, tile); store.refreshProtection()
    const requestCount = requests

    store.renderer.resourceLedger.setLimit(gpu)
    store.restoreContext(); await tick()
    assert.strictEqual(requests, requestCount, 'Recovery fetched without staging credit')
    assert.strictEqual(store.cache.bytes, 0)
    store.renderer.resourceLedger.setLimit(400000)
    store.advance(); await tick()
    const recovered = store.cache.entries.get(key)
    assert(recovered && recovered !== entry, 'Recovery kept an unusable GPU-only entry')
    store.processUploads(Infinity); await tick(); await completeDecode()
    store.processUploads(Infinity); uploads.shift().commit({id: 2})
    assert.strictEqual(requests, requestCount + 1)
    assert.strictEqual(store.cache.bytes, gpu)
    assert.strictEqual(store.inputBytes, 0)

    // An upload cancellation releases pixels but keeps its bounded input;
    // retrying the upload does not require an extra HTTP request.
    store.restoreContext(); await tick()
    store.processUploads(Infinity); await tick(); await completeDecode()
    store.processUploads(Infinity)
    uploads.shift().cancel()
    const cancelledEntry = store.cache.entries.get(key)
    assert(cancelledEntry.value.blob && !cancelledEntry.value.image)
    const beforeRetry = requests
    store.processUploads(Infinity); await tick(); await completeDecode()
    store.processUploads(Infinity); uploads.shift().commit({id: 3})
    assert.strictEqual(requests, beforeRetry)
    assert.strictEqual(store.cache.bytes, gpu)

    // Source replacement retains a running decoder and its encoded input.
    store.restoreContext(); await tick()
    store.processUploads(Infinity); await tick()
    const heldBytes = store.cache.bytes, heldInput = store.inputBytes
    store.setSource(() => 'https://replacement.invalid', [])
    assert.strictEqual(store.cache.bytes, heldBytes)
    assert.strictEqual(store.inputBytes, heldInput)
    assert.strictEqual(store.renderer.resourceLedger.bytes, heldBytes + heldInput + 1024,
      'Source retirement refunded live pixels or kept unused workspace')
    assert.strictEqual(store.cache.stats().retainedEntries, 1)
    await completeDecode()
    assert.strictEqual(store.cache.bytes, 0)
    assert.strictEqual(store.inputBytes, 0)
    assert.strictEqual(store.renderer.resourceLedger.bytes, 0)
    store.destroy()

    const bounded = makeStore()
    oversized = true
    bounded.sync([{texture: tile}], [])
    await tick(); await tick()
    assert.strictEqual(cancelledBodies, 1, 'Oversized body was not cancelled')
    assert.strictEqual(decodes.length, 0, 'Oversized encoded source reached the decoder')
    assert.strictEqual(bounded.cache.bytes + bounded.cache.reservedBytes, 0)
    assert(bounded.failed.has(key))
    bounded.destroy(); oversized = false

    const failing = makeStore()
    failing.sync([{texture: tile}], []); await tick()
    failing.processUploads(Infinity); await tick(); await completeDecode()
    failing.processUploads(Infinity); uploads.shift().commit({id: 4})
    failing.renderer.presentedTextures.set(key, tile); failing.refreshProtection()
    failing.restoreContext(); await tick(); failing.processUploads(Infinity); await tick(); await completeDecode(true)
    assert(failing.failed.has(key), 'Recovery decode failure was hidden')
    assert.strictEqual(failing.cache.bytes + failing.cache.reservedBytes, 0)
    failing.destroy()

    const pair = makeStore(), second = {...tile, matrix: 1}
    pair.sync([{texture: tile}, {texture: second}], [])
    await tick(); await tick(); await tick()
    assert.strictEqual(pair.cache.entries.size, 2)
    assert.strictEqual(decodes.length, 0)
    pair.processUploads(Infinity); await tick(); await completeDecode(); pair.processUploads(Infinity)
    pair.processUploads(Infinity); await tick()
    assert.strictEqual(decodes.length, 1, 'An accepted upload did not allow the next decode to overlap')
    await completeDecode(); pair.processUploads(Infinity); await tick()
    assert.strictEqual(decodes.length, 0, 'A full ready slot started another decode')
    assert.strictEqual(pair.stats().decodedBytes, 2048)
    assert.strictEqual(pair.stats().decodePhase, 'upload')
    uploads.shift().commit({id: 5})
    pair.processUploads(Infinity)
    uploads.shift().commit({id: 6})
    pair.renderer.presentedTextures.set(key,tile)
    pair.renderer.presentedTextures.set('0/1/0/0',second); pair.refreshProtection()
    pair.restoreContext(); await tick(); pair.processUploads(Infinity); await tick()
    assert.strictEqual(decodes.length, 1, 'Recovery decoded the whole visible cut at once')
    await completeDecode(); pair.processUploads(Infinity); await tick()
    assert.strictEqual(decodes.length, 1, 'Recovery could not prepare one image behind an accepted upload')
    await completeDecode()
    uploads.shift().commit({id: 7})
    pair.processUploads(Infinity)
    while (uploads.length) uploads.shift().commit({id: 7})
    assert.strictEqual(pair.stats().decodedBytes, 0)
    pair.destroy()

    // Cancelling the submitted image must not cancel or close the next ready
    // image. A rejected attempt for that next image retains its decode slot.
    const interrupted = makeStore()
    interrupted.sync([{texture: tile}, {texture: second}], [])
    await tick(); await tick(); await tick()
    interrupted.processUploads(Infinity); await tick(); await completeDecode()
    interrupted.processUploads(Infinity); await tick(); await completeDecode()
    interrupted.processUploads(Infinity)
    const cancelled = uploads.shift(), nextImage = interrupted.cache.entries.get('0/1/0/0').value.image
    cancelled.cancel()
    assert.strictEqual(cancelled.image.closed, 1)
    assert.strictEqual(nextImage.closed, 0)
    assert.strictEqual(interrupted.stats().decodedBytes, 1024)
    interrupted.sync([{texture: second}], [])
    interrupted.processUploads(Infinity); uploads.shift().commit({id: 11})
    assert.strictEqual(interrupted.stats().decodedBytes, 0)
    interrupted.destroy()

    const backlog = makeStore({tileSize:256,maximumBytes:8*1024*1024})
    const tiles = Array.from({length: 8}, (_,column) => ({level: 2, matrix: 3, row: 0, column}))
    backlog.sync(tiles.map(texture => ({texture})), [])
    for (let i = 0; i < 30 && backlog.cache.entries.size < 8; ++i) await tick()
    assert.strictEqual(backlog.cache.entries.size, 8, 'Completed assembly credit did not advance the remaining requests')
    assert.strictEqual(decodes.length, 0)
    backlog.processUploads(Infinity); await tick(); await completeDecode(false,256); backlog.processUploads(Infinity)
    await tick(); await completeDecode(false,256)
    for (let i = 0; i < 5; ++i) { backlog.processUploads(Infinity); await tick() }
    assert.strictEqual(decodes.length, 1, 'A completed bitmap blocked the next funded CPU decode')
    // Hold the actual first GPU upload. The CPU may fill only its already
    // funded workspace, with one active decoder and no new GPU submission.
    for(let i=0;i<12;++i) {
      assert(decodes.length<=1,'The cache started concurrent bitmap decoders')
      if(decodes.length)await completeDecode(false,256)
      backlog.prepareUploads();await tick()
      if(!decodes.length)break
    }
    assert.strictEqual(uploads.length,1,'CPU lookahead submitted another GPU upload')
    assert.strictEqual(decodes.length,0,'The decoder outran its funded workspace')
    assert(backlog.stats().readyImages>=2,'Ready cache did not separate decode and upload clocks')
    assert(backlog.stats().readyImages<tiles.length-1,'An unfunded bitmap queue decoded the whole backlog')
    assert(backlog.stats().decodedBytes+backlog.inputBytes<=backlog.pipelineBytes())
    assert(backlog.pipelineBytes()<=backlog.maximumPipelineBytes)
    for (let i = 0; i < 80 && tiles.some(tile => !backlog.gpuReady([tile.level,tile.matrix,tile.row,tile.column].join('/'))); ++i) {
      if (uploads.length) uploads.shift().commit({id: 20+i})
      backlog.processUploads(Infinity); await tick()
      if (decodes.length) await completeDecode(false,256)
      assert(backlog.stats().decodedBytes+backlog.inputBytes<=backlog.pipelineBytes(),
        'Decoded pixels exceeded their actual funded workspace')
      assert(backlog.pipelineBytes()<=backlog.maximumPipelineBytes)
    }
    assert(tiles.every(tile => backlog.gpuReady([tile.level,tile.matrix,tile.row,tile.column].join('/'))))
    assert.strictEqual(backlog.stats().decodedBytes, 0)
    backlog.destroy()

    // A visible sibling group needs all destinations before its first fetch.
    // One byte owned by another producer must reject the group atomically.
    const grouped = makeStore()
    grouped.prefetchAncestors = true
    grouped.cache.maximumEntries = grouped.requestedMaximumEntries = 32
    const completeBytes = gpu + 4 * grouped.requestBytes() + grouped.encodedLimit * 2
    grouped.cache.maximumBytes = grouped.requestedMaximumBytes = completeBytes
    grouped.renderer.resourceLedger.setLimit(completeBytes)
    grouped.cache.set(key, {texture: {}, image: null, width: 16, height: 16}, gpu)
    grouped.renderer.presentedTextures.set(key, tile)
    const siblings = Array.from({length: 4}, (_,i) => ({level: 2, matrix: 2, row: i >> 1, column: i & 1}))
    const interference = grouped.renderer.resourceLedger.reserve('other-owner', 1)
    const beforeGroup = requests
    grouped.sync(siblings.map(texture => ({texture})), [])
    grouped.schedule('2/2/0/0', siblings[0], 1) // A delayed retry cannot bypass group admission.
    await tick(); await tick()
    assert.strictEqual(requests, beforeGroup, 'A partial sibling group began doomed I/O')
    assert.strictEqual(grouped.cache.reservedBytes, 0, 'Rejected group leaked reservations')
    assert(grouped.gpuReady(key), 'Rejected replacement lost its displayed ancestor')
    assert(grouped.blockedByCapacity)
    assert(grouped.stats().admissionBlocked, 'Group refusal was hidden from display capacity recovery')
    interference.release()
    grouped.advance()
    assert.strictEqual(grouped.cache.bytes + grouped.cache.reservedBytes + grouped.pipelineBytes(), completeBytes,
      'First fetch was not backed by every sibling destination')
    assert(siblings.every(tile => grouped.protectedKeys.has([tile.level,tile.matrix,tile.row,tile.column].join('/'))),
      'Admitted destinations were reclaimable between insertion and the next availability callback')
    for (let i = 0; i < 80 && siblings.some(tile => !grouped.gpuReady([tile.level,tile.matrix,tile.row,tile.column].join('/'))); ++i) {
      grouped.processUploads(Infinity); await tick()
      if (decodes.length) await completeDecode()
      if (uploads.length) uploads.shift().commit({id: 700+i})
    }
    assert(siblings.every(tile => grouped.gpuReady([tile.level,tile.matrix,tile.row,tile.column].join('/'))))
    assert.strictEqual(requests - beforeGroup, 4)
    assert.strictEqual(grouped.groupAdmission.pending.size, 0)
    assert.strictEqual(grouped.cache.reservedBytes, 0)
    assert.strictEqual(grouped.renderer.resourceLedger.highWaterBytes, completeBytes)
    grouped.destroy()

    // Even with borrowed replacement headroom, the peak includes production.
    // Shared spare capacity cannot enlarge that local ceiling.
    const localLimit = makeStore()
    localLimit.prefetchAncestors = true
    localLimit.cache.maximumEntries = localLimit.requestedMaximumEntries = 32
    localLimit.requestedMaximumBytes = completeBytes - 4*gpu - 1
    localLimit.renderer.resourceLedger.setLimit(4 * 1024 * 1024)
    localLimit.cache.set(key, {texture: {}, image: null, width: 16, height: 16}, gpu)
    localLimit.renderer.presentedTextures.set(key, tile)
    const localRequests = requests
    localLimit.sync(siblings.map(texture => ({texture})), [])
    await tick(); await tick()
    assert.strictEqual(requests, localRequests)
    assert.strictEqual(localLimit.pipelineBytes(), 0)
    assert.strictEqual(localLimit.cache.reservedBytes, 0)
    localLimit.destroy()

    // Retire an obsolete unsubmitted Blob before pricing the new demand, but
    // acquire the replacement's full credit only when its input actually starts.
    const reclaimInput = makeStore()
    reclaimInput.cache.maximumEntries = reclaimInput.requestedMaximumEntries = 1
    const serialBytes = gpu + reclaimInput.encodedLimit * 2
    reclaimInput.requestedMaximumBytes = serialBytes
    reclaimInput.renderer.resourceLedger.setLimit(serialBytes)
    reclaimInput.sync([{texture: tile}], []); await tick()
    reclaimInput.buildRequirementTree([{texture: second}], [])
    reclaimInput.recomputeAvailability(); reclaimInput.refreshProtection()
    assert.strictEqual(reclaimInput.renderer.resourceLedger.bytes, 0,
      'Waiting demand allocated destinations before its production start')
    assert.strictEqual(reclaimInput.groupAdmission.pending.size, 0)
    reclaimInput.scheduleFrontier()
    assert.strictEqual(reclaimInput.renderer.resourceLedger.bytes, serialBytes)
    assert.strictEqual(reclaimInput.pipelineBytes(), reclaimInput.encodedLimit * 2)
    assert.strictEqual(reclaimInput.groupAdmission.pending.size, 0)
    assert.strictEqual(reclaimInput.cache.reservations.size, 1)
    assert(!reclaimInput.renderer.resourceLedger.reserve('competitor', 1))
    await tick()
    reclaimInput.processUploads(Infinity); await tick(); await completeDecode()
    reclaimInput.processUploads(Infinity); uploads.shift().commit({id: 799})
    assert.strictEqual(reclaimInput.pipelineBytes(), 0)
    reclaimInput.destroy()

    // Zero bytes still represent a live input; keep the decode lane available
    // so invalid empty content becomes a source failure instead of waiting forever.
    const emptyBody = makeStore()
    bodyBytes = 0
    emptyBody.sync([{texture: tile}], []); await tick()
    assert.strictEqual(emptyBody.inputBytes, 0)
    assert.strictEqual(emptyBody.inputJobs, 1)
    assert(emptyBody.pipelineBytes() > 0)
    emptyBody.processUploads(Infinity); await tick(); await tick()
    assert(emptyBody.failed.has(key))
    assert.strictEqual(emptyBody.renderer.resourceLedger.bytes, 0)
    emptyBody.destroy(); bodyBytes = 100

    const queuedGroup = makeStore()
    queuedGroup.prefetchAncestors = true
    queuedGroup.cache.maximumEntries = queuedGroup.requestedMaximumEntries = 32
    queuedGroup.cache.maximumBytes = queuedGroup.requestedMaximumBytes = completeBytes * 4
    queuedGroup.renderer.resourceLedger.setLimit(completeBytes * 4)
    queuedGroup.cache.set(key, {texture: {}, image: null, width: 16, height: 16}, gpu)
    queuedGroup.transitionReserveEntries = 8
    let finishGroupFetch
    queuedGroup.renderer.options.fetchTextures = () => new Promise(resolve => { finishGroupFetch = () => resolve(response()) })
    queuedGroup.sync(siblings.concat(siblings.map(tile => ({...tile, column: tile.column + 2})))
      .map(texture => ({texture})), [])
    await tick()
    assert.strictEqual(queuedGroup.groupAdmission.pending.size, 3)
    assert.strictEqual(queuedGroup.scheduler.queued.size, 7)
    assert.strictEqual(queuedGroup.cache.reservations.size, 4,
      'A queued group consumed GPU destinations while the request lane was full')
    assert.strictEqual(queuedGroup.admissionBlocked.size, 0,
      'An admitted group still producing caused capacity-driven display coarsening')
    assert.strictEqual(queuedGroup.blockedByCapacity, false,
      'Waiting for an admitted group was reported as permanent capacity failure')
    assert.strictEqual(queuedGroup.renderer.resourceLedger.bytes, completeBytes)
    queuedGroup.setPaused(true)
    assert.strictEqual(queuedGroup.groupAdmission.pending.size, 0)
    assert.strictEqual(queuedGroup.renderer.resourceLedger.bytes, gpu + queuedGroup.requestBytes() + queuedGroup.encodedLimit * 2,
      'Pause failed to distinguish queued and actually running group production')
    queuedGroup.setSource(() => 'https://replacement.invalid', [])
    assert.strictEqual(queuedGroup.renderer.resourceLedger.bytes, queuedGroup.requestBytes(),
      'Source retirement retained unused body credit behind a header-only request')
    finishGroupFetch(); await tick(); await tick()
    assert.strictEqual(queuedGroup.renderer.resourceLedger.bytes, 0)
    queuedGroup.destroy()

    // A large group's refusal may precede a smaller group's admission in the
    // same queue drain. Classify the former only after that production finishes.
    const mixedGroups = makeStore()
    mixedGroups.prefetchAncestors = true
    mixedGroups.renderer.resourceLedger.setLimit(completeBytes - 2 * gpu)
    mixedGroups.cache.set(key, {texture: {}, image: null, width: 16, height: 16}, gpu)
    let finishMixedFetch
    mixedGroups.renderer.options.fetchTextures = () => new Promise(resolve => { finishMixedFetch = () => resolve(response()) })
    const smaller = siblings.slice(0,2).map(tile => ({...tile, column: tile.column + 2}))
    mixedGroups.sync(siblings.concat(smaller).map(texture => ({texture})), [])
    await tick(); await tick(); await tick()
    assert.strictEqual(mixedGroups.inputJobs, 1)
    assert.strictEqual(mixedGroups.admissionBlocked.size, 0,
      'Earlier group refusal coarsened display after another group began production')
    assert.strictEqual(mixedGroups.blockedByCapacity, false)
    mixedGroups.destroy()
    finishMixedFetch(); await tick(); await tick()

    // Saturate the input window with slow GPU receipts. Network concurrency
    // and an otherwise roomy cache must not bypass the aggregate byte limit.
    const saturated = makeStore()
    saturated.cache.maximumEntries = saturated.requestedMaximumEntries = 64
    saturated.cache.maximumBytes = saturated.requestedMaximumBytes = 4 * 1024 * 1024
    saturated.renderer.resourceLedger.setLimit(4 * 1024 * 1024)
    saturated.scheduler.maximumConcurrent = 8
    bodyBytes = 65536
    const many = Array.from({length: 16}, (_,column) => ({level: 3, matrix: 4, row: 0, column}))
    const started = requests
    saturated.sync(many.map(texture => ({texture})), [])
    for (let i = 0; i < 30; ++i) await tick()
    assert.strictEqual(requests - started, 11, 'Header requests did not use their bounded independent scheduler slots')
    assert.strictEqual(saturated.cache.entries.size, 3, 'Body reads bypassed the shared input window')
    assert.strictEqual(saturated.inputQueue.pending.length, 8)
    assert.strictEqual(saturated.cache.reservations.size, 8,
      'Header requests did not retain their funded destinations')
    assert.strictEqual(saturated.groupAdmission.pending.size, 0,
      'Independent queued roots consumed production credit')
    assert(saturated.inputBytes <= saturated.maximumInputBytes)
    assert(saturated.inputHighWaterBytes <= saturated.maximumInputBytes)
    assert.strictEqual(saturated.admissionBlocked.size, 0, 'Pipeline waiting was reported as resident capacity failure')
    assert.strictEqual(saturated.estimatedTileBytes, gpu, 'Encoded sizes inflated steady GPU demand')
    const stalledWakes = wakeups
    for (let i = 0; i < 8; ++i) await tick()
    assert.strictEqual(wakeups, stalledWakes, 'Full input pipeline busy-polled admission')
    saturated.processUploads(Infinity); await tick(); await completeDecode(); saturated.processUploads(Infinity)
    await tick(); await completeDecode()
    for (let i = 0; i < 8; ++i) { saturated.processUploads(Infinity); await tick() }
    assert.strictEqual(saturated.stats().decodedBytes, 2048)
    assert.strictEqual(requests - started, 11, 'GPU stall admitted an unbounded header backlog')
    for (let i = 0; i < 150 && many.some(tile => !saturated.gpuReady([tile.level,tile.matrix,tile.row,tile.column].join('/'))); ++i) {
      if (uploads.length) uploads.shift().commit({id: 100+i})
      saturated.processUploads(Infinity); await tick()
      if (decodes.length) await completeDecode()
      assert(saturated.inputBytes <= saturated.maximumInputBytes)
    }
    assert(many.every(tile => saturated.gpuReady([tile.level,tile.matrix,tile.row,tile.column].join('/'))))
    assert.strictEqual(saturated.inputBytes, 0)
    assert.strictEqual(saturated.cache.bytes, 16 * gpu)
    saturated.destroy(); bodyBytes = 100

    // Cancellation cannot return a body reader's credit before its receipt.
    const late = makeStore()
    let finishRead
    late.renderer.options.fetchTextures = async () => ({ok: true, headers: {get: () => 'image/png'},
      body: {cancel: async () => {}, getReader: () => ({
        read: () => new Promise(resolve => { finishRead = () => resolve({done: true}) }),
        cancel: async () => {}, releaseLock() {}
      })}})
    late.sync([{texture: tile}], []); await tick()
    const lateBytes = late.inputBytes, lateLedger = late.renderer.resourceLedger.bytes
    assert(lateBytes > 0)
    late.setSource(() => 'https://replacement.invalid', [])
    assert.strictEqual(late.inputBytes, lateBytes)
    assert.strictEqual(late.renderer.resourceLedger.bytes, lateLedger)
    finishRead(); await tick(); await tick()
    assert.strictEqual(late.inputBytes, 0)
    assert.strictEqual(late.renderer.resourceLedger.bytes, 0)
    late.destroy()

    // A fine displayed tile may no longer belong to the coarse target plan.
    // Context recovery still downloads it through bounded normal admission.
    const historical = makeStore()
    const fine = {level: 2, matrix: 3, row: 0, column: 0}, fineKey = '2/3/0/0'
    historical.sync([{texture: fine}], []); await tick()
    historical.processUploads(Infinity); await tick(); await completeDecode()
    historical.processUploads(Infinity); uploads.shift().commit({id: 400})
    historical.renderer.presentedTextures.set(fineKey, fine)
    historical.sync([{texture: tile}], [], true)
    assert(!historical.desired.has(fineKey))
    historical.restoreContext(); historical.sync([{texture: tile}], [], true)
    for (let i = 0; i < 25 && !historical.gpuReady(fineKey); ++i) {
      historical.processUploads(Infinity); await tick()
      if (decodes.length) await completeDecode()
      if (uploads.length) uploads.shift().commit({id: 401+i})
    }
    assert(historical.gpuReady(fineKey), 'Recovery lost the actual fine display behind a coarse target')
    const online = historical.renderer.options.fetchTextures
    historical.renderer.options.fetchTextures = async () => { throw new Error('Source unavailable') }
    historical.restoreContext()
    for (let i = 0; i < 8; ++i) await tick()
    assert(historical.failed.has(fineKey))
    assert.strictEqual(historical.stats().state, 'degraded', 'A failed historical display was reported as ready')
    assert.strictEqual(historical.inputBytes, 0)
    historical.renderer.options.fetchTextures = online
    assert(historical.retryFailed())
    for (let i = 0; i < 25 && !historical.gpuReady(fineKey); ++i) {
      historical.processUploads(Infinity); await tick()
      if (decodes.length) await completeDecode()
      if (uploads.length) uploads.shift().commit({id: 500+i})
    }
    assert(historical.gpuReady(fineKey), 'Recovery retry did not restore the fine displayed tile')
    historical.destroy()

    const switched = makeStore()
    switched.sync([{texture: tile}], []); await tick()
    switched.processUploads(Infinity); await tick()
    switched.renderer.options.textureDescriptor.tile_size = 32
    switched.setSource(() => 'https://replacement.invalid', [])
    const oldCredit = switched.cache.bytes
    assert(oldCredit > 0)
    await completeDecode()
    assert.strictEqual(switched.cache.bytes, 0)
    switched.sync([{texture: tile}], []); await tick()
    switched.processUploads(Infinity); await tick(); await completeDecode(false,32)
    switched.processUploads(Infinity); uploads.shift().commit({id: 8})
    assert.strictEqual(switched.cache.bytes, textureByteSize(32,32))
    switched.destroy()

    // Moving away releases obsolete pipeline content; returning re-enters
    // normal request admission, without monopolizing decoding.
    const moving = makeStore()
    moving.sync([{texture: tile}, {texture: second}], []); await tick(); await tick()
    moving.processUploads(Infinity); await tick(); await completeDecode()
    const stale = moving.cache.entries.get(key), staleImage = stale.value.image
    const fetched = requests
    moving.sync([{texture: second}], [])
    moving.processUploads(Infinity); await tick()
    assert.strictEqual(staleImage.closed, 1)
    assert(!moving.cache.has(key))
    assert(!stale.value.blob && !stale.value.image)
    assert.strictEqual(decodes.length, 1, 'A no-longer-uploadable image monopolized decoding')
    await completeDecode(); moving.processUploads(Infinity); uploads.shift().commit({id: 9})
    moving.sync([{texture: tile}], []); await tick()
    moving.processUploads(Infinity); await tick(); await completeDecode()
    moving.processUploads(Infinity); uploads.shift().commit({id: 10})
    assert.strictEqual(requests, fetched + 1)
    moving.destroy()

    // An obsolete submitted upload keeps its bitmap and credit through the
    // receipt even though the next source may already have encoded content.
    const replaced = makeStore()
    replaced.sync([{texture: tile}], []); await tick()
    replaced.processUploads(Infinity); await tick(); await completeDecode(); replaced.processUploads(Infinity)
    const submitted = uploads.shift(), oldImage = submitted.image, owned = replaced.cache.bytes
    replaced.setSource(() => 'https://replacement.invalid', [])
    assert.strictEqual(oldImage.closed, 0)
    assert.strictEqual(replaced.cache.bytes, owned)
    assert.strictEqual(replaced.preparations.size, 0)
    submitted.cancel()
    assert.strictEqual(oldImage.closed, 1)
    assert.strictEqual(replaced.cache.bytes, 0)
    replaced.destroy()

    const invalid = makeStore()
    invalid.sync([{texture: tile}], []); await tick()
    invalid.processUploads(Infinity); await tick(); await completeDecode(false,32)
    assert(invalid.failed.has(key), 'Invalid dimensions did not enter the failure policy')
    assert.strictEqual(invalid.cache.bytes, 0)
    assert.strictEqual(invalid.preparations.size, 0)
    invalid.destroy()

    const dying = makeStore()
    dying.sync([{texture: tile}], []); await tick()
    dying.processUploads(Infinity); await tick()
    dying.destroy()
    assert(dying.cache.bytes > 0, 'Destroy refunded a running decoder')
    await completeDecode()
    assert.strictEqual(dying.cache.bytes, 0)
    await require('./parallel_decode_contract')(makeStore, {decodes, uploads, tick})
    assert(wakeups > 0)
  } finally {
    stores.forEach(store => store.destroy())
    while (decodes.length) { decodes.shift().resolve(); await tick() }
    while (uploads.length) uploads.shift().cancel()
    await tick()
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete global[name]
      else global[name] = saved[name]
    }
  }
  assert(images.every(image => image.closed === 1), 'Decoded images survived teardown')
  assert(stores.every(store => store.renderer.resourceLedger.bytes === 0 && !store.preparations.size &&
    store.inputBytes === 0 && store.inputJobs === 0 && store.workspaces.size === 0))
  console.log('Encoded imagery admission, fence lifetime, scheduled recovery, pressure, cancellation and failure passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
