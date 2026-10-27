const assert = require('assert')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

module.exports = async function () {
  const clock = Date.now, measure = surface.surfaceMeasurements
  let now = 0, starts = 0, released = 0, completed = 0, steps = 0
  Date.now = () => now
  surface.surfaceMeasurements = function* () {
    return {visible: true, pixelsPerUv: 64, regions: [], refinable: false}
  }
  const host = new TerrainWorkerHost()
  const draw = {resourceId: 1, flags: 0, origin: [0,0,0],
    textureNode: {level: 0, root: 0, row: 0, column: 0}}
  const packet = {draws: [draw], resources: new Map([[1, {model: {bounds: {}, hull: []}}]]),
    frame: {sequence: 1, projectionView: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},
    updateState: {modelRevision: 1}, meshIdentity: '1'}
  const descriptor = {kind: 'global-geodetic', matrix_level_offset: 1,
    minimum_level: 0, maximum_level: 8, tile_size: 256,
    level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180,-90],[180,90]]}
  const message = {camera: {distance: 1}, viewport: {width: 400, height: 400},
    imagery: {descriptor, maximumTextures: 16, targetPixelError: 1.25}}
  host.abi = {
    createImageryTask(draws) {
      ++starts
      return new CooperativeTask((function* () {
        try {
          for (let i = 0; i < 4; ++i) {++steps; now += 5; yield}
          ++completed
          return {draws, levels: new Set(), quality: {planningComplete: true, meetsTarget: true}}
        } finally {++released}
      })(), 8, () => now)
    }
  }
  host.imageryJob = {coarsening: false, exact: new Set(), precise: new Map(), releaseMeshes() {}}
  const slice = () => host.planImagery(packet, message)
  try {
    for (let i=0; i<100 && !host.imageryTask; ++i) await slice()
    assert(host.imageryTask, 'Input fixture did not suspend within its slice limit')
    const first = host.imageryTask
    let result = await slice()
    assert(result.pending && !result.imageryPlan && host.imageryTask === first && starts === 1,
      'Pending input was restarted or published before native admission')
    assert.strictEqual(steps, 2, 'One host call consumed more than its input-work slice')
    message.imagery = {...message.imagery, maximumTextures: 32}
    result = await slice()
    assert(result.pending && released === 1 && starts === 2 && !completed,
      'Changed admission reused an unfinished input or leaked its scratch')
    for (let i=0; i<100 && (result.pending || result.continuation || !result.imageryPlan); ++i) result = await slice()
    assert(!result.pending && !result.continuation && result.imageryPlan, 'Input fixture did not settle')
    assert(result.imageryPlan.quality.planningComplete && completed === 1 && released === 2)
    assert.strictEqual(host.imageryTask, null)
    assert.strictEqual((await slice()).imageryPlan, result.imageryPlan,
      'Unchanged demand repeated completed input work')
    message.imagery = {...message.imagery, maximumTextures: 64}
    await slice()
    assert(host.imageryTask)
    host.clearPlanning()
    assert.strictEqual(released, 3, 'Cancellation retained an input task between Worker replies')
    assert.strictEqual(host.imageryTask, null)
    const workspace = new (require('../../sdk/js/resources/imagery_input_workspace').ImageryInputWorkspace)(99)
    workspace.reserve(100); workspace.grant({id:99,bytes:100})
    const credit = workspace.reserve(100), measured = new Map()
    const retainedJob = {releaseMeshes() {throw new Error('Input cancellation retired the measured snapshot')}}
    host.imageryJob = retainedJob; host.imageryMeasurements = measured
    host.imageryInputWorkspace = workspace
    host.imageryTask = {task:{cancel() {credit.release()}}}
    host.cancelImageryInputGrant(98)
    assert(workspace.active)
    host.cancelImageryInputGrant(99)
    assert(workspace.finished && host.imageryTask === null && host.imageryInputWorkspace === null)
    assert.strictEqual(host.imageryJob,retainedJob)
    assert.strictEqual(host.imageryMeasurements,measured)
    host.imageryJob = null
  } finally {host.clearPlanning(); Date.now = clock; surface.surfaceMeasurements = measure}
  console.log('Persistent input slices, admission replacement and cancellation ownership passed')
}

if (require.main === module) module.exports().catch(error => {console.error(error);process.exitCode = 1})
