const assert = require('assert')
const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const {bindMeshModel} = require('../../adapters/wasm/borrowed_mesh')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = function verifyMeshBorrow(abi) {
  const draw = abi.getMeshResources().find(draw => !draw.flags)
  assert(draw, 'Borrow fixture needs visible native geometry')
  const before = abi.meshPayloadBytes(), copy = abi.copyMeshResource(draw)
  const loan = abi.borrowMeshResource(draw), other = abi.borrowMeshResource(draw)
  const release = holdMeshes([loan])
  try {
    assert.strictEqual(loan.positions.buffer, abi.module.exports.memory.buffer)
    assert.strictEqual(loan.positions.byteOffset,
      abi.module.call('terra_get_mesh_position_view', abi.context, draw.resourceId))
    assert.strictEqual(abi.meshPayloadBytes(), before, 'Native loans duplicated mesh payload')
    const indices = abi.getIndices()
    const preparation = surface.createSurfaceTask({get positions() {return loan.positions},
      get uv() {return loan.textureUv}}, indices, draw.firstIndex, draw.indexCount)
    let prepared, preparationTurns = 0
    try {
      do {
        prepared = preparation.step()
        if (!prepared.done) {abi.module.exports.memory.grow(1); ++preparationTurns}
      } while (!prepared.done)
    } finally {if (!preparation.done) preparation.cancel()}
    assert(preparationTurns > 0, 'Actual mesh preparation did not yield')
    const model = bindMeshModel(loan, prepared.value)
    const reference = surface.prepareSurface(copy.positions, copy.textureUv, indices, draw.firstIndex, draw.indexCount)
    assert.deepStrictEqual(model.blocks, reference.blocks)
    assert.deepStrictEqual(model.hull, reference.hull)
    const context = surface.projectionContext(abi.getFrame(), {width: 1280, height: 720})
    const expected = surface.measureSurface(reference, draw.origin, context, true)
    const work = surface.surfaceMeasurements(model, draw.origin, context, false, true)
    const detached = loan.positions
    loan.ownership.retire()
    let result, turns = 0
    do {
      result = work.next()
      if (!result.done) { abi.module.exports.memory.grow(1); ++turns }
    } while (!result.done)
    assert(turns > 0 && expected.visible, 'Native fixture skipped cooperative visible measurement')
    assert.strictEqual(detached.byteLength, 0)
    assert.deepStrictEqual(result.value, expected, 'Actual Wasm growth corrupted a resumed measurement')
    assert.deepStrictEqual(loan.positions, copy.positions)
    assert.deepStrictEqual(other.textureUv, copy.textureUv)
    release()
    assert.throws(() => loan.positions, /loan has ended/)
    assert.deepStrictEqual(other.positions, copy.positions, 'Independent loan was invalidated')
    assert.strictEqual(abi.meshPayloadBytes(), before)
  } finally { loan.ownership.retire(); release(); other.ownership.retire() }
}
