const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const {surfaceBlocks} = require('../../sdk/js/terrain/surface_blocks')
const {isDeepStrictEqual} = require('util')

module.exports = async function verifySharedTransfer(abi, worker, ledger) {
  const frames = new MeshFrames(ledger)
  const manifest = {formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
    heightScale: 1 / 512, minimumU: -180, minimumV: -90, maximumU: 180, maximumV: 90, radius: 6378000,
    texture: {kind: 'global-geodetic', matrix_level_offset: 0, maximum_level: 8, minimum_level: 0,
      tile_size: 256, level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180, -90], [180, 90]]}}
  const record = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_root_0_record.bin'))
  const budget = {maximumChangeCount: 32, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0}
  let release
  const read = async (threshold = 1) => {
    const packet = worker ? await abi.step(threshold, budget, frames) : await frames.read(abi, threshold, budget)
    await abi.presentFrame(packet.frame.sequence)
    frames.present(packet.frame.sequence)
    return packet
  }
  try {
    await abi.loadManifest(manifest)
    abi.setViewport(640, 360, Math.PI / 4)
    abi.setGlobeTarget(116.5623, 40.74863)
    abi.setCamera({distance: 20000000, tiltRadians: 0, yawRadians: 0})
    const empty = await read(), requests = worker ? empty.requests : abi.getRequests()
    assert.strictEqual(requests.filter(r => r.kind === 1).length, 8)
    for (const request of requests) if (request.kind === 1) await abi.submitRecord(request.kind, request.key, record)
    const packet = await read(), uniqueUv = new Map(), uniqueLayouts = new Map(), meshes = Array.from(frames.resources.values())
    for (const resource of meshes) {
      if (uniqueUv.has(resource.textureResourceId))
        assert.strictEqual(resource.textureUv, uniqueUv.get(resource.textureResourceId), 'Host duplicated an immutable UV array')
      uniqueUv.set(resource.textureResourceId, resource.textureUv)
      if (worker) {
        const layout = resource.model.layout, previous = uniqueLayouts.get(resource.textureResourceId)
        assert(layout && layout.faceCount > 0, 'Worker did not prepare a complete surface layout')
        if (previous) assert.strictEqual(layout, previous, 'Worker transfer duplicated static surface topology')
        uniqueLayouts.set(resource.textureResourceId, layout)
        assert(resource.model.blocks.every((block, i) => block.faces === layout.blocks[i].faces && block.uv === layout.blocks[i].uv))
        assert(isDeepStrictEqual(resource.model.blocks, surfaceBlocks(resource.positions, resource.textureUv,
          resource.model.faces, resource.model.bounds)), 'Shared native layout changed terrain summaries')
      }
    }
    assert.strictEqual(meshes.length, 16)
    assert(uniqueUv.size < meshes.length)
    assert.strictEqual(packet.textureAdditions.length, uniqueUv.size, 'Wire protocol duplicated UV resources')
    const positionBytes = meshes.reduce((n, mesh) => n + mesh.positions.byteLength, 0)
    const textureBytes = Array.from(uniqueUv.values()).reduce((n, uv) => n + uv.byteLength, 0)
    const nativeBytes = worker ? abi.nativeBytes : abi.meshPayloadBytes()
    const indexBytes = frames.indices.byteLength, residentIndexBytes = indexBytes * (worker ? 2 : 1)
    assert.strictEqual(frames.copiedBytes, positionBytes + textureBytes + residentIndexBytes)
    assert.strictEqual(frames.ledger.bytes, nativeBytes + positionBytes + textureBytes + residentIndexBytes +
      abi.recordBudget.actual + abi.heightBudget.actual)
    assert.strictEqual(frames.ledger.stats().owners['terrain-index-host'].retired, indexBytes)
    if (worker) assert.strictEqual(abi.indexBudget.actual, indexBytes)
    assert(!frames.ledger.stats().owners['mesh-worker'], 'Worker native views were charged as duplicate CPU arrays')
    const stable = await read()
    assert.strictEqual(stable.additions.length, 0)
    assert.strictEqual(stable.textureAdditions.length, 0)
    const borrowed = meshes[0]
    release = holdMeshes([borrowed])
    if (worker) {
      abi.setCamera({distance: 2000000, tiltRadians: -0.4, yawRadians: 0.5})
      const detail = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_root_0_detail_record.bin'))
      let reused = 0
      const trace = []
      // Refinement requests height detail before producing the next topology;
      // root-only data cannot exercise cross-publication layout reuse.
      for (let turn = 0; turn < 6 && !reused; ++turn) {
        const next = await read(0.005)
        trace.push({added: next.additions.length, changes: next.updateState.topologyChangeCount,
          heightBuilds: next.updateState.heightBuildCount})
        for (const request of next.requests) if (request.kind === 2 && request.key.level === 0)
          await abi.submitRecord(request.kind, request.key, detail)
        for (const resource of next.additions) if (uniqueLayouts.has(resource.textureResourceId)) {
          assert.strictEqual(resource.model.layout, uniqueLayouts.get(resource.textureResourceId),
            'A later publication recopied a still-owned UV layout')
          ++reused
        }
        // The first finer level introduces another UV template. Compare
        // subsequent publications against it, not just against root UVs.
        for (const resource of next.additions) uniqueLayouts.set(resource.textureResourceId, resource.model.layout)
      }
      assert(reused > 0, 'Native fixture did not produce new geometry with existing UV: '+JSON.stringify(trace))
    }
    frames.clear()
    await abi.loadManifest(manifest)
    assert.strictEqual(frames.ledger.bytes, borrowed.positions.byteLength + borrowed.textureUv.byteLength +
      indexBytes + abi.recordBudget.actual,
      'Source reset refunded a live host mesh or kept unrelated shared coordinates')
    release(); release = null
    assert.strictEqual(frames.ledger.bytes, abi.recordBudget.actual)
  } finally {
    if (release) release()
    frames.clear()
    await abi.loadManifest(manifest)
  }
  console.log((worker ? 'Worker' : 'Direct Wasm') + ' unique UV transfer, reuse, credit and source retirement passed')
}
