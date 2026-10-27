const assert = require('assert')
const {PartitionFitCache} = require('../../sdk/js/terrain/partition_fit_cache')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = function () {
  const fixture = require('./reference/grid_surface_fixture')(32)
  const model = surface.prepareSurface(fixture.positions, fixture.uv, fixture.indices, 0, fixture.indices.length)
  const sourceTexture = {level:0, matrix:1, row:0, column:0}
  const initial = {draws:Array.from({length:4}, (_, i) => ({resourceId:1, sourceTexture,
    texture:{level:1, matrix:2, row:i >> 1, column:i % 2}, imageryPixelError:1})),
  quality:{planningComplete:false, limitedByBudget:false, limitedByPartitionBudget:false, cachedNodeCount:5}}
  const options = {maximumPartitionBytes:1e9, targetPixelError:1.25, sourceUvScale:1}
  let calls = 0
  const modelFor = () => { ++calls; return model }
  const drain = work => { let step; do { step = work.next() } while (!step.done); return step.value }
  const cache = new PartitionFitCache()
  const first = drain(cache.fit(initial, options, modelFor))
  assert.deepStrictEqual(first, surface.fitImageryPartitionBudget(initial, options, () => model))
  const before = calls
  const latest = {...initial, quality:{...initial.quality, planningComplete:true, cachedNodeCount:9}}
  const reused = drain(cache.fit(latest, {...options}, modelFor))
  assert.strictEqual(calls, before, 'Unchanged draw snapshot was priced again')
  assert.strictEqual(reused.draws, first.draws)
  assert(reused.quality.planningComplete && reused.quality.cachedNodeCount === 9,
    'Cached partition fit hid fresh progress')
  assert(!first.quality.planningComplete, 'Reuse mutated an earlier result')
  for (const changed of [
    {...options, maximumPartitionBytes:first.quality.partitionBytes - 1},
    {...options, targetPixelError:2}, {...options, sourceUvScale:8}
  ]) {
    const actual = drain(cache.fit(latest, changed, modelFor))
    assert.deepStrictEqual(actual, surface.fitImageryPartitionBudget(latest, changed, () => model))
  }
  const limited = {...latest, quality:{...latest.quality, limitedByBudget:true, limitedByPartitionBudget:true}}
  assert(drain(cache.fit(limited, options, modelFor)).quality.limitedByPartitionBudget)
  const current = drain(cache.fit(latest, options, modelFor))
  assert(!current.quality.limitedByPartitionBudget)
  const held = cache.entry
  const otherFixture = require('./reference/grid_surface_fixture')(64)
  const other = surface.prepareSurface(otherFixture.positions, otherFixture.uv, otherFixture.indices, 0, otherFixture.indices.length)
  const pending = cache.fit({...latest, draws:latest.draws.slice()}, options, () => other)
  assert(!pending.next().done, 'Cancellation fixture did not suspend partition pricing')
  pending.return()
  assert.strictEqual(cache.entry, held, 'Cancelled price replaced the completed cache')
  assert.strictEqual(drain(cache.fit(latest, options, modelFor)).draws, current.draws)
  cache.clear()
  const restart = calls
  drain(cache.fit(latest, options, modelFor))
  assert(calls > restart, 'Reset retained the old partition price')
  console.log('Immutable partition fit reuse, fresh quality, admission invalidation and cancellation passed')
}
