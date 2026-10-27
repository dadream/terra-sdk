const assert = require('assert')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

// Partition retirement is an opportunity to retry admission, not a different
// spatial input. Receipts arriving between slices must not starve either the
// native input producer or the UV pricing iterator.
module.exports = async function verifyImageryAdmissionContinuation() {
  const clock = Date.now, measure = surface.surfaceMeasurements
  try {
    for (const phase of ['input', 'fit']) {
      let now = 0, measured = 0, freed = 0, cancelled = 0, fitCancelled = 0
      Date.now = () => now
      surface.surfaceMeasurements = function* (model, origin, context, conservative) {
        if (conservative) return {visible:true, pixelsPerUv:Infinity, regions:[], refinable:false}
        ++measured
        return {visible:true, pixelsPerUv:64, regions:[], refinable:false}
      }
      const ledger = new ResourceLedger(64), host = new TerrainWorkerHost(), starts = [], epochs = []
      const resource = ownPayload({model:{bounds:{}, hull:[]}}, ledger.reserve('fixture-mesh',8), 8, () => ++freed)
      const snapshot = {projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}
      const view = {revision:1, snapshot, camera:{distance:100}, viewport:{width:400,height:400,fovRadians:1}}
      const descriptor = {kind:'global-geodetic', matrix_level_offset:1, minimum_level:0, maximum_level:8,
        tile_size:256, level_zero_columns:2, level_zero_rows:1, bounds:[[-180,-90],[180,90]]}
      const request = admissionRevision => ({...view, type:'imagery', viewRevision:1, sequence:1,
        imagery:{descriptor, maximumTextures:147, targetPixelError:1.25, devicePixelRatio:1, admissionRevision}})
      host.frames.presented = {frame:{sequence:1,...snapshot}, resources:new Map([[1,resource]]),
        draws:[{resourceId:1,flags:0,origin:[0,0,0],textureNode:{level:0,root:0,row:0,column:0}}],
        meshIdentity:'1', updateState:{modelRevision:1}}
      host.manifest = {radius:6378000}; host.observeView(view)
      host.abi = {
        acceptImagery(plan, epoch) { if (!plan) epochs.push(epoch) },
        createImageryTask(draws, measureDraw, options) {
          starts.push(Boolean(options.continuation))
          return new CooperativeTask((function* () {
            let done = false
            try {
              if (phase === 'input') for (let i=0; i<4; ++i) { now+=5; yield }
              done = true
              return {draws, levels:new Set(), quality:{planningComplete:true, meetsTarget:false,
                limitedByTextureBudget:true, maximumTextureCount:options.maximumTextures}}
            } finally { if (!done) ++cancelled }
          })())
        }
      }
      host.partitionFitCache.fit = function* (plan) {
        let done = false
        try {
          if (phase === 'fit') for (let i=0; i<4; ++i) { now+=5; yield }
          done = true; return plan
        } finally { if (!done) ++fitCancelled }
      }
      try {
        let complete, revision = 0
        for (; revision<24; ++revision) {
          const result = await host.handle(request(revision))
          if (result.imageryPlan && result.imageryPlan.quality.planningComplete) {complete=result; break}
        }
        assert(complete, phase + ' made no publishable progress through partition retirement receipts')
        assert.strictEqual(cancelled + fitCancelled, 0, 'Availability changes cancelled useful work')
        assert.strictEqual(starts.length, 1, 'Availability changes restarted native planning')
        assert.strictEqual(complete.continuation, true, 'Latest admission opportunity was lost at publication')
        assert.deepStrictEqual(epochs, [1], 'Pending input was mutated by an admission reset')
        // Stop receipt churn: coalesce it into one retry, reusing native input.
        let settled
        for (let i=0; i<24; ++i) {
          const result = await host.handle(request(revision))
          if (!result.pending && !result.continuation) {settled=result; break}
        }
        assert(settled && settled.imageryPlan.quality.planningComplete)
        assert.deepStrictEqual(starts, [false,true], 'Admission retry repacked unchanged native input')
        assert.deepStrictEqual(epochs, [1,2], 'Availability notifications were not coalesced')
        assert.strictEqual(measured, 1, 'Admission retry repeated projection')
      } finally {host.clearPlanning(); resource.ownership.retire()}
      assert.strictEqual(freed, 1)
      assert.strictEqual(ledger.bytes, 0)
    }
  } finally {Date.now=clock; surface.surfaceMeasurements=measure}
  console.log('Partition retirement preserves input/UV progress and coalesces admission retry after publication')
}

if (require.main===module) module.exports().catch(error => {console.error(error); process.exitCode=1})
