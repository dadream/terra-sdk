const {invariant}=require('../../sdk/js/core/terra_globe_common')
const {CooperativeTask,TASK_WAIT}=require('../../sdk/js/runtime/cooperative_task')
const {Cleanup}=require('../../sdk/js/runtime/cleanup')
const {requireStatus}=require('./abi_status')
const {TERRA_ABI_VERSION}=require('./terra_wasm')

const PAGE_BYTES=256*176+4,rowsStorage=new WeakMap()
function call(abi,name,...args){requireStatus(abi.nativeCall(name,abi.context,...args),name)}
function progress(abi,pointer) {
  const view=abi.module.refreshMemory().dataView,values=[]
  for(let i=0;i<17;++i)values.push(view.getUint32(pointer+i*4,true))
  return {id:values[2],phase:values[3],operations:values[4],requiredBytes:values[5],modelId:values[6],
    resourceId:values[7],planId:values[8],viewRevision:values[9],sourceRevision:values[10],
    regionCount:values[11],hullCount:values[12],quoteId:values[16]}
}
function* fund(abi,workspace,bytes,produce) {
  let credit
  if(workspace) {
    invariant(typeof workspace==='function','Native measurement needs a per-stage workspace factory')
    const stage=workspace()
    try {while(!(credit=stage.reserve(bytes)))yield TASK_WAIT}
    finally {if(!credit&&!abi.destroyed)stage.finished=true}
  }
  else credit=abi.beginImageryInput(bytes)
  const cleanup=new Cleanup();let value
  try{value=produce()}catch(error){cleanup.capture(error)}
  cleanup.run(()=>abi.observeImageryInput());cleanup.run(()=>credit.release());cleanup.finish();return value
}
function owner(abi,id,closeName) {
  const context=abi.context
  const value={abi,context,id,close() {
    const previous=this.id;this.id=0;abi.nativeSurfaceOwners.delete(this)
    if(previous&&abi.context===context&&!abi.destroyed)call(abi,closeName,previous)
  }}
  abi.nativeSurfaceOwners.add(value);return value
}
function createTask(abi,iterator,session=0) {
  const task=new CooperativeTask(iterator,8),registration={session,close:()=>task.cancel()}
  abi.nativeSurfaceOwners.add(registration)
  const step=task.step.bind(task),cancel=task.cancel.bind(task)
  task.step=()=>{try{return step()}finally{if(task.done)abi.nativeSurfaceOwners.delete(registration)}}
  task.cancel=()=>{try{cancel()}finally{abi.nativeSurfaceOwners.delete(registration)}}
  return task
}
function setSize(abi,pointer,size){abi.module.refreshMemory().dataView.setUint32(pointer,size,true)}
function* ensurePage(abi,workspace) {
  if(!abi.nativeSurfacePage)yield* fund(abi,workspace,PAGE_BYTES,()=>{
    abi.nativeSurfacePage=abi.alloc(PAGE_BYTES,'imagery-input')
  })
}

class NativeMeasurementRows {
  constructor(handle,session,length,hullCount) {
    this.length=length;this.hullCount=hullCount
    rowsStorage.set(this,{handle,session,references:1,initial:true});Object.freeze(this)
  }
  borrow() {
    const state=this.state();++state.references;let active=true
    return ()=>{if(active){active=false;if(!--state.references)state.handle.close()}}
  }
  close() {
    const state=rowsStorage.get(this)
    if(state.initial){state.initial=false;if(!--state.references)state.handle.close()}
  }
  state() {
    const state=rowsStorage.get(this)
    invariant(state.references&&state.handle.id&&state.handle.abi.context===state.handle.context&&!state.handle.abi.destroyed,
      'Native measurement loan has ended')
    return state
  }
  appendTo(planner,index) {
    const {handle,session}=this.state()
    invariant(planner.abi===handle.abi&&planner.id===session,'Native measurement belongs to another planner')
    planner.call('terra_append_measured_imagery_surface',handle.id,index)
  }
  copyTo(output,offset=0,first=0,count=this.length-first) {
    const {handle,session}=this.state(),abi=handle.abi,pointer=abi.nativeSurfacePage
    invariant(pointer&&output instanceof Uint8Array&&Number.isSafeInteger(offset)&&offset>=0&&
      Number.isSafeInteger(first)&&first>=0&&Number.isSafeInteger(count)&&count>=0&&count<=256&&
      first+count<=this.length&&offset+count*176<=output.byteLength,'Invalid native measurement copy')
    call(abi,'terra_get_surface_measurement_regions',session,handle.id,first,pointer,count,pointer+PAGE_BYTES-4)
    const memory=abi.module.refreshMemory()
    invariant(memory.dataView.getUint32(pointer+PAGE_BYTES-4,true)===count,'Native measurement copy lost rows')
    output.set(memory.bytes.subarray(pointer,pointer+count*176),offset)
  }
}

