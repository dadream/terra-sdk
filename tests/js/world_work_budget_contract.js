const assert=require('assert')
const {WorldDisplayPlan}=require('../../adapters/webgl/world_display_plan')
const {PartitionPublication}=require('../../adapters/webgl/partition_publication')
const {CooperativeTask,TASK_WAIT}=require('../../sdk/js/runtime/cooperative_task')
const {TerraWebGlRenderer}=require('../../adapters/webgl/terra_webgl_renderer')
const {FakeGl,FakeCanvas,frame}=require('./support/webgl_fixture')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')

function verifyPendingFrontier(World) {
  const root={level:0,matrix:0,row:0,column:0}
  const a=descendantTextureTile(root,1,0,0),b=descendantTextureTile(root,1,0,1)
  const geometries=new Map(),reads=new Map(),queued=[]
  let wakes=0,renders=0
  const rows=['one','two','three'].flatMap(id=>{
    const parts=new Map([[key(a),{}],[key(b),{}]]),has=parts.has.bind(parts)
    reads.set(id,0);parts.has=cell=>{reads.set(id,reads.get(id)+1);return has(cell)}
    geometries.set(id,{partitions:parts})
    return(id==='two'?[a,b]:[a]).map(texture=>({geometryKey:id,texture,imageryClipCell:true}))
  })
  const r={geometry:{get:id=>geometries.get(id)},requestResources(){++wakes},requestRender(){++renders},
    partitionCell:draw=>({key:key(draw.texture)}),requestPartitionSet(geometry,cells){queued.push({geometry,cells})}}
  const world=new World(r,()=>0)
  const publication=new PartitionPublication(r.geometry.get,()=>true,draw=>draw.geometryKey)
  publication.prepare(rows)
  const cuts=new Map(['one','two','three'].map(id=>[id,{rows:rows.filter(draw=>draw.geometryKey===id)}]))
  const record={publication,cuts,aliases:new Set()};world.records=[record]
  world.advanceWork(4)
  assert.strictEqual(record.uvPending,0,'Completed immutable footprints did not park')
  const before=new Map(reads)
  for(let n=0;n<64;++n)world.advanceWork(4)
  assert.deepStrictEqual(reads,before,'Unrelated resource turns rescanned completed UV footprints')
  assert(!record.maintenance&&!queued.length,'Completed work retained a maintenance cursor or producer demand')
  world.partitionReleased('two',key(root))
  assert.strictEqual(record.uvPending,0,'An unrelated UV cell reopened a complete footprint')
  assert.strictEqual(wakes,0,'An unrelated UV cell woke preparation')

  const geometry=geometries.get('two'),cut=cuts.get('two')
  geometry.partitions.delete(key(a));world.partitionReleased('two',key(a))
  assert.strictEqual(record.uvPending,1)
  world.advanceWork(4)
  assert(queued.length===1&&queued[0].geometry===geometry&&queued[0].cells.length===1&&queued[0].cells[0].key===key(a),
    'UV retirement did not resume only the affected missing destination')
  assert.strictEqual(reads.get('one'),before.get('one'))
  assert.strictEqual(reads.get('three'),before.get('three'))
  geometry.partitions.set(key(a),{});world.advanceWork(4)
  assert.strictEqual(record.uvPending,0,'Restored UV did not park its footprint again')

  const resident=new Set(),imageRows=[Object.assign({},rows[0],{imageryTarget:a})]
  record.publication=new PartitionPublication(r.geometry.get,id=>resident.has(id),()=> 'image')
  record.publication.prepare(imageRows);record.readinessChecked=false
  world.advanceWork(4)
  const blockedReads=new Map(reads)
  for(let n=0;n<64;++n)world.advanceWork(4)
  assert.deepStrictEqual(reads,blockedReads,'An unchanged missing image restarted full publication scans')
  resident.add(key(a));world.advanceWork(4)
  assert(record.publication.ready('image')&&renders===1,'The last relevant image receipt did not publish its group')

  cut.uvComplete=false;record.uvPending=1
  const work=world.maintain(record),beforeRead=reads.get('two')
  let next=work.next(),steps=0
  while(!next.done&&reads.get('two')===beforeRead&&++steps<32)next=work.next()
  assert(!next.done&&reads.get('two')>beforeRead,'Fixture did not pause after checking its first ready UV')
  const beforeWake=wakes
  geometry.partitions.delete(key(a));world.partitionReleased('two',key(a))
  do{next=work.next();assert(++steps<64)}while(!next.done)
  assert(!cut.uvComplete&&record.uvPending===1,
    'A UV retired during a suspended scan was incorrectly parked as complete')
  assert(wakes>beforeWake,'A relevant UV retirement lost the final maintenance wake')
  const count=queued.length;world.advanceWork(4)
  assert(queued.length===count+1,'The queued continuation did not recover its missing UV')
  geometry.partitions.set(key(a),{});world.advanceWork(4)
  assert.strictEqual(record.uvPending,0)
  assert(!record.maintenance)
  console.log('World pending frontier: completed parking, precise UV retirement, image recovery and sliced invalidation passed')
}

