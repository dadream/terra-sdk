const partitionSurface = require('../js/reference/partition_surface')
const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {preparedPartitionBytes} = require('../../adapters/wasm/prepared_partitions')
const cells = [0, 1, 2, 3].map(i => ({key: String(i), sourceUv: i % 2 === 0, bounds: {
  minimumU: i / 3, maximumU: (i + 1) / 3, minimumV: 0.25, maximumV: 0.75}}))

function read(abi, packet) {
  const before = abi.meshPayloadBytes(), frame = abi.getFrame()
  const output = new Map(), scratch = abi.alloc(1024 * 8)
  try {
    for (const draw of packet.draws) {
      if (output.has(draw.resourceId)) continue
      const uv = new Float32Array(draw.vertexCount * 2)
      for (let first = 0; first < draw.vertexCount; first += 1024) {
        const count = Math.min(1024, draw.vertexCount - first)
        assert.strictEqual(abi.module.call('terra_get_prepared_mesh_uv', abi.context,
          packet.nativePlan.id, draw.resourceId, first, count, scratch), 0)
        uv.set(new Float32Array(abi.module.refreshMemory().bytes.buffer, scratch, count * 2), first * 2)
      }
      // Mixed candidates also include already materialized old group members.
      const resident = abi.module.call('terra_get_mesh_texture_view', abi.context, draw.resourceId)
      if (resident) assert.deepStrictEqual(uv,
        new Float32Array(abi.module.refreshMemory().bytes.buffer, resident, uv.length))
      output.set(draw.resourceId, uv)
    }
    assert.strictEqual(abi.meshPayloadBytes(), before, 'UV reading materialized mesh arrays')
    assert.deepStrictEqual(abi.getFrame(), frame, 'UV reading published a frame')
    return output
  } finally { abi.free(scratch) }
}

async function plan(abi, packet) {
  const output = new Map(), indices = abi.getIndices(), before = abi.meshPayloadBytes()
  const cached = surface.partitionCacheStats(), draw = packet.draws[0]
  const bytes = preparedPartitionBytes(draw)
  assert.throws(() => abi.createPreparedPartitionTask(packet.nativePlan.id, draw, cells, indices, bytes-1), /credited/)
  let allocated = 0
  const alloc = abi.alloc, free = abi.free
  abi.alloc = function(n) { ++allocated; return alloc.call(this,n) }
  abi.free = function(p) { --allocated; return free.call(this,p) }
  try {
    const cancelled = abi.createPreparedPartitionTask(packet.nativePlan.id, draw, cells, indices, bytes)
    cancelled.maximumSteps = 1
    assert(!cancelled.step().done)
    assert.strictEqual(allocated, 1)
    cancelled.cancel(); assert.strictEqual(allocated, 0)
    const stale = abi.createPreparedPartitionTask(packet.nativePlan.id+1, draw, cells, indices, bytes)
    await assert.rejects(stale.run(), e => e.status === 2)
    assert.strictEqual(allocated, 0)
    for (const d of packet.draws) if (!output.has(d.resourceId))
      output.set(d.resourceId, await abi.createPreparedPartitionTask(packet.nativePlan.id, d,
        cells, indices, preparedPartitionBytes(d)).run())
    const bootstrap = await abi.createPreparedPartitionTask(packet.nativePlan.id, draw, cells, null,
      preparedPartitionBytes(draw, true)).run()
    assert.deepStrictEqual(bootstrap, output.get(draw.resourceId), 'New Worker index bootstrap changed UV costs')
    assert.throws(() => abi.getIndices(indices.length-1), /credited/)
    assert.strictEqual(allocated, 0)
    assert.strictEqual(abi.meshPayloadBytes(), before, 'Cost planning materialized geometry')
    assert.deepStrictEqual(surface.partitionCacheStats(), cached, 'Temporary UV work entered the cache')
  } finally { abi.alloc=alloc; abi.free=free }
  return output
}

async function verify(abi, packet, sampled, prepared) {
  const indices = abi.getIndices()
  // Includes exact grid lines, fractional triangle cuts and an empty cell.
  for (const [id, uv] of sampled) {
    const draw = packet.draws.find(d => d.resourceId === id)
    const mesh = abi.copyMeshResource(draw)
    assert.deepStrictEqual(uv, mesh.textureUv, 'Prepared UV differs from produced Wasm mesh')
    const model = surface.prepareSurface(mesh.positions, mesh.textureUv,
      indices, draw.firstIndex, draw.indexCount)
    const before = surface.partitionCacheStats()
    const planned = await surface.createUvPartitionPlanTask(uv, model.faces, cells).run()
    assert.deepStrictEqual(surface.partitionCacheStats(), before, 'Prepared UV escaped into persistent cache')
    if (prepared) assert.deepStrictEqual(prepared.get(id), planned, 'Prepared strip cost differs from resident topology')
    const parts = partitionSurface(model, cells)
    assert.deepStrictEqual(planned, cells.map(cell => ({key: cell.key,
      bytes: parts.filter(part => part.cell.key === cell.key).reduce((sum, part) =>
        sum + part.positions.byteLength + part.uv.byteLength + part.indices.byteLength, 0)})))
  }
}

async function bootstrapWorker(abi, manifest, root, ledger) {
  abi.setResourceLedger(ledger)
  await abi.loadManifest(manifest)
  let tested = false
  for (let i=0;i<4 && !tested;++i) {
    const packet = await abi.requestTerrain({type:'step',threshold:1, budget:{maximumChangeCount:32,
      maximumPriorityUpdateCount:256}, residentIds:[],needsIndices:true,generation:abi.generation,
      camera:{distance:20000000,tiltRadians:0,yawRadians:0,longitudeDegrees:0,latitudeDegrees:0},
      viewport:{width:640,height:360,fovRadians:Math.PI/6},viewRevision:abi.viewRevision})
    try {
      if (packet.draws.length) {
        const draw = packet.draws[0], bytes = preparedPartitionBytes(draw, true)
        const lease = await abi.reserveNativeWork('prepared-partition-work', bytes)
        assert(lease)
        try {
          const rows = [{draw, cells}], output = []
          await assert.rejects(abi.createMeshPartitionPlanTask(packet.nativePlan.id, rows, bytes - 1, () => {}).promise,
            /credited/)
          await assert.rejects(abi.createMeshPartitionPlanTask(packet.nativePlan.id, rows.concat(rows), bytes, () => {}).promise,
            /Invalid prepared partition batch member/)
          await assert.rejects(abi.createMeshPartitionPlanTask(packet.nativePlan.id + 1, rows, bytes, () => {}).promise,
            /Stale prepared partition batch/)
          await abi.createMeshPartitionPlanTask(packet.nativePlan.id, rows, bytes,
            completed => {output.push(...completed)}).promise
          assert(output.length === 1 && output[0].prices.length === cells.length && output[0].source === 'sampled')
          assert.strictEqual(abi.nativeBudget.actual,0,'Index bootstrap generated terrain payload')
          tested = true
        } finally {lease.release()}
      }
    } finally {await abi.send({type:'discard-plan',planId:packet.nativePlan.id})}
    for (const request of packet.requests) if (request.kind===1)
      await abi.submitRecord(request.kind,request.key,root)
  }
  assert(tested,'New Worker did not price UVs before its first materialization')
  assert.strictEqual(ledger.stats().reservedBytes,0)
}

module.exports = {read, plan, verify, cells, bootstrapWorker}
