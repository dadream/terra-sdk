// Each physical allocation has one lease. Dependencies keep their own lease;
// retiring a producer cannot refund data still borrowed by frames or GPU work.
const {Cleanup,cleanupAfterError}=require('../runtime/cleanup')
function ownPayload(resource, lease, bytes, dispose = () => {}) {
  if (!lease || lease.bytes !== bytes) {
    if (lease) lease.release()
    dispose()
    throw new Error('Payload differs from its reservation')
  }
  let references = 1, retired = false, unbound = 0
  const borrowers = new Set(),dependents=new Set()
  lease.reclaimWith = () => {
    if (!retired || !borrowers.size || unbound) return null
    return Array.from(borrowers, borrower => borrower.owner)
  }
  // A live query already disproves reclamation. Do not materialize all owner
  // edges just to discover it, or build the same edge list again in the ledger.
  const changed = () => {
    if (retired && borrowers.size && !unbound && lease.availabilityChanged) lease.availabilityChanged()
  }
  const release = () => {
    if(--references!==0)return
    const cleanup=new Cleanup(),callbacks=Array.from(dependents)
    dependents.clear()
    for(const close of callbacks)cleanup.run(close)
    // A failed physical disposer cannot authorize refunding this payload.
    cleanup.run(()=>{dispose();lease.release()})
    cleanup.finish()
  }
  const ownership = {
    addRelease(close) {
      if(!references||typeof close!=='function')throw new Error('Mesh payload has been released')
      dependents.add(close)
      return ()=>dependents.delete(close)
    },
    hold() {
      if (!references) throw new Error('Mesh payload has been released')
      ++references
      const borrower = {owner: null}
      borrowers.add(borrower); ++unbound
      let held = true
      const done = () => {
        if (held) {
          held = false; borrowers.delete(borrower)
          if (!borrower.owner) --unbound
          release(); changed()
        }
      }
      done.ownedBy = owner => {
        if (held) {
          unbound += Number(!owner) - Number(!borrower.owner)
          borrower.owner = owner; changed()
        }
      }
      return done
    },
    retire() {
      if (retired) return
      retired = true
      lease.mark('retired')
      release()
      changed()
    }
  }
  try {
    Object.defineProperty(resource, 'ownership', {value: ownership})
    lease.mark('resident')
  } catch (error) { dispose(); lease.release(); throw error }
  return resource
}

function ownMesh(resource, lease) {
  const release = resource.uvResource ? resource.uvResource.ownership.hold() : () => {}
  if (release.ownedBy) release.ownedBy(lease)
  return ownPayload(resource, lease, resource.positions.byteLength, release)
}

function holdMeshes(resources) {
  const releases = []
  try {
    for (const resource of resources) {
      if (resource && resource.ownership) releases.push(resource.ownership.hold())
    }
  } catch (error) {cleanupAfterError(error,()=>{
    const cleanup=new Cleanup()
    releases.forEach(release=>cleanup.run(release));cleanup.finish()
  })}
  const release = () => {
    const cleanup=new Cleanup()
    releases.splice(0).forEach(done=>cleanup.run(done));cleanup.finish()
  }
  release.ownedBy = owner => releases.forEach(done => done.ownedBy(owner))
  return release
}

function ownMeshWork(work, resources) {
  const release = holdMeshes(resources)
  return {
    next() {
      try { const result = work.next(); if (result.done) release(); return result }
      catch (error) {cleanupAfterError(error,release)}
    },
    return() {
      const cleanup=new Cleanup()
      const result=cleanup.run(()=>work.return())
      cleanup.run(release);cleanup.finish();return result
    }
  }
}

module.exports = {ownPayload, ownMesh, holdMeshes, ownMeshWork}
