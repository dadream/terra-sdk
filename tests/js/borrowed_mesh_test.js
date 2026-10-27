const assert = require('assert')
const {borrowMesh, bindMeshModel} = require('../../adapters/wasm/borrowed_mesh')
const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const plan = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = function verifyBorrowedMesh() {
  const memory = new WebAssembly.Memory({initial: 1})
  const n = 40, positions = [], uv = [], indices = []
  for (let y = 0; y <= n; ++y) for (let x = 0; x <= n; ++x) {
    positions.push(x / n * 1.6 - 0.8, y / n * 1.6 - 0.8, x / n * 0.2)
    uv.push(x / n, y / n)
  }
  for (let y = 0; y < n; ++y) {
    if (indices.length) indices.push(indices[indices.length - 1], y * (n + 1))
    for (let x = 0; x <= n; ++x) indices.push(y * (n + 1) + x, (y + 1) * (n + 1) + x)
  }
  const positionPointer = 4, uvPointer = positionPointer + positions.length * 4
  new Float32Array(memory.buffer, positionPointer, positions.length).set(positions)
  new Float32Array(memory.buffer, uvPointer, uv.length).set(uv)
  let loans = 0, badPointer = false
  const abi = {context: 1,
    nativeCall(name, context, id) {
      assert.strictEqual(context, 1); assert.strictEqual(id, 7)
      if (name === 'terra_acquire_mesh_resource') ++loans
      else { assert.strictEqual(name, 'terra_release_mesh_resource'); --loans }
      return 0
    },
    module: {refreshMemory: () => ({bytes: new Uint8Array(memory.buffer)}),
      call: name => badPointer ? 3 : name === 'terra_get_mesh_position_view' ? positionPointer : uvPointer}
  }
  const draw = {resourceId: 7, positionFloatCount: positions.length, textureFloatCount: uv.length}
  const resource = borrowMesh(abi, draw), first = resource.positions
  const copied = {positions: first.slice(), textureUv: resource.textureUv.slice()}
  const strip = new Uint16Array(indices)
  const prepare = r => plan.prepareSurface(r.positions, r.textureUv, strip, 0, strip.length)
  const model = bindMeshModel(resource, prepare(resource)), reference = prepare(copied)
  assert.strictEqual(model.positions.buffer, memory.buffer)
  const release = holdMeshes([resource])
  resource.ownership.retire()
  assert.strictEqual(loans, 1, 'Frame retirement invalidated a running measurement')
  memory.grow(1)
  assert.strictEqual(first.byteLength, 0)
  assert.strictEqual(resource.positions.buffer, memory.buffer)
  assert.deepStrictEqual(model.positions, copied.positions)
  const context = plan.projectionContext({projectionView: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0.3,1]},
    {width: 640, height: 360})
  let growths = 0
  const measure = plan.surfaceMeasurements(model, [0,0,0], context, false, true)
  let result
  do { result = measure.next(); if (!result.done) { memory.grow(1); ++growths } } while (!result.done)
  const expected = plan.measureSurface(reference, [0,0,0], context, true)
  assert(expected.visible && expected.pixelsPerUv > 0 && growths > 16)
  assert.deepStrictEqual(result.value, expected, 'Cooperative measurement used detached native views')
  const cells = [{key: 'loan-growth', bounds: {minimumU: 0.13, minimumV: 0.17, maximumU: 0.87, maximumV: 0.89}}]
  const run = (task, grow) => {
    task.maximumSteps = 1
    let value
    do { value = task.step(); if (!value.done && grow) memory.grow(1) } while (!value.done)
    return value.value
  }
  const partition = run(plan.createPartitionTask(model, cells), true)
  assert(partition.length && partition[0].positions.length)
  assert.deepStrictEqual(partition, run(plan.createPartitionTask(reference, cells), false),
    'Cooperative partition used detached positions or UV')
  const hits = plan.partitionCacheStats().hits
  release(); release()
  assert.strictEqual(loans, 0)
  assert.throws(() => resource.positions, /loan has ended/)
  memory.grow(1)
  run(plan.createPartitionTask(prepare(copied), cells), false)
  assert(plan.partitionCacheStats().hits > hits, 'Cached topology retained expired native UV')
  assert.deepStrictEqual(copied.positions, new Float32Array(positions), 'Host copy changed with native growth')
  badPointer = true
  assert.throws(() => borrowMesh(abi, draw), /Invalid borrowed mesh view/)
  assert.strictEqual(loans, 0, 'Failed view validation leaked a native loan')
  badPointer = false
  const destroyed = borrowMesh(abi, draw)
  abi.context = 0; loans = 0 // Destroying the native context ends all loans.
  assert.throws(() => destroyed.textureUv, /loan has ended/)
  destroyed.ownership.retire()
  assert.strictEqual(loans, 0, 'Late JS disposal called a destroyed native context')
}
