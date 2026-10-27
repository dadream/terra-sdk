const assert = require('assert')
const fs = require('fs')
const loader = require('../../adapters/wasm/terra_wasm')
const { TerraAbi } = require('../../adapters/wasm/terra_globe_runtime')
const { ImageryAdapter } = require('../../sdk/js/imagery/terra_imagery_adapter')

async function main() {
  assert(process.argv[2], 'A Wasm build path is required')
  const abi = new TerraAbi(await loader.instantiateTerraWasmBytes(fs.readFileSync(process.argv[2])))
  const descriptor = { kind: 'global-geodetic', matrix_level_offset: 1, maximum_level: 8, minimum_level: 0,
    tile_size: 256, level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180, -90], [180, 90]] }
  try {
    abi.loadManifest({ formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
      heightScale: 1, minimumU: -180, minimumV: -90, maximumU: 180, maximumV: 90,
      radius: 6378000, texture: descriptor })
    assert(abi.imageryLayout, 'Core imagery exports are missing')
    await require('./imagery_session_contract')(abi.module,abi.manifest)
    await require('./imagery_input_credit_contract')(abi.module,abi.manifest)
    require('./imagery_input_identity_contract')(abi.module,abi.manifest)
    await require('./imagery_reference_credit_contract')(abi.module,abi.manifest)
    await require('./imagery_reference_reclaim_contract')(abi.module,abi.manifest)
    await require('./imagery_output_credit_contract')(abi.module,abi.manifest)
    require('./imagery_credit_turn_contract')(abi.module,abi.manifest)
    require('./imagery_reference_batch_contract')(abi.module,abi.manifest)
    await require('./imagery_input_contract')(abi,descriptor)
    await require('./imagery_output_contract')(abi,descriptor)
    await require('./measurement_refinement_contract')(abi,descriptor)
    await require('./local_imagery_preparation_contract')(abi.module,abi.manifest)
    await require('./native_surface_measurement_contract')(abi.module)
    abi.resetImagery()
    const square = [[0, 0], [1, 0], [1, 1], [0, 1]]
    const triangle = [[0, 0], [1, 0], [0, 1]]
    const scenes = [
      [{ level: 0, row: 0, column: 0, pixels: 4096, hull: square }],
      [{ level: 0, row: 0, column: 0, pixels: 4096, hull: triangle },
        { level: 0, row: 0, column: 0, pixels: 4096, hull: [[1, 0], [1, 1], [0, 1]] }],
      [{ level: 2, row: 1, column: 2, pixels: 1536, hull: triangle },
        { level: 2, row: 1, column: 3, pixels: 768, hull: triangle },
        { level: 1, row: 0, column: 2, pixels: 640, hull: square }],
      [{ level: 0, row: 0, column: 0, pixels: 4096, hull: square, varied: true }],
      [{ level: 0, row: 0, column: 0, pixels: Infinity, hull: square },
        { level: 0, row: 0, column: 1, pixels: 4096, hull: square }]
    ]
    let comparisons = 0
    for (const scene of scenes) for (const capacity of [8, 64, 214, 512]) {
      const draws = scene.map((surface, index) => ({ key: { level: 0, i: index, j: 0, k: 0 },
        fragment: 0, textureNode: {level: surface.level, root: Math.floor(surface.row / 2**surface.level) * 4 +
          Math.floor(surface.column / 2**surface.level), row: surface.row, column: surface.column},
        texture: { level: surface.level + 1, matrix: surface.level + 2,
          row: surface.row, column: surface.column }, origin: [0, 0, 0], vertexCount: 3 }))
      const measurements = new Map(draws.map((draw, i) => {
        const source = scene[i], uv = { minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1 }
        const regions = source.varied ? [
          { uv: Object.assign({}, uv, { maximumU: 0.5 }), pixelsPerUv: source.pixels },
          { uv: Object.assign({}, uv, { minimumU: 0.5 }), pixelsPerUv: source.pixels / 8 }
        ] : [{ uv, pixelsPerUv: source.pixels }]
        return [draw, { visible: true, regions, bounds: uv, pixelsPerUv: source.pixels,
          hull: source.hull }]
      }))
      const options = { descriptor, targetPixelError: 1.25, maximumTextures: capacity, maximumDraws: 1024 }
      const measure = draw => measurements.get(draw)
      abi.resetImagery()
      const actual = abi.planImagery(draws, measure, options)
      const signature = result => result.draws.map(draw => [draw.key.i, draw.texture.level,
        draw.texture.matrix, draw.texture.row, draw.texture.column, draw.imageryPixelError].join('/')).sort()
      // Independent coverage oracle: every interior surface sample must have
      // exactly one admitted spatial cell, including bounded and mixed cuts.
      draws.forEach((draw, index) => {
        const selected = actual.draws.filter(d => d.key.i === index)
        for (let y = 0; y < 16; ++y) for (let x = 0; x < 16; ++x) {
          const u = (x + 0.37) / 16, v = (y + 0.61) / 16
          const hull = scene[index].hull
          if (hull.some((a, j) => { const b = hull[(j + 1) % hull.length]
            return (b[0]-a[0])*(v-a[1]) - (b[1]-a[1])*(u-a[0]) <= 0 })) continue
          const covers = selected.filter(d => {
            const scale = 2 ** (d.texture.level - draw.texture.level)
            return Math.floor((draw.texture.column + u) * scale) === d.texture.column &&
              Math.floor((draw.texture.row + v) * scale) === d.texture.row
          })
          assert.strictEqual(covers.length, 1, `Hole or overlap in scene ${comparisons}`)
        }
        assert(selected.every(d => d.textureNode.root === draw.textureNode.root))
      })
      assert(actual.quality.selectedTextureCount <= capacity)
      assert.strictEqual(actual.quality.targetPixelError, options.targetPixelError)
      assert.strictEqual(actual.quality.planner, 'terra-core')
      assert(actual.draws.every(draw => draw.imageryPixelError <= actual.quality.feasiblePixelError))
      abi.resetImagery()
      const resumed = await abi.planImageryAsync(draws, measure, options)
      assert.deepStrictEqual(signature(resumed), signature(actual), 'Bounded continuations changed the spatial cut')
      const repeated = abi.planImagery(draws, measure, options)
      assert.deepStrictEqual(signature(repeated), signature(actual), 'A stable view did not keep its imagery cut')
      comparisons += 1
    }
    const adapter = new ImageryAdapter(descriptor)
    const roots = Array.from({length: 8}, (_, root) => adapter.prepareDraw({
      textureNode: {level: 0, root, row: root >> 2, column: root % 4}}))
    const fineOptions = {descriptor, maximumTextures: 512, maximumDraws: 2048, maximumRounds: 1}
    const fineMeasure = () => ({visible: true, pixelsPerUv: 4096,
      bounds: {minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1}})
    abi.resetImagery()
    const fine = abi.planImagery([roots[0]], fineMeasure, fineOptions)
    assert(!fine.quality.rebuilding && fine.quality.planningComplete)
    // End the funded slice after one native call so this fixture observes
    // temporary roots even when several cheap calls would fit in a batch.
    const nativeCall = abi.module.call, clock = Date.now
    let refresh, now = 0
    try {
      Date.now = () => now
      abi.module.call = function(name, ...args) {
        if (name === 'terra_step_imagery') now += 4
        return nativeCall.call(this, name, ...args)
      }
      refresh = await abi.planImageryAsync([roots[0]], fineMeasure, fineOptions)
    } finally { abi.module.call = nativeCall; Date.now = clock }
    assert(refresh.quality.rebuilding && !refresh.quality.planningComplete,
      'ABI did not distinguish temporary roots during persistent cut remeasurement')
    for (let round = 0; !refresh.quality.planningComplete && round < 1000; ++round) {
      refresh = await abi.planImageryAsync([roots[0]], fineMeasure,
        {...fineOptions, continuation: true})
    }
    const keys = cut => cut.draws.map(d => `${d.texture.level}/${d.texture.row}/${d.texture.column}`).sort()
    assert(refresh.quality.planningComplete && !refresh.quality.rebuilding)
    assert.deepStrictEqual(keys(refresh), keys(fine), 'Remeasurement lost the persistent fine cut')
    const ascent = await abi.planImageryAsync([roots[0]], () => ({visible: true, pixelsPerUv: 100,
      bounds: {minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1}}), fineOptions)
    assert(ascent.quality.planningComplete && !ascent.quality.rebuilding && ascent.draws.length === 1,
      'A valid coarse cut was mislabeled as temporary root coverage')
    // Every public continuation must retain the above-target donor when an urgent
    // split cannot fit, including repeated input epochs. Force one actual
    // Native topology operation per call so intermediate cuts are observed.
    const call = abi.module.call
    abi.module.call = function(name, ...args) {
      if (name === 'terra_step_imagery') { args[2] = 1; args[3] = 1; args[4] = 0 }
      return call.call(this, name, ...args)
    }
    try {
      abi.resetImagery()
      const quiet = {...roots[0], key: {i: 0}}, urgent = {...roots[1], key: {i: 1}}
      const input = [quiet, urgent, {...urgent, key: {i: 2}}, {...urgent, key: {i: 3}}]
      const options = {descriptor, maximumTextures: 512, maximumDraws: 4, maximumRounds: 1}
      const measure = draw => ({visible: true, pixelsPerUv: (draw.key.i ? 8 : 1.3) * 256,
        bounds: {minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1}, hull: square})
      const old = abi.planImagery([quiet], () => ({...measure(quiet), pixelsPerUv: 1.3 * 256}), options)
      assert.strictEqual(old.draws.length, 4)
      for (let epoch = 0; epoch < 3; ++epoch) {
        let cut, rounds = 0
        do {
          cut = await abi.planImageryAsync(input, measure, {...options, continuation: rounds > 0})
          assert(++rounds < 64, 'Infeasible exchange did not converge across the ABI')
          if (!cut.quality.rebuilding) assert.strictEqual(cut.draws.filter(d => d.key.i === 0).length, 4,
            'ABI published an infeasible donor-only coarsening')
        } while (!cut.quality.planningComplete)
        assert(cut.quality.limitedByBudget && !cut.quality.limitedByTextureBudget &&
          !cut.quality.limitedByPartitionBudget, 'ABI lost the real draw limitation')
      }
    } finally { abi.module.call = call }
    abi.resetImagery()
    const coarse = abi.planImagery(roots, () => ({visible: true, pixelsPerUv: 100,
      bounds: {minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1}}),
    {descriptor, targetPixelError: 1.25, maximumTextures: 2})
    assert.strictEqual(coarse.draws.length, 8)
    assert.strictEqual(coarse.quality.selectedTextureCount, 2, 'Eight roots duplicated shared coarse images')
    assert(coarse.draws.every(d => d.texture.level === 0 && d.imageryPixelError === 100 / 128))
    abi.acceptImagery(coarse, 1)
    // A shared image may cover roots outside the visible cut. Admission must
    // acknowledge only measured internal nodes, not invent other root demands.
    abi.resetImagery()
    const partial = abi.planImagery([roots[0]], () => ({visible: true, pixelsPerUv: 100,
      bounds: {minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1}}), {descriptor})
    abi.acceptImagery(partial, 2)
    const invalid = { textureNode: {level: 0, root: 0, row: 0, column: 0}, texture: { level: 0, matrix: 1, row: 0, column: 0 } }
    assert.throws(() => abi.planImagery([invalid], () => ({ visible: true,
      regions: [{ uv: { minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1 }, pixelsPerUv: NaN }] }),
    { descriptor }), /Terra status 1/)
    console.log(`Wasm unified imagery coverage, budget and continuation contracts passed for ${comparisons} view and budget cases.`)
  } finally { abi.destroy() }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1 })