class NativeMeasurementLoans {
  constructor(){this.values=new Map()}
  hold(value) {if(value&&typeof value.borrow==='function'&&!this.values.has(value))this.values.set(value,value.borrow())}
  replace(rows) {
    const next=new Set(Array.from(rows).filter(value=>value&&typeof value.borrow==='function')),added=new Map()
    try {for(const value of next)if(!this.values.has(value))added.set(value,value.borrow())}
    catch(error){const cleanup=new Cleanup();cleanup.capture(error);for(const release of added.values())cleanup.run(release);cleanup.finish()}
    const retired=[]
    for(const [value,release] of this.values)if(!next.has(value)){retired.push(release);this.values.delete(value)}
    for(const [value,release] of added)this.values.set(value,release)
    const cleanup=new Cleanup();for(const release of retired)cleanup.run(release);cleanup.finish()
  }
  clear(){const cleanup=new Cleanup(),releases=Array.from(this.values.values());this.values.clear();for(const release of releases)cleanup.run(release);cleanup.finish()}
}

const snapshots=new WeakMap()
function ownNativeMeasurements(values) {
  invariant(!snapshots.has(values),'Native measurement response already owns its input')
  const loans=new NativeMeasurementLoans();loans.replace(values.map(value=>value.regions));snapshots.set(values,loans);return values
}
function releaseNativeMeasurements(values) {
  const loans=values&&snapshots.get(values)
  if(loans){snapshots.delete(values);loans.clear()}
}

