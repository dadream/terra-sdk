const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ResourceCache} = require('../../sdk/js/resources/resource_cache')
const {ownPayload, ownMesh, holdMeshes} = require('../../sdk/js/resources/mesh_ownership')

// Every reachable owner is required. A pinned leaf must reject immediately,
// without expanding an unrelated large sibling graph on each loan return.
{
  const ledger = new ResourceLedger(16), target = ledger.reserve('target',4)
  const sibling = ledger.reserve('sibling',4), pinned = ledger.reserve('pinned',4)
  const root = ledger.reserve('root',4)
  let visits = 0
  target.reclaimWith = () => [sibling,pinned]
  sibling.reclaimWith = () => {++visits;return [root]}
  root.reclaimable = () => true
  assert.strictEqual(ledger.canReclaim(target),false)
  assert.strictEqual(visits,0,'A known pinned owner still expanded unrelated dependencies')
  pinned.reclaimable = () => true
  assert.strictEqual(ledger.canReclaim(target),true)
  assert.strictEqual(visits,1)
  for (const lease of [target,sibling,pinned,root]) lease.release()
  assert.strictEqual(ledger.bytes,0)
}

// Binding/revocation updates reclamation eligibility without dropping loans.
// Duplicate returns/bindings after return cannot corrupt the unbound count.
{
  const ledger = new ResourceLedger(8), lease = ledger.reserve('payload',4)
  const root = ledger.reserve('eviction-root',4), payload = ownPayload({},lease,4)
  root.reclaimable = () => true
  const a = payload.ownership.hold(), b = payload.ownership.hold()
  a.ownedBy(root); payload.ownership.retire()
  assert.strictEqual(lease.reclaimWith(),null)
  b.ownedBy(root); assert.strictEqual(ledger.canReclaim(lease),true)
  a.ownedBy(null); assert.strictEqual(lease.reclaimWith(),null)
  a(); a(); a.ownedBy(root)
  assert.strictEqual(ledger.canReclaim(lease),true)
  b.ownedBy(undefined); assert.strictEqual(lease.reclaimWith(),null)
  b.ownedBy(root); b.ownedBy(root)
  assert.deepStrictEqual(lease.reclaimWith(),[root])
  b(); root.release()
  assert.strictEqual(ledger.bytes,0)
}

function mesh(ledger) {
  const lease = ledger.reserve('mesh-host', 60)
  return {lease, resource: ownPayload({positions: new Float32Array(9), textureUv: new Float32Array(6)}, lease, 60)}
}
function cache(ledger, pins = new Set()) {
  return new ResourceCache({ledger, owner: 'geometry-gpu', canEvict: key => !pins.has(key),
    dispose(value) {
      value.release()
      for (const part of value.parts || []) part.release()
    }})
}
function geometry(store, key, resource, bytes = 60) {
  const reservation = store.reserve(key, bytes), release = holdMeshes([resource])
  release.ownedBy(reservation.lease)
  const value = {release, parts: []}
  assert(reservation.commit(value))
  return {lease: reservation.lease, value}
}

// One old idle GPU mesh can fund its full successor only when the CPU input
// and owned partitions are included. A live query forbids that refund.
{
  const ledger = new ResourceLedger(170), store = cache(ledger)
  const display = ledger.reserve('display', 20), input = mesh(ledger)
  const old = geometry(store, 'idle', input.resource)
  const partition = ledger.reserve('partition-gpu', 30)
  partition.reclaimWith = () => [old.lease]
  old.value.parts.push(partition)
  const query = holdMeshes([input.resource])
  input.resource.ownership.retire()
  assert.strictEqual(ledger.canReserve(130), false)
  assert.strictEqual(ledger.reserve('successor', 130), null)
  assert(store.has('idle') && ledger.bytes === 170, 'Failed group admission evicted useful members')
  const revision = ledger.availabilityRevision
  query()
  assert(ledger.availabilityRevision > revision, 'Released query did not wake dependency-blocked admission')
  const before = ledger.stats()
  assert(ledger.canReserve(130), 'Feasibility omitted dependent host and UV refunds')
  assert.deepStrictEqual(ledger.stats(), before)
  assert(store.has('idle'), 'Feasibility disposed the previous cache')
  const successor = ledger.reserve('successor', 130)
  assert(successor, 'Retired mesh and partition bytes were omitted from reclamation')
  assert.strictEqual(ledger.bytes, 150)
  assert.strictEqual(ledger.stats().reclaimedBytes, 150)
  assert.strictEqual(ledger.stats().dependentReclaimedBytes, 90)
  assert.strictEqual(store.has('idle'), false)
  successor.release(); display.release(); store.clear()
  assert.strictEqual(ledger.bytes, 0)
}

