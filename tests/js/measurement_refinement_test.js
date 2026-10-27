const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {invertMatrix4} = require('../../sdk/js/math/matrix')
const {refineMeasurements} = require('./reference/measurement_refinement')

function drain(work, afterStep) {
  let result
  do { result = work.next(); if (!result.done && afterStep) afterStep() } while (!result.done)
  return result.value
}

module.exports = function verifyMeasurementReuse(refine = refineMeasurements) {
  const f = require('./reference/measurement_fixture')()
  const model = surface.prepareSurface(f.positions, f.uv, f.indices, 0, f.indices.length)
  const memory = new WebAssembly.Memory({initial: Math.ceil((f.positions.byteLength + f.uv.byteLength) / 65536)})
  new Float32Array(memory.buffer, 0, f.positions.length).set(f.positions)
  new Float32Array(memory.buffer, f.positions.byteLength, f.uv.length).set(f.uv)
  Object.defineProperties(model, {
    positions: {get: () => new Float32Array(memory.buffer, 0, f.positions.length)},
    uv: {get: () => new Float32Array(memory.buffer, f.positions.byteLength, f.uv.length)}
  })
  const original = surface.surfaceMeasurements
  for (const slope of [0, 0.6, 0.8, 1, 1.7]) {
    const matrix = [1,0,0,0,0,1,0,0,0,0,1,0,slope,0,0,1]
    const context = surface.projectionContext({projectionView: matrix},
      {width: 400, height: 400}, invertMatrix4(matrix))
    const previous = drain(original(model, [0,0,0], context, false, false))
    const complete = drain(original(model, [0,0,0], context, false, true))
    const before = JSON.stringify(previous), visited = []
    surface.surfaceMeasurements = function* (input, ...args) {
      visited.push(...input.blocks)
      return yield* original(input, ...args)
    }
    let refined
    try { refined = drain(refine(model, [0,0,0], context, previous), () => memory.grow(1)) }
    finally { surface.surfaceMeasurements = original }
    assert.deepStrictEqual(refined.regions, complete.regions, 'Refinement changed an SSE region')
    assert.strictEqual(refined.visible, complete.visible)
    assert.deepStrictEqual(refined.uv, complete.uv)
    assert.strictEqual(refined.refinable, false)
    assert(refined.pixelsPerUv <= complete.pixelsPerUv * (1 + 1e-12))
    assert(refined.regions.every(r => r.pixelsPerUv <= refined.pixelsPerUv * (1 + 1e-12)))
    assert(refined.centerDistance <= complete.centerDistance)
    assert.strictEqual(JSON.stringify(previous), before, 'Refinement changed published metadata')
    if (previous.regions.some(r => r.projection)) {
      const loose = new Set(previous.regions.filter(r => !r.projection).map(r => r.uv))
      assert(visited.every(block => loose.has(block.uv)), 'Already exact blocks were measured again')
      for (const region of previous.regions.filter(r => r.projection)) {
        assert(refined.regions.includes(region), 'Exact projective output was copied or reconstructed')
      }
    }
    // A foreign summary cannot authorize omission of another model's blocks.
    if (slope === 0.8) {
      const foreign = {...previous, regions: previous.regions.map(r => ({...r, uv: {...r.uv}}))}
      assert.deepStrictEqual(drain(refine(model, [0,0,0], context, foreign)).regions, complete.regions)
    }
  }
  // Correlated derivatives make the box's facing interval inconclusive even
  // though both triangles face away. Tightening must retract that visibility:
  // otherwise the planner emits no cells but the consumer waits for this mesh.
  const hiddenModel = surface.prepareSurface(new Float32Array([
    -.2,-.2,0, .2,-.2,0, -.2,.2,0, .2,.2,0, -.2,.2,0, .2,-.2,0
  ]), new Float32Array([0,0,1,0,0,1, 0,0,1,0,0,1]),
  new Uint16Array([0,1,2,2,3,3,3,4,5]), 0, 9)
  const matrix = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
  const context = surface.projectionContext({projectionView: matrix},
    {width: 400, height: 400}, invertMatrix4(matrix))
  const previous = drain(original(hiddenModel, [0,0,0], context))
  const complete = drain(original(hiddenModel, [0,0,0], context, false, true))
  assert(previous.visible && previous.refinable && previous.regions.length)
  assert.strictEqual(complete.visible, false)
  const refined = drain(refine(hiddenModel, [0,0,0], context, previous))
  assert.strictEqual(refined.visible, false, 'Exact rejection retained provisional visibility')
  assert.deepStrictEqual(refined.regions, complete.regions)
  assert.deepStrictEqual(refined.uv, complete.uv)
  const {mergeImageryDemand} = require('../../sdk/js/imagery/imagery_demand')
  const target = {resourceId: 1, geometryKey: 'hidden', texture: {level: 0}}
  const merged = mergeImageryDemand([target], null, {draws: [], quality: {planningComplete: true}},
    new Map(), [{...refined, resourceId: 1}], {sameView: true, measurementsCurrent: true,
      scheduledImagery: true, hidden: () => false, rootDraw: draw => draw})
  assert.strictEqual(merged.plan.quality.planningComplete, true,
    'A fully rejected mesh kept completed image planning alive')
}

if (require.main === module) {
  module.exports()
  console.log('Block-local refinement, exact region reuse and immutable metadata passed')
}
