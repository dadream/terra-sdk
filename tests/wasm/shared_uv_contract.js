const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')

// Native sharing must survive separate mesh loans, topology replacement, cache
// eviction and manifest reset. Views still expose each mesh's exact coordinates;
// host copies and GPU buffers remain separately charged until they also share.
module.exports = function verifySharedUv(module) {
  const abi = new TerraAbi(module)
  const manifest = {
    formatVersion: 1, patchDimension: 64, transform: 'cylindrical',
    heightScale: 0.001953125, minimumU: -180, minimumV: -90,
    maximumU: 180, maximumV: 90, radius: 6378000,
    texture: {kind: 'global-geodetic', matrix_level_offset: 0, maximum_level: 8, minimum_level: 0,
      tile_size: 256, level_zero_columns: 2, level_zero_rows: 1, bounds: [[-180, -90], [180, 90]]}
  }
  const record = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_root_0_record.bin'))
  const budget = {maximumChangeCount: 32, maximumPriorityUpdateCount: 256, maximumElapsedMs: 0}
  const loans = []
  const publish = (threshold = 1) => {
    const packet = abi.prepareMeshFrame(threshold, budget)
    const before = abi.meshPayloadBytes(), credit = packet.nativePlan.additionalBytes
    abi.materializeMeshFrame(packet); abi.commitMeshFrame(packet)
    assert(abi.meshPayloadBytes() <= before + credit, 'Native UV production exceeded its funded bytes')
    abi.presentFrame(packet.frame.sequence)
    return Array.from(new Map(packet.draws.map(draw => [draw.resourceId, draw])).values())
  }
  const physical = draws => {
    const positions = new Map(), uv = new Map(), layouts = new Map()
    for (const draw of draws) {
      const id = draw.resourceId, copy = abi.copyMeshResource(draw)
      positions.set(module.call('terra_get_mesh_position_view', abi.context, id), copy.positions.byteLength)
      const pointer = module.call('terra_get_mesh_texture_view', abi.context, id)
      uv.set(pointer, copy.textureUv.byteLength)
      const identity = Buffer.from(copy.textureUv.buffer).toString('hex')
      if (layouts.has(identity)) assert.strictEqual(pointer, layouts.get(identity), 'Identical UV layouts were allocated per mesh')
      layouts.set(identity, pointer)
    }
    assert(uv.size < positions.size, 'Sharing fixture needs distinct meshes with identical UV')
    return [...positions.values(), ...uv.values()].reduce((sum, bytes) => sum + bytes, 0)
  }
  try {
    abi.loadManifest(manifest)
    abi.setViewport(1280, 720, Math.PI / 6)
    publish()
    const roots = abi.getRequests().filter(request => request.kind === 1)
    assert.strictEqual(roots.length, 8)
    roots.forEach(request => abi.submitRecord(request.kind, request.key, record))
    const initial = publish()
    abi.trimMeshCache()
    assert.strictEqual(abi.meshPayloadBytes(), physical(initial), 'Native accounting duplicated shared UV')
    const rootUv = new Set(initial.map(draw => module.call('terra_get_mesh_texture_view', abi.context, draw.resourceId)))
    abi.setGlobeTarget(116.5623, 40.74863)
    abi.setCamera({distance: 2000000, tiltRadians: 0, yawRadians: 0})
    let a, b
    for (let step = 0; step < 24 && !b; ++step) {
      const detailed = publish(0.005)
      const layouts = new Map()
      for (const draw of detailed) {
        if (!draw.key.level) continue
        const pointer = module.call('terra_get_mesh_texture_view', abi.context, draw.resourceId)
        if (!rootUv.has(pointer)) continue
        if (layouts.has(pointer)) { a = layouts.get(pointer); b = draw; break }
        layouts.set(pointer, draw)
      }
      // This synthetic fixture declares absent residuals, retaining root heights.
      abi.getRequests().filter(request => request.kind === 2).forEach(request => abi.noDataRecord(request.key))
    }
    assert(a && b, 'Sharing fixture needs two detailed meshes with a retained root UV layout')
    loans.push(abi.borrowMeshResource(a), abi.borrowMeshResource(a), abi.borrowMeshResource(b))
    const savedUv = loans[0].textureUv.slice()
    abi.setCamera({distance: 30000000, tiltRadians: 0, yawRadians: 0})
    let successor
    for (let step = 0; step < 24; ++step) {
      successor = publish()
      if (successor.every(draw => draw.key.level === 0)) break
    }
    assert(successor.every(draw => draw.key.level === 0), 'Coarsening did not release detailed positions')
    abi.trimMeshCache()
    const heldBytes = abi.meshPayloadBytes()
    assert.strictEqual(heldBytes, physical([...successor, a, b]), 'Cache trim lost UV or a mesh loan owner')
    loans.forEach(loan => assert.deepStrictEqual(loan.textureUv, savedUv, 'Topology replacement changed immutable UV'))
    loans[0].ownership.retire()
    abi.trimMeshCache()
    assert.strictEqual(abi.meshPayloadBytes(), heldBytes, 'First mesh borrower refunded a still borrowed allocation')
    loans[1].ownership.retire()
    abi.trimMeshCache()
    assert.strictEqual(abi.meshPayloadBytes(), heldBytes - a.vertexCount * 12,
      'Last mesh borrower must release its positions while the shared UV remains owned')
    loans[2].ownership.retire()
    abi.trimMeshCache()
    assert.strictEqual(abi.meshPayloadBytes(), physical(successor), 'Shared UV was refunded before its successor retired')
    abi.loadManifest(manifest)
    assert.strictEqual(abi.meshPayloadBytes(), 0, 'Manifest reset retained unowned UV payload')
  } finally {
    loans.forEach(loan => loan.ownership.retire())
    abi.destroy()
  }
}
