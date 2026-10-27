const assert = require('assert')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')

// Independent native contexts supply serial oracles. The subject interleaves
// two planners on one context, including packing and native normalization.
module.exports = async function verifyImagerySessions(module, manifest) {
  const abi = new TerraAbi(module), oracle = new TerraAbi(module)
  const sourceA = manifest.texture
  const sourceB = {...sourceA, id:'candidate', tile_size:512, level_zero_columns:4,
    level_zero_rows:2, matrix_level_offset:0}
  const uv = {minimumU:0, minimumV:0, maximumU:1, maximumV:1}
  const input = (descriptor, pixels, count, root) => {
    const draw = new ImageryAdapter(descriptor).prepareDraw({resourceId:0,
      textureNode:{level:0,root,row:0,column:root}, key:{i:root}})
    return {draws:[draw], measure:() => ({visible:true,pixelsPerUv:pixels,bounds:uv,
      regions:Array.from({length:count}, () => ({uv,pixelsPerUv:pixels})),
      hull:[[0,0],[1,0],[1,1],[0,1]]}),
    options:{descriptor,detached:true,maximumTextures:64,maximumDraws:512,maximumRounds:1}}
  }
  // The coarse B cut still needs multiple native normalization windows even
  // when allocation-free steps share the bounded eight-step CPU slice.
  const regionsA = 8192, regionsB = 40960
  const a = input(sourceA, 2048, regionsA, 0), b = input(sourceB, 384, regionsB, 1)
  let allocated = 0
  const alloc = abi.alloc, free = abi.free, active = new Set()
  abi.alloc = function(bytes) { const p = alloc.call(this, bytes); active.add(p); ++allocated; return p }
  abi.free = function(p) { assert(active.delete(p), 'Planner scratch released twice'); return free.call(this,p) }
  try {
    assert.throws(() => abi.createImageryPlanner(), e => e.status === 2)
    assert.strictEqual(active.size, 0)
    abi.loadManifest(manifest); oracle.loadManifest(manifest)
    assert.strictEqual(abi.imageryPayloadBytes(), 0)
    const display = abi.getImageryPlanner(), candidate = abi.createImageryPlanner()
    const emptyOwners = abi.imageryPayloadBytes()
    assert(emptyOwners > 0)
    const expected = [a,b].map(value => {
      oracle.resetImagery()
      return oracle.planImagery(value.draws,value.measure,value.options)
    })
    assert.throws(() => abi.createImageryPlanner(), e => e.status === 5)
    assert.strictEqual(abi.imageryPlanners.size, 2)
    const rows = [a,b].map((value,i) => ({...value,planner:i ? candidate : display,rounds:0,done:false}))
    let slices = 0, overlapped = false
    while (rows.some(row => !row.done)) {
      for (const row of rows) {
        if (row.done) continue
        if (!row.task) {
          row.task = row.planner.createTask(row.draws,row.measure,{...row.options,continuation:row.rounds > 0})
          row.task.maximumSteps = 1
        }
        const result = row.task.step()
        overlapped = overlapped || display.tasks.size > 0 && candidate.tasks.size > 0 && active.size >= 8
        if (result.done) {
          row.result = result.value; row.task = null; ++row.rounds
          row.done = row.result.quality.planningComplete
        }
      }
      if (++slices === 3) module.exports.memory.grow(1)
      assert(slices < 1024, 'Isolated imagery sessions failed to converge')
    }
    assert(overlapped && rows.every(row => row.rounds > 1),
      'Fixture did not overlap input/native continuations: ' + JSON.stringify({overlapped, rounds:rows.map(row => row.rounds)}))
    const bothOwners = abi.imageryPayloadBytes()
    assert(bothOwners > emptyOwners + (regionsA + regionsB) * 176, 'Owned imagery measurement inputs were not reported')
    rows.forEach((row,i) => assert.deepStrictEqual(row.result,expected[i], 'Interleaving changed a session cut or source binding'))
    assert.strictEqual(active.size, 0)
    assert.strictEqual(display.tasks.size + candidate.tasks.size, 0)
    const held = display.readPlan(a.draws,a.options)
    candidate.accept(rows[1].result,42); candidate.reset()
    assert(abi.imageryPayloadBytes() < bothOwners, 'Reset did not retire candidate input/tree allocation')
    assert.deepStrictEqual(display.readPlan(a.draws,a.options),held,'Candidate reset changed displayed output')
    const stale = candidate.id
    candidate.destroy(); candidate.destroy()
    const replacement = abi.createImageryPlanner()
    assert.notStrictEqual(replacement.id,stale)
    assert.strictEqual(module.call('terra_reset_imagery',abi.context,stale),2)
    assert.throws(() => candidate.createTask(b.draws,b.measure,b.options),/closed/)
    assert.throws(() => candidate.accept(null,0),/closed/)

    // A replacement task cancels only its owner's scratch, even while the
    // other owner has yielded halfway through a packed input.
    const start = (planner,value) => {
      const task = planner.createTask(value.draws,value.measure,value.options)
      task.maximumSteps = 1; assert(!task.step().done); return task
    }
    const old = start(display,a), other = start(replacement,b)
    const fresh = display.createTask(a.draws,a.measure,a.options)
    assert(old.done && old.value === null && !other.done)
    fresh.cancel(); replacement.reset()
    assert(other.done && other.value === null)
    assert.strictEqual(active.size,0)
    assert.throws(() => replacement.plan(b.draws,b.measure,{...b.options,continuation:true}),/matching input/)

    // Failed manifest validation must preserve live jobs; successful reset
    // invalidates both owners and cancels packing before any scratch escapes.
    const pendingA = start(display,a), pendingB = start(replacement,b)
    assert.throws(() => abi.loadManifest({...manifest,formatVersion:99}))
    assert(!pendingA.done && !pendingB.done)
    abi.loadManifest(manifest)
    assert.strictEqual(abi.imageryPayloadBytes(), 0, 'Manifest reset retained imagery sessions')
    assert(pendingA.done && pendingB.done && display.closed && replacement.closed)
    assert.strictEqual(abi.imageryPlanners.size,0)
    assert.strictEqual(active.size,0)
    assert.strictEqual(module.call('terra_reset_imagery',abi.context,replacement.id),2)
    const current = abi.getImageryPlanner()
    assert(current.id > replacement.id)
    assert.deepStrictEqual(abi.planImagery(a.draws,a.measure,a.options),expected[0])
    const closing = start(current,a)
    abi.destroy()
    assert.strictEqual(abi.imageryPayloadBytes(), 0)
    assert(current.closed && closing.done && closing.value === null)
    assert.strictEqual(active.size,0)
    assert(allocated > 0)
  } finally { abi.destroy(); oracle.destroy(); abi.alloc=alloc; abi.free=free }
  console.log('Isolated imagery cuts, independent source bindings, interleaved normalization, cancellation and stale-session rejection passed')
}