// Two caches borrow one allocation. Its bytes are released once, and only when
// all GPU owners can be evicted. A pinned owner protects the shared CPU payload.
{
  const ledger = new ResourceLedger(120), pins = new Set(['b']), store = cache(ledger, pins)
  const input = mesh(ledger)
  geometry(store, 'a', input.resource, 30)
  geometry(store, 'b', input.resource, 30)
  input.resource.ownership.retire()
  assert.strictEqual(ledger.reserve('next', 120), null)
  assert.strictEqual(store.stats().entries, 2)
  pins.clear()
  const next = ledger.reserve('next', 120)
  assert(next)
  assert.strictEqual(ledger.stats().dependentReclaimedBytes, 60)
  assert.strictEqual(ledger.highWaterBytes, 120)
  next.release(); store.clear()
  assert.strictEqual(ledger.bytes, 0)
}

// Resizing/keeping a dependent cannot evict the parent that owns it. Rejecting
// that candidate must roll back graph counters so an independent victim works.
{
  const ledger = new ResourceLedger(150), store = cache(ledger), input = mesh(ledger)
  geometry(store, 'idle', input.resource)
  const other = new ResourceCache({ledger, owner: 'other'})
  assert(other.trySet('independent', {}, 30))
  input.resource.ownership.retire()
  assert(ledger.canReserve(30, [], [input.lease]))
  assert(store.has('idle') && other.has('independent'))
  assert.strictEqual(ledger.canReserve(31, [], [input.lease]), false)
  const reserved = ledger.reserve('next', 30, [], [input.lease])
  assert(reserved && store.has('idle') && !other.has('independent'))
  assert.strictEqual(ledger.stats().dependentReclaimedBytes, 0)
  assert.strictEqual(input.lease.resize(61), false)
  assert.strictEqual(input.lease.bytes, 60)
  reserved.release(); store.clear(); other.clear()
  assert.strictEqual(ledger.bytes, 0)
}

// No bytes may be borrowed from a future asynchronous completion or a cycle
// that has no reclaimable owner. A false disposal declaration fails closed.
{
  const ledger = new ResourceLedger(10), a = ledger.reserve('a', 5), b = ledger.reserve('b', 5)
  a.reclaimWith = () => [b]; b.reclaimWith = () => [a]
  assert.strictEqual(ledger.reserve('next', 1), null)
  a.reclaimable = () => true
  a.reclaim = () => a.release()
  assert.throws(() => ledger.reserve('next', 10), /declared allocations/)
  assert.strictEqual(ledger.bytes, 5)
  b.release()
  assert.strictEqual(ledger.bytes, 0)
}

// Revoking a queued upload's parent association must not make its still-live
// input reclaimable through an unrelated, reused cache key.
{
  const ledger = new ResourceLedger(120), store = cache(ledger), input = mesh(ledger)
  const queued = holdMeshes([input.resource]), old = geometry(store, 'same', input.resource)
  input.resource.ownership.retire()
  queued.ownedBy(old.lease); queued.ownedBy(null)
  assert.strictEqual(ledger.reserve('next', 120), null)
  queued()
  const next = ledger.reserve('next', 120)
  assert(next)
  next.release(); store.clear()
  assert.strictEqual(ledger.bytes, 0)
}

// A temporary reader of a still-pinned entry does not increase reclaimable
// capacity. Retired storage and newly evictable live entries still wake work.
{
  const ledger = new ResourceLedger(100), pins = new Set(['display'])
  const store = new ResourceCache({ledger, canEvict: key => !pins.has(key)})
  store.set('display', {}, 10); store.set('idle', {}, 10)
  const a = store.retain('display'), b = store.retain('display')
  const before = ledger.availabilityRevision
  a(); b()
  assert.strictEqual(ledger.availabilityRevision, before, 'A displayed resource advertised false capacity')
  const idle = store.retain('idle')
  idle()
  assert(ledger.availabilityRevision > before, 'A newly evictable resource did not wake admission')
  const retired = store.retain('display')
  store.delete('display')
  const pending = ledger.availabilityRevision
  retired()
  assert.strictEqual(ledger.availabilityRevision, pending + 1, 'Retirement did not issue one real refund')
  store.set('zero', {}, 0)
  const zero = store.retain('zero'), zeroVersion = ledger.availabilityRevision
  zero()
  assert(ledger.availabilityRevision > zeroVersion, 'Zero-byte owners lost their dependency eligibility notification')
  store.clear()
  assert.strictEqual(ledger.bytes, 0)
}

