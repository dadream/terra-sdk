const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ResourceCache} = require('../../sdk/js/resources/resource_cache')

// Use the live ownership records as an independent, deliberately slow oracle.
// Bypass any iterator instrumentation used to check observation complexity.
function check(ledger) {
  const owners = Object.create(null), totals = {reserved: 0, resident: 0, retired: 0}
  let disposableBytes=0
  for (const lease of Set.prototype.values.call(ledger.leases)) {
    const owner = owners[lease.owner] || (owners[lease.owner] = {reserved: 0, resident: 0, retired: 0})
    owner[lease.phase] += lease.bytes
    totals[lease.phase] += lease.bytes
    if(lease.disposable)disposableBytes+=lease.bytes
  }
  const stats = ledger.stats()
  assert.deepStrictEqual(stats.owners, owners)
  assert.strictEqual(stats.reservedBytes, totals.reserved)
  assert.strictEqual(stats.residentBytes, totals.resident)
  assert.strictEqual(stats.retiredBytes, totals.retired)
  assert.strictEqual(stats.bytes, totals.reserved + totals.resident + totals.retired)
  assert.strictEqual(ledger.disposableBytes,disposableBytes)
  return stats
}

async function main() {
  await require('./reclamation_fairness_contract')()
  // Numerical work can be parked without another copy, then claimed before
  // reattaching payloads. Revoked handles and late reclaim callbacks cannot
  // release the new owner; the independent ownership oracle checks each step.
  for (const bytes of [0, 73, Number.MAX_SAFE_INTEGER]) {
    const ledger = new ResourceLedger(bytes || 1)
    const work = ledger.reserve('selection', bytes); work.mark('resident')
    let reclaimed = 0, memo
    memo = ledger.memoize(work, 'quote', () => {++reclaimed;memo.release()})
    assert(!work.active && work.bytes === 0); check(ledger)
    assert.strictEqual(ledger.bytes, bytes); assert.strictEqual(ledger.highWaterBytes, bytes)
    assert.throws(()=>memo.split(0), /Disposable/)
    if (bytes) {ledger.setLimit(bytes-1);assert.strictEqual(ledger.claimMemo(memo,'selection'),null);ledger.setLimit(bytes)}
    const claimed = ledger.claimMemo(memo,'selection')
    assert(claimed && !memo.active); memo.reclaim()
    assert.strictEqual(reclaimed,0); check(ledger)
    assert.strictEqual(claimed.bytes,bytes); assert.strictEqual(ledger.highWaterBytes,bytes)
    const available=ledger.availabilityRevision
    let parked
    parked=ledger.memoize(claimed,'quote',()=>parked.release())
    assert.strictEqual(ledger.availabilityRevision,available,'An unchanged memo round trip woke its own capacity retry')
    check(ledger);parked.release();assert.strictEqual(ledger.bytes,0);check(ledger)
  }
  {
    const ledger=new ResourceLedger(100),work=ledger.reserve('selection',100)
    let memo
    memo=ledger.memoize(work,'quote',()=>memo.release())
    const allocation=ledger.reserve('payload',100)
    assert(allocation&&!memo.active,'A parked numerical quote blocked a real producer')
    check(ledger);allocation.release();check(ledger)
  }
  // An ownership transfer must never temporarily count both copies. Even an
  // admitted safe-integer total can otherwise lose a byte before subtraction.
  for (const phase of ['reserved', 'resident', 'retired']) {
    const wide = new ResourceLedger(Number.MAX_SAFE_INTEGER)
    const large = wide.reserve('wide', Number.MAX_SAFE_INTEGER - 2), small = wide.reserve('wide', 2)
    large.mark(phase); small.mark(phase); check(wide)
    large.merge(small); check(wide)
    large.release(); check(wide)
  }

  const ledger = new ResourceLedger(100)
  check(ledger)
  const input = ledger.reserve('terrain', 40)
  check(ledger)
  const old = check(ledger)
  const mesh = input.split(20, 'resident', 'mesh')
  check(ledger)
  const empty = mesh.split(0, 'retired', '__proto__')
  check(ledger)
  assert.deepStrictEqual(old.owners, Object.assign(Object.create(null), {
    terrain: {reserved: 40, resident: 0, retired: 0}}), 'A later transfer mutated an earlier snapshot')
  input.mark('resident'); check(ledger)
  input.mark('retired'); check(ledger)
  input.mark('retired'); check(ledger)
  assert(input.resize(30)); check(ledger)
  assert(input.resize(0)); check(ledger)
  assert(Object.hasOwnProperty.call(check(ledger).owners, 'terrain'), 'A zero-byte live owner disappeared')
  assert.strictEqual(input.resize(101), false); check(ledger)
  assert.throws(() => mesh.mark('invalid'), /Invalid resource phase/); check(ledger)
  assert.throws(() => mesh.split(21), /Invalid resource transfer/); check(ledger)
  assert.throws(() => input.merge(mesh), /Invalid resource merge/); check(ledger)

  const credit = ledger.reserve('mesh', 12)
  check(ledger)
  mesh.merge(credit); check(ledger)
  assert.strictEqual(mesh.phase, 'resident')
  assert.strictEqual(mesh.bytes, 32)
  assert.strictEqual(credit.active, false)
  assert.strictEqual(credit.bytes, 0)
  assert.strictEqual(credit.release(), false); check(ledger)
  assert.strictEqual(credit.resize(1), false); check(ledger)
  credit.mark('reserved'); check(ledger)
  empty.mark('resident'); check(ledger)
  empty.release(); check(ledger)
  assert(!Object.hasOwnProperty.call(check(ledger).owners, '__proto__'))

  const source = ledger.reserve('workspace', 40), offer = {lease: source, bytes: 30}
  check(ledger)
  const before = ledger.stats()
  assert.strictEqual(ledger.reserve('output', 100, [], [], [offer]), null)
  assert.deepStrictEqual(ledger.stats(), before, 'Refused funding changed ownership')
  assert.strictEqual(offer.bytes, 30)
  const output = ledger.reserve('output', 35, [], [], [offer])
  check(ledger)
  assert.strictEqual(source.bytes, 10)
  assert.strictEqual(offer.bytes, 0)
  output.mark('resident'); check(ledger)
  ledger.setLimit(30)
  assert.strictEqual(check(ledger).overBudgetBytes, 47)
  source.release(); output.release(); mesh.release(); input.release(); check(ledger)

  // Cache retirement, dependent reclamation, cancellation and disposable memo
  // refunds must update the same totals as direct production/transfer paths.
  ledger.setLimit(100)
  const cache = new ResourceCache({ledger, owner: 'gpu'})
  assert(cache.trySet('held', {}, 30))
  const held = cache.retain('held')
  cache.delete('held')
  assert.strictEqual(check(ledger).retiredBytes, 30)
  held(); check(ledger)
  const cancelled = cache.reserve('cancelled', 10)
  check(ledger)
  cancelled.cancel(); check(ledger)
  const dependent = ledger.reserve('host', 20)
  dependent.mark('resident')
  assert(cache.trySet('idle', {release: () => dependent.release()}, 30))
  const root = cache.entries.get('idle').lease
  dependent.reclaimWith = () => [root]
  cache.dispose = value => value.release()
  check(ledger)
  const next = ledger.reserve('next', 80)
  assert(next)
  assert.strictEqual(check(ledger).dependentReclaimedBytes, 20)
  next.release(); cache.clear(); check(ledger)
  let memo
  memo = ledger.reserveDisposable('memo', 10, () => memo.release())
  check(ledger)
  assert(memo.resize(8)); check(ledger)
  const revision = ledger.availabilityRevision
  memo.release(); check(ledger)
  assert.strictEqual(ledger.availabilityRevision, revision, 'Statistics changed disposable refund policy')

  // Many interleaved ownership changes, checked against the full-scan oracle.
  // Zero-sized owners and special property names retain their original meaning.
  const names = ['terrain', 'gpu', '__proto__', 'constructor', 'toString']
  let seed = 41
  const random = count => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % count }
  ledger.setLimit(256)
  for (let i = 0; i < 600; ++i) {
    const leases = Array.from(ledger.leases), lease = leases[random(leases.length || 1)]
    const phase = ['reserved', 'resident', 'retired'][random(3)]
    switch (random(6)) {
      case 0: ledger.reserve(names[random(names.length)], random(32)); break
      case 1: if (lease) lease.mark(phase); break
      case 2: if (lease) lease.resize(random(32)); break
      case 3: if (lease) lease.split(random(lease.bytes + 1), phase, names[random(names.length)]); break
      case 4: if (lease) lease.release(); break
      case 5: {
        const other = leases.find(other => other !== lease && other.owner === lease.owner)
        if (other) lease.merge(other)
      }
    }
    check(ledger)
  }
  for (const lease of ledger.leases) lease.release()
  assert.deepStrictEqual(check(ledger).owners, Object.create(null))

  // Reclamation status may change without an ownership revision. A cheap state
  // reader must still observe pending work and attempts, and never wake work.
  const live = ledger.reserve('native', 5)
  let complete, wakes = 0
  const unlisten = ledger.subscribe(() => ++wakes)
  const unregister = ledger.reclamation.register({owner:'fixture-native',revision: () => 0, reclaim: async () => {
    await new Promise(resolve => { complete = resolve })
    live.release()
    return 5
  }})
  const ownershipRevision = ledger.revision
  const request = ledger.reclamation.request(5)
  const pending = check(ledger)
  assert.strictEqual(pending.reclamation.pending, true)
  assert.strictEqual(pending.reclamation.attempts, 0)
  await Promise.resolve()
  assert.strictEqual(ledger.revision, ownershipRevision)
  assert.strictEqual(check(ledger).reclamation.attempts, 1)
  for (let i = 0; i < 10; ++i) check(ledger)
  assert.strictEqual(wakes, 0)
  complete()
  await request
  assert.strictEqual(check(ledger).reclamation.pending, false)
  assert.strictEqual(check(ledger).reclamation.reclaimedBytes, 5)
  assert.deepStrictEqual(check(ledger).reclamation.providers,[{owner:'fixture-native',attempts:1,
    failures:0,reclaimedBytes:5,emptyReceipts:0,lastRequestedBytes:5,lastReleasedBytes:5}])
  assert.strictEqual(pending.reclamation.pending, true, 'An earlier reclamation snapshot changed')
  assert.strictEqual(pending.reclamation.providers[0].attempts,0,'A provider snapshot changed after its receipt')
  unlisten(); unregister()
  assert.deepStrictEqual(check(ledger).reclamation.providers,[])

  // Query cost depends on the small set of owners, not the number of tiles or
  // allocations. Include changes between reads, so revision-only memoization
  // cannot hide a scan on every frame that performs real work.
  const many = new ResourceLedger(4096), leases = []
  for (let i = 0; i < 2048; ++i) leases.push(many.reserve('owner-' + i % 16, 1))
  let visited = 0
  many.leases[Symbol.iterator] = function* () {
    for (const lease of Set.prototype.values.call(this)) { ++visited; yield lease }
  }
  const changes = many.availabilityRevision
  for (let i = 0; i < 20; ++i) {
    leases[i].mark(i % 2 ? 'resident' : 'retired')
    const stats = check(many)
    stats.owners['owner-0'].resident = 123456
    delete stats.owners['owner-1']
    check(many)
  }
  assert.strictEqual(visited, 0, 'Resource state reporting traversed individual leases')
  assert.strictEqual(many.availabilityRevision, changes, 'State reads or phase changes advertised capacity')
  for (const lease of leases) lease.release()
  check(many)
  console.log('Resource ledger ownership, reclamation snapshots and bounded state reporting passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
