const {NativePayloadBudget} = require('../../sdk/js/resources/native_payload_budget')
const {terrainCapacityPolicy} = require('../../sdk/js/resources/terrain_capacity_policy')
const {runImageryGrants}=require('./imagery_grants')
const {runHeightWork} = require('../../sdk/js/terrain/height_work')
const common = require('../../sdk/js/core/terra_globe_common')
const {terrainRecordBytes} = require('../../sdk/js/terrain/terrain_record')
const { cameraSnapshot } = require('../../sdk/js/camera/terra_camera_snapshot')
const {produceMeshCandidate} = require('./mesh_candidate_production')
const {NativeMeshBudget} = require('../../sdk/js/resources/native_mesh_budget')
const { WORKER_PROTOCOL } = require('./worker_protocol')
const {MeasurementReceiver} = require('./measurement_transport')
const {MeasurementDeliveryClient} = require('./measurement_delivery_client')
const {releaseMeasurements} = require('../../sdk/js/terrain/measurement_rows')
let nextGeneration = 1

class TerrainWorkerClient {
  constructor(worker, options) {
    this.worker = worker
    this.options = options || {}
    this.pending = new Map()
    this.imageryOperations = new Set()
    this.nextId = 1
    this.destroyed = false
    this.incrementalLayout = true
    this.isWorker = true
    this.lastMemoryBytes = 0
    this.viewRevision = 0
    this.nativeRevision = 0
    this.imageryReferenceRevision = 0
    this.measurementReceiver = new MeasurementReceiver(undefined,items=>{
      if(!this.destroyed)try{this.worker.postMessage({type:'measurement-forget',items})}catch(error){this.crash(error)}
    })
    this.measurementDelivery = new MeasurementDeliveryClient(this.measurementReceiver,{
      post:message=>this.worker.postMessage(message),
      fatal:error=>{try{this.crash(error)}catch(failure){this.measurementFatalReportingError=failure}}
    })
    this.generation = nextGeneration++
    worker.onmessage = event => this.receive(event.data)
    worker.onerror = event => {
      this.crash(new Error(event.message || 'Terrain Worker failed'))
    }
  }

