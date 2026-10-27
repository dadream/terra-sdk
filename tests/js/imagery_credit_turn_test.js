const assert = require('assert')
const {TerrainWorkerHost} = require('./reference/measurement_host_fixture')
const {CooperativeTask, TASK_WAIT} = require('../../sdk/js/runtime/cooperative_task')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

// Exercise the real host's nested scheduling loops. A remote grant cannot
// arrive until this RPC returns; repeating a blocked iterator is never work.
module.exports = async function verifyImageryCreditTurns() {
  const clock = Date.now, measure = surface.surfaceMeasurements
  const host = new TerrainWorkerHost(), observations = []
  let now = 0, turns = 0, polls = 0, produced = 0, closed = 0
  Date.now = () => now
  surface.surfaceMeasurements = function* () {
    return {visible:true, pixelsPerUv:64, regions:[], refinable:false}
  }
  const draw = {resourceId:1, flags:0, origin:[0,0,0],
    textureNode:{level:0, root:0, row:0, column:0}}
  const packet = {draws:[draw], resources:new Map([[1, {model:{bounds:{}, hull:[]}}]]),
    frame:{sequence:1, projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},
    updateState:{modelRevision:1}, meshIdentity:'1'}
  const descriptor = {kind:'global-geodetic', matrix_level_offset:1,
    minimum_level:0, maximum_level:8, tile_size:256, level_zero_columns:2,
    level_zero_rows:1, bounds:[[-180,-90],[180,90]]}
  const message = {type:'imagery', sequence:1, viewRevision:1,
    camera:{distance:1}, viewport:{width:400,height:400,fovRadians:1},
    imagery:{descriptor, maximumTextures:16, targetPixelError:1.25}}
  host.frames.presented = packet
  host.manifest = {radius:6378000}
  host.yieldWork = async () => { ++turns; ++now; return true }
  host.abi = {
    createImageryTask(draws, measure, options) {
      return new CooperativeTask((function* () {
        try {
          // Output has separate native publication and range-decoding grants.
          for (const kind of ['input', 'reference', 'output', 'output']) {
            const workspace = kind === 'input' ? options.inputWorkspace : options[kind + 'Workspace']()
            let credit
            for (;;) {
              ++polls
              credit = workspace.reserve(128)
              if (credit) break
              yield TASK_WAIT
            }
            ++produced
            credit.release()
          }
          return {draws, levels:new Set(), quality:{planningComplete:true, meetsTarget:true}}
        } finally { ++closed }
      })())
    }
  }
  try {
    let next = message, result
    for (let call=0; call<32; ++call) {
      const before = {polls, turns, produced}
      result = await host.handle(next)
      const kind = ['output', 'reference', 'input'].find(k => result[k + 'Work'])
      if (kind) {
        const quote = result[kind + 'Work']
        observations.push({kind, id:quote.id, blockedPolls:polls - before.polls - (produced - before.produced),
          extraTurns:turns - before.turns})
        next = {...message, [kind + 'Grant']:quote}
      } else {
        next = message
        if (result.imageryPlan && result.imageryPlan.quality.planningComplete) break
      }
    }
    console.log('Imagery credit turn observations:', JSON.stringify(observations))
    assert.deepStrictEqual(observations.map(row => row.kind), ['input','reference','output','output'])
    assert.strictEqual(new Set(observations.map(row => row.id)).size, 4)
    assert(observations.every(row => row.blockedPolls === 1 && row.extraTurns === 0),
      'A grant-dependent cursor was polled or yielded to the host before returning its quote')
    assert(result.imageryPlan.quality.planningComplete && produced === 4 && closed === 1)
  } finally {
    host.clearPlanning(); Date.now = clock; surface.surfaceMeasurements = measure
  }
}

if (require.main === module) module.exports().catch(error => {console.error(error);process.exitCode = 1})
