const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {MeshCopyPlan, textureResourceKey, meshCutBytes} = require('../../sdk/js/resources/mesh_coordinates')
const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const {GeometryCache, geometryRequests} = require('../../adapters/webgl/geometry_cache')

const draw = (resourceId, textureResourceId = 512) => ({resourceId, textureResourceId, vertexCount: 3, firstIndex: 0, indexCount: 3})
const key = d => 'mesh:' + d.resourceId
const indices = new Uint16Array([0, 1, 2])

function copy(frames, draws, sequence = 1) {
  const plan = new MeshCopyPlan(frames, draws), credit = frames.reserve(plan.bytes)
  let positions = 0, uv = 0
  try {
    plan.allocate(credit)
    const frame = plan.read({getIndices: () => indices.slice(),
      copyMeshPositions() { ++positions; return new Float32Array(9) },
      copyMeshUv() { ++uv; return new Float32Array([0, 0, 1, 0, 0, 1]) }
    }, {frame: {sequence}, draws})
    frames.present(sequence)
    return {frame, positions, uv}
  } finally { plan.release(); credit.release() }
}

{
  const ledger = new ResourceLedger(102), frames = new MeshFrames(ledger)
  const initial = copy(frames, [draw(1), draw(2), draw(1)])
  assert.strictEqual(initial.positions, 2)
  assert.strictEqual(initial.uv, 1)
  assert.strictEqual(ledger.bytes, 102)
  assert.strictEqual(meshCutBytes([draw(1), draw(2), draw(1)]), ledger.bytes - indices.byteLength,
    'Selected-cut quote disagrees with physical position/UV ownership')
  assert.strictEqual(frames.copiedBytes, 102)
  assert.strictEqual(frames.resources.get(1).textureUv, frames.resources.get(2).textureUv)
  assert.strictEqual(ledger.stats().owners['mesh-uv-host'].retired, 24)
  const release = holdMeshes([frames.resources.get(1)])
  frames.clear()
  assert.strictEqual(ledger.bytes, 66)
  release()
  assert.strictEqual(ledger.bytes, 0)
}

{
  const frames = new MeshFrames(new ResourceLedger(200))
  copy(frames, [draw(1)])
  const pending = new MeshCopyPlan(frames, [draw(2)])
  assert.strictEqual(pending.bytes, 36, 'An existing UV was quoted again')
  const credit = frames.reserve(pending.bytes)
  pending.allocate(credit)
  frames.clear()
  assert.strictEqual(frames.ledger.bytes, 60, 'Source cancellation refunded pending UV or destination credit')
  assert.throws(() => pending.adopt({additions: [], textureAdditions: []}), /invalidated/)
  pending.release(); credit.release()
  assert.strictEqual(frames.ledger.bytes, 0)
}

function cache(ledger, maximumBytes) {
  const disposed = [], result = new GeometryCache({ledger, maximumBytes,
    dispose(value) { if (value.releaseUv) value.releaseUv(); disposed.push(value.key) }})
  result.disposed = disposed
  return result
}

// A malformed reply or a failed model attachment cannot leave a partial pool.
for (const failure of ['identity', 'size', 'duplicate', 'attachment']) {
  const frames = new MeshFrames(new ResourceLedger(102)), draws = [draw(1), draw(2)]
  const plan = new MeshCopyPlan(frames, draws), credit = frames.reserve(plan.bytes)
  plan.allocate(credit)
  const packet = {frame: {sequence: 1}, indices: indices.slice(), draws,
    textureAdditions: [{textureResourceId: 512, textureUv: new Float32Array(6)}],
    additions: draws.map(d => ({resourceId: d.resourceId, textureResourceId: 512, positions: new Float32Array(9)}))}
  if (failure === 'identity') packet.additions[1].textureResourceId = 513
  if (failure === 'size') packet.textureAdditions[0].textureUv = new Float32Array(5)
  if (failure === 'duplicate') packet.additions[1].resourceId = 1
  try {
    assert.throws(() => plan.adopt(packet, () => {
      if (failure === 'attachment') throw new Error('Model attachment failed')
    }))
  } finally { plan.release(); credit.release() }
  assert.strictEqual(frames.ledger.bytes, 0)
  assert.strictEqual(frames.textureResources.size, 0)
  assert.strictEqual(frames.resources.size, 0)
}
function upload(cache, draws) {
  const outputs = cache.reserveBatch(geometryRequests(draws, key), 0, 'geometry-producer')
  assert(outputs, 'Complete shared geometry group was refused')
  try {
    for (const draw of draws) {
      const uvKey = textureResourceKey(draw), uv = outputs.take(uvKey)
      if (uv) { assert(uv.commit({kind: 'uv', key: uvKey})); cache.ownCoordinates(uvKey) }
    }
    for (const draw of draws) {
      const destination = outputs.take(key(draw))
      if (!destination) continue
      const releaseUv = cache.holdCoordinates(textureResourceKey(draw), destination.lease)
      assert(releaseUv)
      assert(destination.commit({key: key(draw), releaseUv}))
    }
  } finally { outputs.release(); outputs.credit.release() }
}

{
  const ledger = new ResourceLedger(96), geometry = cache(ledger, 96)
  upload(geometry, [draw(1), draw(2)])
  assert.strictEqual(geometry.bytes, 96)
  assert.strictEqual(geometry.values().length, 2)
  upload(geometry, [draw(3)])
  assert(geometry.has('mesh:2') && geometry.has('mesh:3'))
  assert.strictEqual(ledger.bytes, 96, 'New geometry duplicated an existing UV allocation')
  assert(!geometry.disposed.includes(textureResourceKey(draw(1))), 'Eviction destroyed the borrowed shared UV')
  upload(geometry, [draw(4, 513)])
  assert.strictEqual(ledger.bytes, 60)
  assert.strictEqual(geometry.values().length, 1)
  assert.strictEqual(geometry.disposed.filter(id => id === textureResourceKey(draw(1))).length, 1)
  geometry.clear()
  assert.strictEqual(ledger.bytes, 0)
}

{
  const ledger = new ResourceLedger(95), geometry = cache(ledger, 95)
  assert.strictEqual(geometry.reserveBatch(geometryRequests([draw(1), draw(2)], key), 0, 'producer'), null)
  assert.strictEqual(ledger.bytes, 0)
  assert.strictEqual(geometry.disposed.length, 0)
}

console.log('Shared UV copy credit, source retirement, aggregate GPU capacity and dependent eviction passed')
