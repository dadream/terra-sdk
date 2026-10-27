(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraNavigationTerrain = factory()
})(typeof self === 'undefined' ? this : self, function () {
  'use strict'

  // This fixture replays responses by CBDAM key. An uncaptured key is a test
  // failure, never fabricated terrain, a service 404, or an online fallback.
  function create(catalogue, payload, checksum) {
    if (catalogue.schema !== 'terra.fixture-records.v1' ||
        catalogue.datasetId !== 'globe' || catalogue.heightScale !== 0.015625 ||
        !(payload instanceof ArrayBuffer) || catalogue.bytes !== payload.byteLength ||
        catalogue.count !== catalogue.records.length) throw new Error('Invalid navigation terrain snapshot')
    const records = new Map(), requested = new Set(), missing = new Set()
    let offset = 0, requests = 0, notFoundResponses = 0
    for (const row of catalogue.records) {
      const key = row.key.join('/')
      if (row.key.length !== 4 || !row.key.every(Number.isInteger) ||
          ![1, 2].includes(row.key[0]) || records.has(key) ||
          row.offset !== offset || !Number.isInteger(row.bytes) || row.bytes < 1 ||
          row.offset + row.bytes > payload.byteLength ||
          !(row.status === 200 || row.status === 404 && row.key[0] === 2)) {
        throw new Error('Invalid navigation terrain record: ' + key)
      }
      records.set(key, row)
      offset += row.bytes
    }
    if (offset !== payload.byteLength) throw new Error('Unindexed navigation terrain bytes')
    return {
      request(options) {
        const path = new URL(options.url).pathname
        const match = /^\/terra\/v1\/datasets\/globe\/(root|detail)\/(-?\d+)\/(-?\d+)\/(-?\d+)$/.exec(path)
        const key = match ? [match[1] === 'root' ? 1 : 2, ...match.slice(2).map(Number)].join('/') : path
        const row = records.get(key)
        ++requests
        requested.add(key)
        if (!row) missing.add(key)
        let cancelled = false
        return {
          promise: Promise.resolve().then(() => {
            if (cancelled) throw new Error('Navigation terrain request cancelled')
            if (!row) throw new Error('Uncaptured navigation terrain key: ' + key)
            const data = payload.slice(row.offset, row.offset + row.bytes)
            if (row.status === 404) ++notFoundResponses
            return {statusCode: row.status, data, header: {
              'Content-Length': String(data.byteLength),
              'X-Terra-Checksum': 'fnv1a64:' + checksum(new Uint8Array(data))
            }}
          }),
          abort() { cancelled = true }
        }
      },
      stats() {
        return {datasetId: catalogue.datasetId, sha256: catalogue.sha256,
          recordCount: records.size, requests, uniqueRequests: requested.size,
          notFoundResponses, missingKeys: Array.from(missing).sort()}
      },
      assertComplete() {
        if (missing.size) throw new Error('Navigation snapshot is incomplete: ' + Array.from(missing).join(', '))
      }
    }
  }

  return {create}
})
