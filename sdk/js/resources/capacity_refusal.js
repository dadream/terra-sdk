// Compare the whole transaction, including its last disposer. Returning its
// own work credit is not progress. A net reduction of previously occupied
// payload is: do not hide that real refund behind a post-cleanup retry epoch.
// Disposable memo data was already reclaimable before admission, so dropping
// or recreating it must not manufacture another attempt.
function capacityCheckpoint(ledger) {
  return {bytes:ledger.bytes-ledger.disposableBytes,revision:ledger.availabilityRevision,
    eligibility:ledger.eligibilityRevision}
}

function capacityRefusalRevision(ledger,before) {
  return ledger.bytes-ledger.disposableBytes<before.bytes || ledger.eligibilityRevision!==before.eligibility
    ?before.revision:ledger.availabilityRevision
}

module.exports={capacityCheckpoint,capacityRefusalRevision}
