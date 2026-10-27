(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraJointOwnership = factory()
})(typeof self === 'undefined' ? this : self, function () {
  'use strict'

  // Read-only snapshot. Calling ledger.planRoom() here would start native
  // reclamation and contaminate the trajectory being measured.
  function read(runtime) {
    const ledger = runtime.resourceLedger, leases = Array.from(ledger.leases)
    const ids = new Map(leases.map((lease, index) => [lease, index]))
    return {ledger:ledger.stats(), reclamation:ledger.reclamation.stats(),
      rpc:Array.from(runtime.abi.pending.values(), value => value.type),
      leases:leases.map(lease => ({id:ids.get(lease), owner:lease.owner,
        bytes:lease.bytes, phase:lease.phase,
        reclaimable:Boolean(lease.reclaimable && lease.reclaimable()),
        dependencies:lease.reclaimWith ? Array.from(lease.reclaimWith() || [],
          owner => ids.has(owner) ? ids.get(owner) : -1) : []}))}
  }

  function analyze(snapshot) {
    const leases = snapshot.leases, ids = new Set(leases.map(lease => lease.id))
    if (ids.size !== leases.length || leases.some(lease =>
      !Number.isSafeInteger(lease.bytes) || lease.bytes < 0 || !Array.isArray(lease.dependencies)))
      throw new Error('Invalid resource ownership snapshot')
    if (leases.reduce((sum, lease) => sum + lease.bytes, 0) !== snapshot.ledger.bytes)
      throw new Error('Ownership snapshot does not reconcile with the ledger')
    const released = new Set(leases.filter(lease => lease.reclaimable).map(lease => lease.id))
    // A dependent is releasable only when ALL its owners are releasable.
    // Unknown owners and rootless cycles do not create fictitious credit.
    let changed
    do {
      changed = false
      for (const lease of leases) if (!released.has(lease.id) && lease.dependencies.length &&
        lease.dependencies.every(owner => ids.has(owner) && released.has(owner))) {
        released.add(lease.id); changed = true
      }
    } while (changed)
    const owners = {}
    for (const lease of leases) {
      const row = owners[lease.owner] || (owners[lease.owner] = {bytes:0, eligibleBytes:0, remainingBytes:0})
      row.bytes += lease.bytes
      row[released.has(lease.id) ? 'eligibleBytes' : 'remainingBytes'] += lease.bytes
    }
    const eligibleBytes = leases.reduce((sum, lease) => sum + (released.has(lease.id) ? lease.bytes : 0), 0)
    return {bytes:snapshot.ledger.bytes, eligibleBytes,
      remainingBytes:snapshot.ledger.bytes - eligibleBytes, owners,
      scope:'Synchronous declared eviction closure only; remaining includes async Native caches and is NOT minimum required capacity'}
  }

  return {read, analyze}
})
