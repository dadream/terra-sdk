const assert = require('assert')
const { planImageryFrontier } = require('../../apps/miniprogram/utils/terra_webgl_renderer')
const tileKey = t => [t.level, t.row, t.column].join('/')
const bounds = (u0, u1, v0 = 0, v1 = 1) => ({ minimumU: u0, maximumU: u1, minimumV: v0, maximumV: v1 })
const source = { level: 0, matrix: 1, row: 0, column: 0 }
const draw = (id, region, density) => ({ geometryKey: id, texture: source,
  measurement: { visible: true, pixelsPerUv: density, bounds: region,
    regions: [{ uv: region, pixelsPerUv: density }] } })
const descriptor = { tile_size: 256, maximum_level: 12 }
function plan(draws, options = {}) {
  return planImageryFrontier(null, draws, null, null, null, descriptor,
    Object.assign({ targetPixelError: 1.25, maximumTextures: 256, maximumDraws: 4096,
      measureDraw: draw => draw.measurement }, options))
}
function tiles(result) {
  return Array.from(new Map(result.draws.map(d => [tileKey(d.texture), d.texture])).values())
    .sort((a, b) => tileKey(a).localeCompare(tileKey(b)))
}
function assertCut(result) {
  const selected = tiles(result)
  for (const a of selected) for (const b of selected) {
    if (a.level >= b.level) continue
    const scale = 2 ** (b.level - a.level)
    assert(!(Math.floor(b.row / scale) === a.row && Math.floor(b.column / scale) === a.column),
      'A spatial imagery cut cannot contain a parent and its descendant')
  }
}
const draws = [draw('a', bounds(0, 0.55), 1700), draw('b', bounds(0.45, 1), 600)]
const selected = plan(draws)
assertCut(selected)
assert.deepStrictEqual(tiles(plan(draws.slice().reverse())), tiles(selected),
  'Terrain traversal order must not change imagery selection')
const repartitioned = [draw('a1', bounds(0, 0.25), 1700),
  draw('a2', bounds(0.25, 0.55), 1700), draws[1]]
assert.deepStrictEqual(tiles(plan(repartitioned)), tiles(selected),
  'Splitting a terrain fragment must not change the imagery cut')
const limited = plan(draws, { maximumTextures: 7 })
assertCut(limited)
assert(tiles(limited).length <= 7)
assert(limited.quality.limitedByTextureBudget)
const hidden = draw('hidden', bounds(0, 1), 1e8)
hidden.measurement.visible = false
assert.deepStrictEqual(tiles(plan(draws.concat(hidden))), tiles(selected))
const tiny = draw('tiny', bounds(0, 1), 250)
const coarse = plan([tiny])
assert.strictEqual(tiles(coarse)[0].level, 0)
const refined = plan([draw('tiny', bounds(0, 1), 330)])
assert.strictEqual(tiles(refined)[0].level, 1)
assert.strictEqual(tiles(plan([draw('replacement', bounds(0, 1), 310)],
  { previousLevels: refined.levels }))[0].level, 1, 'Hysteresis belongs to the imagery tile')
assert.strictEqual(tiles(plan([tiny], { previousLevels: refined.levels }))[0].level, 0)
console.log('Spatial imagery frontier contracts passed.')