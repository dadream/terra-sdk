const assert = require('assert')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')

async function verifyPricedDemand() {
  const measure = surface.surfaceMeasurements, fit = surface.fitPartitionSteps, clock = Date.now
  let now = 0
  Date.now = () => now
  surface.surfaceMeasurements = function* () {
    return {pixelsPerUv: 1024, visible: true, refinable: false, regions: []}
  }
  // Deterministic slice expiry before the real fitter has examined the cut.
  // No alternate cost or replacement algorithm is used by this fixture.
  surface.fitPartitionSteps = function* (...args) {
    now += 5
    yield
    return yield* fit(...args)
  }
  try {
    for (const coarsening of [false, true]) {
      const host = new TerrainWorkerHost(), accepted = [], published = []
      const descriptor = {kind:'global-geodetic', matrix_level_offset:1,
        bounds:[[-180,-90],[180,90]], minimum_level:0, maximum_level:8,
        tile_size:256, level_zero_columns:2, level_zero_rows:1}
      const model = surface.prepareSurface(new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
        new Float32Array([0,0,1,0,0,1,1,1]), new Uint16Array([0,2,1,3]), 0, 4)
      const draw = {resourceId:1, origin:[0,0,0], flags:0,
        textureNode:{level:0,root:0,row:0,column:0}}
      const packet = {frame:{sequence:1, projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},
        draws:[draw], resources:new Map([[1,{model}]]), updateState:{modelRevision:1}, meshIdentity:'1'}
      const message = {imagery:{descriptor, maximumTextures:16, maximumPartitionBytes:1, targetPixelError:1.25},
        camera:{distance:1}, viewport:{width:400,height:400}}
      let round = 0
      host.abi = {
        ...require('./reference/imagery_task_fixture'),
        async planImageryAsync(draws) {
          const source = draws[0].texture
          return {draws:[0,1,2,3].map(i => ({...draws[0], sourceTexture:source,
            texture:{level:source.level+1,matrix:source.matrix+1,row:Math.floor(i/2),column:i%2},
            imageryPixelError:1, imageryClipCell:true})), levels:new Set(),
          quality:{planningComplete:++round === 2, targetPixelError:1.25, meetsTarget:true}}
        },
        acceptImagery(plan) { if (plan) accepted.push(plan) }
      }
      host.imageryJob = {coarsening, exact:new Set(), precise:new Map(), releaseMeshes() {}}
      let waiting = 0
      try {
        for (let i=0; i<30; ++i) {
          const result = await host.planImagery(packet, message)
          if (host.partitionFit) {
            ++waiting
            assert(result.pending && !result.imageryPlan,
              'Unpriced candidate changed request demand while UV fitting was suspended')
          }
          if (!result.imageryPlan || result.imageryPlan.quality.measurementPending) continue
          const plan = result.imageryPlan
          published.push(plan)
          assert(plan.quality.partitionBytes <= 1, 'Request demand escaped its UV budget')
          assert(plan.draws.every(d => d.texture.level === 1),
            'Temporary fine candidates escaped before their required coarsening')
          if (plan.quality.planningComplete) break
        }
        assert(waiting >= 2, 'The fixture did not suspend both candidate fits')
        assert(published.length && published[published.length-1].quality.planningComplete)
        assert.strictEqual(published.some(plan => !plan.quality.planningComplete), !coarsening,
          'Fitted incremental refinement waited for global completion, or stale coarsening escaped')
        assert.strictEqual(accepted.length, 1)
        assert(accepted[0].quality.limitedByPartitionBudget,
          'The completed capacity limitation was hidden from the consumer')
      } finally { host.clearPlanning() }
    }
  } finally {
    Date.now = clock; surface.surfaceMeasurements = measure; surface.fitPartitionSteps = fit
  }
}

module.exports = verifyPricedDemand
if (require.main === module) verifyPricedDemand().then(() => console.log('Only priced imagery cuts update demand; fitted partial progress remains publishable'))
  .catch(error => { console.error(error); process.exitCode = 1 })
