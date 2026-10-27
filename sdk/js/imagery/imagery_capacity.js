// Native planning deduplicates physical source images. For a fixed-size source
// each such image has the same resident cost, so a byte budget can be expressed
// as a count without coupling internal texture nodes to external tile IDs.
const MAXIMUM_IMAGERY_RESOURCES = 65536

function imageryCapacity({maximumBytes, maximumEntries = MAXIMUM_IMAGERY_RESOURCES,
  imageBytes, workspaceBytes = 0, coverageEntries = 0, replacementEntries = 0,
  replacementHeadroomBytes = 0}) {
  const residentCapacity = Math.max(0, Math.min(MAXIMUM_IMAGERY_RESOURCES, maximumEntries,
    Math.floor(Math.max(0, maximumBytes - workspaceBytes) / imageBytes)))
  const peakCapacity = Math.max(0, Math.min(MAXIMUM_IMAGERY_RESOURCES, maximumEntries,
    Math.floor(Math.max(0, maximumBytes + replacementHeadroomBytes - workspaceBytes) / imageBytes)))
  // Small/insufficient configurations still need a root demand to bootstrap.
  // Report the missing complete path; never claim that clipping a reserve
  // proves a full replacement can fit. Actual production must be admitted.
  // This is a local feasibility bound, not shared-ledger production credit.
  // Managed producers may fund the replacement peak from the shared envelope;
  // a final target still fits the steady budget, with a serial workspace.
  const completeGroupFits = residentCapacity > coverageEntries &&
    peakCapacity >= coverageEntries + replacementEntries + 1
  const capacity = Math.max(1, peakCapacity)
  const coverage = Math.min(coverageEntries, capacity - 1)
  const replacement = Math.min(replacementEntries, capacity - coverage - 1)
  const targets = Math.max(1, Math.min(residentCapacity - coverage, capacity - coverage - replacement))
  return {capacity, steadyCapacity: residentCapacity, targets, replacement, completeGroupFits,
    imageBytes, workspaceBytes, replacementHeadroomBytes,
    coverageBytes: coverageEntries * imageBytes,
    replacementBytes: replacementEntries * imageBytes, targetBytes: targets * imageBytes}
}

module.exports = {imageryCapacity, MAXIMUM_IMAGERY_RESOURCES}
