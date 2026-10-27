const assert = require('assert')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')
const {TerrainWorkerClient} = require('../../adapters/wasm/terra_worker_client')
const {partitionGroupPlan} = require('../../adapters/wasm/resident_partition_plan')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = async function () {
  const model = surface.prepareSurface(new Float32Array([0,0,0,1,0,0,0,1,0]),
    new Float32Array([0,0,1,0,0,1]), new Uint16Array([0,1,2]), 0, 3)
  const cells = [{key: 'all', sourceUv: true, bounds: {minimumU:0, maximumU:1, minimumV:0, maximumV:1}}]
  const expected = await surface.createPartitionPlanTask(model, cells).run()
  for (const cancel of [false, true]) {
    const host = new TerrainWorkerHost({}), ledger = new ResourceLedger(2000)
    host.abi = {}
    const rows = Array.from({length:80}, (_, i) => ({resourceId: i + 1, cells}))
    for (const row of rows) {
      const resource = {positions: new Float32Array(3), textureUv: new Float32Array(2), model}
      ownPayload(resource, ledger.reserve('input', 20), 20)
      host.frames.resources.set(row.resourceId, resource)
    }
    rows.push({resourceId: 1000, cells})
    const request = {id: 1, type: 'partition-group-plan', rows}
    const first = await host.handle(request), completed = first.rows.slice()
    assert(first.pending && completed.length < 80, 'Group monopolized a Worker slice')
    for (const resource of host.frames.resources.values()) resource.ownership.retire()
    host.frames.resources.clear()
    assert.strictEqual(ledger.bytes, 1600, 'A queued row lost its immutable input before its turn')
    if (cancel) host.cancelPartition(1)
    else {
      let result = first
      while (result.pending) { result = await host.handle(request); completed.push(...result.rows) }
      assert.strictEqual(completed.length, 81)
      completed.slice(0,80).forEach(row => assert.deepStrictEqual(row.prices, expected))
      assert.deepStrictEqual(completed[80], {resourceId:1000, source:'missing', prices:null})
    }
    assert.strictEqual(ledger.bytes, 0)
    assert.strictEqual(host.partitionJobs.size, 0)
  }

  // Feed streamed rows before the final receipt; missing/old-generation rows
  // use their retained host models. There is one outbound RPC for the group.
  for (const cancel of [false, true]) {
    const sent = [], client = new TerrainWorkerClient({postMessage: m => sent.push(m), terminate() {}})
    try {
      const rows = [1,2,3].map(resourceId => ({cells, geometry:{resourceId, key:'mesh:'+resourceId, model}}))
      const task = partitionGroupPlan(rows, client, geometry => geometry.resourceId !== 3)
      assert.strictEqual(sent.length, 1)
      assert.strictEqual(sent[0].type, 'partition-group-plan')
      assert.strictEqual(sent[0].rows.length, 2)
      const id = sent[0].id, reply = value => client.receive({id, recordBytes: 0, heightBytes: 0, imageryBytes: 0, imageryOutputBytes:0,indexBytes:0, imageryReferenceRevision:0, imageryReferenceBytes: 0, imageryInputBytes: 0, memoryBytes:0,nativeRevision:0, nativeBytes:0, ...value})
      reply({progress:true, value:{rows:[{resourceId:1, prices:expected}]}})
      let done = false
      const receipt = task.promise.then(value => { done = true; return value })
      if (cancel) {
        task.cancel(); await Promise.resolve()
        assert(!done, 'Cancellation refunded ownership before the Worker receipt')
        assert.strictEqual(sent[1].type, 'cancel-partition')
        reply({value:{superseded:true}})
        assert.strictEqual(await receipt, null)
      } else {
        reply({value:{rows:[{resourceId:2, prices:null}]}})
        const result = await receipt
        rows.forEach(row => assert.deepStrictEqual(result.get(row.geometry.key), expected))
        assert.strictEqual(sent.length, 1, 'Host fallback issued another per-mesh RPC')
      }
    } finally {client.destroy()}
  }
  console.log('Resident group pricing: bounded slices, one RPC, retirement, missing rows and cancellation passed')
}
