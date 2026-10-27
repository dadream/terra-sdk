const assert = require('assert')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')

module.exports = async function verifyImageryInput(abi, descriptor) {
  assert.strictEqual(abi.module.call('terra_sizeof_imagery_region_v4'),176)
  const draw = new ImageryAdapter(descriptor).prepareDraw({
    textureNode: {level: 0, root: 0, row: 0, column: 0}})
  const uv = {minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1}
  const regions = Array.from({length: 16384}, (_, index) => index % 3 === 0
    ? {uv, pixelsPerUv: 64}
    : {uv, pixelsPerUv: 128, projection: [0,32,0,0,0,32,1,.25,.5],
      triangle: [[0,0],[1,0],[0,1]], ...(index % 3 === 1 ? {numeratorBound: 128} : {})})
  const measurement = {visible: true, pixelsPerUv: 128, bounds: uv,
    hull: [[0,0],[1,0],[1,1],[0,1]], regions}
  const options = {descriptor, maximumTextures: 64, maximumDraws: 512,
    targetPixelError: 1.25, maximumRounds: 1, detached: true}
  const alloc = abi.alloc, free = abi.free, call = abi.module.call
  const live = new Set()
  let begins = 0
  abi.alloc = function(bytes) {const p = alloc.call(this, bytes); live.add(p); return p}
  abi.free = function(pointer) {assert(live.delete(pointer), 'Scratch released twice');return free.call(this, pointer)}
  abi.module.call = function(name, ...args) {
    if (name === 'terra_begin_imagery') ++begins
    return call.call(this, name, ...args)
  }
  try {
    for (const slices of [1, 2, 6]) {
      abi.resetImagery()
      const before = begins, task = abi.createImageryTask([draw], () => measurement, options)
      try {
        for (let i = 0; i < slices; ++i) {
          assert.strictEqual(task.step().done, false, 'Large input was copied in one scheduler turn')
          abi.module.exports.memory.grow(1)
        }
        assert.strictEqual(begins, before, 'Partially packed input reached the native planner')
        assert(live.size > 0, 'Fixture did not hold native input scratch')
      } finally {task.cancel();task.cancel()}
      assert.strictEqual(live.size, 0, 'Cancelled input retained native scratch')
    }
    const run = async () => {
      let result, rounds = 0
      do {
        const task = abi.createImageryTask([draw], () => measurement,
          {...options, continuation: rounds > 0})
        try {
          let step
          do {
            step = task.step()
            if (!step.done) abi.module.exports.memory.grow(1)
          } while (!step.done)
          result = step.value
        } finally {task.cancel()}
        assert(++rounds < 1024, 'Staged input did not converge')
        assert.strictEqual(live.size, 0, 'Completed packing retained scratch')
      } while (!result.quality.planningComplete)
      return result
    }
    abi.resetImagery()
    const staged = await run()
    abi.resetImagery()
    const synchronous = abi.planImagery([draw], () => measurement, options)
    assert.deepStrictEqual(staged, synchronous, 'Input slicing or Wasm growth changed the complete native cut')
    const zero = {uv,pixelsPerUv:128,projection:Array(9).fill(0),triangle:[[0,0],[1,0],[0,1]],domain:0}
    const explicit = abi.planImagery([draw],()=>({...measurement,regions:[zero]}),options)
    assert(explicit.draws.length && explicit.draws.some(d=>d.imageryPixelError===Infinity),
      'Explicit zero-W projection was treated as an absent projection')
    const absent = abi.planImagery([draw],()=>({...measurement,regions:[{uv,pixelsPerUv:128,domain:335}]}),options)
    assert(absent.draws.length && absent.draws.every(d=>Number.isFinite(d.imageryPixelError)),
      'Absent projection inherited stale projection fields')
    assert.throws(()=>abi.planImagery([draw],()=>({...measurement,regions:[{...zero,domain:-1}]}),options),
      /Invalid measurement domain/)
    assert.strictEqual(live.size,0,'Invalid provenance retained packing scratch')
    regions[10000] = {...regions[10000], pixelsPerUv: NaN}
    await assert.rejects(run(), /Terra status 1/)
    assert.strictEqual(live.size, 0, 'Rejected native input retained packing allocations')
  } finally {
    abi.alloc = alloc; abi.free = free; abi.module.call = call
    abi.resetImagery()
  }
  console.log('Bounded imagery input, scratch cancellation, Wasm growth and exact native parity passed')
}
