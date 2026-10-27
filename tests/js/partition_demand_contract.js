const assert = require('assert')

module.exports = async function ({Renderer, FakeGl, FakeCanvas, stagePartitionJob, settle}) {
  const tasks = []
  const renderer = new Renderer(new FakeCanvas(new FakeGl()), {urlForTile: () => '',
    createPartitionPlanTask(id,cells) {
      return {promise:Promise.resolve(cells.map(c => ({key:c.key,bytes:66}))),cancel(){}}
    },
    createPartitionTask(id,cells) {
      const task={cells,cancelled:false,cancel(){this.cancelled=true}}
      task.promise=new Promise(resolve=>{task.finish=resolve});tasks.push(task);return task
    }})
  const geometry={key:'generation:mesh',resourceId:1,partitions:new Map()}
  const draw=i=>({geometryKey:geometry.key,texture:{level:3,matrix:3,row:0,column:i},
    imageryClipCell:true,imageryCellScale:8,imageryCellOffsetX:-i,imageryCellOffsetY:0})
  const cell=i=>renderer.partitionCell(draw(i))
  const queued=()=>renderer.partitionQueue.flatMap(job=>job.cells.map(c=>c.key)).sort()
  try {
    renderer.geometry.set(geometry.key,geometry,0);renderer.geometryPinnedKeys.add(geometry.key)
    renderer.requestPartitionSet(geometry,[cell(0),cell(2),cell(3)])
    // A frozen, admitted mesh footprint is a third existing owner, even after
    // its pending credit has been transferred into the producing task.
    renderer.meshOutputPlan={has(){return false},take(){return null},
      protects:(id,c)=>id===geometry.key&&c===cell(3).key,release(){}}
    renderer.partitionPublication.setHandoff([draw(2)])
    renderer.preparePartitions([draw(1)])
    assert.deepStrictEqual(queued(),[cell(1).key,cell(2).key,cell(3).key].sort(),
      'An obsolete visible cell survived complete demand replacement')
    assert(!geometry.partitionPending.has(cell(0).key))
    renderer.requestPartitionSet(geometry,[cell(1)],10)
    renderer.pumpPartitionRequests();await settle()
    // Pricing resumes production on the next background turn, never inside
    // its Promise completion. This fixture drives that clock explicitly.
    renderer.pumpPartitionRequests();await settle()
    assert.strictEqual(tasks.length,1)
    assert.strictEqual(tasks[0].cells[0].key,cell(1).key)
    renderer.partitionPublication.setHandoff([draw(1)])
    renderer.preparePartitions([draw(4)])
    assert(!tasks[0].cancelled,'Display changes cancelled a still-required handoff task')
    const charged=renderer.partitionCpuBytes
    assert(charged>0)
    renderer.partitionPublication.setHandoff([])
    renderer.preparePartitions([draw(4)])
    assert(tasks[0].cancelled,'Unowned producer continued after its demand was replaced')
    assert.strictEqual(renderer.partitionCpuBytes,charged,'Cancellation refunded a live producer')
    assert.strictEqual(renderer.resourceLedger.stats().owners['partition-output'].retired,charged)
    // Re-demanding a cancelled cell cannot let its late completion clear the
    // successor request or publish an empty result as ready geometry.
    renderer.preparePartitions([draw(1)])
    tasks[0].finish([]);await settle()
    assert(geometry.partitionPending.has(cell(1).key))
    assert(!geometry.partitions.has(cell(1).key))
    assert.strictEqual(renderer.partitionCpuBytes,0)
    const obsolete=cell(0)
    const pending=geometry.partitionPending
    stagePartitionJob(renderer,geometry,[obsolete],[{cell:obsolete,
      positions:new Float32Array(9),uv:new Float32Array(6),indices:new Uint16Array(3)}])
    pending.forEach(key=>geometry.partitionPending.add(key))
    geometry.partitions.set(cell(5).key,{byteSize:0})
    renderer.preparePartitions([draw(4)])
    assert.strictEqual(renderer.partitionUploads.length,0,'Unowned ready output blocked the upload lane')
    assert.strictEqual(renderer.partitionCpuBytes+renderer.partitionReservedBytes,0)
    assert(geometry.partitions.has(cell(5).key),'Demand cancellation destroyed resident display buffers')
    assert(queued().includes(cell(3).key),'Frozen mesh admission lost its required output')
    assert(geometry.partitionPending.has(cell(3).key),'Ready-output retirement cleared unrelated pending work')
  } finally {
    renderer.destroy();tasks.forEach(task=>task.finish([]));await settle()
  }
  assert.strictEqual(renderer.resourceLedger.bytes,0)
  const presentationDraws=renderer.presentationDraws
  renderer.presentationDraws=()=>{throw new Error('Idle queue needlessly rebuilt presentation demand')}
  renderer.syncPartitionDemand()
  renderer.presentationDraws=presentationDraws
}
