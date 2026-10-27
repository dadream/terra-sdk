const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')

async function verifyRebuildDemand() {
  const original = surface.surfaceMeasurements, fit = surface.fitPartitionSteps
  try {
    for (const coarsening of [false, true]) {
      const host = new TerrainWorkerHost(), continuations = [], fitted = [], accepted = []
      const draw = {resourceId: 1, origin: [0, 0, 0], flags: 0,
        textureNode: {level: 0, root: 0, row: 0, column: 0}}
      const packet = {frame: {sequence: 1, projectionView: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},
        draws: [draw], resources: new Map([[1, {model: {bounds: {}, hull: []}}]]),
        updateState: {modelRevision: 1}, meshIdentity: '1'}
      const descriptor = {kind: 'global-geodetic', matrix_level_offset: 1,
        bounds: [[-180, -90], [180, 90]], minimum_level: 0, maximum_level: 8,
        tile_size: 256, level_zero_columns: 2, level_zero_rows: 1}
      const message = {imagery: {descriptor, maximumTextures: 16, targetPixelError: 1.25},
        camera: {distance: 1}, viewport: {width: 400, height: 400}}
      surface.surfaceMeasurements = function* () {
        return {pixelsPerUv: 100, visible: true, refinable: false, regions: []}
      }
      surface.fitPartitionSteps = function* (plan, ...args) {
        fitted.push(plan.stage)
        return yield* fit(plan, ...args)
      }
      let round = -1
      host.abi = {
        ...require('./reference/imagery_task_fixture'),
        async planImageryAsync(draws, measure, options) {
          continuations.push(options.continuation)
          const stage = ++round
          return {stage, draws, levels: new Set(), quality: {
            rebuilding: stage === 1 || stage === 2,
            planningComplete: stage === 0 || stage === 4,
            // Round 3 is usable partial refinement. Round 4 is valid coarsening
            // under capacity, so neither can be mistaken for temporary roots.
            meetsTarget: stage === 0, limitedByBudget: stage === 4,
            targetPixelError: 1.25}}
        },
        acceptImagery(plan) {if (plan) accepted.push(plan.stage)}
      }
      host.imageryJob = {coarsening, exact: new Set(), precise: new Map(), releaseMeshes() {}}
      const published = []
      try {
        for (let i = 0; i < 100; ++i) {
          const result = await host.planImagery(packet, message)
          if (result.imageryPlan) published.push(result.imageryPlan)
          if (result.imageryPlan && result.imageryPlan.quality.planningComplete) break
        }
        assert.strictEqual(published[published.length - 1].stage, 0)
        // Preserve a completed previous plan in the host cache: an incorrect
        // continuation signature alone would replay that cache and stall forever.
        message.camera = {distance: 2}
        let lastDemand = published[published.length - 1]
        for (let i = 0; i < 100; ++i) {
          const result = await host.planImagery(packet, message)
          if (round === 1 || round === 2) {
            assert(result.pending && !result.imageryPlan, 'Rebuilding revoked active fine demand')
            assert.strictEqual(host.partitionFit, null, 'Temporary roots started partition production')
            assert(lastDemand && !lastDemand.quality.rebuilding,
              'Rebuilding lost the previous usable preview or fine demand')
          }
          if (result.imageryPlan) {lastDemand = result.imageryPlan; published.push(lastDemand)}
          if (result.imageryPlan && result.imageryPlan.quality.planningComplete) break
        }
        assert.strictEqual(lastDemand.stage, 4, 'Capacity-limited coarsening failed to publish')
        assert(lastDemand.quality.limitedByBudget && !lastDemand.quality.rebuilding)
        if (!coarsening) assert(published.some(plan => plan.stage === 3),
          'Usable partial refinement waited for whole-cut completion')
        assert(!published.some(plan => plan.quality.rebuilding), 'Temporary coverage escaped the Worker')
        assert.deepStrictEqual(continuations, [false, false, true, true, true])
        assert.deepStrictEqual(fitted, [0, 3, 4])
        assert.deepStrictEqual(accepted, [0, 4])
      } finally {host.clearPlanning()}
    }
  } finally {surface.surfaceMeasurements = original; surface.fitPartitionSteps = fit}
}
module.exports = verifyRebuildDemand
if (require.main === module) verifyRebuildDemand().then(() => console.log('Imagery rebuild demand contracts passed'))
  .catch(error => {console.error(error); process.exitCode = 1})
