const assert = require('assert')
const {createReplacementTask} = require('./reference/surface_replacement')
const {patch, surface} = require('./terrain_surface_fixture')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')

const lower = [[0, 0], [1, 0], [0, 1]], upper = [[1, 1], [0, 1], [1, 0]]
function groups(before, after, global = false) {
  const task = createReplacementTask(surface(before), surface(after), global)
  for (let i = 0; i < 1000; ++i) {
    const result = task.step()
    if (result.done) return result.value
  }
  throw new Error('Replacement dependency scan did not finish')
}
function ids(result) {
  return result.map(group => group.before.concat(group.after).map(d => d.resourceId).sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0])
}
const a = patch(1, lower, undefined, 2), b = patch(2, upper, undefined, 2)
const nextA = patch(3, lower, undefined, 2), nextB = patch(4, upper, undefined, 2)
assert.deepStrictEqual(ids(groups([a, b], [nextA, nextB])), [[1, 3], [2, 4]],
  'Unchanged shared boundary unnecessarily joined independent replacements')
const elevated = point => point[0] === 0.5 && point[1] === 0.5 ? 0.1 : 0
const changedA = patch(3, lower, elevated, 2), changedB = patch(4, upper, elevated, 2)
assert.deepStrictEqual(ids(groups([a, b], [changedA, changedB])), [[1, 2, 3, 4]],
  'Changed shared edge allowed a crack between old and new neighbours')
const children = [patch(5, [[0, 0], [1, 0], [0.5, 0.5]], undefined, 2),
  patch(6, [[0, 0], [0.5, 0.5], [0, 1]], undefined, 2)]
assert.deepStrictEqual(ids(groups([a, b], children.concat(b))), [[1, 5, 6], [2, 2]],
  'Refinement failed to close both children against their old parent')
assert.deepStrictEqual(ids(groups(children.concat(b), [a, b])), [[1, 5, 6], [2, 2]],
  'Coarsening did not preserve the compatible adjacent fragment')
assert.deepStrictEqual(ids(groups([b, a], [nextB, nextA])), [[1, 3], [2, 4]],
  'Draw order changed transaction dependencies')

const east = patch(10, [[3, 0], [4, 0], [4, 1]], undefined, 2)
const west = patch(11, lower, undefined, 2)
const eastNext = patch(12, [[3, 0], [4, 0], [4, 1]], p => p[0] === 4 ? 0.1 : 0, 2)
const westNext = patch(13, lower, p => p[0] === 0 ? 0.1 : 0, 2)
assert.deepStrictEqual(ids(groups([east, west], [eastNext, westNext], true)), [[10, 11, 12, 13]],
  'Longitude seam split one dependent replacement into independent islands')
delete nextA.draw.textureNode
assert.strictEqual(groups([a], [nextA]), null, 'Missing model coordinates authorized a partial replacement')
const cancelled = createReplacementTask(surface([a]), surface([b]), false)
cancelled.cancel()
assert.deepStrictEqual(cancelled.step(), {done: true, value: null})
// A suspended boundary scan retains its input independently of frame retirement.
for (const cancel of [true, false]) {
  const before = surface([patch(20, lower, undefined, 2)])
  const after = surface([patch(21, lower, undefined, 2)])
  const ledger = new ResourceLedger()
  const resources = [...before.meshResources.values(), ...after.meshResources.values()]
  resources.forEach(resource => ownPayload(resource, ledger.reserve('mesh-host',
    resource.positions.byteLength + resource.textureUv.byteLength),
    resource.positions.byteLength + resource.textureUv.byteLength))
  const task = createReplacementTask(before, after, false)
  resources.forEach(resource => resource.ownership.retire())
  assert(ledger.bytes > 0, 'Pending boundary scan released retired payload')
  if (cancel) task.cancel()
  else while (!task.step().done) {}
  assert.strictEqual(ledger.bytes, 0, 'Finished boundary scan retained its input')
}
console.log('Terrain surface replacement tests passed.')

const {identityReplacementPlan, atomicReplacementPlan, bindReplacementPlan} = require('../../sdk/js/terrain/surface_replacement')
const oldCut = surface([a,b]), newCut = surface([changedA,changedB])
const identity = identityReplacementPlan(oldCut.draws, [b.draw, a.draw, a.draw, {resourceId: 99, flags: 1}])
assert.deepStrictEqual(identity, {groups: [{before: [1], after: [1]}, {before: [2], after: [2]}]})
assert.strictEqual(bindReplacementPlan(identity, oldCut, oldCut).length, 2)
for (const next of [[], [a.draw], [a.draw, changedB.draw], newCut.draws])
  assert.strictEqual(identityReplacementPlan(oldCut.draws, next), null,
    'Changed geometry or coverage was classified as an identical cut')
assert.strictEqual(identityReplacementPlan([], []), null)
const proof = {groups: [{before:[1,2],after:[3,4]}]}
assert.strictEqual(bindReplacementPlan(proof, oldCut, newCut).length, 1)
const atomic = atomicReplacementPlan(oldCut.draws, newCut.draws)
assert.deepStrictEqual(atomic, {atomic: true, groups: [{before:[1,2],after:[3,4]}]})
assert.strictEqual(bindReplacementPlan(atomic, oldCut, newCut).length, 1)
assert.strictEqual(bindReplacementPlan(atomic, surface([a]), newCut), null,
  'Complete-cut proof accepted a different submitted membership')
assert.strictEqual(atomicReplacementPlan([], []), null)
for (const bad of [null, {groups:[]}, {groups:[{before:[1],after:[3,4]}]},
  {groups:[{before:[1,2,2],after:[3,4]}]}, {groups:[{before:[1,2],after:[3,9]}]},
  {groups:[{before:[1,2],after:[3,4]}, {before:[],after:[]}]}])
  assert.strictEqual(bindReplacementPlan(bad, oldCut, newCut), null,
    'Malformed or stale native proof authorized partial display')
assert.strictEqual(bindReplacementPlan(proof, newCut, oldCut), null)

// Native calls are short bounded units: spend up to the same 4ms slice instead
// of paying one clamped browser timer after every eight units.
const {CooperativeTask, TASK_WAIT} = require('../../sdk/js/runtime/cooperative_task')
const originalClock = Date.now
try {
  let steps = 0, ticks = 0
  Date.now = () => 0
  const task = new CooperativeTask((function* () {for (;;) {++steps; yield}})(), 64)
  task.step(); assert.strictEqual(steps, 64); task.cancel()
  steps = 0; Date.now = () => ticks++
  const timed = new CooperativeTask((function* () {for (;;) {++steps; yield}})(), 64)
  timed.step(); assert.strictEqual(steps, 4, 'Native slice ignored its time bound'); timed.cancel()
  Date.now = () => 0
  let ready = false, released = 0, resumed = 0
  const dependent = new CooperativeTask((function* () {
    try { while (!ready) { ++resumed; yield TASK_WAIT }; return 42 }
    finally { ++released }
  })(), 64)
  assert(dependent.step().waiting && resumed === 1 && released === 0)
  ready = true
  assert.deepStrictEqual(dependent.step(), {done:true, value:42})
  assert.strictEqual(released, 1)
  const cancelled = new CooperativeTask((function* () {
    try { yield TASK_WAIT; assert.fail('Cancelled dependency resumed') }
    finally { ++released }
  })())
  assert(cancelled.step().waiting)
  cancelled.cancel(); cancelled.cancel()
  assert.strictEqual(released, 2, 'Waiting cancellation skipped or repeated the release')
} finally {Date.now = originalClock}
