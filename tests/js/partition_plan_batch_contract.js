const assert = require('assert')
const {PartitionPlanBatch} = require('../../sdk/js/terrain/partition_plan_batch')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')

module.exports = async function verifyPartitionBatch() {
  await require('./resident_partition_plan_contract')()
  let operations = 0, holds = 0, released = 0
  const rows = [1,2,3].map(resourceId => ({draw: {resourceId}}))
  const create = row => {
    assert.strictEqual(++holds, 1, 'Batch simultaneously owned multiple scratch inputs')
    const task = new CooperativeTask((function* () {
      for (let i = 0; i < 150; ++i) { ++operations; yield }
      return [{key: 'cell', bytes: row.draw.resourceId}]
    })())
    return {task, source: 'sampled', release() { --holds; ++released }}
  }
  const batch = new PartitionPlanBatch(rows, create), completed = []
  for (;;) {
    const before = operations, result = batch.step()
    assert(operations - before <= 64, 'Nested tasks multiplied the slice operation budget')
    completed.push(...result.value.rows)
    if (result.done) break
  }
  assert.deepStrictEqual(completed.map(row => row.resourceId), [1,2,3])
  assert.strictEqual(holds, 0); assert.strictEqual(released, 3)
  const cancelled = new PartitionPlanBatch(rows, create)
  assert.strictEqual(await cancelled.run(() => {}, async () => {
    assert.strictEqual(holds, 1)
    cancelled.cancel()
    assert.strictEqual(holds, 0)
  }), null)
  assert.strictEqual(released, 4, 'Cancellation started another row')
  const failure = new PartitionPlanBatch(rows, row => {
    const input = create(row)
    input.task.step = () => { throw new Error('cost failed') }
    return input
  })
  assert.throws(() => failure.step(), /cost failed/)
  assert.strictEqual(holds, 0)

  // Consumer refusal/failure must await the producer's final receipt, keeping
  // the enclosing work reservation alive while cancellation is in flight.
  for (const throws of [false, true]) {
    const sent = [], worker = {postMessage: value => sent.push(value), terminate() {}}
    const client = new TerrainWorkerClient(worker)
    let terminal = false
    try {
      const task = client.createMeshPartitionPlanTask(20, rows.map(row => ({...row, cells: []})), 8192, () => {
        if (throws) throw new Error('consumer rejected costs')
        return false
      })
      const done = task.promise.then(value => {terminal = true; return value}, error => {terminal = true; return error})
      const id = sent[0].id
      client.receive({id, recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 0, nativeBytes: 0, progress: true, value: {rows: []}})
      assert.deepStrictEqual(sent.map(m => m.type), ['mesh-partition-plan', 'cancel-partition'])
      await Promise.resolve()
      assert(!terminal && client.pending.has(id), 'Consumer refunded an unacknowledged producer')
      client.receive({id, recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision: 0, nativeBytes: 0, value: {superseded: true}})
      const result = await done
      if (throws) assert.match(result.message, /consumer rejected costs/)
      else assert.strictEqual(result, null)
      assert.strictEqual(client.pending.size, 0)
    } finally { client.destroy() }
  }
}