// CPU inputs can remain owned through several retired allocations. Returning
// a query must not wake capacity waiters while even one GPU owner is pinned.
{
  const ledger = new ResourceLedger(180), pins = new Set(['display']), store = cache(ledger, pins)
  const uvLease = ledger.reserve('uv-host', 60)
  const uv = ownPayload({}, uvLease, 60)
  const input = ownMesh({positions: new Float32Array(15), uvResource: uv}, ledger.reserve('mesh-host', 60))
  geometry(store, 'idle', input, 30)
  geometry(store, 'display', input, 30)
  uv.ownership.retire(); input.ownership.retire()
  for (const resource of [input, uv]) {
    const query = holdMeshes([resource]), before = ledger.availabilityRevision
    assert.strictEqual(ledger.canReserve(180), false)
    query()
    assert.strictEqual(ledger.canReserve(180), false)
    assert.strictEqual(ledger.availabilityRevision, before, 'Pinned dependency advertised false capacity')
  }
  pins.clear()
  const query = holdMeshes([uv]), before = ledger.availabilityRevision
  assert.strictEqual(ledger.canReserve(180), false)
  query()
  assert(ledger.availabilityRevision > before, 'Transitive dependency release did not wake admission')
  const next = ledger.reserve('successor', 180)
  assert(next && !store.has('idle') && !store.has('display'))
  assert.strictEqual(ledger.stats().dependentReclaimedBytes, 120)
  next.release(); store.clear()
  assert.strictEqual(ledger.bytes, 0)
}

// Ownership cycles cannot advertise capacity unless an actual reclaimable root
// breaks the cycle. Detached owners cannot provide a disposal guarantee either.
{
  const ledger = new ResourceLedger(10), a = ledger.reserve('a', 5), b = ledger.reserve('b', 5)
  a.reclaimWith = () => [b]; b.reclaimWith = () => [a]
  const before = ledger.availabilityRevision
  a.availabilityChanged()
  assert.strictEqual(ledger.availabilityRevision, before, 'A dependency cycle advertised capacity')
  b.reclaimable = () => true
  b.reclaim = () => { a.release(); b.release() }
  a.availabilityChanged()
  assert(ledger.availabilityRevision > before)
  const next = ledger.reserve('successor', 10)
  assert(next)
  next.release()
  const detached = ledger.reserve('detached', 5)
  detached.reclaimWith = () => [a]
  const version = ledger.availabilityRevision
  detached.availabilityChanged()
  assert.strictEqual(ledger.availabilityRevision, version)
  detached.release()
  assert.strictEqual(ledger.bytes, 0)
}

// Rebuilding immediately disposable metadata changes accounted ownership, but
// not the capacity already obtainable by reclaiming it. It must not wake a
// refused producer, evict real payload, become protected or transfer credit.
{
  const ledger = new ResourceLedger(100)
  const required = ledger.reserve('required', 40), idle = ledger.reserve('idle-image', 20)
  idle.reclaimable = () => true; idle.reclaim = () => idle.release()
  const version = ledger.availabilityRevision
  let memo = ledger.reserveDisposable('memo', 30, () => memo.release())
  assert(memo && ledger.bytes === 90)
  const feasibility = [ledger.canReserve(60), ledger.canReserve(61)]
  assert.deepStrictEqual(feasibility, [true, false])
  assert.strictEqual(ledger.reserveDisposable('other-memo', 11, () => {}), null)
  assert(idle.active, 'Optional data evicted real cached content')
  assert.strictEqual(memo.resize(41), false)
  assert(memo.resize(40)); assert(memo.resize(10))
  assert.deepStrictEqual([ledger.canReserve(60), ledger.canReserve(61)], feasibility)
  assert.strictEqual(ledger.availabilityRevision, version, 'Memo resizing woke refused producers')
  assert.throws(() => memo.split(1), /transfer/)
  assert.throws(() => required.merge(memo), /merge/)
  assert.throws(() => memo.mark('reserved'), /protected/)
  assert.throws(() => ledger.canReserve(1, [], [memo]), /protected/)
  memo.release()
  assert.strictEqual(ledger.availabilityRevision, version)
  memo = ledger.reserveDisposable('memo', 30, () => memo.release())
  const producer = ledger.reserve('producer', 30)
  assert(producer && !memo.active && idle.active, 'Real admission did not discard optional metadata first')
  assert.strictEqual(ledger.availabilityRevision, version)
  assert.strictEqual(ledger.reserveDisposable('too-large', 11, () => {}), null)
  producer.release()
  assert(ledger.availabilityRevision > version, 'A real refund failed to wake admission')
  required.release(); idle.release()
  assert.strictEqual(ledger.bytes, 0)
}

console.log('Dependency reclamation, shared borrowers, query protection, disposable metadata and atomic refusal passed')
