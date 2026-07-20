const common = require('./terra_globe_common')

const PS_1K_BASELINE = {
  datasetId: 'ps-1k',
  patchDimension: 64,
  bounds: [[0, 0], [1025, 1025]],
  root: {
    key: { i: 0, j: 0, k: 268435456 },
    byteLength: 10967,
    checksum: 'd0765aba37fb767e'
  },
  detail: {
    key: { i: -268435456, j: 0, k: 268435456 },
    byteLength: 9225,
    checksum: '6a40a4d592bf87b1'
  }
}

function errorMessage(error) {
  return common.redactSensitiveText(
    error && error.message ? error.message : String(error || 'Unknown error'))
}

function requestWithWx(options) {
  common.invariant(typeof wx !== 'undefined' && typeof wx.request === 'function',
    'wx.request is unavailable')
  return new Promise((resolve, reject) => {
    wx.request({
      url: options.url,
      method: 'GET',
      responseType: options.responseType,
      timeout: options.timeout || 15000,
      success: resolve,
      fail(error) {
        reject(new Error(error && error.errMsg
          ? error.errMsg
          : 'wx.request failed'))
      }
    })
  })
}

function expectNumber(actual, expected, label) {
  common.invariant(actual === expected,
    `${label} expected ${expected}, got ${actual}`)
}

function validateManifestResponse(response, baseline) {
  common.invariant(response && response.statusCode === 200,
    'Planar manifest request did not return HTTP 200')
  const manifest = typeof response.data === 'string'
    ? JSON.parse(response.data)
    : response.data
  common.invariant(manifest && manifest.schema === 'terra.dataset-manifest' &&
    manifest.schema_version === 1, 'Planar manifest schema is unsupported')
  common.invariant(manifest.dataset_id === baseline.datasetId,
    'Planar manifest dataset ID does not match the baseline')
  common.invariant(manifest.format_version === 1,
    'Planar manifest format version is unsupported')
  expectNumber(manifest.patch_dim, baseline.patchDimension,
    'Planar patch dimension')
  common.invariant(manifest.transform &&
    manifest.transform.kind === 'planar',
    'Planar manifest transform is not planar')
  expectNumber(manifest.transform.root_count, 1, 'Planar root count')
  common.invariant(JSON.stringify(manifest.transform.bounds) ===
    JSON.stringify(baseline.bounds),
    'Planar manifest bounds do not match the baseline')
  common.invariant(manifest.endpoints &&
    typeof manifest.endpoints.root === 'string' &&
    typeof manifest.endpoints.detail === 'string',
    'Planar manifest endpoints are missing')
  return manifest
}

function littleEndianUint32(bytes, offset) {
  return (bytes[offset] |
    bytes[offset + 1] << 8 |
    bytes[offset + 2] << 16 |
    bytes[offset + 3] << 24) >>> 0
}

function validateRecordResponse(response, expected, label) {
  common.invariant(response && response.statusCode === 200,
    `${label} request did not return HTTP 200`)
  common.invariant(response.data instanceof ArrayBuffer ||
    response.data instanceof Uint8Array,
    `${label} response is not an ArrayBuffer`)
  const bytes = common.validateRecordPayload(response.data, response.header)
  expectNumber(bytes.byteLength, expected.byteLength, `${label} byte length`)
  const checksum = common.fnv1a64(bytes)
  common.invariant(checksum === expected.checksum,
    `${label} checksum does not match the 1k baseline`)
  common.invariant(bytes.byteLength >= 4,
    `${label} record is shorter than its framing prefix`)
  const framedBytes = littleEndianUint32(bytes, 0)
  expectNumber(framedBytes, bytes.byteLength - 4,
    `${label} framing length`)
  return {
    statusCode: response.statusCode,
    byteLength: bytes.byteLength,
    checksum: `fnv1a64:${checksum}`,
    framedBytes
  }
}

function recordUrl(origin, template, key) {
  return common.joinServiceUrl(origin, common.replaceTemplate(template, key))
}

async function runPlanarLoadProbe(options) {
  const value = options || {}
  const origin = value.serviceOrigin || ''
  const baseline = value.baseline || PS_1K_BASELINE
  const request = value.request || requestWithWx
  const manifestPath = value.manifestPath ||
    `/terra/v1/datasets/${baseline.datasetId}/manifest`
  const startedAt = Date.now()

  const manifestResponse = await request({
    url: common.joinServiceUrl(origin, manifestPath),
    responseType: 'text',
    timeout: 15000
  })
  const manifest = validateManifestResponse(manifestResponse, baseline)
  const rootResponse = await request({
    url: recordUrl(origin, manifest.endpoints.root, baseline.root.key),
    responseType: 'arraybuffer',
    timeout: 15000
  })
  const root = validateRecordResponse(rootResponse, baseline.root,
    'Planar root')
  const detailUrl = recordUrl(origin, manifest.endpoints.detail,
    baseline.detail.key)
  const detailResponse = await request({
    url: detailUrl,
    responseType: 'arraybuffer',
    timeout: 15000
  })
  const detail = validateRecordResponse(detailResponse, baseline.detail,
    'Planar detail')
  const repeatedResponse = await request({
    url: detailUrl,
    responseType: 'arraybuffer',
    timeout: 15000
  })
  const repeated = validateRecordResponse(repeatedResponse, baseline.detail,
    'Repeated planar detail')
  common.invariant(detail.byteLength === repeated.byteLength &&
    detail.checksum === repeated.checksum,
    'Repeated planar detail response is not stable')

  return {
    schema: 'terra.miniprogram.planar-load.v1',
    capturedAt: new Date().toISOString(),
    passed: true,
    durationMs: Date.now() - startedAt,
    scope: {
      serviceRepositoryRead: true,
      miniProgramArrayBuffer: true,
      transportIntegrity: true,
      recordFraming: true,
      repeatedReadStability: true,
      wasmDecode: false,
      planarRendering: false
    },
    dataset: {
      id: manifest.dataset_id,
      transform: manifest.transform.kind,
      bounds: manifest.transform.bounds,
      patchDimension: manifest.patch_dim,
      heightScale: manifest.height_scale
    },
    manifest: { statusCode: manifestResponse.statusCode },
    root,
    detail,
    repeatedDetail: repeated
  }
}

function reportSummary(report) {
  if (!report || !report.passed) {
    return 'Planar load failed'
  }
  return [
    `manifest ${report.manifest.statusCode}`,
    `root ${report.root.byteLength} B`,
    `detail ${report.detail.byteLength} B`,
    'repeat stable'
  ].join(' | ')
}

module.exports = {
  PS_1K_BASELINE,
  errorMessage,
  littleEndianUint32,
  reportSummary,
  requestWithWx,
  runPlanarLoadProbe,
  validateManifestResponse,
  validateRecordResponse
}
