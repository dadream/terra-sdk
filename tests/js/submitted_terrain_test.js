const assert = require('assert')
const {SubmittedTerrain} = require('../../sdk/js/terrain/submitted_terrain')

function testSubmittedTerrain() {
  const progress = new SubmittedTerrain()
  const surface = (ids, workerGeneration = 1) => ({draws: ids.map(resourceId => ({resourceId, workerGeneration}))})
  const first = surface([51, 52])
  progress.submit(first, false)
  const initial = progress.snapshot()
  assert.deepStrictEqual(initial, {submissions: 1, partialSubmissions: 0, meshRevision: 1, meshes: 2})

  // Camera/imagery partitions, order, duplicate draws and coverage roots do not
  // change the immutable terrain cut, even if a new surface object is drawn.
  const redraw = surface([52, 51, 51])
  redraw.draws.push({resourceId: 999, flags: 1})
  redraw.cameraVersion = 2; redraw.imageryPlan = {}
  progress.submit(redraw, true)
  assert.strictEqual(progress.snapshot().meshRevision, 1)
  progress.submit(surface([53, 52]), true)
  assert.deepStrictEqual(progress.snapshot(),
    {submissions: 3, partialSubmissions: 2, meshRevision: 2, meshes: 2})
  assert.strictEqual(initial.submissions, 1, 'A previous snapshot changed underneath its consumer')

  const before = progress.snapshot()
  progress.submit({draws: [{resourceId: 999, flags: 1}]}, false)
  assert.deepStrictEqual(progress.snapshot(), before, 'Fallback-only display fabricated terrain progress')
  // Resource IDs are scoped to their native generation.
  progress.submit(surface([52, 53], 2), false)
  assert.strictEqual(progress.snapshot().meshRevision, 3)
}

module.exports = {testSubmittedTerrain}
