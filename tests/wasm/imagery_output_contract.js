const assert = require('assert')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')

module.exports = async function verifyImageryOutput(abi, descriptor) {
  const uv = {minimumU:0, minimumV:0, maximumU:1, maximumV:1}
  const draw = new ImageryAdapter(descriptor).prepareDraw({resourceId:0,
    textureNode:{level:0, root:0, row:0, column:0}})
  const measurement = {visible:true, pixelsPerUv:1024, bounds:uv,
    regions:Array.from({length:8192}, () => ({uv, pixelsPerUv:1024}))}
  const options = {descriptor, detached:true, maximumTextures:1, maximumDraws:512, maximumRounds:1}
  const call = abi.module.call, clock = Date.now
  let now = 0
  Date.now = () => now
  let reads = 0, reused = 0, rounds = 0, firstParent, previous, priorRevision
  abi.module.call = function(name, ...args) {
    if (name === 'terra_get_imagery_draws') {
      ++reads
      this.exports.memory.grow(1)
      assert(args[4] <= 256, 'Output readback exceeded its bounded range')
    }
    // Deterministic work allowance exercises partial measurements without
    // relying on machine speed. Production continuation limits stay unchanged.
    if (name === 'terra_step_imagery') { args[3] = 1; args[4] = 0; now += 4 }
    return call.call(this, name, ...args)
  }
  try {
    abi.resetImagery()
    const owner = abi.getImageryPlanner()
    do {
      const before = reads
      const task = owner.createTask([draw], () => measurement, {...options, continuation: rounds > 0})
      let next
      try { do { next = task.step() } while (!next.done) } finally { task.cancel() }
      const plan = next.value, revision = owner.output.revision
      if (revision === priorRevision) {
        assert.strictEqual(reads, before, 'Unchanged native output was copied again')
        if (plan.quality.limitedByBudget === previous.quality.limitedByBudget) {
          assert.strictEqual(plan.draws, previous.draws, 'Measurement progress rebuilt adapted rows')
          ++reused
        }
      }
      if (!plan.quality.rebuilding && !firstParent) firstParent = plan
      previous = plan; priorRevision = revision
      assert(++rounds < 1024, 'Output continuation failed to converge')
    } while (!previous.quality.planningComplete)
    assert(reused > 500 && reads <= 3, 'Fixture did not exercise repeated unchanged output')
    assert(previous.quality.limitedByTextureBudget && previous.draws[0].imageryCapacityCoarsened)
    assert(!firstParent.quality.planningComplete && !firstParent.draws[0].imageryCapacityCoarsened,
      'Final limitation mutated a previously published plan')
    const held = JSON.stringify(firstParent)
    abi.resetImagery()
    const expected = abi.planImagery([draw], () => measurement, options)
    assert.deepStrictEqual(previous, expected, 'Output reuse changed final cut or quality')
    assert.notStrictEqual(owner.output.revision, priorRevision, 'Reset reused native output identity')
    const changed = {...draw, marker:'new source draw'}
    const replaced = abi.planImagery([changed], () => ({...measurement, pixelsPerUv:64,
      regions:[{uv, pixelsPerUv:64}]}), options)
    assert(replaced.draws.every(row => row.marker === changed.marker), 'New input reused stale draw bindings')
    assert.strictEqual(JSON.stringify(firstParent), held, 'New input mutated a retained output')
    console.log(`Immutable imagery output: ${rounds} continuations, ${reads} readbacks including resets, ${reused} reused snapshots`)
  } finally { abi.module.call = call; Date.now = clock; abi.resetImagery() }
}
