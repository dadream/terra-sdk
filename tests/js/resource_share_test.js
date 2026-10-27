const assert = require('assert')
const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
const {ResourceCache} = require('../../sdk/js/resources/resource_cache')
const {ResourceWorkspace} = require('../../sdk/js/resources/resource_workspace')
const {ResourceShare} = require('../../sdk/js/resources/resource_share')
const {ImageryGroupAdmission} = require('../../sdk/js/imagery/imagery_group_admission')

// A complete GPU/UV group needs both a prior producer's surplus and an actual
// imagery grant. Neither transfer may manufacture global free capacity.
{
  const ledger = new ResourceLedger(100)
  const query = ledger.reserve('query', 10), terrain = ledger.reserve('terrain', 20)
  const cache = new ResourceCache({ledger, maximumBytes: 60, canEvict: () => false})
  cache.set('display', {}, 40)
  const producer = new ResourceWorkspace('production')
  producer.accept(ledger.reserve('production', 10))
  const share = new ResourceShare(ledger, 'imagery-share', 40, 60)
  assert(share.grow(20))
  assert.strictEqual(ledger.bytes, 100)
  const admission = new ImageryGroupAdmission(cache)
  let output
  const children = new Map([['next', {}]])
  const outputs = {bytes: 7, keep: [], accept: credit => { output = credit }}
  const admit = () => share.fund(grants => admission.admit(children, 20, new Set(), producer, 4, outputs, 4, grants))
  const revision = ledger.availabilityRevision
  assert.strictEqual(admit(), false, 'One-byte shortage partially consumed either funding source')
  assert.strictEqual(producer.availableBytes, 10)
  assert.strictEqual(share.stats().unusedBytes, 20)
  assert.strictEqual(cache.reservedBytes, 0)
  assert.strictEqual(output, undefined)
  outputs.bytes = 6
  assert(admit())
  assert.strictEqual(ledger.bytes, 100)
  assert.strictEqual(ledger.availabilityRevision, revision)
  assert.strictEqual(producer.availableBytes, 4)
  assert.strictEqual(share.stats().unusedBytes, 0)
  assert.strictEqual(share.stats().extraBytes, 20)
  assert(share.revoke(true))
  assert.strictEqual(share.bytes, 40)
  assert.strictEqual(ledger.bytes, 100, 'Withdrawing spent allowance refunded live output ownership')
  assert.strictEqual(share.grow(1), false, 'Terrain pressure permitted new detail growth')
  const pending = admission.take('next')
  assert(pending.commit({}))
  assert(cache.has('display'), 'The old display was discarded to fund its replacement')
  cache.clear(); output.release(); producer.retire(); query.release(); terrain.release()
  assert.strictEqual(ledger.bytes, 0)
  assert.strictEqual(ledger.leases.size, 0)
  assert.strictEqual(ledger.highWaterBytes, 100)
}

{
  const ledger = new ResourceLedger(100), occupied = ledger.reserve('display', 99)
  const share = new ResourceShare(ledger, 'imagery-share', 40, 60)
  assert.strictEqual(share.grow(20), false)
  assert.strictEqual(share.grow(20), false)
  assert.strictEqual(share.stats().attempts, 1, 'A refused grant polled the unchanged ledger')
  occupied.resize(80)
  assert(share.grow(30))
  assert.strictEqual(share.bytes, 60, 'Growth exceeded the application hard ceiling')
  assert.strictEqual(share.grow(1), false)
  assert.strictEqual(ledger.bytes, 100)
  assert(share.revoke(true))
  assert.strictEqual(ledger.bytes, 80, 'Unused grant did not return immediately')
  assert.strictEqual(share.grow(20), false)
  share.pressured = false
  assert(share.grow(20))
  assert(share.setPreferred(30))
  assert.strictEqual(share.bytes, 30)
  assert.strictEqual(ledger.bytes, 80)
  share.revoke(); occupied.release()
  assert.strictEqual(ledger.leases.size, 0)
}

// Duplicate sources must be rejected even when the first offer could cover
// the output; otherwise a future caller can accidentally spend a lease twice.
{
  const ledger = new ResourceLedger(20), credit = ledger.reserve('source', 20)
  const offers = [{lease: credit, bytes: 20}, {lease: credit, bytes: 1}]
  assert.throws(() => ledger.reserve('output', 10, [], [], offers), /Invalid resource funding/)
  assert.strictEqual(credit.bytes, 20)
  assert.deepStrictEqual(offers.map(offer => offer.bytes), [20, 1])
  credit.release()
  assert.strictEqual(ledger.bytes, 0)
}
console.log('Funded imagery shares, multi-source atomic admission and receipt-owned revocation passed')

// Retraction distinguishes unused credit from already owned outputs. The
// preferred policy is unchanged; reducing it would require a different plan.
{
  const ledger = new ResourceLedger(100), share = new ResourceShare(ledger, 'imagery-share', 40, 80)
  assert(share.grow(40))
  const live = share.fund(funding => ledger.reserve('display', 25, [], [], funding))
  assert(live)
  assert(share.retract(30))
  assert.strictEqual(share.bytes, 50)
  assert.strictEqual(share.stats().unusedBytes, 10)
  assert.strictEqual(ledger.bytes, 35, 'Retraction credited a live image before its receipt')
  assert(share.retract(100))
  assert.strictEqual(share.bytes, 40)
  assert.strictEqual(ledger.bytes, 25)
  assert.strictEqual(share.retract(1), false)
  assert.strictEqual(share.stats().retractedBytes, 40)
  live.release(); share.revoke()
  assert.strictEqual(ledger.leases.size, 0)
}
