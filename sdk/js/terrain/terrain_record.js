const {binaryResponseBytes} = require('../transport/response_limits')

// The same conservative encoded envelope used by native CBDAM height queries.
// It bounds ingress/copies, separately from decoded arrays and reconstruction.
function maximumEncodedRecordBytes(patchDimension, kind) {
  if (!Number.isInteger(patchDimension) || patchDimension < 1 || patchDimension > 4096 ||
      kind !== 1 && kind !== 2) throw new Error('Invalid terrain record shape')
  const dimension = patchDimension + (kind === 1 ? 1 : 0)
  return dimension * dimension * 16 + 4096
}

function terrainRecordBytes(manifest, kind, data) {
  return binaryResponseBytes(data, maximumEncodedRecordBytes(manifest && manifest.patchDimension, kind))
}

function isMissingTerrainRecord(data) {
  try {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const problem = JSON.parse(String.fromCharCode(...bytes.subarray(0, 4096)))
    return Boolean(problem && problem.error && problem.error.code === 'patch_not_found')
  } catch (_) { return false }
}

module.exports = {maximumEncodedRecordBytes, terrainRecordBytes, isMissingTerrainRecord}
