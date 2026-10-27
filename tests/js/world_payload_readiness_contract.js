const assert=require('assert')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {WorldDisplayPlan}=require('../../adapters/webgl/world_display_plan')
const {ImageryPresentation}=require('../../sdk/js/imagery/terra_imagery_presentation')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')

// A numeric payload can outlive the publication that owned its readiness
// machine. Never lend a pending boolean to a new, independently ready cut.
module.exports=function verifyWorldPayloadReadiness() {
  const ledger=new ResourceLedger(65536),ready=new Set(),jobs=[]
  const root={level:0,matrix:0,row:0,column:0},tile={level:1,matrix:1,row:0,column:0}
  const source={geometryKey:'mesh:1',resourceId:1,textureResourceId:4294967297,
    texture:root,origin:[0,0,0],firstVertex:0,vertexCount:3,firstIndex:0,indexCount:3}
  const draw={...source,sourceTexture:root,texture:tile,imageryTarget:tile,
    imageryClipCell:true,imageryCellScale:2,imageryCellOffsetX:0,imageryCellOffsetY:0}
  const geometry={key:source.geometryKey,partitions:new Map([[key(tile),{}]])}
  const renderer={geometry:{get:()=>geometry,entries:new Map()},textures:{gpuReady:id=>ready.has(id)}}
  const world=new WorldDisplayPlan(renderer)
  function build() {
    const job={sourceDraws:[source],camera:1,releases:[],used:1024,
      credit:ledger.reserve('fixture-world-work',16384)}
    jobs.push(job)
    const account=bytes=>{job.used+=bytes;assert(job.used<=job.credit.bytes)}
    const work=world.buildCuts(job,[draw],new ImageryPresentation(0),new Map(),account)
    let step
    do{step=work.next()}while(!step.done)
    job.result=step.value;return job.result.cuts.get(source.geometryKey)
  }
  try {
    const pending=build()
    assert.strictEqual(pending.rows[0].imageryPublicationState.ready,false)
    world.commit(new Map([[source.geometryKey,pending]]))
    ready.add(key(tile))
    const successor=build()
    assert.strictEqual(successor.rows[0].imageryPublicationState.ready,true,
      'A ready successor borrowed an abandoned pending publication')
    assert.strictEqual(pending.rows[0].imageryPublicationState.ready,false,
      'Preparing a successor mutated the borrowed old cut')
    world.commit(new Map([[source.geometryKey,successor]]))
    const reused=build()
    assert(reused.rows.every((row,i)=>row===successor.rows[i]),'Ready immutable payload was unnecessarily copied')
    assert.strictEqual(reused.payload,successor.payload||successor)
  } finally {
    for(const job of jobs) {
      for(const close of job.releases)close()
      for(const cut of job.outputs||[])cut.ownership.retire()
      job.credit.release()
    }
    world.releaseEntry(source.geometryKey)
  }
  assert.strictEqual(ledger.bytes,0)
  assert.strictEqual(world.residentBytes,0)
  console.log('World payload reuse: pending publications stay private; ready rows share one owned payload')
}
