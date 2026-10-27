const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {descendantTextureTile: child} = require('../../sdk/js/imagery/terra_texture_tiles')
const installGeometry = require('./reference/geometry_payload')

// One complete replacement: old geometry/image64 + producing host/native60 +
// four already-funded images16 + new geometry60 + complete UV48 =248 bytes.
// Pending images are real cache reservations, not a guessed future allowance.
// This is the image/UV allocation contract, without a native display frame.
// Actual display-cut costs and receipts are tested with real Wasm/Worker cuts.
module.exports = async function verifyCandidateImages(Renderer, canvas) {
  for (const action of ['complete', 'missing', 'queued', 'short', 'lost', 'replaced', 'resize', 'pause', 'source', 'late-lost', 'late-short']) {
    const ledger = new ResourceLedger(action === 'short' ? 247 : 248)
    let entered, finish, outputs, pending
    const started = new Promise(resolve => {entered = resolve})
    const r = new Renderer(canvas, {resourceLedger: ledger, urlForTile: () => {
      assert.fail('Ownership fixture must not access a network')
    }, textureDescriptor: {tile_size: 1}, geometryCacheBytes: 10000,
    createTextureStore: action === 'queued' ? (renderer, options) =>
      new (require('../../adapters/webgl/image_texture_store').ImageTextureStore)(renderer, options) : undefined,
    partitionCacheBytes: 10000, meshPartitionWorkspaceBytes: () => 0,
    createMeshPartitionPlanTask(id, rows, onRows) {
      entered()
      return {promise: new Promise(resolve => {finish = () => {
        finish = null
        const ready = onRows(rows.map(row => ({resourceId: row.draw.resourceId, source: 'sampled',
          prices: row.cells.map(cell => ({key: cell.key, bytes: 6}))})))
        resolve(ready)
      }}), cancel() {}}
    }})
    const root = {level: 0, matrix: 0, row: 0, column: 0}
    const before = {resourceId: 1, textureResourceId: 4294967297, texture: root, vertexCount: 3}
    const next = {...before, resourceId: 2, textureResourceId: 4294967298}
    const targets = [0,1].flatMap(row => [0,1].map(column => ({...next,
      sourceTexture: root, texture: child(root, 1, row, column), imageryClipCell: true,
      imageryCellScale: 2, imageryCellOffsetX: -column, imageryCellOffsetY: -row})))
    const store = r.textures, reservations = []
    let producer, completeRequest, competitor
    try {
      installGeometry(r, before, {key: 'mesh:1', partitions: new Map()})
      r.geometryPinnedKeys.add('mesh:1')
      r.displaySurface = {current: {draws: [before]}, renderDraws: []}
      r.presentation.cells.set(key(root), {cell: root, a: root, b: root})
      store.currentRoots.set(key(root), root)
      store.cache.set(key(root), {texture: {}, width: 1, height: 1}, 4)
      const paid = action === 'missing' ? targets.slice(0, 3) : targets
      if (action === 'queued') {
        assert(store.groupAdmission.admit(new Map(targets.map(draw => [key(draw.texture), draw.texture])), 4, new Set()))
        reservations.push(...store.groupAdmission.pending.values())
      } else for (const draw of paid) reservations.push(store.cache.reserve(key(draw.texture), 4))
      assert(reservations.every(Boolean))
      let aborted = false
      if (action === 'complete') store.scheduler.enqueue(key(targets[0].texture), () => ({
        promise: new Promise(resolve => {completeRequest = resolve}), abort() {aborted = true}
      }), 1)
      producer = ledger.reserve('fixture-native-and-host', 60)
      assert(producer)
      const packet = {draws: [next],
        nativePlan: {id: 2}, imageryPlan: {draws: targets, quality: {cameraCurrent: true}}}
      pending = r.admitCandidate(packet)
      await Promise.race([started, pending.then(() => assert.fail('UV preparation did not suspend'))])
      assert(store.candidateDemands.size === 1)
      const transaction = Array.from(store.candidateDemands)[0]
      if (action === 'queued') {
        store.protectRequests()
        assert(transaction.valid(), 'Group pruning cancelled destinations already borrowed by a candidate')
        assert.strictEqual(store.groupAdmission.pending.size, 4)
      }
      assert.strictEqual(transaction.continuationBytes, action === 'missing' ? 4 : 0,
        'Already funded image destinations were charged a second time')
      assert.strictEqual(ledger.bytes, 200)
      if (action === 'lost' || action === 'replaced') {
        reservations[0].cancel()
        if (action === 'replaced') {
          reservations[0] = store.cache.reserve(key(targets[0].texture), 4)
          assert(reservations[0])
        }
        assert.strictEqual(transaction.valid(), false,
          'A cancelled/replaced image producer left a valid zero-byte continuation')
      } else if (action === 'resize') {
        assert(reservations[0].resize(8))
        assert.strictEqual(transaction.valid(), false,
          'A changed image quote retained the old continuation receipt')
      } else if (action === 'pause') r.setPaused(true)
      else if (action === 'source') store.clear()
      else {
        assert(store.isWanted(key(targets[0].texture)),
          'Current-view pruning can cancel an image producer borrowed by UV preparation')
        assert(store.wantedKeys(Date.now()).has(key(targets[0].texture)))
        assert(!store.isWanted(key(child(root, 2, 0, 0))),
          'Candidate ownership started unrelated speculative image work')
        if (action === 'missing') assert(!store.isWanted(key(targets[3].texture)),
          'A not-yet-started future image became speculative request demand')
        store.sync([before], [], true)
        assert.strictEqual(aborted, false,
          'A coarse view cancelled the actual request backing the candidate image quote')
        if (!action.startsWith('late-')) for (const reservation of reservations)
          assert(reservation.commit({texture: {}, width: 1, height: 1}))
        assert(transaction.valid(), 'Upload completion invalidated the borrowed image receipt')
      }
      finish()
      if (!['complete', 'missing', 'queued', 'late-lost', 'late-short'].includes(action)) {
        await assert.rejects(pending, error => error.status === 9)
        assert(r.geometry.has('mesh:1'), 'Refusal changed the old displayed geometry')
        if (action !== 'source') assert(store.cache.has(key(root)))
      } else {
        outputs = await pending
        assert(outputs.valid())
        assert.strictEqual(ledger.bytes, 248)
        assert.strictEqual(ledger.reserve('unfunded-competitor', 1), null)
        assert.strictEqual(r.partitionCpuBytes, 24)
        assert.strictEqual(r.partitionReservedBytes, 24)
        if (action.startsWith('late-')) {
          reservations[0].cancel()
          assert.strictEqual(outputs.valid(), false)
          if (action === 'late-short') {
            competitor = ledger.reserve('late-competitor', 4)
            assert(competitor)
            assert.throws(() => outputs.acceptImageryDemand(), error => error.status === 9 && error.candidateAdmissionRejected,
              'Late destination loss was treated as an engine error instead of a refused exchange')
            const current = r.current, display = r.displaySurface, plan = r.meshOutputPlan
            assert.throws(() => r.setMeshFrame({sequence:2,coverageComplete:true}, packet.draws, new Map(), new Uint16Array(1),
              {}, packet.imageryPlan, [], {outputs}), error => error.status === 9 && error.candidateAdmissionRejected)
            assert.strictEqual(r.current, current, 'Refused exchange changed renderer metadata')
            assert.strictEqual(r.displaySurface, display, 'Refused exchange changed the submitted cover')
            assert.strictEqual(r.meshOutputPlan, plan, 'Receiver retired output before its final price')
            assert(r.geometry.has('mesh:1'))
            continue
          }
        }
        outputs.acceptImageryDemand()
        assert.strictEqual(store.candidateDemands.size, 0)
        if (action === 'late-lost') for (const reservation of reservations.slice(1))
          assert(reservation.commit({texture: {}, width: 1, height: 1}))
        if (action === 'missing' || action === 'late-lost') {
          const image = store.reserveRequest(key(targets[action === 'missing' ? 3 : 0].texture))
          assert(image, 'The missing member lost its paid continuation at acceptance')
          reservations.push(image)
          assert.strictEqual(ledger.bytes, 248, 'Image production duplicated continuation credit')
          assert(image.commit({texture: {}, width: 1, height: 1}))
        }
        assert.strictEqual(outputs.imageryDemand().requiredBytes, 0)
        assert(targets.every(draw => store.gpuReady(key(draw.texture))))
      }
    } finally {
      if (finish) finish()
      if (pending) await pending.catch(() => {})
      if (outputs) {outputs.release(); outputs.credit.release()}
      if (completeRequest) completeRequest()
      reservations.forEach(reservation => reservation.cancel())
      if (producer) producer.release()
      if (competitor) competitor.release()
      r.destroy()
      assert.strictEqual(ledger.bytes, 0, action + ' leaked image/geometry/UV ownership')
      assert(ledger.highWaterBytes <= ledger.maximumBytes)
    }
  }
}

if (require.main === module) {
  const {TerraWebGlRenderer} = require('../../adapters/webgl/terra_webgl_renderer')
  const {FakeCanvas, FakeGl} = require('./support/webgl_fixture')
  module.exports(TerraWebGlRenderer, new FakeCanvas(new FakeGl())).then(() =>
    console.log('Candidate images: joint exact-budget admission, producer identity and disposal passed'),
  error => {console.error(error); process.exitCode = 1})
}
