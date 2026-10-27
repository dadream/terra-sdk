const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = function () {
  const n = 64, {positions: p, uv: t, indices} = require('./reference/grid_surface_fixture')(n)
  const memory = new WebAssembly.Memory({initial: Math.ceil((p.byteLength + t.byteLength) / 65536)})
  new Float32Array(memory.buffer, 0, p.length).set(p)
  new Float32Array(memory.buffer, p.byteLength, t.length).set(t)
  let reads = 0
  const counted = values => new Proxy(values, {get(target, key) {
    if (/^\d+$/.test(String(key))) ++reads
    return Reflect.get(target, key, target)
  }})
  const source = {get positions() { return counted(new Float32Array(memory.buffer, 0, p.length)) },
    get uv() { return counted(new Float32Array(memory.buffer, p.byteLength, t.length)) }}
  const make = () => {const task = surface.createSurfaceTask(source, indices, 0, indices.length); task.maximumSteps = 1; return task}
  const cancelled = make()
  assert.strictEqual(cancelled.step().done, false, 'A cold D64 strip was prepared in one uninterrupted step')
  cancelled.cancel()
  assert.strictEqual(cancelled.value, null)
  assert.strictEqual(cancelled.iterator, null)
  const task = make(), detached = memory.buffer
  let result, slices = 0, largest = 0
  do {
    reads = 0; result = task.step(); ++slices; largest = Math.max(largest, reads)
    if (!result.done && slices % 17 === 0) memory.grow(1)
  } while (!result.done)
  assert(slices > 100 && detached.byteLength === 0)
  assert(largest <= 3072, `A preparation slice scanned ${largest} vertex coordinates`)
  const model = result.value
  assert.strictEqual(model.faces.length, n * n * 6)
  assert.strictEqual(model.blocks.reduce((sum, b) => sum + b.faces.length, 0), n * n * 2)
  assert.deepStrictEqual(model.bounds, {minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1})
  assert.deepStrictEqual(model.hull, [[0,0], [1,0], [1,1], [0,1]])
  const reference = surface.prepareSurface(p, t, indices.slice(), 0, indices.length)
  assert.deepStrictEqual(model.blocks, reference.blocks, 'Wasm growth changed immutable surface summaries')
  assert.deepStrictEqual(model.faces, reference.faces, 'Cancelled topology contaminated the next task')
  memory.grow(1)
  assert.strictEqual(model.positions.buffer, memory.buffer, 'Completed preparation retained a detached Wasm view')
  // Cancellation after topology completion must also abandon partial bounds/blocks.
  const late = make()
  for (let i = 0; i < 20; ++i) assert.strictEqual(late.step().done, false)
  late.cancel()
  assert.strictEqual(late.value, null)
  assert.deepStrictEqual(model.blocks, reference.blocks)
  console.log(`Surface preparation: ${slices} slices, at most ${largest} vertex reads; cancellation and Wasm growth passed`)
}

if (require.main === module) module.exports()