  static async create(options) {
    const worker = options.workerFactory ? options.workerFactory(options.workerUrl) : new Worker(options.workerUrl)
    const client = new TerrainWorkerClient(worker, options)
    const controller = options.wasmBytes ? null : new AbortController()
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null
    try {
      let bytes = options.wasmBytes
      if (!bytes) {
        const response = await fetch(options.wasmUrl, { cache: 'no-store', signal: controller.signal })
        common.invariant(response.ok, `Worker Wasm returned HTTP ${response.status}`)
        bytes = await response.arrayBuffer()
      }
      client.wasmBytes = bytes.slice(0)
      const ready = await client.send({ type: 'initialize', protocol: WORKER_PROTOCOL, bytes }, [bytes])
      common.invariant(ready && ready.protocol === WORKER_PROTOCOL, 'Terrain Worker protocol mismatch')
      return client
    } catch (error) {
      client.destroy()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  send(message, transfer, onProgress) {
    if (this.destroyed) return Promise.reject(new Error('Terrain Worker is destroyed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = () => {
        const error = new Error(`Terrain Worker ${message.type} timed out`)
        this.crash(error)
      }
      const timer = setTimeout(timeout, this.options.workerTimeoutMs || 30000)
      this.pending.set(id, { resolve, reject, timer, timeout, onProgress, type: message.type })
      try { this.worker.postMessage(Object.assign({ id }, message), transfer || []) }
      catch (error) { this.crash(error) }
    })
  }

  receive(message) {
    if(message.measurementStopped===true&&(this.mirrorStopResolve||message.type==='fatal')) {
      this.measurementDelivery.stopped()
      if(this.mirrorStopResolve){clearTimeout(this.mirrorStopTimer);const resolve=this.mirrorStopResolve;this.mirrorStopResolve=null;resolve()}
    }
    if (this.destroyed) {
      if(message.mirrorReceipt)try {
        this.measurementDelivery.receive(message.id,message.mirrorReceipt,message.value&&message.value.measurements,true)
      }catch(error){
        if(message.value&&message.value.measurements&&Array.isArray(message.value.measurements.buffers))message.value.measurements.buffers.length=0
        this.measurementDiscardError=error
      }
      return
    }
    // A failed native owner cannot provide a trustworthy zero-byte receipt.
    // Terminate the complete Worker and wait for its real termination instead.
    if(message.type==='fatal') {this.crash(new Error(message.error||'Terrain Worker native owner failed'));return}
    if(message.mirrorWork) {
      try {
        if(this.pending.has(message.id))this.measurementDelivery.quote(message.id,message.mirrorWork)
        else this.worker.postMessage({type:'measurement-cancel',workId:message.mirrorWork.id})
      }catch(error){this.crash(error);return}
    }
    // Ownership reports remain authoritative after RPC cancellation. Idle
    // cancellation can also end the last native loan without another request.
    // Heap capacity comes from this envelope too, never from an older result
    // consumed after an await. It retires only with the actual Worker.
    if (!Number.isSafeInteger(message.memoryBytes) || message.memoryBytes < this.lastMemoryBytes ||
        !Number.isSafeInteger(message.nativeRevision) || message.nativeRevision < this.nativeRevision ||
        !Number.isSafeInteger(message.recordBytes) || message.recordBytes < 0 ||
        !Number.isSafeInteger(message.indexBytes) || message.indexBytes < 0 ||
        !Number.isSafeInteger(message.heightBytes) || message.heightBytes < 0 ||
        !Number.isSafeInteger(message.imageryBytes) || message.imageryBytes < 0 ||
        !Number.isSafeInteger(message.imageryReferenceRevision) || message.imageryReferenceRevision < this.imageryReferenceRevision ||
        !Number.isSafeInteger(message.imageryReferenceBytes) || message.imageryReferenceBytes < 0 ||
        !Number.isSafeInteger(message.imageryOutputBytes) || message.imageryOutputBytes < 0 ||
        !Number.isSafeInteger(message.imageryInputBytes) || message.imageryInputBytes < 0) {
      this.crash(new Error('Terrain Worker native ownership revision is invalid')); return
    }
    this.lastMemoryBytes = message.memoryBytes
    this.nativeRevision = message.nativeRevision
    this.imageryReferenceRevision = message.imageryReferenceRevision
    if (this.nativeBudget) {
      try { this.nativeBudget.observe(message.nativeBytes) }
      catch (error) { this.crash(error); return }
    }
    if (this.recordBudget) {
      try { this.recordBudget.observe(message.recordBytes) }
      catch (error) { this.crash(error); return }
    }
    this.nativeRecordBytes = message.recordBytes
    if (this.indexBudget) {
      try { this.indexBudget.observe(message.indexBytes) }
      catch (error) { this.crash(error); return }
    }
    this.workerIndexBytes = message.indexBytes
    if (this.heightBudget) {
      try { this.heightBudget.observe(message.heightBytes) }
      catch (error) { this.crash(error); return }
    }
    this.nativeHeightBytes = message.heightBytes
    this.nativeImageryBytes = message.imageryBytes
    if (this.imageryInputBudget) {
      try { this.imageryInputBudget.observe(message.imageryInputBytes) }
      catch (error) { this.crash(error); return }
    }
    if (this.imageryReferenceBudget) {
      try { this.imageryReferenceBudget.observe(message.imageryReferenceBytes) }
      catch (error) { this.crash(error); return }
    }
    this.nativeImageryReferenceBytes = message.imageryReferenceBytes
    this.nativeImageryInputBytes = message.imageryInputBytes
    if (this.imageryOutputBudget) {
      try { this.imageryOutputBudget.observe(message.imageryOutputBytes) }
      catch (error) { this.crash(error); return }
    }
    this.nativeImageryOutputBytes = message.imageryOutputBytes
    if (message.nativeBytes !== undefined) this.nativeBytes = message.nativeBytes
    if (message.measurementReset) this.measurementReceiver.clear()
    let mirrorFailure
    if(message.value&&message.value.measurements&&!message.mirrorReceipt) {
      this.crash(new Error('Measurement publication has no ownership receipt'));return
    }
    if (message.mirrorReceipt) {
      try {
        const received=this.measurementDelivery.receive(message.id,message.mirrorReceipt,message.value&&message.value.measurements)
        mirrorFailure=received.error
        if(message.value&&received.values)message.value.measurements=received.values
      }
      catch (error) { this.crash(error); return }
    }
    // A cancelled RPC still advances the transport's reference state, even
    // though its result must not be adopted by the renderer.
    const pending = this.pending.get(message.id)
    if (!pending) {if(message.value)releaseMeasurements(message.value.measurements);return}
    if(message.mirrorWork) {
      clearTimeout(pending.timer)
      pending.timer=setTimeout(pending.timeout,this.options.workerTimeoutMs||30000)
      return
    }
    if (pending.type === 'imagery' && message.value && message.value.measurementHistory) {
      this.measurementHistory = message.value.measurementHistory
      this.imageryPlanning = {
        viewRevision: message.value.viewRevision, modelRevision: message.value.modelRevision,
        ageMs: message.value.cameraPlanAgeMs, settledRebases: message.value.settledRebases,
        stage: message.value.progress ? message.value.progress.stage :
          message.value.imageryPlan && message.value.imageryPlan.quality.planningComplete ? 'complete' : 'planning',
        index:message.value.progress && message.value.progress.index,
        measured:message.value.progress && message.value.progress.measured,
        work:message.value.preparationWork
      }
    }
    clearTimeout(pending.timer)
    if (message.progress) {
      pending.timer = setTimeout(pending.timeout, this.options.workerTimeoutMs || 30000)
      try { if (pending.onProgress) pending.onProgress(message.value) }
      catch (error) {
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        this.worker.postMessage({type: 'cancel-imagery', id: message.id})
        pending.reject(error)
      }
      finally {if(message.value)releaseMeasurements(message.value.measurements)}
      return
    }
    this.pending.delete(message.id)
    if(mirrorFailure)pending.reject(mirrorFailure)
    else if (message.error) pending.reject(Object.assign(new Error(message.error),
      {status: message.status, requests: message.requests}))
    else pending.resolve(message.value)
  }

  fail(error) {
    this.pending.forEach(pending => { clearTimeout(pending.timer); pending.reject(error) })
    this.pending.clear()
  }

  crash(error) {
    if (this.destroyed) return
    this.destroyed = true
    this.terminateProducer(error)
    if (this.options.onFatal) this.options.onFatal(error)
  }

  async call(method, ...args) {
    return this.send({ type: 'call', method, args })
  }

  command(method, ...args) {
    this.call(method, ...args).catch(error => {
      if (!this.destroyed && this.options.onError) this.options.onError(error)
    })
  }

  loadManifest(manifest, capacityBytes = this.terrainCapacity && this.terrainCapacity.meshBytes) {
    const capacity = terrainCapacityPolicy(capacityBytes)
    return this.produceRecord(4 * manifest.patchDimension * manifest.patchDimension,
      'loadManifest', [manifest, capacity.meshBytes]).then(result => {
      this.terrainCapacity = capacity
      return result
    })
  }

  produceRecord(bytes, method, args) {
    const reset = method === 'loadManifest'
    const send = recordCreditBytes => this.send({type: 'call', method, args, recordCreditBytes}).then(value => {
      if (reset) this.manifest = args[0]
      return value
    })
    if (!this.recordBudget) return send(bytes)
    return reset ? this.recordBudget.runReset(bytes, send) : this.recordBudget.run(bytes, send)
  }
  notifyView() {
    const signature = JSON.stringify([this.viewport, this.camera, this.target])
    if (signature === this.viewSignature || this.destroyed) return
    this.viewSignature = signature
    this.worker.postMessage({ type: 'view', revision: ++this.viewRevision,
      camera: Object.assign({}, this.camera, this.target), viewport: this.viewport,
      snapshot: this.manifest && this.camera && this.viewport ? this.getCameraSnapshot() : null })
  }
  setViewport(width, height, fovRadians) { this.viewport = { width, height, fovRadians }; this.notifyView() }
  setCamera(camera) {
    this.camera = Object.assign({}, camera)
    // A runtime camera contains its complete target. Publish it atomically so
    // the next selection cannot capture a new target with an old orientation.
    if (camera.longitudeDegrees !== undefined) {
      this.target = {longitudeDegrees: camera.longitudeDegrees, latitudeDegrees: camera.latitudeDegrees}
    } else if (camera.x !== undefined) this.target = {x: camera.x, y: camera.y}
    this.notifyView()
  }
  setGlobeTarget(longitudeDegrees, latitudeDegrees) { this.target = { longitudeDegrees, latitudeDegrees }; this.notifyView() }
  setPlanarTarget(x, y) { this.target = { x, y }; this.notifyView() }
  setPlanarLevel(level) { this.command('setPlanarLevel', level) }
  recordBytes(kind, bytes) {
    bytes = terrainRecordBytes(this.manifest, kind, bytes)
    // Structured clone includes the backing buffer, not only the visible view.
    return bytes.byteOffset || bytes.byteLength !== bytes.buffer.byteLength ? bytes.slice() : bytes
  }
  submitRecord(kind, key, bytes) {
    const dimension = this.manifest.patchDimension + (kind === 1 ? 1 : 0)
    return this.produceRecord(4 * dimension * dimension, 'submitRecord',
      [kind, key, this.recordBytes(kind, bytes)])
  }
  noDataRecord(key) { return this.call('noDataRecord', key) }
  failRecord(kind, key) { this.command('failRecord', kind, key) }
  retryRecord(kind, key) { this.command('retryRecord', kind, key) }
  computeAtmosphere(options) { return this.call('computeAtmosphere', options) }
  sampleTerrain(u, v) { return this.call('sampleTerrain', u, v) }
  beginHeightQuery(options) { return this.call('beginHeightQuery', options) }
  stepHeightQuery(id, maximumWork) { return this.call('stepHeightQuery', id, maximumWork) }
  submitHeightQueryRecord(id, kind, key, bytes) { return this.call('submitHeightQueryRecord', id, kind, key, this.recordBytes(kind, bytes)) }
  heightQueryUnavailable(id, kind, key, failed) { return this.call('heightQueryUnavailable', id, kind, key, failed) }
  endHeightQuery(id) { return this.call('endHeightQuery', id) }
  getHeightQueryRegion(id, maximumValues) { return this.call('getHeightQueryRegion', id, maximumValues) }
  getCameraSnapshot() {
    return cameraSnapshot(this.manifest, Object.assign({}, this.camera, this.target), this.viewport)
  }
  memoryBytes() { return this.lastMemoryBytes }
  imageryPayloadBytes() { return this.nativeImageryBytes || 0 }
  imageryOutputPayloadBytes() { return this.nativeImageryOutputBytes || 0 }
  reclaimImageryReferences(needed) {
    return require('../../sdk/js/resources/imagery_reference_reclamation').reclaimImageryReferences(this, needed,
      (bytes, restart) => this.send({type:'trim-imagery-references', needed:bytes, restart}),
      () => new Promise(resolve => setTimeout(resolve, 0)))
  }

  imageryReferencePayloadBytes() { return this.nativeImageryReferenceBytes || 0 }

  imageryInputPayloadBytes() { return this.nativeImageryInputBytes || 0 }
  async reclaimMeasurementInputs(needed) {
    const before=this.imageryInputPayloadBytes()
    for(let round=0;round<128&&!this.destroyed;++round) {
      const value=await this.send({type:'trim-native-measurements',needed:Math.max(1,needed-(before-this.imageryInputPayloadBytes()))})
      if(!value.more||before-this.imageryInputPayloadBytes()>=needed)break
      await new Promise(resolve=>setTimeout(resolve,0))
    }
    return Math.max(0,before-this.imageryInputPayloadBytes())
  }
  presentFrame(sequence) { return this.send({ type: 'present', sequence }) }
  retainMeshes(sequence, draws) { return this.send({ type: 'retain', sequence, draws }) }
  discardFrame(sequence) { return this.send({ type: 'discard', sequence }) }
  createPartitionTask(resourceId, cells, maximumBytes) {
    common.invariant(Number.isSafeInteger(maximumBytes) && maximumBytes >= 0, 'Partition output credit is required')
    return this.partitionTask({type: 'partition', resourceId, cells, maximumBytes})
  }
  createPartitionPlanTask(resourceId, cells) {
    return this.partitionTask({type: 'partition-plan', resourceId, cells})
  }
  createPartitionGroupPlanTask(rows, onRows) {
    return this.partitionTask({type: 'partition-group-plan', rows}, value => onRows(value.rows))
  }
  createMeshPartitionPlanTask(planId, rows, maximumBytes, onRows) {
    return this.partitionTask({type: 'mesh-partition-plan', planId, maximumBytes,
      rows: rows.map(row => ({resourceId: row.draw.resourceId, cells: row.cells}))}, value => onRows(value.rows))
  }
  partitionTask(message, onProgress) {
    const id = this.nextId
    let cancelled = false, failure
    const cancel = () => {
      cancelled = true
      if (!this.destroyed && this.pending.has(id)) {
        try { this.worker.postMessage({type: 'cancel-partition', id}) }
        catch (error) { this.crash(error) }
      }
    }
    const progress = value => {
      if (!cancelled && onProgress) {
        try { if (onProgress(value) === false) cancel() }
        catch (error) { failure = error; cancel() }
      }
    }
    const promise = this.send(message, [], progress).then(result => {
      if (!(result && result.superseded)) progress(result)
      if (failure) throw failure
      return cancelled || result && result.superseded ? null : result
    })
    // A callback failure waits for the cancellation receipt too. The caller
    // must not refund work credit while the producer still owns its input.
    return {promise, cancel}
  }

  // Internal results own a temporary measurement loan. Callers adopt then close
  // it with releaseMeasurements; progress loans close when the callback returns.
  async planImagery(sequence, imagery, onProgress, planId) {
    const message = { stream: Boolean(onProgress), type: 'imagery', sequence, imagery, viewRevision: this.viewRevision,
      camera: Object.assign({}, this.camera, this.target), viewport: this.viewport,
      snapshot: this.getCameraSnapshot(), planId }
    const operation={interrupted:false}
    this.imageryOperations.add(operation)
    try {
      return await runImageryGrants(this,message,next=>this.send(next,[],onProgress),
        ()=>operation.interrupted,releaseMeasurements)
    } catch (error) {
      if (!this.destroyed) this.cancelImagery()
      if (error.status === 9 && this.imageryInputBudget)
        error.capacityRevision = this.imageryInputBudget.ledger.availabilityRevision
      throw error
    }finally{this.imageryOperations.delete(operation)}
  }

  cancelImagery(previous, next) {
    if (!previous && !next) {
      for(const operation of this.imageryOperations)operation.interrupted=true
      this.worker.postMessage({type: 'cancel-imagery', all: true})
      return
    }
    const signature = value => JSON.stringify(Object.assign({}, value,
      {visibility: undefined, admissionRevision: undefined}))
    const rebase = Boolean(previous && next && signature(previous) === signature(next))
    this.interruptImagery(rebase)
  }

  // End the RPC at a slice boundary while retaining compatible projection
  // work. The host validates the next candidate before reusing that snapshot.
  suspendImagery() { this.interruptImagery(true) }

  interruptImagery(rebase) {
    // One logical preparation spans many quote/grant RPCs. A cancellation can
    // cross the previous reply, or arrive while credit reclamation has no RPC.
    // Fence the complete operation before cancelling its current request.
    for(const operation of this.imageryOperations)operation.interrupted=true
    this.pending.forEach((pending, id) => {
      if (pending.type === 'imagery') this.worker.postMessage({type: 'cancel-imagery', id, rebase})
    })
  }

  async step(threshold, budget, frames, imagery) {
    this.setResourceLedger(frames.ledger)
    const client = this
    return produceMeshCandidate({
      generation:this.generation, nativeBudget:this.nativeBudget, indexBudget:this.indexBudget,
      get destroyed() {return client.destroyed},
      describe:() => this.requestTerrain({type:'step', threshold, budget, viewRevision:this.viewRevision,
        camera:Object.assign({},this.camera,this.target), viewport:this.viewport, generation:this.generation,
        residentIds:Array.from(frames.resources.keys()), needsIndices:!frames.indices, imagery}),
      reserveNativeWork:(...args) => this.reserveNativeWork(...args),
      replacement:(planId, maximumBytes) => this.send({type:'replacement',planId,maximumBytes}),
      select:(planId, groups) => this.send({type:'select-groups',planId,groups}),
      materialize:(packet, residentTextureIds) => this.send({type:'materialize',sequence:packet.sequence,
        planId:packet.nativePlan.id,maximumNativeBytes:packet.nativePlan.additionalBytes,
        maximumIndexBytes:packet.indexProducerBytes,residentTextureIds}),
      forecast:(sequence, options, planId) => this.planImagery(sequence,options,()=>{},planId),
      commit:planId => this.send({type:'commit-mesh',planId}),
      discardPlan:planId => this.send({type:'discard-plan',planId}),
      discardFrame:sequence => this.discardFrame(sequence)
    }, frames, imagery)
  }

  setResourceLedger(ledger) {
    this.measurementReceiver.setLedger(ledger)
    if (!this.indexBudget || this.indexBudget.ledger !== ledger) {
      common.invariant(!this.indexBudget || !this.indexBudget.actual && !this.indexBudget.credits.size,
        'Worker index ledger cannot change while occupied')
      const next = new NativePayloadBudget(ledger, 'terrain-index-worker', this.workerIndexBytes || 0)
      if (this.indexBudget) this.indexBudget.close()
      this.indexBudget = next
    }
    if (!this.imageryOutputBudget || this.imageryOutputBudget.ledger !== ledger) {
      common.invariant(!this.imageryOutputBudget || !this.imageryOutputBudget.credits.size,
        'Imagery output ledger cannot change during production')
      const next = new NativePayloadBudget(ledger, 'imagery-output-native', this.imageryOutputPayloadBytes())
      if (this.imageryOutputBudget) this.imageryOutputBudget.close()
      this.imageryOutputBudget = next
    }
    if (!this.imageryReferenceBudget || this.imageryReferenceBudget.ledger !== ledger) {
      common.invariant(!this.imageryReferenceBudget || !this.imageryReferenceBudget.credits.size,
        'Imagery reference ledger cannot change during production')
      const next = new NativePayloadBudget(ledger, 'imagery-reference-native', this.imageryReferencePayloadBytes(), {
        revision: () => this.imageryReferenceRevision,
        trim: needed => this.reclaimImageryReferences(needed),
        failed: error => { if (!this.destroyed && this.options.onError) this.options.onError(error) }
      })
      if (this.imageryReferenceBudget) this.imageryReferenceBudget.close()
      this.imageryReferenceBudget = next
    }
    if (!this.imageryInputBudget || this.imageryInputBudget.ledger !== ledger) {
      common.invariant(!this.imageryInputBudget || !this.imageryInputBudget.credits.size,
        'Imagery input ledger cannot change during production')
      const next = new NativePayloadBudget(ledger, 'imagery-input-native', this.imageryInputPayloadBytes(),{
        revision:()=>[this.nativeRevision,this.imageryReferenceRevision,this.measurementReceiver.sequence].join(':'),
        trim:needed=>this.reclaimMeasurementInputs(needed),
        failed:error=>{if(!this.destroyed&&this.options.onError)this.options.onError(error)}
      })
      if (this.imageryInputBudget) this.imageryInputBudget.close()
      this.imageryInputBudget = next
    }
    if (this.nativeBudget && this.nativeBudget.ledger !== ledger) {
      common.invariant(!this.nativeBudget.actual && !this.nativeBudget.credit,
        'Native mesh ledger cannot change while occupied')
      this.nativeBudget.close(); this.nativeBudget = null
    }
    if (!this.nativeBudget) this.nativeBudget = new NativeMeshBudget(ledger, this.nativeBytes || 0, {
      revision: () => this.nativeRevision,
      trim: needed => this.send({type: 'trim-native', needed}),
      failed: error => { if (!this.destroyed && this.options.onError) this.options.onError(error) }
    })
    common.invariant(this.nativeBudget.ledger === ledger, 'Native mesh ledger cannot change')
    if (!this.recordBudget || this.recordBudget.ledger !== ledger) {
      common.invariant(!this.recordBudget || !this.recordBudget.credits.size && !this.recordBudget.queue.pending.length,
        'Native record ledger cannot change during production')
      const next = new NativePayloadBudget(ledger, 'terrain-record-native', this.nativeRecordBytes || 0, {
        revision: () => this.nativeRevision,
        trim: needed => this.send({type: 'trim-records', needed}),
        failed: error => { if (!this.destroyed && this.options.onError) this.options.onError(error) }
      })
      if (this.recordBudget) this.recordBudget.close()
      this.recordBudget = next
    }
    if (!this.heightBudget || this.heightBudget.ledger !== ledger) {
      common.invariant(!this.heightBudget || !this.heightBudget.credits.size,
        'Native height ledger cannot change during production')
      const next = new NativePayloadBudget(ledger, 'terrain-height-native', this.nativeHeightBytes || 0, {
        revision: () => this.nativeRevision,
        trim: needed => this.send({type: 'trim-heights', needed}),
        failed: error => { if (!this.destroyed && this.options.onError) this.options.onError(error) }
      })
      if (this.heightBudget) this.heightBudget.close()
      this.heightBudget = next
    }
  }

  async reserveNativeWork(owner, bytes, acquire = () => this.nativeBudget.ledger.reserve(owner, bytes)) {
    let lease = acquire()
    if (!lease) { await this.nativeBudget.ledger.reclamation.pending; lease = acquire() }
    return lease
  }

  closeNativeBudget() {
    if (this.indexBudget) this.indexBudget.close()
    if (this.imageryOutputBudget) this.imageryOutputBudget.close()
    this.measurementReceiver.clear()
    if (this.imageryReferenceBudget) this.imageryReferenceBudget.close()
    if (this.nativeBudget) this.nativeBudget.close()
    if (this.recordBudget) this.recordBudget.close()
    if (this.heightBudget) this.heightBudget.close()
    if (this.imageryInputBudget) this.imageryInputBudget.close()
  }

  terminateProducer(error,graceful=false) {
    if (this.indexBudget) this.indexBudget.retire()
    this.measurementDelivery.retire()
    if (this.imageryOutputBudget) this.imageryOutputBudget.retire()
    if (this.imageryReferenceBudget) this.imageryReferenceBudget.retire()
    if (this.nativeBudget) this.nativeBudget.retire()
    if (this.recordBudget) this.recordBudget.retire()
    if (this.heightBudget) this.heightBudget.retire()
    if (this.imageryInputBudget) this.imageryInputBudget.retire()
    const completed = () => {
      this.lastMemoryBytes = 0
      this.workerIndexBytes = 0
      this.nativeImageryBytes = this.nativeImageryInputBytes = this.nativeImageryReferenceBytes = this.nativeImageryOutputBytes = 0
      try {this.closeNativeBudget()}finally{this.fail(error)}
      if(this.measurementDelivery.pendingBytes())throw new Error('Measurement transfer has no complete release receipt')
    }
    const terminate=()=>{
      let result
      try {result=this.worker.terminate()}
      catch(failure){this.fail(error);return Promise.reject(failure)}
      if(result&&typeof result.then==='function')return result.then(completed,failure=>{this.fail(error);throw failure})
      try{completed();return Promise.resolve()}catch(failure){return Promise.reject(failure)}
    }
    // Browser termination is synchronous; Node/platform adapters can return
    // an explicit termination receipt. Rejected RPCs do not refund producers.
    if(graceful&&this.measurementDelivery.pendingBytes()) {
      const stopped=new Promise((resolve,reject)=>{
        this.mirrorStopResolve=resolve
        this.mirrorStopTimer=setTimeout(()=>{this.mirrorStopResolve=null;reject(new Error('Measurement stop receipt timed out'))},this.options.workerTimeoutMs||30000)
        try{this.worker.postMessage({type:'measurement-stop'})}
        catch(failure){clearTimeout(this.mirrorStopTimer);this.mirrorStopResolve=null;reject(failure)}
      })
      this.termination=stopped.then(terminate,failure=>{this.measurementStopError=failure;return terminate()})
    }else this.termination=terminate()
    if(this.termination)this.termination.catch(failure=>{
      // A failed receipt rejects callers but retains producer credit. An app's
      // reporting callback must not introduce another unhandled rejection.
      try {if(this.options.onError)this.options.onError(failure)}
      catch(reportError){this.terminationReportError=reportError}
    })
    return this.termination
  }

  requestTerrain(message) {
    common.invariant(this.heightBudget, 'Terrain production requires a shared ledger')
    let workId
    return runHeightWork(async bytes => {
      const result = await this.send(workId === undefined ? message
        : {type: 'terrain-continue', workId, heightCreditBytes: bytes})
      if (result.heightPending) {
        common.invariant(Number.isSafeInteger(result.workId) && result.workId > 0,
          'Invalid terrain work identity')
        workId = result.workId
      } else workId = undefined
      return result
    }, this.heightBudget, () => workId !== undefined && !this.destroyed
      ? this.send({type: 'terrain-cancel', workId}) : undefined)
  }

  advanceTerrain(threshold, budget) {
    return this.requestTerrain({type: 'advance', threshold, budget, viewRevision: this.viewRevision,
      camera: Object.assign({}, this.camera, this.target), viewport: this.viewport})
  }

  destroy() {
    if (this.destroyed) return this.termination
    this.destroyed = true
    return this.terminateProducer(new Error('Terrain Worker is destroyed'),true)
  }
}

module.exports = { TerrainWorkerClient }