function createNativeSurfaceModelTask(abi,draw,options={}) {
  const workspace=options.inputWorkspace
  function* work() {
    let pointer=0,handle,transferred=false,reusedLayout=false
    try {
      const metadata=abi.module.call('terra_surface_model_work_bytes')>>>0
      yield* fund(abi,workspace,metadata+72,()=>{
        pointer=abi.alloc(72,'imagery-input');setSize(abi,pointer,68)
        // Optional derived layouts may retire while funding yields. Resolve
        // the live handle only now; retaining an idle model would block pressure.
        const previous=options.reuseModel
        invariant(!previous||previous.abi===abi&&previous.context===abi.context,
          'Native surface model reuse belongs to another ABI')
        const reuse=previous&&previous.id||0
        call(abi,'terra_open_surface_model',options.planId||0,draw.resourceId,reuse,metadata,pointer+68)
        reusedLayout=Boolean(reuse)
        handle=owner(abi,abi.module.refreshMemory().dataView.getUint32(pointer+68,true),'terra_close_surface_model')
      })
      call(abi,'terra_step_surface_model',handle.id,0,0,0,0,pointer)
      let value=progress(abi,pointer)
      for(;;) {
        if(value.phase===2){transferred=true;return Object.assign(handle,{resourceId:value.resourceId,planId:value.planId,reusedLayout})}
        invariant(value.phase<=1,'Native surface model failed')
        if(value.requiredBytes)yield* fund(abi,workspace,value.requiredBytes,()=>
          call(abi,'terra_step_surface_model',handle.id,options.maximumOperations||4096,options.maximumMilliseconds===undefined?2:options.maximumMilliseconds,
            value.quoteId,value.requiredBytes,pointer))
        else call(abi,'terra_step_surface_model',handle.id,options.maximumOperations||4096,
          options.maximumMilliseconds===undefined?2:options.maximumMilliseconds,0,0,pointer)
        value=progress(abi,pointer);yield
      }
    }finally {
      const cleanup=new Cleanup()
      if(!transferred&&handle)cleanup.run(()=>handle.close())
      if(pointer)cleanup.run(()=>abi.free(pointer))
      cleanup.run(()=>abi.observeImageryInput());cleanup.finish()
    }
  }
  return createTask(abi,work())
}
function createNativeSurfaceMeasurementTask(abi,model,context,options={}) {
  const workspace=options.inputWorkspace,planner=options.planner||abi.getImageryPlanner()
  function* work() {
    let pointer=0,handle,transferred=false,releasePrevious
    try {
      invariant(model.abi===abi&&model.id,'Native surface model belongs to another ABI')
      const codes=options.domains||[]
      invariant(codes.length<=256&&codes.every(n=>Number.isInteger(n)&&n>=0&&n<336),'Invalid native measurement domains')
      let previousId=0
      if(options.previous) {
        invariant(options.previous instanceof NativeMeasurementRows,'Native refinement needs canonical previous rows')
        const previous=options.previous.state()
        invariant(previous.handle.abi===abi&&previous.session===planner.id,'Previous native measurement belongs to another planner')
        previousId=previous.handle.id;releasePrevious=options.previous.borrow()
        invariant(options.tight&&!options.boundsOnly&&!codes.length,'Native refinement requires a complete tight measurement')
      }
      const bytes=248+codes.length*4,metadata=abi.module.call('terra_surface_measurement_work_bytes')>>>0
      yield* fund(abi,workspace,metadata+bytes,()=>{
        pointer=abi.alloc(bytes,'imagery-input')
        const view=abi.module.refreshMemory().dataView
        view.setUint32(pointer,176,true);view.setUint32(pointer+4,TERRA_ABI_VERSION,true)
        view.setUint32(pointer+8,model.id,true);view.setUint32(pointer+12,Number(Boolean(options.tight))|Number(Boolean(options.boundsOnly))<<1,true)
        view.setUint32(pointer+16,options.viewRevision||0,true);view.setUint32(pointer+20,options.sourceRevision||0,true)
        view.setUint32(pointer+24,previousId,true);view.setUint32(pointer+28,0,true)
        for(let i=0;i<16;++i)view.setFloat64(pointer+32+i*8,context.matrix[i],true)
        view.setFloat64(pointer+160,context.sx,true);view.setFloat64(pointer+168,context.sy,true)
        codes.forEach((code,i)=>view.setUint32(pointer+248+i*4,code,true))
        call(abi,'terra_open_surface_measurement',planner.id,pointer,pointer+248,codes.length,metadata,pointer+244)
        handle=owner(abi,abi.module.refreshMemory().dataView.getUint32(pointer+244,true),'terra_close_surface_measurement')
        handle.session=planner.id
        setSize(abi,pointer+176,68)
      })
      call(abi,'terra_step_surface_measurement',planner.id,handle.id,0,0,0,0,pointer+176)
      let value=progress(abi,pointer+176)
      while(value.phase!==6) {
        invariant(value.phase<6,'Native surface measurement failed')
        const advance=grant=>call(abi,'terra_step_surface_measurement',planner.id,handle.id,options.maximumOperations||4096,
          options.maximumMilliseconds===undefined?2:options.maximumMilliseconds,grant?value.quoteId:0,grant,pointer+176)
        if(value.requiredBytes)yield* fund(abi,workspace,value.requiredBytes,()=>advance(value.requiredBytes))
        else advance(0)
        value=progress(abi,pointer+176);yield
      }
      yield* ensurePage(abi,workspace)
      setSize(abi,pointer,64);call(abi,'terra_get_surface_measurement_summary',handle.id,pointer)
      let view=abi.module.refreshMemory().dataView
      const bounds={minimumU:view.getFloat64(pointer+16,true),minimumV:view.getFloat64(pointer+24,true),
        maximumU:view.getFloat64(pointer+32,true),maximumV:view.getFloat64(pointer+40,true)}
      const result={visible:Boolean(view.getUint32(pointer+8,true)),refinable:Boolean(view.getUint32(pointer+12,true)),bounds,
        pixelsPerUv:view.getFloat64(pointer+48,true),centerDistance:view.getFloat64(pointer+56,true),hull:[],
        viewRevision:value.viewRevision,sourceRevision:value.sourceRevision}
      for(let first=0;first<value.hullCount;first+=256) {
        const count=Math.min(256,value.hullCount-first),page=abi.nativeSurfacePage
        call(abi,'terra_get_surface_measurement_hull',planner.id,handle.id,first,page,count,page+PAGE_BYTES-4)
        view=abi.module.refreshMemory().dataView
        invariant(view.getUint32(page+PAGE_BYTES-4,true)===count,'Native hull read lost points')
        for(let i=0;i<count;++i)result.hull.push([view.getFloat64(page+i*16,true),view.getFloat64(page+i*16+8,true)])
        if(first+count<value.hullCount)yield
      }
      result.uv=bounds
      if(result.hull.length)result.bounds={minimumU:Math.min(...result.hull.map(p=>p[0])),minimumV:Math.min(...result.hull.map(p=>p[1])),
        maximumU:Math.max(...result.hull.map(p=>p[0])),maximumV:Math.max(...result.hull.map(p=>p[1]))}
      result.regions=new NativeMeasurementRows(handle,planner.id,value.regionCount,value.hullCount)
      transferred=true;return result
    }finally {
      const cleanup=new Cleanup()
      if(!transferred&&handle)cleanup.run(()=>handle.close())
      if(pointer)cleanup.run(()=>abi.free(pointer))
      if(releasePrevious)cleanup.run(releasePrevious)
      cleanup.run(()=>abi.observeImageryInput());cleanup.finish()
    }
  }
  return createTask(abi,work(),planner.id)
}

module.exports={NativeMeasurementRows,NativeMeasurementLoans,ownNativeMeasurements,releaseNativeMeasurements,
  createNativeSurfaceModelTask,createNativeSurfaceMeasurementTask}
