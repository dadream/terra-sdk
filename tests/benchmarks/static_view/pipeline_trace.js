'use strict'

// Opt-in observation of the real producer. Keep only IDs/times/counters, never
// payload ownership; no additional timers, GPU queries, requests or retries.
function installPipelineTrace(renderer, now, bitmapHost = typeof window === 'object' ? window : null) {
  const trace = {schema:'terra.static-pipeline.v1', limit:4096, truncated:false,
    images:[], transport:[], attempts:[], batches:[], groups:[], worlds:[], goals:[], demands:[],
    demandKeys:0, demandKeyLimit:65536, samples:[], work:{}}
  const restores = [], reservations = new WeakMap(), assets = new WeakMap(), images = new WeakMap()
  const attempts = new Map(), latest = new Map(), batches = new WeakMap(), groups = new WeakMap()
  const blobs = new WeakMap()
  const worlds = new WeakMap()
  const store = renderer.textures
  let closed = false
  const append = (name, row) => {
    if (closed) return null
    if (trace[name].length >= trace.limit) {trace.truncated = true; return null}
    trace[name].push(row); return row
  }
  const wrap = (object, name, operation) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, name), original = object[name]
    if (typeof original !== 'function') throw Error('Missing trace boundary: ' + name)
    object[name] = function(...args) { return operation.call(this, original, args) }
    restores.push(() => {
      if (descriptor) Object.defineProperty(object, name, descriptor)
      else delete object[name]
    })
  }
  const groupRow = group => {
    if (!group || groups.has(group)) return groups.get(group)
    const row = append('groups', {kind:group.future?'imagery':'display',
      keys:group.future?Array.from(group.future.keys()):[], startedMs:now()})
    if (row) groups.set(group, row)
    return row
  }
  const groupState = group => group ? {
    kind:group.future?'imagery':'display',
    phase:group.task?(group.selection?'selection':'pricing'):
      group.pending&&group.pending.size?'outputs':'receipts',
    funded:Boolean(group.pool), pendingOutputs:group.pending?group.pending.size:0,
    outputBytes:group.pool?group.pool.output.bytes:0,
    workspaceBytes:group.workspace?group.workspace.bytes:0,
    workspaceAvailableBytes:group.workspace?group.workspace.availableBytes:0
  } : null
  const work = (name, start) => {
    const key = name + ':' + Math.floor(start / 1000)
    const row = trace.work[key] || (trace.work[key] = {name, second:Math.floor(start / 1000), count:0, wallMs:0, maxMs:0})
    const duration = now() - start
    ++row.count; row.wallMs += duration; row.maxMs = Math.max(row.maxMs, duration)
    return row
  }
  if (bitmapHost && typeof bitmapHost.createImageBitmap === 'function') {
    wrap(bitmapHost, 'createImageBitmap', function(fn, args) {
      const row = blobs.get(args[0])
      if (row) row.bitmapCalledMs = now()
      const result = fn.apply(this, args)
      if (row) result.then(() => {if (!closed) row.bitmapObservedMs = now()},
        () => {if (!closed) row.bitmapFailedMs = now()})
      return result
    })
  }
  if (bitmapHost && typeof bitmapHost.fetch === 'function') {
    wrap(bitmapHost, 'fetch', function(fn, args) {
      const row=append('transport',{path:String(args[0]).split('?')[0],requestedMs:now()})
      const result=fn.apply(this,args)
      if(row)result.then(response=>{if(!closed){row.headersMs=now();row.status=response.status}},
        error=>{if(!closed){row.failedMs=now();row.failure=error.name||'Error'}})
      return result
    })
  }
  wrap(renderer, 'advanceResources', function(fn, args) {
    const start = now()
    try {return fn.apply(this, args)} finally {work('resources', start)}
  })
  wrap(renderer, 'prepareResources', function(fn, args) {
    const start = now()
    try {return fn.apply(this, args)} finally {work(args[0] ? 'prepareDisplay' : 'prepareResources', start)}
  })
  const tileId = tile => tile && [tile.level,tile.matrix,tile.row,tile.column].join('/')
  let demand = null, demandContext = null, demandTargets = new Map(), demandTruncated = false
  const has = (values, key) => Boolean(values && values.has(key))
  const recordDemand = draws => {
    if (closed || demandTruncated) return
    const current = renderer.current || {}, plan = current.imageryPlan || {}, quality = plan.quality || {}
    const context = {camera:renderer.cameraVersion, plannedCamera:renderer.plannedCameraVersion,
      source:store.generation, sequence:current.frame && current.frame.sequence, planRevision:plan.revision,
      preview:quality.measurementPending===true, complete:quality.planningComplete===true,
      fitted:quality.spatialCut===true, demandReady:quality.demandReady===true,
      refinable:quality.refinableMeasurementCount, rebuilding:quality.rebuilding===true,
      maxError:quality.measuredMaxPixelError, targetError:quality.targetPixelError}
    // Preserve per-target proof even when a preview keeps another mesh's
    // fitted rows. No geometry, image data or measurement regions are retained.
    const targets = new Map(Array.from(store.targetDesired || [], ([key]) => [key,0]))
    for (const draw of draws || []) {
      const key = tileId(draw.texture)
      if (!targets.has(key)) continue
      const fitted = Number.isInteger(renderer.cameraVersion) && draw.imageryDemandView===renderer.cameraVersion &&
        draw.imageryPixelError!==undefined
      const coverage = Number.isInteger(renderer.cameraVersion) && draw.imageryDemandView===renderer.cameraVersion &&
        draw.imageryCoverageBound
      targets.set(key, targets.get(key) | (fitted?1:coverage?4:2))
    }
    const added = [], removed = []
    for (const [key, flags] of targets) if (demandTargets.get(key)!==flags) added.push([key,flags])
    for (const key of demandTargets.keys()) if (!targets.has(key)) removed.push(key)
    const signature = JSON.stringify(context)
    if (signature===demandContext && !added.length && !removed.length) return
    if (trace.demandKeys+added.length+removed.length > trace.demandKeyLimit || trace.demands.length>=trace.limit) {
      trace.truncated=demandTruncated=true;demand=null;demandTargets.clear();return
    }
    demand=append('demands',{id:trace.demands.length,timeMs:now(),...context,added,removed,targets:targets.size})
    trace.demandKeys+=added.length+removed.length;demandTargets=targets;demandContext=signature
  }
  wrap(store, 'buildRequirementTree', function(fn, args) {
    const result=fn.apply(this,args);recordDemand(args[0]);return result
  })
  recordDemand(renderer.renderDraws)
  const drawId = d => [d.geometryKey,tileId(d.sourceTexture||d.texture),d.textureResourceId||0,
    d.resourceId||0,d.firstIndex,d.indexCount,d.vertexCount,d.flags||0,...d.origin,
    tileId(d.texture),!!d.imageryCapacityCoarsened].join(':')
  wrap(renderer, 'setImageryPlan', function(fn, args) {
    const before = this.renderDraws.map(drawId), result = fn.apply(this, args)
    if (!result) return result
    const after = this.renderDraws.map(drawId), counts = new Map()
    for (const id of before) counts.set(id,(counts.get(id)||0)+1)
    let added = 0
    for (const id of after) {
      if (counts.get(id)) counts.set(id,counts.get(id)-1)
      else ++added
    }
    append('goals', {timeMs:now(), before:before.length, after:after.length, added,
      removed:Array.from(counts.values()).reduce((a,b)=>a+b,0),
      sameOrder:before.length===after.length&&before.every((id,i)=>id===after[i]),
      preview:Boolean(args[1].quality.measurementPending), complete:Boolean(args[1].quality.planningComplete)})
    return result
  })
  const world = renderer.worldDisplay
  let admission = null
  wrap(world, 'targetState', function(fn, args) {
    const start=now(), result=fn.apply(this,args), row=work('worldAdmission',start)
    if(admission)admission.world=result
    if(result==='ready'&&args[0]) {
      const record=this.records.find(value=>value.aliases.has(renderer.renderDraws))
      if(!this.demandPrepared(record))row.scopedReady=(row.scopedReady||0)+1
    }
    return result
  })
  wrap(world, 'start', function(fn, args) {
    const result = fn.apply(this, args), job = this.job
    if (result && job) {
      const row = append('worlds', {startedMs:now(), goalRevision:job.record.goalRevision,
        draws:job.draws.length, sources:job.sourceDraws.length, stamp:job.stamp})
      if (row) worlds.set(job, row)
    }
    return result
  })
  wrap(world, 'advanceWork', function(fn, args) {
    const start = now(), allowance = Math.max(0, args[0] - this.now())
    try {return fn.apply(this, args)} finally {
      const row = work('world', start)
      row.allowanceMs = (row.allowanceMs || 0) + allowance
      row.exhausted = (row.exhausted || 0) + Number(allowance === 0)
    }
  })
  wrap(world, 'install', function(fn, args) {
    const job = args[0], row = worlds.get(job)
    if (row) Object.assign(row, {installedMs:now(), currentStamp:this.signature(job.record),
      currentGoalRevision:job.record.goalRevision, rows:args[1].rows.length})
    return fn.apply(this, args)
  })
  wrap(world, 'closeJob', function(fn, args) {
    const row = worlds.get(this.job)
    if (row) Object.assign(row, {closedMs:now(), cancelled:Boolean(args[0])})
    return fn.apply(this, args)
  })
  wrap(store, 'reserveRequest', function(fn, args) {
    const key = args[0]
    let row = attempts.get(key)
    if (!row) {
      row = append('attempts', {key, firstMs:now(), refused:{}})
      if (row) attempts.set(key, row)
    }
    const result = fn.apply(this, args)
    if (result) reservations.set(result, key)
    else if (row) {
      const reason = this.preparationWaiting.has(key) ? 'preparation' :
        this.inputBlocked.has(key) ? 'input' : 'other'
      row.refused[reason] = (row.refused[reason] || 0) + 1
      row.lastRefusedMs = now()
    }
    return result
  })
  wrap(store, 'requestAsset', function(fn, args) {
    const key=reservations.get(args[1])
    const row = append('images', {key, requestMs:now(), demandId:demand&&demand.id,
      target:has(store.targetDesired,key), targetFlags:demandTargets.get(key),
      coverage:has(store.coverageKeys,key), root:has(store.currentRoots,key), forecast:has(store.forecastTargets,key),
      candidate:Boolean(store.candidateDemands&&Array.from(store.candidateDemands).some(value=>value.pendingKeys.has(key)))})
    if (row) latest.set(row.key, row)
    const result = fn.apply(this, args)
    if (row) result.promise.then(asset => {
      if (closed) return
      row.bodyMs = now(); assets.set(asset, row)
      if (asset.blob) blobs.set(asset.blob, row)
    }, error => {if (!closed) {row.failedMs = now(); row.failure = error.name || 'Error'}})
    return result
  })
  wrap(store, 'prepareAsset', function(fn, args) {
    const before = this.preparations.get(args[1]), result = fn.apply(this, args), task = this.preparations.get(args[1])
    const row = assets.get(args[1].value)
    if (row && task && task !== before && task.entry === args[1]) row.decodeStartMs = now()
    return result
  })
  wrap(store, 'finishPreparation', function(fn, args) {
    const asset = args[0].entry.value, row = assets.get(asset)
    if (row && asset.image) {row.decodedMs = now(); images.set(asset.image, row)}
    return fn.apply(this, args)
  })
  wrap(renderer, 'uploadTexture', function(fn, args) {
    const row = images.get(args[0])
    if (!row) return fn.apply(this, args)
    const publish = args[3], cancel = args[4]
    args[3] = function(...values) {if (!closed) row.gpuMs = now(); return publish.apply(this, values)}
    args[4] = function(...values) {if (!closed) row.cancelledUploadMs = now(); return cancel.apply(this, values)}
    const submitted = now(), result = fn.apply(this, args)
    if (result !== false) row.uploadMs = submitted
    else row.rejectedUploads = (row.rejectedUploads || 0) + 1
    return result
  })
  wrap(renderer.submissions, 'submit', function(fn, args) {
    const batch = args[0], labels = {}
    for (const item of batch.items) labels[item.label] = (labels[item.label] || 0) + 1
    const result = fn.apply(this, args)
    if (this.batches.includes(batch)) {
      const row = append('batches', {submittedMs:now(), drawn:Boolean(args[1]), labels,
        budget:batch.budget ? {...batch.budget} : null})
      if (row) batches.set(batch, row)
    }
    return result
  })
  wrap(renderer.submissions, 'poll', function(fn, args) {
    const complete = args[0]
    args[0] = function(batch) {
      const row = batches.get(batch)
      if (row && !closed) row.completedMs = now()
      return complete.apply(this, arguments)
    }
    return fn.apply(this, args)
  })
  wrap(renderer, 'renderSurface', function(fn, args) {
    const start = now(), result = fn.apply(this, args)
    work('render', start)
    if (this.surfaceDrawn) for (const key of this.presentedTextures.keys()) {
      const row = latest.get(key)
      if (row && row.gpuMs !== undefined && row.displayMs === undefined) row.displayMs = now()
    }
    return result
  })
  wrap(renderer.partitionGroups, 'prepareImagery', function(fn, args) {
    const start=now(),previous=admission,plan=renderer.meshOutputPlan
    const call=admission={privatePlan:Boolean(plan&&!plan.accepted),handoff:Boolean(plan&&plan.accepted)}
    let result
    try {result=fn.apply(this,args);groupRow(this.current);return result}
    finally {
      const row=work('imageAdmission',start),state=result||'error'
      row[state]=(row[state]||0)+1
      if(call.privatePlan)row['private_'+state]=(row['private_'+state]||0)+1
      if(call.handoff)row['handoff_'+state]=(row['handoff_'+state]||0)+1
      if(call.world)row['world_'+call.world]=(row['world_'+call.world]||0)+1
      // These are overlapping observations, not exclusive critical-path
      // causes. Inspect the state after the real refresh, without querying or
      // advancing readiness a second time from the observer.
      if(state==='waiting'&&call.current&&call.current===this.current) {
        const label='waiting_with_'+call.group.kind+'_'+call.group.phase
        row[label]=(row[label]||0)+1
      }
      if(state==='waiting'&&call.active)row.waiting_with_uv_producer=(row.waiting_with_uv_producer||0)+1
      if(state==='waiting'&&call.uploads)row.waiting_with_uv_upload=(row.waiting_with_uv_upload||0)+1
      admission=previous
    }
  })
  wrap(renderer.partitionGroups, 'refresh', function(fn, args) {
    const result=fn.apply(this,args)
    if(admission)Object.assign(admission,{current:this.current,group:groupState(this.current),
      active:Boolean(renderer.partitionActive),uploads:renderer.partitionUploads.length})
    return result
  })
  wrap(renderer.partitionGroups, 'price', function(fn, args) {
    const row = groupRow(args[0]); if (row) row.selectionMs = now()
    return fn.apply(this, args)
  })
  wrap(renderer.partitionGroups, 'fund', function(fn, args) {
    const result = fn.apply(this, args), group=args[0], row = groupRow(group)
    if (row && group.pool) row.fundedMs = now()
    else if(row) {
      const sizes=Array.from(group.pending.values()),bytes=sizes.reduce((a,b)=>a+b,0),minimum=sizes.reduce((a,b)=>Math.max(a,b),0)
      row.unfunded=(row.unfunded||0)+1
      row.partitionShortfallBytes=Math.max(row.partitionShortfallBytes||0,bytes+minimum-renderer.partitionCapacityBytes,
        renderer.partitionBytes+renderer.partitionReservedBytes+renderer.partitionCpuBytes+bytes+minimum-renderer.partitionCapacityBytes)
      row.sharedShortfallBytes=Math.max(row.sharedShortfallBytes||0,
        store.capacityPressure&&store.capacityPressure.shortfallBytes||0)
    }
    return result
  })
  wrap(renderer.partitionGroups, 'release', function(fn, args) {
    const group=args[0]||this.current,row=groupRow(group)
    if(row&&row.releaseRequestedMs===undefined) {
      row.releaseRequestedMs=now();row.stateAtRelease=groupState(group)
    }
    const result=fn.apply(this,args)
    if(row&&!group.task)row.releasedMs=now()
    return result
  })
  return {
    trace,
    sample() {
      const counts = {encoded:0, ready:0, uploading:0, gpu:0}
      for (const entry of store.cache.entries.values()) {
        const asset = entry.value
        ++counts[asset.texture ? 'gpu' : asset.uploading ? 'uploading' : asset.image ? 'ready' : 'encoded']
      }
      const record = world.records.find(value => value.aliases.has(renderer.renderDraws))
      append('samples', {timeMs:now(), demandId:demand&&demand.id, ...counts, decoding:store.preparations.size,
        requests:store.scheduler.active.size, queued:store.scheduler.queued.size,
        waitingPreparation:store.preparationWaiting.size, waitingInput:store.inputBlocked.size,
        waitingBodies:store.inputQueue?store.inputQueue.pending.length:0,
        inputWorkspaceBytes:store.workspace?store.workspace.bytes:0,
        inputWorkspaceAvailableBytes:store.workspace?store.workspace.availableBytes:0,
        partitions:renderer.partitionQueue.length, partitionUploads:renderer.partitionUploads.length,
        group:Boolean(renderer.partitionGroups.current), worldPreparing:Boolean(renderer.worldDisplay.job),
        worldDemandReady:world.demandPrepared(record), worldStats:{...world.stats},
        meshOutputPlan:Boolean(renderer.meshOutputPlan),
        meshOutputAccepted:Boolean(renderer.meshOutputPlan&&renderer.meshOutputPlan.accepted),
        partitionActive:Boolean(renderer.partitionActive),
        groupState:groupState(renderer.partitionGroups.current),
        managedBytes:renderer.resourceLedger.bytes,managedMaximumBytes:renderer.resourceLedger.maximumBytes,
        partitionBytes:renderer.partitionBytes,partitionReservedBytes:renderer.partitionReservedBytes,
        partitionCpuBytes:renderer.partitionCpuBytes,partitionCapacityBytes:renderer.partitionCapacityBytes,
        maximumInputBytes:store.maximumInputBytes,maximumPipelineBytes:store.maximumPipelineBytes,
        inputHighWaterBytes:store.inputHighWaterBytes,
        renderRequested:renderer.renderRequested, resourcesRequested:renderer.resourcesRequested,
        inputBytes:store.inputBytes, pipelineBytes:store.pipelineBytes(),
        uploads:renderer.submissions.uploading, display:renderer.submissions.batches.some(batch => batch.drawn)})
    },
    close() {if (!closed) {closed = true; restores.reverse().forEach(restore => restore())}}
  }
}
if (typeof module !== 'undefined') module.exports = {installPipelineTrace}
else window.TerraStaticPipeline = {installPipelineTrace}
