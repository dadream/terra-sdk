const {textureKeyString:key} = require('../../sdk/js/core/terra_globe_common')
const {parentTextureTile,textureTileContains} = require('../../sdk/js/imagery/terra_texture_tiles')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {Cleanup} = require('../../sdk/js/runtime/cleanup')
const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')
const {MeasurementRows} = require('../../sdk/js/terrain/measurement_rows')
const {ImageryPresentation} = require('../../sdk/js/imagery/terra_imagery_presentation')
const {PartitionPublication} = require('./partition_publication')
const {imageryDrawWork} = require('./imagery_draws')
const {terrainSourceDraws,completeWorldInputs,captureWorldView} = require('./world_display_inputs')
const {coarseningCutRows} = require('./world_coarsening_cut')
const {WorldDemandIndex} = require('./world_demand_index')
const {monotonicNow}=require('../../sdk/js/diagnostics/timing')

const tileCopy=t=>t&&({level:t.level,matrix:t.matrix,row:t.row,column:t.column})
const partReady=(geometry,d)=>!d.imageryClipCell||d.imageryDirectClip||
  geometry.partitions.has(d.imageryIndexCell||key(d.texture))
// Mesh buffers are local to immutable resource IDs. firstVertex is only a
// per-packet transfer offset and cannot version persistent world sources.
function sourceKey(d) {
  return [d.geometryKey,key(d.sourceTexture||d.texture),d.textureResourceId||0,
    d.resourceId||0,d.firstIndex,d.indexCount,d.vertexCount,d.flags||0,...d.origin].join(':')
}
function sameSources(a,b) {
  if(a===b)return true
  const left=new Set(a.map(sourceKey)),right=new Set(b.map(sourceKey))
  return left.size===right.size&&Array.from(right).every(id=>left.has(id))
}
function sameInputs(a,b) {
  return a===b||a.length===b.length&&a.every((d,i)=>sourceKey(d)===sourceKey(b[i])&&
    key(d.texture)===key(b[i].texture)&&!!d.imageryCapacityCoarsened===!!b[i].imageryCapacityCoarsened)
}
const inputKey=d=>sourceKey(d)+':'+key(d.texture)+':'+Number(!!d.imageryCapacityCoarsened)
function copyRow(d) {
  const row={}
  for(const name of ['geometryKey','resourceId','textureResourceId','workerGeneration','flags',
    'fragment','vertexCount','firstIndex','indexCount','imageryCellScale',
    'imageryCellOffsetX','imageryCellOffsetY','imageryClipCell','imageryDirectClip',
    'imageryHandover','imageryCapacityCoarsened'])if(d[name]!==undefined)row[name]=d[name]
  row.origin=Array.from(d.origin)
  if(d.key)row.key={level:d.key.level,i:d.key.i,j:d.key.j,k:d.key.k}
  for(const name of ['texture','sourceTexture','imageryTarget'])row[name]=tileCopy(d[name])
  row.imageryIndexCell=d.imageryIndexCell
  return row
}
function sameFootprint(left,right,presentation) {
  return left.length===right.length&&left.every((a,i)=>{
    const b=right[i]
    return sourceKey(a)===sourceKey(b)&&key(a.texture)===key(b.texture)&&
      key(a.imageryTarget||a.texture)===key(b.imageryTarget||b.texture)&&
      a.imageryGroup===presentation.group(b.texture,b.imageryTarget||b.texture)&&
      ['imageryCellScale','imageryCellOffsetX','imageryCellOffsetY','imageryClipCell',
        'imageryDirectClip','imageryIndexCell','imageryHandover','imageryCapacityCoarsened']
        .every(name=>a[name]===b[name])
  })
}
function visible(r,draw) {
  if(r.terrainBoundImagery)return true
  const m=r.measureDraw(draw)
  if(m.visible===false)return false
  if(!m.regions)return true
  const s=draw.imageryCellScale||1,x=draw.imageryCellOffsetX||0,y=draw.imageryCellOffsetY||0
  const loU=-x/s,loV=-y/s,hiU=(1-x)/s,hiV=(1-y)/s
  return m.regions instanceof MeasurementRows?m.regions.intersects(loU,loV,hiU,hiV):
    m.regions.some(({uv:b})=>b.maximumU>loU&&b.minimumU<hiU&&b.maximumV>loV&&b.minimumV<hiV)
}

