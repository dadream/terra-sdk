const assert = require('assert')
const { ResourceLedger } = require('../../sdk/js/resources/resource_ledger')
const { ResourceCache } = require('../../sdk/js/resources/resource_cache')
const { ResourceWorkspace } = require('../../sdk/js/resources/resource_workspace')
const { ImageryGroupAdmission } = require('../../sdk/js/imagery/imagery_group_admission')
const { textureByteSize } = require('../../adapters/webgl/texture_store')
require('./resource_share_test')

const ledger = new ResourceLedger(80)
const cache = new ResourceCache({ledger, maximumBytes: 40, canEvict: () => false})
const groups = new ImageryGroupAdmission(cache)
let changes = 0
const workspace = new ResourceWorkspace('production', () => ++changes)
const children = new Map([['a', {}], ['b', {}]])
cache.set('display', {}, 20)
const competing = ledger.reserve('other', 1)
assert.strictEqual(groups.admit(children, 10, new Set(), workspace, 40), false)
assert.strictEqual(cache.reservedBytes, 0)
assert.strictEqual(workspace.bytes, 0)
assert.strictEqual(ledger.bytes, 21, 'Rejected destinations left a separately funded workspace')
competing.release()
assert(groups.admit(children, 10, new Set(), workspace, 40))
assert.strictEqual(ledger.bytes, 80)
assert.strictEqual(workspace.availableBytes, 40)
const before = ledger.revision
assert(groups.admit(children, 10, new Set(), workspace, 40))
assert.strictEqual(ledger.revision, before, 'Existing group funding created a wake loop')
assert(!ledger.reserve('competing', 1), 'Another producer consumed the admitted stage capacity')

const input = workspace.take(25), decode = workspace.take(10)
assert(input && decode)
assert(!workspace.take(6))
input.mark('resident'); decode.mark('resident')
assert.strictEqual(ledger.bytes, 80, 'A funded stage was charged twice')
assert.strictEqual(ledger.stats().owners.production.resident, 35)
assert.strictEqual(ledger.stats().owners.production.reserved, 5)
assert(input.resize(5))
assert.strictEqual(workspace.availableBytes, 25)
assert(!ledger.reserve('competing', 1), 'Stage completion refunded the next stage to another owner')
assert(groups.take('a').commit({}))
assert(groups.take('b').commit({}))

workspace.retire()
assert.strictEqual(workspace.bytes, 15)
assert.strictEqual(ledger.bytes, 55, 'Retirement did not refund free capacity only')
assert(!workspace.take(1))
assert(!input.resize(6), 'A retired producer expanded its allocation')
input.mark('resident')
assert.strictEqual(ledger.stats().owners.production.retired, 15, 'Late input revived retired ownership')
assert(input.resize(3))
assert.strictEqual(ledger.bytes, 53)
input.release(); input.release()
decode.release(); decode.release()
assert.strictEqual(workspace.bytes, 0)
assert.strictEqual(workspace.children.size, 0)
cache.clear()
assert.strictEqual(ledger.bytes, 0)
assert.strictEqual(ledger.leases.size, 0)

const empty = new ResourceWorkspace('empty', () => ++changes)
const count = changes
empty.retire(); empty.retire()
assert.strictEqual(changes, count + 1, 'Empty workspace retirement left its owner uninformed')
assert.throws(() => empty.take(-1), /Invalid workspace allocation/)

// The serial path fits the largest allowed encoded body and decoded image at
// each size. It needs one reusable workspace, even with four GPU destinations.
for (const size of [16, 256, 512, 1024]) {
  const gpu = textureByteSize(size, size), pixels = size * size * 4
  const encoded = Math.max(65536, pixels * 2), serial = 2 * encoded
  const budget = 5 * gpu + serial
  const memory = new ResourceLedger(budget)
  const images = new ResourceCache({ledger: memory, maximumBytes: 5 * gpu, canEvict: () => false})
  const production = new ResourceWorkspace('imagery-production')
  const admission = new ImageryGroupAdmission(images)
  const targets = new Map(['a', 'b', 'c', 'd'].map(key => [key, {}]))
  images.set('coverage', {}, gpu)
  assert(admission.admit(targets, gpu, new Set(), production, serial))
  assert.strictEqual(memory.bytes, budget)
  for (const key of targets.keys()) {
    const input = production.take(serial)
    assert(input)
    assert.strictEqual(production.availableBytes, 0)
    assert(input.resize(encoded))
    const bitmap = production.take(pixels)
    assert(bitmap, 'A maximum-size body prevented its own decode')
    assert(admission.take(key).commit({}))
    bitmap.release(); input.release()
    assert.strictEqual(production.availableBytes, serial)
    assert.strictEqual(memory.bytes, budget)
  }
  production.trim()
  assert.strictEqual(memory.bytes, 5 * gpu)
  images.clear()
  assert.strictEqual(memory.bytes, 0)
  assert.strictEqual(memory.highWaterBytes, budget)
  if (size === 256) console.log(JSON.stringify({groupGpuBytes: 4 * gpu,
    serialWorkspaceBytes: serial, groupAdmissionBytes: 4 * gpu + serial,
    formerGroupAdmissionBytes: 4 * (gpu + serial)}))
}
console.log('Joint destination/workspace admission, stage reuse and late retirement passed')

