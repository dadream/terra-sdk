const assert = require('assert')
const {serialize, deserialize} = require('v8')
const {isDeepStrictEqual} = require('util')
const clone = value => deserialize(serialize(value))
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {surfaceBlocks} = require('../../sdk/js/terrain/surface_blocks')
const {measurementBlocks} = require('../../sdk/js/terrain/measurement_domains')
const {refineMeasurements} = require('./reference/measurement_refinement')
const {transferList} = require('../../adapters/wasm/terra_worker_host')
const {invertMatrix4} = require('../../sdk/js/math/matrix')

const drain = work => {let result; do {result = work.next()} while (!result.done); return result.value}
const summary = model => ({blocks: model.blocks, bounds: model.bounds, hull: model.hull})

module.exports = function () {
  const f = require('./reference/grid_surface_fixture')(32)
  const changed = Float32Array.from(f.positions, (value, i) => i % 3 === 2 ? value * 2.1 + 1 : value * 0.8)
  for (let orientation = 0; orientation < 8; ++orientation) {
    const uv = f.uv.slice()
    for (let i = 0; i < uv.length; i += 2) {
      const u = uv[i], v = uv[i + 1]
      uv[i] = orientation & 4 ? v : u; uv[i + 1] = orientation & 4 ? u : v
      if (orientation & 1) uv[i] = 1 - uv[i]
      if (orientation & 2) uv[i + 1] = 1 - uv[i + 1]
    }
    const original = surface.prepareSurface(f.positions, uv, f.indices, 0, f.indices.length)
    const before = JSON.stringify(summary(original))
    const model = surface.prepareSurface(changed, uv, f.indices, 0, f.indices.length)
    assert.strictEqual(model.layout, original.layout)
    assert.strictEqual(model.hull, original.hull)
    assert(isDeepStrictEqual(model.blocks, surfaceBlocks(changed, uv, model.faces, model.bounds)),
      'A shared UV layout changed height-dependent bounds or derivatives')
    assert.notDeepStrictEqual(model.blocks, original.blocks)
    for (let i = 0; i < model.blocks.length; ++i) {
      assert.notStrictEqual(model.blocks[i], original.blocks[i])
      assert.notStrictEqual(model.blocks[i].minimum, original.blocks[i].minimum)
      assert.notStrictEqual(model.blocks[i].du, original.blocks[i].du)
      assert.strictEqual(model.blocks[i].faces, original.blocks[i].faces)
      assert.strictEqual(model.blocks[i].uv, original.blocks[i].uv)
    }
    assert.strictEqual(JSON.stringify(summary(original)), before)
    const visit = value => {
      assert(value !== f.positions && value !== uv && value !== changed, 'A layout retained vertex data')
      if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) Object.values(value).forEach(visit)
    }
    visit(model.layout)
    // Separate packets clone static arrays; the host's immutable UV owner must
    // recover sharing across publications, not just within one postMessage.
    const hostUv = uv.slice(), hostIndices = f.indices.slice()
    const a = surface.attachSurface(clone(summary(original)), f.positions,
      hostUv, hostIndices, 0, hostIndices.length)
    const b = surface.attachSurface(clone(summary(model)), changed,
      hostUv, hostIndices, 0, hostIndices.length)
    assert.strictEqual(a.layout, b.layout)
    assert(isDeepStrictEqual(b.blocks, model.blocks), 'Transfer changed a surface summary')
    assert(b.blocks.every((block, i) => block.faces === a.blocks[i].faces && block.uv === a.blocks[i].uv))
    const reset = surface.attachSurface(summary(model), changed, hostUv.slice(), hostIndices, 0, hostIndices.length)
    assert.notStrictEqual(reset.layout, a.layout, 'A new coordinate owner reused an old source identity')
  }
  // Explicit native layout reuse must tolerate memory growth between slices.
  const model = surface.prepareSurface(f.positions, f.uv, f.indices, 0, f.indices.length)
  const memory = new WebAssembly.Memory({initial: Math.ceil((changed.byteLength + f.uv.byteLength) / 65536)})
  new Float32Array(memory.buffer, 0, changed.length).set(changed)
  new Float32Array(memory.buffer, changed.byteLength, f.uv.length).set(f.uv)
  const source = {get positions() {return new Float32Array(memory.buffer, 0, changed.length)},
    get uv() {return new Float32Array(memory.buffer, changed.byteLength, f.uv.length)}}
  const steps = surface.prepareSurfaceSteps(source, f.indices, 0, f.indices.length, model.layout)
  let result, turns = 0
  do {result = steps.next(); if (!result.done) {memory.grow(1); ++turns}} while (!result.done)
  assert(turns > 1)
  assert(isDeepStrictEqual(result.value.blocks, surfaceBlocks(changed, f.uv, model.faces, model.bounds)), 'Wasm growth changed reused-layout derivatives')
  assert.strictEqual(result.value.layout, model.layout)
  const cancelled = surface.prepareSurfaceSteps(source, f.indices, 0, f.indices.length, model.layout)
  assert.strictEqual(cancelled.next().done, false); cancelled.return()
  assert.strictEqual(model.blocks[0].faces, model.layout.blocks[0].faces)

  // Shared UV domains must not certify measurements of different geometry.
  const measuredFixture = require('./reference/measurement_fixture')()
  const old = surface.prepareSurface(measuredFixture.positions, measuredFixture.uv,
    measuredFixture.indices, 0, measuredFixture.indices.length)
  const next = surface.prepareSurface(Float32Array.from(measuredFixture.positions, v => v * 0.7),
    measuredFixture.uv, measuredFixture.indices, 0, measuredFixture.indices.length)
  const matrix = [1,0,0,0,0,1,0,0,0,0,1,0,0.8,0,0,1]
  const context = surface.projectionContext({projectionView: matrix}, {width: 400, height: 400}, invertMatrix4(matrix))
  const previous = drain(surface.surfaceMeasurements(old, [0,0,0], context))
  const loose = previous.regions.filter(region => !region.projection)
  assert(loose.length && old.blocks[0].uv === next.blocks[0].uv)
  assert.strictEqual(drain(measurementBlocks(next, loose)), null,
    'Shared UV topology was mistaken for immutable geometry identity')
  assert(isDeepStrictEqual(drain(refineMeasurements(next, [0,0,0], context, previous)),
    drain(surface.surfaceMeasurements(next, [0,0,0], context, false, true))), 'Foreign mesh measurements survived shared-layout refinement')

  // Shared graphs are traversed once; shared buffers are transferred once.
  const buffer = new ArrayBuffer(64), view = new Uint8Array(buffer)
  let visits = 0
  const shared = {get payload() {++visits; return view}}
  const packet = {meshes: Array.from({length: 256}, () => ({shared})), other: new Float32Array(buffer)}
  packet.self = packet
  assert.deepStrictEqual(transferList(packet), [buffer])
  assert.strictEqual(visits, 1)
  console.log('Shared UV layouts preserve eight orientations, relief, source lifetimes, measurement provenance and transfer identity')
}

if (require.main === module) module.exports()
