const assert = require('assert')
const {TerraWebGlRenderer} = require('../../adapters/webgl/terra_webgl_renderer')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {MeshReceipts} = require('../../sdk/js/terrain/mesh_receipts')
const {MeshCopyPlan} = require('../../sdk/js/resources/mesh_coordinates')
const {FakeCanvas, AsyncGl, frame} = require('./support/webgl_fixture')
const {patch, surface} = require('./terrain_surface_fixture')
const {createReplacementTask} = require('./reference/surface_replacement')

// Two disconnected, dyadic boundaries produce two independently replaceable
// groups. Interrupt AFTER one group is submitted, including while receipts or
// world preparation are suspended. Plain arrays/atomic replacement miss this
// ownership boundary: use the real copy plan, shared UV and frame receipts.
// An additional boundary prepares a distinct successor before the display is
// locked. Exercise a display turn without an intervening resource turn too.
module.exports = async function verifyPartialMeshRetention() {
  const previous = Object.getOwnPropertyDescriptor(global, 'performance')
  let clock = 1000, sliced = false, tested = 0
  Object.defineProperty(global, 'performance', {configurable:true,
    value:{now:() => (clock += sliced ? 0.25 : 0)}})
  try {
    for (const preparedBeforeHold of [false, true]) for (const slices of [false, true]) for (const mode of ['height', 'texture']) {
      sliced = slices
      for (const delay of [0, 1, 4]) {
        let turn = 0, sequence = 0, replies = [], failures = [], partials = 0
        const later = () => new Promise(resolve => replies.push({resolve, turn:turn + delay}))
        const owner = {retainMeshes:later, presentFrame:later}
        const receipts = new MeshReceipts(null, () => owner, error => failures.push(error))
        const gl = new AsyncGl(), canvas = new FakeCanvas(gl)
        canvas.width = canvas.height = 64
        const renderer = new TerraWebGlRenderer(canvas, {
          mode, scheduledImagery:true, terrainBoundImagery:false, managedResources:true,
          maximumResourceBytes:4 * 1048576, geometryCacheBytes:preparedBeforeHold ? 1800 : 540, partitionCacheBytes:100000,
          uploadBudgetObjects:1, requestResources() {}, requestRender() {}, textureTransitionMs:0,
          onPresented:id => receipts.present(id).catch(error => failures.push(error)),
          onSurfaceSubmitted:(value, partial) => {
            if (partial) { ++partials; receipts.retain(value.frame.sequence, value.draws) }
          },
          textureDescriptor:{kind:'global-geodetic', level_zero_columns:2, level_zero_rows:1,
            matrix_level_offset:0, tile_size:16, maximum_level:4}, urlForTile:() => null
        })
        const frames = receipts.frames = new MeshFrames(renderer.resourceLedger)
        const coarse = [[[0,0],[1,0],[0,1]], [[2,2],[3,2],[2,3]]]
        if (preparedBeforeHold) coarse.push([[4,4],[5,4],[4,5]])
        const fine = coarse.flatMap(([a,b,c]) => {
          const middle = a.map((value, axis) => (value + b[axis]) / 2)
          return [[a,middle,c], [middle,b,c]]
        })
        renderer.measureDraw = () => ({visible:true, hull:[[0,0],[1,0],[1,1],[0,1]]})
        renderer.measureTextureDraw = () => 0
        renderer.textures.scheduler.pause()
        for (const tile of renderer.textures.coverageTiles) renderer.textures.cache.set(
          [tile.level,tile.matrix,tile.row,tile.column].join('/'),
          {image:{}, texture:{}, width:16, height:16}, 1364)

        const publish = finer => {
          ++sequence
          const value = surface((finer ? fine : coarse).map((corners, index) =>
            patch(sequence * 10 + index, corners, () => 0, 2)))
          value.draws.forEach((draw, index) => {
            draw.textureResourceId = 1 + index + (finer ? 10 : 0)
            value.meshResources.get(draw.resourceId).textureResourceId = draw.textureResourceId
          })
          let replacementPlan = null
          if (renderer.displaySurface) {
            const task = createReplacementTask(renderer.displaySurface.current, value, false)
            let result
            do { result = task.step() } while (!result.done)
            assert(result.value && result.value.length >= 2, 'Fixture lost independent replacement groups')
            replacementPlan = {groups:result.value.map(group => ({
              before:group.before.map(draw => draw.resourceId), after:group.after.map(draw => draw.resourceId)}))}
          }
          const copies = new MeshCopyPlan(frames, value.draws), credit = frames.reserve(copies.bytes)
          let packet
          try {
            copies.allocate(credit)
            packet = copies.adopt({frame:{...frame(), sequence, coverageComplete:true}, draws:value.draws,
              indices:frames.indices || value.indices.slice(), additions:[...value.meshResources.values()],
              textureAdditions:Array.from(copies.missingTextures.values(), draw => ({
                textureResourceId:draw.textureResourceId, textureUv:value.meshResources.get(draw.resourceId).textureUv})),
              updateState:{modelRevision:sequence, workerGeneration:1, pendingPriorityUpdateCount:1}})
          } finally { copies.release(); credit.release() }
          renderer.setMeshFrame(packet.frame, packet.draws, packet.resources, packet.indices, packet.updateState,
            null, [], {replacementPlan, selectionCurrent:true, camera:{}})
          if (mode === 'texture') renderer.setImageryPlan(sequence, {draws:renderer.current.draws, levels:new Map(),
            quality:{planningComplete:true, cameraCurrent:true, targetPixelError:1.25}}, [])
        }
        const step = async (display = true) => {
          clock += 20; ++turn
          const completed = replies.filter(value => value.turn <= turn)
          replies = replies.filter(value => value.turn > turn)
          completed.forEach(value => value.resolve())
          gl.complete(); renderer.advanceResources()
          const held = renderer.heldCandidate
          if (display) renderer.render(false)
          if (held) assert.strictEqual(renderer.displaySurface, held.surface,
            'A prepared successor replaced the frozen display before its retention receipt')
          await Promise.resolve(); await Promise.resolve()
          if (failures.length) throw failures[0]
          for (const value of [renderer.current, renderer.displaySurface && renderer.displaySurface.current]) {
            if (value) for (const resource of value.meshResources.values()) {
              const release = resource.ownership.hold(); release()
            }
          }
        }
        const wait = async (predicate, label) => {
          for (let attempt = 0; attempt < 500 && !predicate(); ++attempt) await step()
          assert(predicate(), label)
        }
        try {
          publish(false)
          await wait(() => !frames.candidate, 'Bootstrap did not reach presentation')
          const cycles = preparedBeforeHold ? 1 : 12
          for (let cycle = 0; cycle < cycles; ++cycle) {
            publish(cycle % 2 === 0)
            await wait(() => renderer.replacement && renderer.replacement.committed.size > 0 &&
              renderer.displaySurface.current !== renderer.current, 'No genuine mixed display was submitted: ' +
              JSON.stringify({preparedBeforeHold,mode,slices,delay,cycle}))
            assert(frames.candidate, 'Fixture already completed the full candidate')
            if (preparedBeforeHold) {
              const ahead = () => renderer.preparedSurfaceSource === renderer.current &&
                renderer.preparedSurface &&
                renderer.preparedSurface.current !== renderer.displaySurface.current
              for (let attempt = 0; attempt < 100 && !ahead(); ++attempt) await step(false)
              assert(ahead(), 'Fixture did not prepare a second independent group before locking display: ' +
                JSON.stringify({mode,slices,delay,cycle,committed:[...renderer.replacement.committed],
                  proposed:[...renderer.replacement.proposed],queued:renderer.uploadQueue.length,
                  prepared:renderer.preparedSurface&&renderer.preparedSurface.current.draws.map(d=>d.resourceId),
                  display:renderer.displaySurface.current.draws.map(d=>d.resourceId)}))
            }
            const held = renderer.holdCandidate(sequence)
            assert(held, 'Submitted partial candidate could not be held')
            if (preparedBeforeHold) {
              // The display clock may run before the next background turn.
              // An explicit readback uses exactly this already-prepared state.
              gl.complete(); renderer.render(true)
              assert.strictEqual(renderer.displaySurface, held.surface,
                'The display clock published a prepared successor during a retention hold')
            }
            let done = false
            receipts.retain(sequence, held.draws).then(() => { done = true })
            await wait(() => done, 'Partial ownership receipt did not complete')
            assert.deepStrictEqual([...frames.presented.resources.keys()].sort((a,b) => a-b),
              [...new Set(held.draws.map(draw => draw.resourceId))].sort((a,b) => a-b),
              'Retained CPU membership differs from the submitted mixed display')
            frames.discard(sequence); renderer.discardCandidate(held)
            for (let pause = 0; pause <= delay; ++pause) await step()
            renderer.releaseCandidate(held)
          }
          publish(false)
          await wait(() => !frames.candidate && renderer.submittedSequence === sequence,
            'Interrupted handoffs did not recover to a complete successor')
          assert(partials >= cycles)
          ++tested
        } finally {
          receipts.clear(); frames.clear(); renderer.destroy()
          replies.forEach(value => value.resolve())
          await Promise.resolve(); await Promise.resolve()
        }
        assert.strictEqual(renderer.resourceLedger.bytes, 0, 'Partial handoff retained payload after teardown')
      }
    }
  } finally {
    if (previous) Object.defineProperty(global, 'performance', previous)
    else delete global.performance
  }
  assert.strictEqual(tested, 24)
  console.log('Partial mesh retention: prepared successors, frozen display, shared UV, delayed receipts, interruption and recovery passed')
}

if (require.main === module) module.exports().catch(error => {console.error(error); process.exitCode = 1})
