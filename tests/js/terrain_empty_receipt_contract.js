const assert = require('assert')
const adoptPacket = require('./reference/mesh_packet')

// Data reclamation can temporarily leave a selected cut without any meshes.
// It has no display receipt while an older complete cut is still presented.
module.exports = async function({createRuntime, FakeAbi, settle}) {
  for (const worker of [false, true]) {
    const abi = new FakeAbi(), receipts = [], discarded = []
    let phase = 'boot', resourceId = 1
    const update = abi.updateStep.bind(abi)
    abi.getRequests = () => []
    abi.updateStep = () => Object.assign(update(), {
      drawCount: phase === 'surface' ? 1 : 0,
      coverageComplete: phase === 'surface' || phase === 'empty-view',
      omittedDrawCount: phase === 'missing' ? 1 : 0
    })
    abi.getMeshResources = () => phase === 'surface' ? [{resourceId, vertexCount: 3}] : []
    abi.copyMeshResource = draw => ({resourceId: draw.resourceId,
      positions: new Float32Array(9), textureUv: new Float32Array(6)})
    abi.presentFrame = sequence => { receipts.push(sequence) }
    if (worker) {
      abi.isWorker = true
      abi.viewRevision = 1
      abi.discardFrame = async sequence => { discarded.push(sequence) }
      abi.advanceTerrain = async () => ({progress: abi.getUpdateState(),
        selectionViewRevision: abi.viewRevision, requests: []})
      abi.step = async (_, budget, frames) => {
        const frame = abi.updateStep(), draws = abi.getMeshResources()
        return adoptPacket(frames, {frame, draws, additions: draws.map(draw => abi.copyMeshResource(draw)),
          indices: new Uint16Array([0,1,2]), requests: [], updateState: abi.getUpdateState(),
          selectionViewRevision: abi.viewRevision})
      }
    }
    const {runtime} = await createRuntime({abi, canvas: {requestAnimationFrame: () => 1}})
    try {
      await settle(3)
      await runtime.meshReceipts.tail
      assert(runtime.meshFrames.presented && !runtime.meshFrames.presented.draws.length,
        'An initial empty selection could not release the bootstrap transaction')
      phase = 'surface'
      await runtime.refresh()
      const first = runtime.meshFrames.candidate
      assert(first && first.draws.length === 1)
      await runtime.presentMeshFrame(first.frame.sequence)
      const shown = runtime.meshFrames.presented, shownFrame = runtime.presentedFrame
      const before = receipts.length, old = runtime.meshFrames.resources.get(1)
      assert(old)

      phase = 'missing'
      await runtime.refresh()
      await runtime.meshReceipts.tail
      assert.strictEqual(runtime.meshFrames.presented, shown,
        'An empty incomplete candidate retired the still displayed terrain cut')
      const missing = runtime.meshFrames.candidate
      assert(missing && !missing.draws.length && missing.frame.coverageComplete === false)
      await runtime.presentMeshFrame(missing.frame.sequence)
      assert.strictEqual(receipts.length, before, 'An empty incomplete cut obtained a native display receipt')
      assert.strictEqual(runtime.presentedFrame, shownFrame)
      assert.strictEqual(runtime.meshFrames.resources.get(1), old, 'Missing data refunded the old CPU mesh')

      phase = 'surface'; resourceId = 2
      await runtime.refresh()
      const successor = runtime.meshFrames.candidate
      assert(successor && successor.draws.length === 1)
      assert.strictEqual(runtime.meshFrames.presented, shown, 'Preparation retired old coverage before submission')
      await runtime.presentMeshFrame(successor.frame.sequence)
      assert.strictEqual(runtime.meshFrames.presented, successor)
      assert(!runtime.meshFrames.resources.has(1), 'Actual successor receipt retained the retired mesh')
      if (worker) assert(discarded.includes(missing.frame.sequence), 'Missing-data candidate was not discarded')

      phase = 'empty-view'
      await runtime.refresh()
      await runtime.meshReceipts.tail
      assert(!runtime.meshFrames.candidate)
      assert(runtime.meshFrames.presented.frame.coverageComplete)
      assert.strictEqual(runtime.meshFrames.presented.draws.length, 0,
        'A genuine complete empty view was treated as missing data')
    } finally { runtime.destroy() }
    assert.strictEqual(runtime.resourceLedger.bytes, 0, 'Empty selection retained owned terrain resources')
  }
  console.log('Terrain receipts: missing-data emptiness preserves old coverage; bootstrap, successor and complete empty views progress')
}
