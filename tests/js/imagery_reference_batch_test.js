const assert = require('assert')
const {ImageryPlanner} = require('../../adapters/wasm/imagery_planner')

// Native steps deliberately stop before using their full grant. Observe the
// planner boundary, not a second implementation of the native selection rule.
function fixture({steps = 8, grant = 128, elapsed = 0, outputAt = 0, overspend = false,
  initialPayload = 0, growths = [], freeSteps = 0} = {}) {
  const planner = Object.create(ImageryPlanner.prototype)
  const memory = new DataView(new ArrayBuffer(4)), supplied = [], events = []
  let count = 0, payload = initialPayload, now = 0, outputPending = false, active = 0, grants = 0
  planner.abi = {
    context:1, alloc:() => 0, free() {},
    imageryReferencePayloadBytes:() => payload,
    beginImageryReferences(minimum) {
      assert(grant >= minimum && active === 0)
      ++active; ++grants; events.push('reference')
      return {bytes:grant, release() {--active; events.push('receipt')}}
    },
    beginImageryOutput() {
      assert.strictEqual(active, 0, 'Output requested before the reference receipt')
      events.push('output')
      return {bytes:64, release() {}}
    },
    module:{refreshMemory:() => ({dataView:memory}), call(name) {
      if (name === 'terra_imagery_reference_work_bytes') return count >= freeSteps && count < steps ? 16 : 0
      if (name === 'terra_imagery_output_work_bytes') return outputPending ? 64 : 0
      throw new Error(name)
    }}
  }
  planner.call = (name, changes, priorities, milliseconds, reference, output) => {
    assert.strictEqual(name, 'terra_step_imagery')
    if (outputPending) {
      assert(output === 64 && reference === 0)
      outputPending = false
    } else {
      if (count < freeSteps) {
        assert.strictEqual(reference, 0, 'Allocation-free work claimed reference credit')
        if (overspend) ++payload
      } else {
        assert(reference >= 16)
        supplied.push(reference)
        payload += overspend ? reference + 1 : growths[count] === undefined ? 8 : growths[count]
      }
      ++count; now += elapsed
      if (count === outputAt) outputPending = true
    }
    memory.setUint32(0, count === steps && !outputPending ? 1 : 0, true)
  }
  planner.readPlanSteps = function* () { return {count, payload} }
  return {planner, supplied, events, now:() => now, active:() => active, grants:() => grants}
}

function run(options, maximumRounds) {
  const value = fixture(options), clock = Date.now
  Date.now = value.now
  const work = value.planner.continuePlan([], {incremental:true, maximumRounds})
  try {
    let result
    do {result = work.next()} while (!result.done)
    return {...value, result:result.value}
  } finally {work.return(); Date.now = clock; assert.strictEqual(value.active(), 0)}
}

module.exports = function () {
  const free = run({freeSteps:8}, 1)
  assert.strictEqual(free.result.count, 8, 'Allocation-free priority work ended its CPU slice after one checkpoint')
  assert.strictEqual(free.grants(), 0, 'Pure native work reserved reference memory')
  assert.strictEqual(run({steps:17,freeSteps:17}, 1).result.count, 8,
    'Allocation-free work exceeded the same native operation limit as funded work')
  assert.strictEqual(run({freeSteps:8,elapsed:1}, 1).result.count, 4,
    'Allocation-free work exceeded the existing4ms time budget')
  const freeOutput = run({freeSteps:8,outputAt:3}, 1)
  assert.strictEqual(freeOutput.result.count, 3, 'Batching skipped a funded output publication milestone')
  assert.deepStrictEqual(freeOutput.events, ['output'])
  assert.throws(() => run({freeSteps:8,overspend:true}), /credit/)
  const batch = run({})
  assert.strictEqual(batch.grants(), 1, 'Unused reference credit was refunded after every small native step')
  assert.deepStrictEqual(batch.supplied, [128,120,112,104,96,88,80,72])
  assert.deepStrictEqual(batch.result, {count:8,payload:64})
  assert.strictEqual(run({grant:16}).grants(), 8, 'Minimum grants must still advance without spare room')
  assert.strictEqual(run({steps:17}).grants(), 3, 'One batch exceeded its eight-step limit')
  assert.strictEqual(run({elapsed:1}).grants(), 2, 'One batch exceeded its cooperative time limit')
  assert.strictEqual(run({}, 1).result.count, 8, 'A planning round ended before its funded slice')
  assert.strictEqual(run({steps:4,grant:16,initialPayload:64,growths:[-64,8,8,8]}).grants(), 3,
    'Retired resident bytes were reused after their ledger ownership was released')
  const output = run({outputAt:3})
  assert.strictEqual(output.grants(), 2)
  assert.deepStrictEqual(output.events, ['reference','receipt','output','reference','receipt'])
  assert.throws(() => run({overspend:true}), /credit/)
  console.log('Imagery reference batching: retained growth, minimum credit, output receipts and bounded work passed')
}

if (require.main === module) module.exports()
