const {invariant} = require('../core/terra_globe_common')

// Reclamation is an independent, bounded producer lane. Planning can make
// protected inputs eligible again, but consecutive pressure in the same epoch
// must continue past references already reclaimed by the preceding request.
async function reclaimImageryReferences(owner, needed, slice, yieldWork) {
  const revision = owner.imageryReferenceRevision || 0
  const stats = owner.imageryReferenceReclamation || (owner.imageryReferenceReclamation = {scans:0, slices:0, bytes:0, interrupted:0})
  ++stats.scans
  const previous = owner.imageryReferenceReclamationCursor, cursor = {revision, ready:false}
  let released = 0, restart = !previous || !previous.ready || previous.revision !== revision
  owner.imageryReferenceReclamationCursor = cursor
  try {
    for (;;) {
      if (owner.destroyed || owner.context === 0) return released
      const result = await slice(needed - released, restart)
      invariant(result && Number.isSafeInteger(result.releasedBytes) && result.releasedBytes >= 0 &&
        typeof result.pending === 'boolean', 'Invalid imagery reclamation receipt')
      ++stats.slices; stats.bytes += result.releasedBytes; released += result.releasedBytes
      if ((owner.imageryReferenceRevision || 0) !== revision) { ++stats.interrupted; return released }
      if (released >= needed || !result.pending) { cursor.ready = true; return released }
      restart = false
      await yieldWork()
    }
  } finally {
    // A failed/interrupted receipt proves no reusable cursor. Native planners
    // also invalidate their own iterator on tree mutations; no live frontier
    // or displayed cut is released merely to preserve this optimization.
    if (!cursor.ready && owner.imageryReferenceReclamationCursor === cursor)
      owner.imageryReferenceReclamationCursor = null
  }
}

module.exports = {reclaimImageryReferences}
