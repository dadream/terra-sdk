const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {GlSubmission, UploadBudget} = require('../../adapters/webgl/gl_allocation')
const {ownIndices} = require('../../sdk/js/resources/mesh_indices')

module.exports = function verifyTerrainIndices({Renderer, AsyncGl, FakeCanvas, draw}) {
  const ledger = new ResourceLedger(1000), gl = new AsyncGl()
  const r = new Renderer(new FakeCanvas(gl), {resourceLedger: ledger, mode: 'height', urlForTile: () => ''})
  const first = new Uint16Array([0, 1, 2]), second = new Uint16Array([2, 1, 0])
  const buffers = () => gl.calls.filter(call => call.name === 'bufferData').length
  const stage = source => {
    r.current = {indices: source}
    const batch = new GlSubmission(gl)
    r.uploadBatch = batch
    try { r.indices.stage(source) } finally { r.uploadBatch = null }
    return batch
  }
  let outputs, batch, display
  try {
    // A genuinely empty bootstrap can remain current after its CPU producer
    // retires. It needs no GL buffer and must not poison the later upload lane.
    const empty = ownIndices(new Uint16Array(0), ledger.reserve('terrain-index-host', 0))
    empty.ownership.retire()
    r.indices.accept(empty)
    const emptyBefore = buffers()
    batch = stage(empty); batch.commit(); batch = null
    assert.strictEqual(buffers(), emptyBefore, 'Empty bootstrap allocated a GL strip')
    assert.strictEqual(r.indices.pending, undefined, 'Empty bootstrap stranded an index upload')
    assert(r.indices.ready(empty))
    r.uploadIndexBuffer(empty)
    assert.strictEqual(ledger.bytes, 0)

    // A rejected nonempty source must refund its unissued GPU destination
    // and leave the lane usable by the next real frame.
    const released = ownIndices(new Uint16Array([0, 1, 2]), ledger.reserve('terrain-index-host', 6))
    released.ownership.retire()
    assert.throws(() => stage(released), /released/)
    assert(!r.indices.pending)
    assert.strictEqual(ledger.bytes, 0)

    // Admission includes the first index destination before mesh production.
    const packet = {indexBytes: 6, draws: [Object.assign(draw(0), {resourceId: 1,
      textureResourceId: 1, vertexCount: 3})]}
    ledger.setLimit(85) // 60 GPU mesh + 20 producer + 6 indices, less one byte.
    assert.strictEqual(r.reserveMeshOutputs(packet, 20), null, 'Indices were omitted from complete-frame admission')
    assert.strictEqual(ledger.bytes, 0, 'Refused joint admission retained a partial destination')
    ledger.setLimit(86)
    outputs = r.reserveMeshOutputs(packet, 20)
    assert(outputs && outputs.valid())
    assert.strictEqual(outputs.credit.bytes, 20)
    assert.strictEqual(r.indices.bytes, 6, 'Unclaimed GPU index output was not accounted')
    r.indices.accept(first, outputs)
    outputs.release(); outputs.credit.release(); outputs = null
    assert.strictEqual(ledger.bytes, 6, 'Frame receipt refunded the claimed index destination')
    // Upload timeslicing is not cancellation. Keep the admitted destination
    // when another producer has already consumed this batch's GL command budget.
    ledger.setLimit(6)
    const budget = new UploadBudget(6, 1)
    assert(budget.take(6, 1))
    batch = new GlSubmission(gl, null, budget)
    r.current = {indices: first}; r.uploadBatch = batch
    try { r.indices.stage(first) } finally { r.uploadBatch = null }
    assert.strictEqual(batch.items.length, 0)
    assert.strictEqual(ledger.bytes, 6, 'Upload deferral refunded a promised index destination')
    assert.strictEqual(ledger.reserve('competitor', 1), null,
      'Another producer stole index completion credit during upload deferral')
    batch.commit(); batch = null
    const reserve = ledger.reserve
    ledger.reserve = () => assert.fail('Admitted indices tried to obtain a second grant')
    try { batch = stage(first) } finally { ledger.reserve = reserve }
    assert.strictEqual(r.indexBuffer, null, 'Upload published before its completion receipt')
    assert.strictEqual(r.indices.bytes, 6)
    batch.commit(); batch = null
    r.uploadIndexBuffer(first)
    const old = r.indexBuffer
    assert(old)

    // One byte short leaves the displayed buffer intact and issues no upload.
    ledger.setLimit(11)
    const before = buffers()
    batch = stage(second)
    assert.strictEqual(buffers(), before, 'Index allocation escaped shared admission')
    assert.strictEqual(batch.items.length, 0)
    assert.strictEqual(r.indexBuffer, old)
    batch.commit(); batch = null

    // A submitted display retains old indices after a replacement activates.
    ledger.setLimit(12)
    display = new GlSubmission(gl); r.indices.hold(display)
    batch = stage(second)
    assert.strictEqual(ledger.bytes, 12)
    assert.strictEqual(ledger.reserve('competitor', 1), null)
    batch.commit(); batch = null
    r.uploadIndexBuffer(second)
    assert.notStrictEqual(r.indexBuffer, old)
    assert.strictEqual(ledger.bytes, 12, 'Replacement refunded a submitted old buffer before its receipt')
    assert(!gl.calls.some(call => call.name === 'deleteBuffer' && call.args[0] === old))
    display.commit(); display = null
    assert.strictEqual(ledger.bytes, 6)
    assert(gl.calls.some(call => call.name === 'deleteBuffer' && call.args[0] === old))

    // A superseded upload and a failed upload return only their own credit.
    batch = stage(first)
    r.current = {indices: second}
    batch.commit(); batch = null
    assert.strictEqual(ledger.bytes, 6)
    assert.strictEqual(r.uploadedIndices, second)

    // A prepared but never displayed layout must yield to a newer layout
    // inside the same two-buffer envelope, without discarding the old display.
    batch = stage(first); batch.commit(); batch = null
    assert.strictEqual(ledger.bytes, 12)
    const third = new Uint16Array([1, 0, 2])
    r.indices.accept(third)
    assert.strictEqual(ledger.bytes, 6, 'Superseded prepared indices blocked the next layout')
    assert.strictEqual(r.uploadedIndices, second)
    batch = stage(third); batch.commit(); batch = null
    r.uploadIndexBuffer(third)
    assert.strictEqual(ledger.bytes, 6)
    batch = stage(first)
    const getError = gl.getError
    gl.getError = () => 0x0505
    try { assert.throws(() => batch.commit(), /allocation failed/) }
    finally { gl.getError = getError; batch.cancel(); batch = null }
    assert.strictEqual(ledger.bytes, 6)
    assert.strictEqual(r.uploadedIndices, third)

    // Context loss proves all old GPU handles gone; no deletion crosses into
    // the replacement context. The retained host source can be uploaded anew.
    batch = stage(first)
    r.contextLost = true; batch.cancel(true); batch = null
    const deletes = gl.calls.filter(call => call.name === 'deleteBuffer').length
    r.indices.clear(true)
    assert.strictEqual(ledger.bytes, 0)
    assert.strictEqual(gl.calls.filter(call => call.name === 'deleteBuffer').length, deletes)
    r.contextLost = false
    batch = stage(first); batch.commit(); batch = null
    r.uploadIndexBuffer(first)
    assert.strictEqual(ledger.bytes, 6)
    assert.strictEqual(r.indices.bytes, 6)
    r.indices.clear()
    assert.strictEqual(ledger.bytes, 0)

    // CPU ownership survives both producer retirement and renderer reset
    // while a submitted draw still owns the GPU buffer that borrowed it.
    const owned = ownIndices(new Uint16Array([0, 1, 2]), ledger.reserve('terrain-index-host', 6))
    ledger.setLimit(12)
    r.indices.accept(owned)
    batch = stage(owned); batch.commit(); batch = null
    r.uploadIndexBuffer(owned)
    owned.ownership.retire()
    display = new GlSubmission(gl); r.indices.hold(display)
    r.indices.clear()
    assert.strictEqual(ledger.bytes, 12, 'Renderer reset refunded submitted CPU/GPU indices')
    assert.strictEqual(ledger.reserve('competitor', 1), null)
    display.commit(); display = null
    assert.strictEqual(ledger.bytes, 0, 'Draw receipt retained the final CPU index borrower')
  } finally {
    if (batch) batch.cancel(r.contextLost)
    if (display) display.cancel(r.contextLost)
    if (outputs) { outputs.release(); outputs.credit.release() }
    r.current = null
    r.destroy()
  }
  assert.strictEqual(ledger.bytes, 0, 'Destroyed renderer retained terrain index credit')
}