// World cuts survive camera frames. CPU topology and UV demand advance only on
// the resource clock; the display borrows ready cuts and applies a live mask.
class WorldDisplayPlan {
  constructor(renderer, now = monotonicNow) {
    this.renderer=renderer;this.records=[];this.entries=new Map();this.pending=new Set()
    this.now=now;this.workCursor=0
    this.stats={builds:0,slices:0,completed:0,cancelled:0,refused:0,reused:0,sourceFallbacks:0,prepaidInstalls:0}
    this.serial=0;this.publicationRevision=0;this.residentBytes=0
  }
  meshPlanFor(record) {
    const r=this.renderer,plan=r.meshOutputPlan
    // Future terrain pricing shares the broker, not this display's lifetime.
    // Old submitted records also cannot inherit a new model's handoff plan.
    return plan&&plan.accepted&&plan.valid()&&(!record||record.aliases.has(r.renderDraws))?plan:null
  }
  pressureState() {
    const r=this.renderer,store=r.textures,handover=r.capacityHandover||new Map()
    const quality=r.current&&r.current.imageryPlan&&r.current.imageryPlan.quality||{}
    if(!handover.size&&!store.blockedByCapacity&&!store.admissionBlocked.size&&!quality.coarsening)return 0
    const roots=Array.from(store.currentRoots.keys(),id=>id+'='+Number(store.gpuReady(id))).sort()
    const targets=Array.from(handover,([id,tile])=>{
      const fallback=key(store.presentationTileFor(tile))
      return id+'='+fallback+'='+Number(store.gpuReady(fallback))
    }).sort()
    return 'pressure:'+roots.join('|')+':'+targets.join('|')
  }
  demandSignature(record, goalRevision = record&&record.goalRevision||0) {
    const r=this.renderer
    const plan=this.meshPlanFor(record)
    const quality=r.current&&r.current.imageryPlan&&r.current.imageryPlan.quality||{}
    return [r.plannedCameraVersion,r.plannedCameraVersion===r.cameraVersion,
      r.partitionGeneration,r.mode,
      !!quality.coarsening,!!quality.planningComplete,r.options.imageryPixelError||1.25,
      this.pressureStamp||0,goalRevision,
      plan?plan.planId:0,
      r.presentationBridges.map(key).join('|')].join(':')
  }
  signature(record) {
    return this.demandSignature(record)+':'+this.renderer.presentation.settledCoarseningRevision
  }
  demandPrepared(record, members) {
    // A completed fade can compact an already complete UV layout. Until that
    // successor is ready, the finer paid footprint still funds the same image
    // demand. Camera, source, goals, pressure and mesh handoff keep their proof.
    if(!record||!record.aliases.has(this.renderer.renderDraws)||!this.valid(record)||!record.publication)return false
    if(record.demandStamp===this.demandSignature(record))return true
    // A different region's refinement cannot revoke an unchanged image group's
    // paid complete mesh footprint. Camera/source/pressure/handoff changes do
    // revoke it. Keep row order within a mesh; independent meshes may reorder.
    if(!members||record.demandContext!==this.demandSignature(record,0))return false
    const index=record.demandIndex
    return Boolean(index&&index.complete&&index.revision===record.goalRevision&&
      Array.from(members).every(id=>!index.badMeshes.has(id)&&record.cuts.has(id)))
  }
  request(draws) {
    if(!draws||!draws.length)return null
    let record=this.records.find(value=>value.aliases.has(draws))
    if(!record) {
      // A newer goal array must not hide an already prepared terrain source
      // until collect() runs. Read only the existing normalized source memo;
      // goal admission and comparison still belong to the resource clock.
      const r=this.renderer,surface=this.sourceSurface(draws),memo=surface&&surface.imagerySourceState
      const descriptor=r.options.textureDescriptor
      const offset=Number.isInteger(descriptor&&descriptor.matrix_level_offset)?descriptor.matrix_level_offset:0
      if(memo&&memo.draws===surface.draws&&memo.offset===offset)
        record=this.records.find(value=>value.sourceDraws===memo.value&&this.valid(value))
      if(!this.pending.has(draws)){this.pending.add(draws);r.requestResources()}
    }
    return record
  }
  sourceSurface(draws) {
    // The visible imagery list can change before a bounded job finishes. Its
    // immutable terrain cut supplies identity and the complete coverage scope.
    const r=this.renderer
    if(draws===r.renderDraws)return r.current
    if(r.displaySurface&&draws===r.displaySurface.renderDraws)return r.displaySurface.current
    if(r.preparedSurfaceSource===r.current&&r.preparedSurface&&draws===r.preparedSurface.renderDraws)
      return r.preparedSurface.current
    return null
  }
  sourceDraws(draws) {
    const surface=this.sourceSurface(draws)
    if(!surface)throw new Error('World display source is not registered')
    return terrainSourceDraws(surface,this.renderer.options.textureDescriptor)
  }
  collect() {
    const r=this.renderer,used=new Set([r.renderDraws,
      r.displaySurface&&r.displaySurface.renderDraws,
      r.preparedSurfaceSource===r.current&&r.preparedSurface&&r.preparedSurface.renderDraws].filter(Boolean))
    let checkedGoals=false
    for(const draws of this.pending)if(used.has(draws)) {
      const sourceDraws=this.sourceDraws(draws)
      let record=this.records.find(value=>sameSources(value.sourceDraws,sourceDraws))
      if(record){
        if(!sameInputs(record.draws,draws))++record.goalRevision
        record.sourceDraws=sourceDraws
        record.aliases.add(draws);++this.stats.reused
      }
      else this.records.push({draws,sourceDraws,goalRevision:0,aliases:new Set([draws]),cuts:new Map(),coarseCuts:new Map(),
        generation:r.partitionGeneration,source:r.textures.generation})
      if(draws===r.renderDraws)checkedGoals=true
    }
    this.pending.clear()
    for(const record of [...this.records]) {
      for(const alias of record.aliases)if(!used.has(alias))record.aliases.delete(alias)
      if(!record.aliases.size)this.releaseRecord(record)
      else record.draws=record.aliases.has(r.renderDraws)?r.renderDraws:record.aliases.values().next().value
    }
    const plan=this.meshPlanFor(),prepared=plan&&plan.preparedWorld
    if(prepared) {
      const record=this.records.find(value=>value.aliases.has(r.renderDraws)&&
        sameSources(value.sourceDraws,prepared.sourceDraws))
      if(record) {
        // This receipt funds coverage of the accepted immutable mesh cut. It
        // does not certify a newer camera's precision or image demand.
        prepared.record=record;prepared.stamp=this.signature(record);prepared.demandStamp=null
        this.install(prepared,prepared.result)
        record.handoffPlanId=plan.planId
        ++this.stats.prepaidInstalls
        plan.preparedWorld=null
      }
    }
    const sources=new Set()
    for(const draws of used)for(const draw of draws)sources.add(draw.geometryKey)
    for(const [id,entry]of this.entries)if(!r.geometryPinnedKeys.has(id)||!sources.has(id))this.releaseEntry(id,entry)
    // Collection can restore the complete receipt or enable a scoped index.
    // Wake a waiter parked before these goals reached the resource clock.
    if(checkedGoals&&r.textures.preparationWaiting&&r.textures.preparationWaiting.size) {
      const record=this.records.find(value=>value.aliases.has(r.renderDraws))
      if(this.demandPrepared(record)||record&&record.publication&&this.valid(record)&&
          record.demandContext===this.demandSignature(record,0))r.partitionGroups.wakeImagery()
    }
  }
  valid(record) {
    const r=this.renderer
    return !record.closed&&!r.destroyed&&!r.contextLost&&!r.paused&&r.mode==='texture'&&
      record.generation===r.partitionGeneration&&record.source===r.textures.generation
  }
  start(record) {
    const r=this.renderer,stamp=this.signature(record)
    if(record.refusedAt===r.resourceLedger.availabilityRevision+':'+stamp)return false
    const credit=r.resourceLedger.reserve('display-cut-work',1024)
    if(!credit){record.refusedAt=r.resourceLedger.availabilityRevision+':'+stamp;++this.stats.refused;return false}
    const job={record,draws:record.draws,sourceDraws:record.sourceDraws,
      credit,used:1024,releases:[],stamp,demandStamp:this.demandSignature(record),
      demandContext:this.demandSignature(record,0),
      camera:r.cameraVersion,source:r.textures.generation,
      meshPlan:this.meshPlanFor(record)}
    const account=bytes=>{
      job.used+=bytes
      if(job.used<=credit.bytes)return
      const free=r.resourceLedger.maximumBytes?Math.max(0,r.resourceLedger.maximumBytes-r.resourceLedger.bytes):65536
      if(!credit.resize(credit.bytes+Math.max(job.used-credit.bytes,Math.min(65536,free))))
        throw Object.assign(new Error('Display cut workspace is not funded'),{status:9})
    }
    // These checkpoints describe cheap map/cell operations, not terrain
    // topology changes. Spend the shared host deadline instead of yielding
    // after an arbitrary count while most of its CPU window is still free.
    job.task=new CooperativeTask(this.build(job,account),Infinity,this.now)
    this.job=job;++this.stats.builds;return true
  }
  *build(job,account) {
    const r=this.renderer
    const view=yield* captureWorldView(r,job.sourceDraws,account,job.releases)
    const inputs=yield* completeWorldInputs(job.draws,job.sourceDraws,account)
    const presentation=new ImageryPresentation(r.presentation.duration)
    presentation.cells=view.presentation.cells
    yield* presentation.beginFrameWork(0,account)
    const handover=new Map(view.capacityHandover)
    let rows
    if(job.meshPlan)
      rows=yield* job.meshPlan.drawsWork(inputs,view,account)
    else rows=yield* imageryDrawWork(view,inputs,view.textures,presentation,handover,{world:true,reserve:account})
    return yield* this.buildCuts(job,rows,presentation,handover,account)
  }
  *buildCuts(job,rows,presentation,handover,account) {
    const r=this.renderer,sources=new Map(),incoming=new Map(),priors=new Map(),reused=new Map()
    const goals=new Map()
    for(const draw of job.draws||[]) {
      yield
      const value=inputKey(draw)
      account(128+value.length*2)
      if(!goals.has(draw.geometryKey))goals.set(draw.geometryKey,[])
      goals.get(draw.geometryKey).push(value)
    }
    for(const draw of job.sourceDraws) {
      yield
      if(draw.flags&1)continue
      const value=sourceKey(draw)
      account(192+value.length*2)
      if(!sources.has(draw.geometryKey))sources.set(draw.geometryKey,new Set())
      sources.get(draw.geometryKey).add(value)
    }
    for(const draw of rows) {
      yield;account(16)
      if(!incoming.has(draw.geometryKey))incoming.set(draw.geometryKey,[])
      incoming.get(draw.geometryKey).push(draw)
    }
    const publication=new PartitionPublication(id=>r.geometry.get(id),id=>r.textures.gpuReady(id),d=>d.imageryGroup)
    const stored=[]
    for(const [id,items]of incoming) {
      yield;account(192)
      const entry=this.entries.get(id),prior=entry&&entry.current,keys=sources.get(id)
      if(prior) {
        job.releases.push(prior.ownership.hold());priors.set(id,prior)
        if(!handover.size&&!prior.pressure&&!prior.coarsening.length&&
            prior.rows.every(row=>row.imageryPublicationState&&row.imageryPublicationState.ready)&&
            prior.sources.size===keys.size&&Array.from(keys).every(value=>prior.sources.has(value))&&
            sameFootprint(prior.rows,items,presentation))reused.set(id,prior)
      }
      if(reused.has(id))for(const row of prior.rows){yield;stored.push(row)}
      else for(const draw of items) {
        yield;account(896)
        const row=copyRow(draw)
        row.imageryGroup=presentation.group(row.texture,row.imageryTarget||row.texture)
        stored.push(row)
      }
    }
    yield* publication.prepareWork(stored)
    for(const draw of stored) {
      yield
      // A shared boolean has no references to other rows, meshes or assets.
      // Submitted numeric cuts can keep this readiness through producer retirement.
      if(!reused.has(draw.geometryKey))draw.imageryPublicationState=publication.states.get(draw.imageryGroup)
    }
    const coarseRows=[],coarseChanges=new Map()
    for(const [id,items]of publication.meshes) {
      yield;account(192)
      const prior=priors.get(id),keys=sources.get(id)
      if(!prior||reused.has(id))continue
      if(prior.sources.size!==keys.size||Array.from(keys).some(value=>!prior.sources.has(value)))continue
      const stage=yield* coarseningCutRows(prior.rows,items,sourceKey,
        (cell,target)=>presentation.group(cell,target),account)
      if(stage) {
        for(const row of stage.rows){yield;coarseRows.push(row)}
        coarseChanges.set(id,stage.coarsening)
      }
    }
    const coarsePublication=coarseRows.length?new PartitionPublication(id=>r.geometry.get(id),
      id=>r.textures.gpuReady(id),d=>d.imageryGroup):null
    if(coarsePublication) {
      yield* coarsePublication.prepareWork(coarseRows)
      for(const draw of coarseRows){yield;draw.imageryPublicationState=coarsePublication.states.get(draw.imageryGroup)}
    }
    const cuts=new Map(),coarseCuts=new Map()
    job.outputs=new Set()
    for(const [id,items]of publication.meshes) {
      yield
      const prior=priors.get(id),ancestors=new Set()
      if(prior&&!reused.has(id))for(const d of prior.rows)for(let t=parentTextureTile(d.imageryTarget||d.texture);t;t=parentTextureTile(t)) {
        yield;account(64);ancestors.add(key(t))
      }
      cuts.set(id,this.ownCut(job,id,items,sources.get(id),
        items.filter(d=>ancestors.has(key(d.imageryTarget||d.texture))),handover,account,reused.get(id),goals.get(id)))
    }
    if(coarsePublication)for(const [id,items]of coarsePublication.meshes) {
      yield
      coarseCuts.set(id,this.ownCut(job,id,items,sources.get(id),coarseChanges.get(id),handover,account))
    }
    return {cuts,coarseCuts,publication,coarsePublication,handover,rows:stored}
  }
  ownCut(job,id,rows,sources,coarsening,handover,account,reused,goals) {
    // A reused numerical payload has one physical owner. New publications pay
    // their own lists/groups and borrow the original payload directly, avoiding
    // an accumulating chain of previous publications.
    const payload=reused&&(reused.payload||reused)
    const bytes=512+rows.length*(payload?128:768)+sources.size*(payload?64:256)+
      (goals?goals.reduce((sum,value)=>sum+64+value.length*2,64):0)
    if(job.used<bytes)account(bytes-job.used)
    const cut={id,rows,sources,goals,camera:job.camera,coarsening,pressure:handover.size>0,version:++this.serial}
    const lease=job.takeCredit?job.takeCredit(bytes):job.credit.split(bytes,'resident','display-cut')
    const close=payload&&payload.ownership.hold()
    if(payload)cut.payload=payload
    this.residentBytes+=bytes
    job.residentBytes=(job.residentBytes||0)+bytes
    const owned=ownPayload(cut,lease,bytes,()=>{if(close)close();cut.rows=[];cut.goals=null;this.residentBytes-=bytes})
    job.used=Math.max(0,job.used-bytes);job.outputs.add(owned)
    return owned
  }
  advance(deadline = Infinity) {
    const r=this.renderer
    if(r.mode!=='texture'){if(this.records.length||this.entries.size)this.clear();return}
    deadline=Math.min(deadline,this.now()+4)
    // Request admission temporarily clears its attempt flags. Sample pressure
    // only on this clock. A fine image upload changes publication readiness,
    // not the funded world topology. Rebuild pressure handoff only when its
    // actual fallback or coverage readiness changes, including recovery.
    this.pressureStamp=this.pressureState()
    this.request(r.renderDraws)
    if(r.displaySurface)this.request(r.displaySurface.renderDraws)
    if(r.preparedSurfaceSource===r.current&&r.preparedSurface)this.request(r.preparedSurface.renderDraws)
    this.collect()
    if(this.job&&(!this.valid(this.job.record)||this.job.meshPlan&&
        (!this.job.meshPlan.valid()||this.job.meshPlan!==this.meshPlanFor(this.job.record))))this.closeJob(true)
    if(!this.job) {
      const needed=value=>{
        const handoff=this.meshPlanFor(value)
        return this.valid(value)&&value.stamp!==this.signature(value)&&
          !(handoff&&value.handoffPlanId===handoff.planId)
      }
      const record=this.records.find(value=>value.aliases.has(r.renderDraws)&&needed(value))||this.records.find(needed)
      if(record)this.start(record)
    }
    this.advanceWork(deadline)
    this.syncDemand()
  }
  advanceWork(deadline) {
    const r=this.renderer,work=[]
    if(this.job)work.push({job:this.job,task:this.job.task})
    for(const record of this.records)if(record.publication) {
      const scoped=record.aliases.has(r.renderDraws)&&this.valid(record)&&
        record.demandStamp!==this.demandSignature(record)&&record.demandContext===this.demandSignature(record,0)
      if(record.demandIndex&&(!scoped||record.demandIndex.revision!==record.goalRevision)) {
        record.demandIndex.close();record.demandIndex=null
      }
      const indexStamp=()=>record.goalRevision+':'+r.resourceLedger.availabilityRevision
      if(scoped&&!record.demandIndex&&record.indexRefusedAt!==indexStamp()) {
        record.demandIndex=new WorldDemandIndex(record,r.resourceLedger,inputKey,this.now)
        if(!record.demandIndex.task) {
          record.demandIndex.close();record.demandIndex=null;record.indexRefusedAt=indexStamp()
        }
      }
      if(record.demandIndex&&!record.demandIndex.complete)
        work.push({record,index:record.demandIndex,task:record.demandIndex.task})
      const needed=record.uvPending!==0||!record.readinessChecked||
        [record.publication,record.coarsePublication].some(value=>value&&value.needsAdvance())
      if(!record.maintenance&&needed)record.maintenance=new CooperativeTask(this.maintain(record),Infinity,this.now)
      if(record.maintenance)work.push({record,task:record.maintenance})
    }
    // The successor and installed publications share one deadline. Rotate
    // the first opportunity so a continuously changing successor cannot
    // starve the installed footprint or a newly ready publication group.
    const first=this.workCursor%Math.max(1,work.length)
    let advanced=false
    for(let offset=0;offset<work.length;++offset) {
      if(advanced&&this.now()>=deadline)break
      const index=(first+offset)%work.length,item=work[index]
      if(item.job?this.job!==item.job:item.record.closed||
          (item.index?item.record.demandIndex!==item.index:item.record.maintenance!==item.task))continue
      this.workCursor=index+1;advanced=true
      // Even when preceding admission consumed the window, one checkpoint
      // makes progress. The task itself stops at this same deadline.
      if(item.job)try {
        const job=item.job
        ++this.stats.slices
        const result=item.task.step(deadline)
        if(result.done) {
          if(this.valid(job.record))this.install(job,result.value)
          else for(const cut of job.outputs.values())cut.ownership.retire()
          this.closeJob(false)
        }
      }catch(error) {
        const record=item.job.record
        this.closeJob(true)
        if(error.status===9){record.refusedAt=r.resourceLedger.availabilityRevision+':'+this.signature(record);++this.stats.refused}
        else throw error
      }
      else if(item.index)try {
        if(item.task.step(deadline).done)r.partitionGroups.wakeImagery()
      }catch(error) {
        item.index.close();item.record.demandIndex=null
        if(error.status!==9)throw error
        item.record.indexRefusedAt=item.record.goalRevision+':'+r.resourceLedger.availabilityRevision
      }
      else if(item.task.step(deadline).done)item.record.maintenance=null
    }
    if(this.job||this.records.some(record=>record.maintenance||record.demandIndex&&!record.demandIndex.complete))r.requestResources()
  }
  *maintain(record) {
    const r=this.renderer,publications=[record.publication,record.coarsePublication].filter(Boolean)
    const first=!record.readinessChecked
    for(const value of publications)if(first||value.needsAdvance())
      if(yield* value.advanceWork()){++this.publicationRevision;r.requestRender()}
    record.readinessChecked=true
    if(record.uvPending===undefined)
      record.uvPending=Array.from(record.cuts.values()).filter(cut=>!cut.uvComplete).length
    // Finish the installed complete footprint while its latest-goal successor
    // is being built. Withdrawing this UV continuation can starve every moving
    // camera even though the immutable geometry has not changed.
    for(const [id,cut]of record.cuts) {
      if(cut.uvComplete)continue
      yield
      const geometry=r.geometry.get(id)
      if(!geometry)continue
      let cells=[],complete=true
      for(const draw of cut.rows) {
        yield
        if(record.aliases.has(r.renderDraws)&&r.displaySurface&&r.displaySurface.current!==r.current) {
          const bridge=r.presentationBridges.find(tile=>textureTileContains(tile,draw.texture))
          if(bridge&&bridge.level<draw.texture.level){if(!partReady(geometry,draw))complete=false;continue}
        }
        if(!partReady(geometry,draw)) {
          complete=false
          cells.push(r.partitionCell(draw))
        }
        if(cells.length===32){r.requestPartitionSet(geometry,cells,2);cells=[]}
      }
      if(cells.length)r.requestPartitionSet(geometry,cells,2)
      // A partition may be retired while this iterator is suspended. Recheck
      // this one footprint without yielding before parking it; later precise
      // eviction notifications reopen only the affected mesh.
      if(complete&&r.geometry.get(id)===geometry&&cut.rows.every(draw=>partReady(geometry,draw))) {
        cut.uvComplete=true;--record.uvPending
      }
    }
    // The last receipt may have arrived during UV maintenance, after its
    // publication scan completed. Requeue only a recovered pending dependency;
    // completion consumes no wake intended for a fresh readiness pass.
    if(publications.some(value=>value.needsAdvance()))r.requestResources()
  }
  partitionReleased(id,cell) {
    const r=this.renderer
    if(r.destroyed||r.paused||r.contextLost)return
    let changed=false
    for(const record of this.records) {
      const cut=record.cuts.get(id)
      if(!cut||!cut.rows.some(draw=>draw.imageryClipCell&&!draw.imageryDirectClip&&
          (draw.imageryIndexCell||key(draw.texture))===cell))continue
      if(cut.uvComplete){cut.uvComplete=false;++record.uvPending}
      changed=true
    }
    if(changed)r.requestResources()
  }
  install(job,result) {
    const record=job.record,r=this.renderer
    if(record.demandIndex){record.demandIndex.close();record.demandIndex=null}
    if(record.maintenance){record.maintenance.cancel();record.maintenance=null}
    for(const cut of record.cuts.values())cut.ownership.retire()
    for(const cut of (record.coarseCuts||new Map()).values())cut.ownership.retire()
    record.cuts=result.cuts;record.publication=result.publication;record.rows=result.rows;record.stamp=job.stamp
    record.demandStamp=job.demandStamp
    record.demandContext=job.demandContext
    record.coarseCuts=result.coarseCuts;record.coarsePublication=result.coarsePublication
    record.uvPending=record.cuts.size;record.readinessChecked=false
    for(const cut of record.cuts.values())cut.uvComplete=false
    job.installed=true
    ++this.publicationRevision
    if(job.camera===r.cameraVersion)r.capacityHandover=result.handover
    ++this.stats.completed
    r.partitionGroups.wakeImagery()
    r.geometryPublicationPending=true;r.requestRender();r.requestResources()
  }
  closeJob(cancelled) {
    const job=this.job;if(!job)return
    this.job=null
    const cleanup=new Cleanup()
    cleanup.run(()=>job.task.cancel())
    if(!job.installed&&job.outputs)for(const cut of job.outputs.values())cleanup.run(()=>cut.ownership.retire())
    for(const close of job.releases.splice(0))cleanup.run(close)
    cleanup.run(()=>job.credit.release())
    if(cancelled)++this.stats.cancelled
    cleanup.finish()
  }
  syncDemand() {
    const r=this.renderer,primary=this.records.find(record=>record.aliases.has(r.renderDraws)&&record.publication)
    if(primary)r.partitionPublication.adopt(primary.publication)
    else r.partitionPublication.clear(true)
    const handoff=new Set()
    for(const record of this.records)if(record!==primary&&record.publication)
      for(const id of record.publication.required)handoff.add(id)
    for(const record of this.records)if(record.coarsePublication)
      for(const id of record.coarsePublication.required)handoff.add(id)
    for(const entry of this.entries.values())if(entry.current)for(const d of entry.current.rows)
      if(d.imageryClipCell&&!d.imageryDirectClip)handoff.add(d.geometryKey+':'+key(d.texture))
    r.partitionPublication.handoff=handoff
  }
  prepared(draws) {
    const record=this.request(draws)
    return record&&record.publication?record:null
  }
  *imageGroupRows(members,children,reserve,releases) {
    const record=this.records.find(value=>value.aliases.has(this.renderer.renderDraws))
    if(!this.demandPrepared(record,members))return null
    const rows=[]
    for(const id of members) {
      const cut=record.cuts.get(id)
      if(!cut)continue
      reserve(64);releases.push(cut.ownership.hold())
      let needed=false
      for(const draw of cut.rows) {
        yield
        if(children.has(key(draw.imageryTarget||draw.texture)))needed=true
      }
      if(needed)for(const draw of cut.rows){yield;reserve(8);rows.push(draw)}
    }
    return rows
  }
  targetPrepared() {
    return this.targetState()==='ready'
  }
  targetState(children) {
    const record=this.request(this.renderer.renderDraws)
    if(!record)return 'waiting'
    if(this.demandPrepared(record))return 'ready'
    const index=record.demandIndex
    if(children&&record.aliases.has(this.renderer.renderDraws)&&this.valid(record)&&
        record.demandContext===this.demandSignature(record,0)&&index&&index.revision===record.goalRevision&&
        index.allows(children))return 'ready'
    const stamp=this.signature(record)
    return record.refusedAt===this.renderer.resourceLedger.availabilityRevision+':'+stamp?'blocked':'waiting'
  }
  compatible(draws) {
    const sources=new Map(),r=this.renderer
    for(const draw of draws) {
      if(!sources.has(draw.geometryKey))sources.set(draw.geometryKey,new Set())
      sources.get(draw.geometryKey).add(sourceKey(draw))
    }
    return sources.size>0&&Array.from(sources).every(([id,keys])=>{
      const entry=this.entries.get(id),cut=entry&&entry.current,geometry=r.geometry.get(id)
      return geometry&&cut&&cut.sources.size===keys.size&&Array.from(keys).every(value=>cut.sources.has(value))&&
        cut.rows.every(d=>partReady(geometry,d))
    })
  }
  read(draws) {
    const r=this.renderer,record=this.request(draws),sources=new Map(),bases=new Map(),rows=[],chosen=new Map()
    const bridges=new Set(r.plannedCameraVersion===r.cameraVersion?r.presentationBridges.map(key):[])
    for(const draw of draws) {
      const id=draw.geometryKey
      if(!sources.has(id))sources.set(id,new Set())
      sources.get(id).add(sourceKey(draw));if(!bases.has(id))bases.set(id,draw)
    }
    for(const [id,keys]of sources) {
      const geometry=r.geometry.get(id)
      if(!geometry)continue
      const entry=this.entries.get(id),current=entry&&entry.current
      const matches=cut=>cut&&cut.sources.size===keys.size&&Array.from(keys).every(value=>cut.sources.has(value))
      const acceptable=next=>matches(next)&&next.rows.every(d=>partReady(geometry,d))&&
        ((next.pressure&&next.camera===r.cameraVersion)||!next.coarsening.some(d=>
          !(next.camera===r.cameraVersion&&d.imageryHandover&&bridges.has(key(d.imageryTarget||d.texture)))&&visible(r,d)&&
          r.measureTextureDraw(d,(d.imageryTarget||d.texture).level)>(r.options.imageryPixelError||1.25)))
      let next=record&&record.cuts.get(id)
      if(!acceptable(next))next=record&&record.coarseCuts&&record.coarseCuts.get(id)
      if(!acceptable(next))next=null
      if(!next&&matches(current))next=current
      let missing=false
      if(next) {
        chosen.set(id,next)
        for(const d of next.rows)if(visible(r,d)) {
          const missingPart=!partReady(geometry,d)
          const originalClip=missingPart&&r.sourceUvPartitions&&d.imageryClipCell&&
            d.imageryCellScale<=r.sourceUvScale()
          if(missingPart&&!originalClip){missing=true;continue}
          // Prepared numeric descriptors are already owned by the selected
          // cut. Borrow them across display frames; copying every property of
          // every cell on each fade frame needlessly reconstructs this cut.
          let row=d
          if(originalClip)row=Object.assign({},d,{imageryDirectClip:true,imageryIndexCell:undefined})
          // A source-UV ancestor is an optional triangle superset. If it was
          // retired, the already resident original mesh provides that same
          // safe highp clip without allocating another partition.
          if(row.imageryDirectClip&&row.imageryIndexCell&&!geometry.partitions.has(row.imageryIndexCell))
            row=Object.assign({},row,{imageryIndexCell:undefined})
          // An unfinished cut can map a fine terrain mesh to a root image.
          // Its original UVs already support every resident source ancestor;
          // improving that whole-mesh fallback needs no successor partition.
          if(r.options.scheduledImagery&&!r.terrainBoundImagery&&
              (r.plannedCameraVersion!==r.cameraVersion||!r.current.imageryPlan||
              r.current.imageryPlan.quality.planningComplete!==true)&&!row.imageryClipCell&&row.sourceTexture&&
              (row.imageryTarget||row.texture).level<row.sourceTexture.level) {
            const cover=r.residentImageryDraw(Object.assign({},row,{texture:row.sourceTexture}))
            if(cover.texture.level>(row.imageryTarget||row.texture).level)
              row=Object.assign(cover,{texture:cover.sourceTexture,imageryTarget:cover.texture,
                imageryCellScale:1,imageryCellOffsetX:0,imageryCellOffsetY:0,imageryHandover:true,
                imageryResidentCoverage:true})
          }
          rows.push(row)
        }
      }
      if(!next||missing) {
        ++this.stats.sourceFallbacks
        const draw=bases.get(id),source=draw.sourceTexture||draw.texture
        const base=r.residentImageryDraw(Object.assign({},draw,{texture:source}))
        base.imageryResidentCoverage=base.texture.level>0
        base.imagerySourceCoverage=true;base.imageryDirectClip=false;base.imageryIndexCell=undefined;rows.push(base)
        rows.coveragePending=true
      }
    }
    rows.chosen=chosen
    return rows
  }
  commit(chosen) {
    if(!chosen)return
    const r=this.renderer
    for(const [id,cut]of chosen) {
      let entry=this.entries.get(id)
      if(entry&&entry.current===cut)continue
      if(entry)this.releaseEntry(id,entry)
      const close=cut.ownership.hold()
      entry={current:cut,close};this.entries.set(id,entry)
      const geometry=r.geometry.get(id);if(geometry)geometry.partitionDraws=cut.rows
    }
  }
  submitted(geometry) {
    const entry=this.entries.get(geometry.key)
    return Boolean(entry&&geometry.partitionDraws===entry.current.rows)
  }
  releaseEntry(id,entry=this.entries.get(id)) {
    if(!entry)return
    this.entries.delete(id)
    const geometry=this.renderer.geometry.entries.get(id)
    if(geometry&&geometry.value.partitionDraws===entry.current.rows)geometry.value.partitionDraws=null
    entry.close()
  }
  releaseRecord(record) {
    if(record.demandIndex){record.demandIndex.close();record.demandIndex=null}
    if(this.job&&this.job.record===record)this.closeJob(true)
    if(record.maintenance)record.maintenance.cancel()
    const publication=this.renderer.partitionPublication
    if(publication&&record.publication&&publication.meshes===record.publication.meshes)publication.clear(true)
    record.closed=true;this.records=this.records.filter(value=>value!==record)
    for(const cut of record.cuts.values())cut.ownership.retire()
    for(const cut of (record.coarseCuts||new Map()).values())cut.ownership.retire()
    record.cuts.clear();record.publication=null;record.rows=null
    if(record.coarseCuts)record.coarseCuts.clear()
    record.coarsePublication=null
  }
  clear() {
    this.closeJob(true)
    this.workCursor=0
    for(const record of [...this.records])this.releaseRecord(record)
    for(const id of [...this.entries.keys()])this.releaseEntry(id)
    this.pending.clear()
    if(this.renderer.partitionPublication)this.renderer.partitionPublication.clear()
  }
  snapshot() {
    const indexBytes=this.records.reduce((sum,record)=>sum+(record.demandIndex&&record.demandIndex.credit
      ?record.demandIndex.credit.bytes:0),0)
    return Object.assign({},this.stats,{records:this.records.length,submittedSources:this.entries.size,
      preparing:Boolean(this.job),demandIndexBytes:indexBytes,
      bytes:this.residentBytes+(this.job?this.job.credit.bytes:0)+indexBytes})
  }
}

module.exports={WorldDisplayPlan,completeWorldInputs,visible}