module.exports=async function verifyWorldWorkBudget(World=WorldDisplayPlan,Renderer=TerraWebGlRenderer) {
  const canvas=new FakeCanvas(new FakeGl());canvas.width=canvas.height=256
  const r=new Renderer(canvas,{mode:'height',terrainBoundImagery:false,scheduledImagery:true,
    textureTransitionMs:0,requestResources(){},requestRender(){},maximumResourceBytes:4*1024*1024,
    textureDescriptor:{kind:'global-geodetic',level_zero_columns:2,level_zero_rows:1,
      matrix_level_offset:0,tile_size:16,maximum_level:8},urlForTile:()=>null})
  const root={level:0,matrix:0,row:0,column:0}
  const draw={resourceId:1,textureResourceId:1,origin:[0,0,0],key:{level:0,i:0,j:0,k:0},
    fragment:0,texture:root,firstVertex:0,vertexCount:4,firstIndex:0,indexCount:4}
  const resource={resourceId:1,positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
    textureUv:new Float32Array([0,0,1,0,0,1,1,1])}
  let clock=0,buildSteps=0,maintenanceSteps=0,buildClosed=false,maintenanceClosed=false
  r.measureDraw=()=>({visible:true,hull:[[0,0],[1,0],[1,1],[0,1]]})
  r.measureTextureDraw=()=>.5
  try {
    r.textures.cache.set(key(root),{image:{},texture:{},width:16,height:16},1364)
    r.setMeshFrame(Object.assign(frame(),{sequence:1,coverageComplete:true}),[draw],
      new Map([[1,resource]]),new Uint16Array([0,2,1,3]),{modelRevision:1})
    for(let n=0;n<20&&!r.displaySurface;++n){r.advanceResources();r.render(false);await Promise.resolve()}
    assert(r.displaySurface,'Budget fixture did not publish its initial terrain')
    r.worldDisplay.clear()
    const world=r.worldDisplay=new World(r,()=>clock),build=world.build
    const geometry=r.geometry.entries.get('mesh:1')
    world.build=function*(...args){
      const release=r.geometry.retain('mesh:1')
      try {
        for(let n=0;n<16000;++n){clock+=.001;++buildSteps;yield}
        return yield* build.apply(this,args)
      }finally{release();buildClosed=true}
    }
    r.setMode('texture')
    world.advance()
    assert(world.job&&geometry.holds,'Budget fixture did not retain suspended source geometry')
    assert(buildSteps>=3000&&buildSteps<4100,
      'World construction yielded on a checkpoint count with unused host time')
    assert(clock<=4.01,'World construction exceeded its four millisecond window')

    const record=world.job.record
    record.publication=new PartitionPublication(()=>null,()=>false,()=>null)
    record.maintenance=new CooperativeTask((function*(){
      try{for(let n=0;n<16000;++n){clock+=.001;++maintenanceSteps;yield}}
      finally{maintenanceClosed=true}
    })(),Infinity,()=>clock)
    const before=buildSteps
    for(let n=0;n<3;++n){
      const at=clock;world.advance()
      assert(clock-at<=4.01,'Successor and installed maintenance each spent a separate CPU window')
    }
    assert(buildSteps>before&&maintenanceSteps>0,
      'A continuously pending successor starved installed publication maintenance')
    assert(world.job&&record.maintenance,'Fairness fixture did not retain both unfinished cursors')
    r.setPaused(true)
    assert(buildClosed&&maintenanceClosed,'Pause did not cancel both persistent work cursors')
    assert(!geometry.holds&&!world.job&&!world.records.length&&world.snapshot().bytes===0,
      'Cancellation retained source geometry or world workspace')
  }finally{r.destroy();await new Promise(resolve=>setTimeout(resolve,0))}
  assert.strictEqual(r.resourceLedger.bytes,0)

  let checkpoints=0,closed=false
  const waiting=new CooperativeTask((function*(){
    try{++checkpoints;yield TASK_WAIT;++checkpoints}
    finally{closed=true}
  })(),Infinity,()=>0)
  assert(waiting.step(4).waiting&&checkpoints===1,
    'A dependency wait was consumed as another cheap CPU checkpoint')
  waiting.cancel();assert(closed&&checkpoints===1)
  verifyPendingFrontier(World)
  console.log('World work budget: useful CPU windows, shared deadlines, publication fairness and suspended cleanup passed')
}
if(require.main===module)module.exports().catch(error=>{console.error(error);process.exitCode=1})
