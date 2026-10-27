const {invariant}=require('../../sdk/js/core/terra_globe_common')
const {Cleanup}=require('../../sdk/js/runtime/cleanup')
const {TASK_WAIT}=require('../../sdk/js/runtime/cooperative_task')
const {NativeMeasurementLoans}=require('./native_surface_measurement')
const {monotonicNow}=require('../../sdk/js/diagnostics/timing')

const modelKey=Symbol('native surface model')

// Geometry owns its model. Projection owners contain canonical numbers only.
// Idle models are an optional derived cache; pressure may retire them without
// invalidating displayed geometry, current measurement tasks or numeric input.
class NativeMeasurementProduction {
  constructor(abi,workspace) {
    this.abi=abi;this.workspace=workspace;this.entries=new Set();this.layouts=new Map()
    this.loans=new NativeMeasurementLoans();this.pending=new Set();this.deferred=[]
    this.revision=0;this.counts={modelsBuilt:0,layoutReuses:0,measurements:0,refinements:0,bounds:0,reclaimedModels:0,
      modelMs:0,measureMs:0,ownershipMs:0}
    this.registration={close:()=>this.destroy()};abi.nativeSurfaceOwners.add(this.registration)
    this.bindLedger()
  }
  bindLedger() {
    const ledger=this.abi.imageryInputBudget&&this.abi.imageryInputBudget.ledger
    if(!ledger||this.ledger===ledger)return
    invariant(!this.ledger,'Native measurement ledger cannot change while models are owned')
    this.ledger=ledger
    this.unregister=ledger.reclamation.register({owner:'native-surface-models',revision:()=>this.revision,reclaim:async needed=>{
      const before=this.abi.imageryInputPayloadBytes()
      for(let round=0;round<128&&!this.closed;++round) {
        const value=this.trim(Math.max(0,needed-(before-this.abi.imageryInputPayloadBytes())))
        if(!value.more||before-this.abi.imageryInputPayloadBytes()>=needed)break
        await new Promise(resolve=>setTimeout(resolve,0))
      }
      return Math.max(0,before-this.abi.imageryInputPayloadBytes())
    }})
  }
  bindModel(entry,resource) {
    invariant(!entry.closed&&entry.owner===this&&resource.ownership&&resource.ownership.addRelease,
      'Native model binding requires live geometry ownership')
    if(resource[modelKey]===entry)return
    invariant(!resource[modelKey],'Geometry already owns another Native model')
    const unregister=resource.ownership.addRelease(()=>{
      if(resource[modelKey]===entry)delete resource[modelKey]
      entry.resources.delete(resource)
      if(!entry.resources.size)entry.close()
    })
    try {
      Object.defineProperty(resource,modelKey,{value:entry,configurable:true})
      entry.resources.set(resource,unregister)
    }catch(error){unregister();throw error}
  }
  shareModels(source,target) {
    invariant(!this.closed,'Native measurement producer was closed')
    // Only the validated copy transaction may introduce a second wrapper for
    // an immutable Native resource. Both owners participate until retirement;
    // neither an old measurement job nor a refused successor loses its model.
    for(const [id,next] of target) {
      const previous=source.get(id)
      invariant(previous&&previous.resourceId===next.resourceId&&
        previous.textureResourceId===next.textureResourceId&&
        previous.positions.length===next.positions.length&&previous.textureUv.length===next.textureUv.length,
      'Native model handoff changed immutable source identity')
    }
    for(const [id,next] of target) {
      const entry=source.get(id)[modelKey]
      if(entry)this.bindModel(entry,next)
    }
  }
  *model(draw,resource,options={}) {
    invariant(!this.closed,'Native measurement producer was closed')
    invariant(resource&&resource.ownership&&resource.ownership.addRelease,
      'Native measurement requires owned immutable geometry')
    let entry=resource[modelKey],ready=false
    if(entry)invariant(entry.owner===this&&!entry.closed&&(!entry.value||entry.value.id),'Native surface model was invalidated')
    if(!entry) {
      const candidates=this.layouts.get(draw.textureResourceId),reuse=candidates&&Array.from(candidates).find(value=>value.value&&value.value.id)
      entry={owner:this,resources:new Map(),texture:draw.textureResourceId,users:0,closed:false}
      entry.close=()=>{
        if(entry.closed)return
        entry.closed=true;this.entries.delete(entry);++this.revision
        const group=this.layouts.get(entry.texture)
        if(group){group.delete(entry);if(!group.size)this.layouts.delete(entry.texture)}
        const task=entry.task,value=entry.value;entry.task=entry.value=null
        const cleanup=new Cleanup()
        for(const [bound,unregister] of entry.resources) {
          if(bound[modelKey]===entry)delete bound[modelKey]
          cleanup.run(unregister)
        }
        entry.resources.clear()
        if(task)cleanup.run(()=>task.cancel())
        if(value)cleanup.run(()=>value.close())
        cleanup.finish()
      }
      try {
        entry.task=this.abi.createNativeSurfaceModelTask(draw,{
          get planId(){return options.planId||0},reuseModel:reuse&&reuse.value,
          inputWorkspace:this.workspace})
        this.bindModel(entry,resource);this.entries.add(entry);++this.revision
      }catch(error) {
        const cleanup=new Cleanup();cleanup.capture(error);cleanup.run(entry.close);cleanup.finish()
      }
    }
    try {
      while(!entry.value) {
        const started=monotonicNow(),next=entry.task.step()
        this.counts.modelMs+=monotonicNow()-started
        if(next.done) {
          entry.value=next.value;entry.task=null;++this.counts.modelsBuilt;++this.revision
          if(entry.value.reusedLayout)++this.counts.layoutReuses
          let group=this.layouts.get(entry.texture)
          if(!group){group=new Set();this.layouts.set(entry.texture,group)}
          group.add(entry)
        }else yield next.waiting?TASK_WAIT:undefined
      }
      // Touch the optional model cache without changing the geometry owner.
      this.entries.delete(entry);this.entries.add(entry);ready=true;return entry
    }finally {if(!ready&&!entry.value)entry.close()}
  }
  *measure(draw,resource,context,options) {
    this.bindLedger()
    let task,entry
    try {
      entry=yield* this.model(draw,resource,options);++entry.users
      task=this.abi.createNativeSurfaceMeasurementTask(entry.value,context,{...options,inputWorkspace:this.workspace,
        previous:options.previous&&options.previous.regions})
      for(;;) {
        const started=monotonicNow(),next=task.step()
        this.counts.measureMs+=monotonicNow()-started
        if(next.done) {
          const value=next.value;this.pending.add(value.regions);++this.counts.measurements
          if(options.previous)++this.counts.refinements
          if(options.boundsOnly)++this.counts.bounds
          return value
        }
        yield next.waiting?TASK_WAIT:undefined
      }
    }catch(error) {
      if(error.status===5) {
        const owners=Array.from(this.abi.nativeSurfaceOwners).filter(value=>value.id)
        const measurements=owners.filter(value=>value.session).length
        error.message+=' (live Native models='+ (owners.length-measurements)+', measurements='+measurements+')'
        Object.assign(error,{nativeStatus:5,status:9})
      }
      throw error
    }finally {
      if(entry)--entry.users
      if(task&&!task.done)task.cancel()
    }
  }
  defer(release){this.deferred.push(release)}
  settle(values) {
    const started=monotonicNow()
    const cleanup=new Cleanup()
    cleanup.run(()=>this.loans.replace(Array.from(values,value=>value&&value.regions)))
    const rows=Array.from(this.pending),releases=this.deferred.splice(0);this.pending.clear()
    for(const row of rows)cleanup.run(()=>row.close())
    for(const release of releases)cleanup.run(release)
    this.counts.ownershipMs+=monotonicNow()-started
    cleanup.finish()
  }
  trim(needed,maximum=32) {
    const before=this.abi.imageryInputPayloadBytes();let closed=0
    for(const entry of Array.from(this.entries)) {
      if(closed>=maximum||before-this.abi.imageryInputPayloadBytes()>=needed)break
      if(entry.users||!entry.value)continue
      entry.close();++closed;++this.counts.reclaimedModels
    }
    return {released:before-this.abi.imageryInputPayloadBytes(),more:Array.from(this.entries).some(entry=>entry.value&&!entry.users)}
  }
  stats(){return {producer:'native',models:this.entries.size,building:Array.from(this.entries).filter(entry=>entry.task).length,
    activeModels:Array.from(this.entries).filter(entry=>entry.users).length,revision:this.revision,...this.counts}}
  destroy() {
    if(this.closed)return
    this.closed=true
    this.abi.nativeSurfaceOwners.delete(this.registration)
    const cleanup=new Cleanup();cleanup.run(()=>this.settle([]))
    if(this.unregister)cleanup.run(this.unregister)
    for(const entry of Array.from(this.entries))cleanup.run(entry.close)
    this.layouts.clear();cleanup.finish()
  }
}

module.exports={NativeMeasurementProduction}
