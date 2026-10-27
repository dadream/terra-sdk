const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')

async function verifyDemandMeasurements() {
  const original = surface.surfaceMeasurements
  try {
    for (const coarsening of [false, true]) for (const mode of ['safe', 'local', 'shared', 'limited', 'near']) {
      const host = new TerrainWorkerHost(), visits = [[], []], boundsVisits = [0, 0]
      const models = [{bounds: {}, hull: []}, {bounds: {}, hull: []}]
      const draws = models.map((model, i) => ({resourceId: i + 1, origin: [0, 0, 0], flags: 0,
        textureNode: {level: 0, root: i, row: 0, column: 0}, texture: {level: 1, matrix: 2, row: 0, column: i}}))
      const descriptor = {kind: 'global-geodetic', matrix_level_offset: 1, bounds: [[-180, -90], [180, 90]], minimum_level: 0, maximum_level: 19, tile_size: 256,
        level_zero_columns: 2, level_zero_rows: 1}
      const imagery = {descriptor, maximumTextures: 2, maximumDraws: 32, targetPixelError: 1.25}
      const packet = {frame: {sequence: 1, projectionView: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},
        draws, resources: new Map(models.map((model, i) => [i + 1, {model}])),
        updateState: {modelRevision: 1}, meshIdentity: '1,2'}
      surface.surfaceMeasurements = function* (model, origin, context, bounds, tight) {
        const index = models.indexOf(model)
        if (bounds) ++boundsVisits[index]
        if (!bounds) visits[index].push(tight ? 'tight' : 'exact')
        const pixelsPerUv = mode === 'near' && bounds ? Infinity :
          (mode === 'limited' && index === 0 || bounds && mode !== 'safe') ? 500 : 100
        return {pixelsPerUv, visible: true, refinable: !tight, regions: []}
      }
      host.abi = {...require('./reference/imagery_task_fixture'), async planImageryAsync(source, measure) {
        // In 'shared', region 2's safe-looking bound occupies the shared quota.
        const burden = mode === 'shared' && measure(source[1]).pixelsPerUv > 100
        const planned = source.map((draw, i) => ({...draw,
          imageryPixelError: i === 0 ? (burden ? 2 : measure(draw).pixelsPerUv / 256) : 0.1}))
        const meetsTarget = planned.every(draw => draw.imageryPixelError <= 1.25)
        // Several selected imagery cells can refer to the same terrain owner.
        return {draws: planned.concat(planned[0]), levels: new Set(), quality: {planningComplete: true,
          targetPixelError: 1.25, meetsTarget, limitedByBudget: !meetsTarget}}
      }}
      host.imageryJob = {coarsening, exact: new Set(), precise: new Map(), releaseMeshes() {}}
      let result
      try {
        for (let round = 0; round < 100; ++round) {
          result = await host.planImagery(packet, {imagery, camera: {distance: 1}, viewport: {width: 400, height: 400}})
          if (result.imageryPlan && !result.pending && !result.continuation) break
        }
        assert(result.imageryPlan && !result.pending && !result.continuation, `${mode} did not converge`)
        assert.strictEqual(result.imageryPlan.quality.meetsTarget, mode !== 'limited')
        assert.deepStrictEqual(boundsVisits, [1, 1],
          'Tightening an immutable projection repeated its obsolete conservative pass')
        if (mode === 'safe') assert.deepStrictEqual(visits, [[], []],
          'A safe upper bound forced a whole-view triangle scan')
        if (mode === 'local') assert.deepStrictEqual(visits, [['exact'], []],
          'One local overestimate forced unrelated surface measurement')
        if (mode === 'shared' || mode === 'limited') assert(visits[1].length,
          'An apparently passing region was never tightened to verify shared capacity')
        if (mode === 'limited') assert.deepStrictEqual(visits, [['exact', 'tight'], ['exact', 'tight']],
          'A real limit restarted exact work or was accepted before checking all bounds')
        if (mode === 'near') assert.deepStrictEqual(visits, [['exact'], ['exact']],
          'An infinite near-plane bound was accepted without clipping')
        assert.strictEqual(result.measurements.length, 2, 'Completed demand lost its full supporting snapshot')
      } finally { host.clearPlanning() }
    }
  } finally { surface.surfaceMeasurements = original }
}
module.exports = verifyDemandMeasurements
if (require.main === module) verifyDemandMeasurements().then(() => console.log('Demand-driven measurement contracts passed'))
  .catch(error => {console.error(error);process.exitCode = 1})
