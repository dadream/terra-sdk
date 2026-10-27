const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {preparedSurfaceBytes} = require('../../adapters/wasm/prepared_surface')
const {invertMatrix4} = require('../../sdk/js/math/matrix')

function same(a, b, message) {
  assert(a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength)
    .equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength)), message)
}

async function read(abi, packet) {
  const before = abi.meshPayloadBytes(), frame = abi.getFrame(), output = new Map()
  for (const draw of packet.draws) {
    if (output.has(draw.resourceId)) continue
    const sampled = await abi.createPreparedSurfaceTask(packet.nativePlan.id, draw, preparedSurfaceBytes(draw)).run()
    const resident = abi.module.call('terra_get_mesh_position_view', abi.context, draw.resourceId)
    if (resident) same(sampled.positions, new Float32Array(abi.module.refreshMemory().bytes.buffer,
      resident, draw.vertexCount * 3), 'Mixed candidate changed a resident position payload')
    output.set(draw.resourceId, sampled)
  }
  assert.strictEqual(abi.meshPayloadBytes(), before, 'Surface read materialized native mesh payload')
  assert.deepStrictEqual(abi.getFrame(), frame, 'Surface read published a frame')
  return output
}

async function taskContract(abi, packet) {
  const draw = packet.draws[0], bytes = preparedSurfaceBytes(draw)
  const alloc = abi.alloc, free = abi.free, active = new Map()
  let peak = 0
  abi.alloc = function(n) {
    const p = alloc.call(this, n); active.set(p, n)
    peak = Math.max(peak, Array.from(active.values()).reduce((sum, value) => sum + value, 0))
    return p
  }
  abi.free = function(p) { assert(active.delete(p)); return free.call(this, p) }
  try {
    assert.throws(() => abi.createPreparedSurfaceTask(packet.nativePlan.id, draw, bytes - 1), /credited/)
    assert.strictEqual(active.size, 0)
    const stale = abi.createPreparedSurfaceTask(packet.nativePlan.id + 1, draw, bytes)
    await assert.rejects(stale.run(), e => e.status === 2)
    assert.strictEqual(active.size, 0)
    const cancelled = abi.createPreparedSurfaceTask(packet.nativePlan.id, draw, bytes)
    cancelled.maximumSteps = 1
    assert(!cancelled.step().done)
    assert.strictEqual(active.size, 1)
    cancelled.cancel(); assert.strictEqual(active.size, 0)
    assert.strictEqual(cancelled.value, null)
    const task = abi.createPreparedSurfaceTask(packet.nativePlan.id, draw, bytes)
    task.maximumSteps = 1
    assert(!task.step().done)
    // Native allocations elsewhere can grow memory between slices.
    abi.module.exports.memory.grow(1)
    const result = await task.run()
    assert.strictEqual(result.positions.byteLength + result.textureUv.byteLength + peak, bytes)
    assert.strictEqual(active.size, 0)
  } finally { abi.alloc = alloc; abi.free = free }
}

function measurements(abi, packet, samples, tight) {
  const indices = abi.getIndices(), context = surface.projectionContext(packet.frame,
    {width:640,height:360}, invertMatrix4(packet.frame.projectionView))
  return packet.draws.map(draw => {
    const mesh = samples ? samples.get(draw.resourceId) : abi.copyMeshResource(draw)
    const model = surface.prepareSurface(mesh.positions, mesh.textureUv, indices, draw.firstIndex, draw.indexCount)
    return Object.assign(surface.measureSurface(model, draw.origin, context, tight),
      {bounds: model.bounds, hull: model.hull})
  })
}
function verify(abi, packet, samples) {
  for (const draw of packet.draws) {
    const actual = abi.copyMeshResource(draw), expected = samples.get(draw.resourceId)
    same(expected.positions, actual.positions, 'Prepared position bytes differ from produced mesh')
    same(expected.textureUv, actual.textureUv, 'Prepared UV bytes differ from produced mesh')
  }
}

module.exports = {read, taskContract, measurements, verify, same}