// A previous parallel group leaves an idle production envelope. A complete
// successor may transfer its surplus, without refunding it to competitors or
// charging it again, while preserving the serial path and active producers.
{
  const memory = new ResourceLedger(100)
  const images = new ResourceCache({ledger: memory, maximumBytes: 80, canEvict: () => false})
  const production = new ResourceWorkspace('imagery-production')
  const admission = new ImageryGroupAdmission(images)
  images.set('display', {}, 20)
  production.accept(memory.reserve('imagery-production', 60))
  const input = production.take(15)
  const other = memory.reserve('terrain', 20)
  const targets = new Map([['next-a', {}], ['next-b', {}]])
  let output
  const outputs = {bytes: 10, keep: [], accept: credit => { output = credit }}
  const before = memory.availabilityRevision
  assert(admission.admit(targets, 10, new Set(), production, 30, outputs),
    'An owned idle envelope could not fund the complete GPU/UV group')
  assert.strictEqual(memory.maximumBytes, 100)
  assert.strictEqual(memory.bytes, 100)
  assert.strictEqual(memory.availabilityRevision, before, 'Credit transfer advertised a false refund')
  assert.strictEqual(production.bytes, 30)
  assert.strictEqual(production.availableBytes, 15)
  assert.strictEqual(images.reservedBytes, 20)
  assert.strictEqual(output.bytes, 10)
  assert.strictEqual(memory.stats().owners['imagery-production'].reserved, 40)
  assert(input.resize(30), 'Transfer stole the retained serial workspace')
  production.retire()
  admission.retain(new Set(), new Map())
  assert.strictEqual(memory.bytes, 80, 'Cancelled unstarted destinations refunded an active input')
  input.release(); output.release(); other.release(); images.clear()
  assert.strictEqual(memory.bytes, 0)
  assert.strictEqual(memory.leases.size, 0)
}

// One byte short must leave both the offered credit and eligible victims
// unchanged. On success only the unfunded remainder needs fresh admission.
{
  const memory = new ResourceLedger(99), disposed = []
  const images = new ResourceCache({ledger: memory, maximumBytes: 60, dispose: value => disposed.push(value)})
  images.set('idle', 'idle', 10)
  const production = new ResourceWorkspace('imagery-production')
  production.accept(memory.reserve('imagery-production', 50))
  const active = production.take(20), other = memory.reserve('terrain', 39)
  const admission = new ImageryGroupAdmission(images)
  const targets = new Map([['next', {}]])
  const before = memory.availabilityRevision
  assert.strictEqual(admission.admit(targets, 41, new Set(), production, 20), false)
  assert.deepStrictEqual(disposed, [])
  assert.strictEqual(production.bytes, 50)
  assert.strictEqual(production.availableBytes, 30)
  assert.strictEqual(memory.availabilityRevision, before)
  assert(other.resize(38))
  assert(admission.admit(targets, 41, new Set(), production, 20))
  assert.deepStrictEqual(disposed, ['idle'])
  assert.strictEqual(memory.bytes, 99)
  assert.strictEqual(production.bytes, 20)
  assert.strictEqual(production.availableBytes, 0)
  assert(admission.take('next').commit({}))
  production.retire(); active.release(); images.clear(); other.release()
  assert.strictEqual(memory.bytes, 0)
  assert.strictEqual(memory.leases.size, 0)
}
console.log('Owned credit transfer, atomic shortage refusal and receipt-owned retirement passed')

// Evicting an idle asset can return its input to the same workspace during
// admission. This internal refund does not reduce the amount transferred out.
{
  const memory = new ResourceLedger(100), production = new ResourceWorkspace('imagery-production')
  production.accept(memory.reserve('imagery-production', 60))
  const idleInput = production.take(20)
  const images = new ResourceCache({ledger: memory, maximumBytes: 60, dispose: () => idleInput.release()})
  images.set('idle', {}, 10)
  const other = memory.reserve('terrain', 30), admission = new ImageryGroupAdmission(images)
  assert(admission.admit(new Map([['next', {}]]), 50, new Set(), production, 20))
  assert.strictEqual(production.children.size, 0)
  assert.strictEqual(production.availableBytes, 20)
  assert.strictEqual(production.bytes, 20, 'Reclamation refunds hid part of the committed transfer')
  assert.strictEqual(memory.bytes, 100)
  admission.retain(new Set(), new Map()); production.retire(); images.clear(); other.release()
  assert.strictEqual(memory.bytes, 0)
}

// Offers must be real reserved ownership in this ledger. A caller cannot use
// another viewer's credit or spend the same released source a second time.
{
  const memory = new ResourceLedger(20), foreign = new ResourceLedger(20)
  const source = foreign.reserve('source', 20)
  assert.throws(() => memory.reserve('next', 10, [], [], [{lease: source, bytes: 10}]), /Invalid resource funding/)
  assert.strictEqual(memory.bytes, 0)
  assert.strictEqual(foreign.bytes, 20)
  const credit = memory.reserve('source', 20)
  credit.mark('resident')
  assert.throws(() => memory.reserve('next', 10, [], [], [{lease: credit, bytes: 10}]), /Invalid resource funding/)
  credit.mark('reserved')
  assert.throws(() => memory.reserve('next', 10, [], [], [{lease: credit, bytes: 21}]), /Invalid resource funding/)
  const used = memory.reserve('next', 10, [], [], [{lease: credit, bytes: 20}])
  assert(used)
  assert.strictEqual(credit.bytes, 10, 'Admission transferred more credit than its actual group cost')
  assert.strictEqual(memory.bytes, 20)
  credit.release()
  assert.throws(() => memory.reserve('next', 10, [], [], [{lease: credit, bytes: 10}]), /Invalid resource funding/)
  used.release(); source.release()
  assert.strictEqual(memory.bytes, 0)
  assert.strictEqual(foreign.bytes, 0)
}
