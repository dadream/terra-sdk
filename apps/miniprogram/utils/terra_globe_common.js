const FNV64_OFFSET_HIGH = 0xcbf29ce4
const FNV64_OFFSET_LOW = 0x84222325
const FNV64_PRIME_LOW = 0x1b3
const FNV64_PRIME_HIGH = 0x100

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function finiteNumber(value, name) {
  invariant(typeof value === 'number' && Number.isFinite(value),
    `${name} must be finite`)
  return value
}

function getHeader(headers, name) {
  if (!headers) {
    return ''
  }
  const expected = name.toLowerCase()
  const keys = Object.keys(headers)
  for (let index = 0; index < keys.length; ++index) {
    const key = keys[index]
    if (key.toLowerCase() === expected) {
      return String(headers[key])
    }
  }
  return ''
}

function redactSensitiveText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/([?&](?:tk|token|access_token)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\b(tk|token|access_token)\s*([:=])\s*[A-Za-z0-9._-]+/gi,
      '$1$2[redacted]')
}

function sanitizeDiagnosticDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return redactSensitiveText(detail)
  }
  const result = {}
  Object.keys(detail).forEach((key) => {
    const value = detail[key]
    result[key] = typeof value === 'string' ? redactSensitiveText(value) : value
  })
  return result
}

function multiply32(left, right) {
  const leftLow = left & 0xffff
  const leftHigh = left >>> 16
  const rightLow = right & 0xffff
  const rightHigh = right >>> 16
  const productLow = leftLow * rightLow
  const productMiddle = (productLow >>> 16) +
    leftLow * rightHigh + leftHigh * rightLow
  return {
    low: ((productLow & 0xffff) | ((productMiddle & 0xffff) << 16)) >>> 0,
    high: (leftHigh * rightHigh + (productMiddle >>> 16)) >>> 0
  }
}

function fnv1a64(bytes) {
  invariant(bytes && typeof bytes.length === 'number',
    'FNV input must be a byte array')
  let high = FNV64_OFFSET_HIGH
  let low = FNV64_OFFSET_LOW
  for (let index = 0; index < bytes.length; ++index) {
    low = (low ^ bytes[index]) >>> 0
    const product = multiply32(low, FNV64_PRIME_LOW)
    high = (product.high + Math.imul(high, FNV64_PRIME_LOW) +
      Math.imul(low, FNV64_PRIME_HIGH)) >>> 0
    low = product.low
  }
  return high.toString(16).padStart(8, '0') +
    low.toString(16).padStart(8, '0')
}

function validateRecordPayload(data, headers) {
  const bytes = data instanceof Uint8Array
    ? data
    : new Uint8Array(data)
  const length = getHeader(headers, 'content-length')
  const checksum = getHeader(headers, 'x-terra-checksum').toLowerCase()
  invariant(/^\d+$/.test(length), 'Terrain response has invalid Content-Length')
  invariant(Number(length) === bytes.byteLength,
    'Terrain response Content-Length does not match payload')
  invariant(/^fnv1a64:[0-9a-f]{16}$/.test(checksum),
    'Terrain response has invalid X-Terra-Checksum')
  invariant(checksum === `fnv1a64:${fnv1a64(bytes)}`,
    'Terrain response checksum mismatch')
  return bytes
}

function patchKeyString(kind, key) {
  return `${kind}:${key.level}/${key.i}/${key.j}/${key.k}`
}

function textureKeyString(key) {
  return `${key.level}/${key.matrix}/${key.row}/${key.column}`
}

function replaceTemplate(template, values) {
  invariant(typeof template === 'string' && template.length > 0,
    'Endpoint template is required')
  return template.replace(/\{(i|j|k|z|x|y)\}/g, (match, name) => {
    invariant(Object.prototype.hasOwnProperty.call(values, name),
      `Endpoint template value is missing: ${name}`)
    return String(values[name])
  })
}

function isAllowedServiceOrigin(origin) {
  if (typeof origin !== 'string') {
    return false
  }
  if (/^https:\/\//.test(origin)) {
    return true
  }
  const loopbackHost = '(localhost|127\\.0\\.0\\.1|\\[::1\\])'
  const loopback = new RegExp(`^http://${loopbackHost}(?::(\\d{1,5}))?/?$`).exec(origin)
  if (!loopback) {
    return false
  }
  return !loopback[2] || Number(loopback[2]) <= 65535
}

function joinServiceUrl(origin, endpoint) {
  invariant(typeof endpoint === 'string' && endpoint.length > 0,
    'Endpoint is required')
  if (/^https:\/\//.test(endpoint)) {
    return endpoint
  }
  invariant(isAllowedServiceOrigin(origin),
    'Terrain service origin must use HTTPS or a loopback HTTP address')
  return `${origin.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`
}

function validateTextureMatrix(texture, terrain, defaults) {
  const minimumLevel = texture.minimum_level === undefined
    ? 0 : texture.minimum_level
  const tileSize = texture.tile_size === undefined
    ? 256 : texture.tile_size
  const columns = texture.level_zero_columns === undefined
    ? defaults.columns : texture.level_zero_columns
  const rows = texture.level_zero_rows === undefined
    ? defaults.rows : texture.level_zero_rows
  const origin = texture.origin || 'top-left'
  const bounds = texture.bounds || [[terrain.minimumU, terrain.minimumV],
    [terrain.maximumU, terrain.maximumV]]
  invariant(minimumLevel === 0, 'Texture minimum level must be zero in V1')
  invariant(Number.isInteger(tileSize) && tileSize > 0 && tileSize <= 16384,
    'Texture tile size is invalid')
  invariant(Number.isInteger(columns) && columns > 0 && columns <= 1024 &&
    Number.isInteger(rows) && rows > 0 && rows <= 1024,
  'Texture level-zero matrix is invalid')
  invariant(origin === 'top-left', 'Texture origin must be top-left')
  invariant(Array.isArray(bounds) && bounds.length === 2 &&
    Array.isArray(bounds[0]) && bounds[0].length === 2 &&
    Array.isArray(bounds[1]) && bounds[1].length === 2,
  'Texture bounds are invalid')
  bounds.forEach((point, pointIndex) => point.forEach((value, axis) =>
    finiteNumber(value, `Texture bound ${pointIndex}/${axis}`)))
  invariant(bounds[0][0] < bounds[1][0] && bounds[0][1] < bounds[1][1],
    'Texture bounds are empty')
  return Object.assign({}, texture, {
    minimum_level: minimumLevel,
    tile_size: tileSize,
    level_zero_columns: columns,
    level_zero_rows: rows,
    origin,
    bounds: [bounds[0].slice(), bounds[1].slice()]
  })
}

function selectTextureDescriptor(manifest, textureId) {
  const textures = Array.isArray(manifest.textures) ? manifest.textures : []
  const candidates = textureId
    ? textures.filter((texture) => texture.id === textureId)
    : textures
  const texture = candidates.find((candidate) =>
    candidate && candidate.kind === 'global-geodetic')
  invariant(texture, 'Manifest has no global-geodetic texture descriptor')
  invariant(typeof texture.url_template === 'string' &&
    /^https:\/\//.test(texture.url_template),
  'Texture URL template must use HTTPS')
  invariant(Number.isInteger(texture.matrix_level_offset) &&
    texture.matrix_level_offset >= 0 && Number.isInteger(texture.maximum_level) &&
    texture.maximum_level >= 0 && texture.maximum_level <= 28,
  'Texture level descriptor is invalid')
  return texture
}

function validateManifestBase(manifest) {
  invariant(manifest && typeof manifest === 'object', 'Manifest is required')
  invariant(manifest.schema === 'terra.dataset-manifest' &&
    manifest.schema_version === 1, 'Manifest schema is unsupported')
  invariant(typeof manifest.dataset_id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(manifest.dataset_id),
  'Manifest dataset ID is invalid')
  invariant(manifest.format_version === 1, 'Manifest format version is unsupported')
  invariant(Number.isInteger(manifest.patch_dim) && manifest.patch_dim > 0 &&
    manifest.patch_dim <= 256, 'Manifest patch dimension is invalid')
  finiteNumber(manifest.height_scale, 'Manifest height scale')
  invariant(manifest.height_scale > 0, 'Manifest height scale must be positive')
  const transform = manifest.transform
  invariant(transform && typeof transform === 'object',
    'Manifest terrain transform is missing')
  invariant(Array.isArray(transform.bounds) && transform.bounds.length === 2 &&
    Array.isArray(transform.bounds[0]) && transform.bounds[0].length === 2 &&
    Array.isArray(transform.bounds[1]) && transform.bounds[1].length === 2,
  'Manifest terrain bounds are invalid')
  const minimum = transform.bounds[0]
  const maximum = transform.bounds[1]
  finiteNumber(minimum[0], 'Manifest minimum longitude')
  finiteNumber(minimum[1], 'Manifest minimum latitude')
  finiteNumber(maximum[0], 'Manifest maximum longitude')
  finiteNumber(maximum[1], 'Manifest maximum latitude')
  invariant(minimum[0] < maximum[0] && minimum[1] < maximum[1],
    'Manifest terrain bounds are empty')
  invariant(manifest.endpoints && typeof manifest.endpoints.root === 'string' &&
    typeof manifest.endpoints.detail === 'string',
  'Manifest terrain endpoints are missing')
  return {
    datasetId: manifest.dataset_id,
    formatVersion: manifest.format_version,
    patchDimension: manifest.patch_dim,
    heightScale: manifest.height_scale,
    minimumU: minimum[0],
    minimumV: minimum[1],
    maximumU: maximum[0],
    maximumV: maximum[1],
    rootEndpoint: manifest.endpoints.root,
    detailEndpoint: manifest.endpoints.detail
  }
}

function selectPlanarTextureDescriptor(manifest, textureId) {
  const textures = Array.isArray(manifest.textures) ? manifest.textures : []
  const candidates = textureId
    ? textures.filter((texture) => texture.id === textureId)
    : textures
  const texture = candidates.find((candidate) =>
    candidate && (candidate.kind === 'planar-tms' ||
      candidate.kind === 'planar-single'))
  invariant(texture, 'Manifest has no planar texture descriptor')
  invariant(typeof texture.url_template === 'string' &&
    (/^\//.test(texture.url_template) ||
      /^https:\/\//.test(texture.url_template) ||
      /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\//
        .test(texture.url_template)),
  'Planar texture URL must be relative, HTTPS, or loopback HTTP')
  invariant(Number.isInteger(texture.matrix_level_offset) &&
    texture.matrix_level_offset >= 0 &&
    Number.isInteger(texture.maximum_level) &&
    texture.maximum_level >= 0 && texture.maximum_level <= 28,
  'Planar texture level descriptor is invalid')
  if (texture.kind === 'planar-single') {
    invariant(texture.matrix_level_offset === 0 && texture.maximum_level === 0,
      'Planar single texture level descriptor is invalid')
  } else {
    invariant(/\{z\}/.test(texture.url_template) &&
      /\{x\}/.test(texture.url_template) && /\{y\}/.test(texture.url_template),
    'Planar TMS texture template must contain z, x, and y')
  }
  return texture
}

function validateManifest(manifest, textureId) {
  const result = validateManifestBase(manifest)
  const transform = manifest.transform
  invariant(transform && transform.kind === 'cylindrical',
    'Mini Program renderer requires a cylindrical terrain manifest')
  finiteNumber(transform.radius, 'Manifest terrain radius')
  invariant(transform.radius > 0, 'Manifest terrain radius must be positive')
  result.transform = 'cylindrical'
  result.radius = transform.radius
  result.texture = validateTextureMatrix(
    selectTextureDescriptor(manifest, textureId), result, { columns: 2, rows: 1 })
  return result
}

function validatePlanarManifest(manifest, textureId) {
  const result = validateManifestBase(manifest)
  const transform = manifest.transform
  invariant(transform && transform.kind === 'planar',
    'Planar renderer requires a planar terrain manifest')
  finiteNumber(transform.radius, 'Manifest terrain radius')
  invariant(transform.radius === 0,
    'Planar terrain radius must be zero')
  result.transform = 'planar'
  result.radius = 0
  result.texture = validateTextureMatrix(
    selectPlanarTextureDescriptor(manifest, textureId), result,
    { columns: 1, rows: 1 })
  return result
}

class LruCache {
  constructor(options) {
    const value = options || {}
    this.maximumEntries = value.maximumEntries || 0
    this.maximumBytes = value.maximumBytes || 0
    this.dispose = value.dispose || (() => {})
    this.entries = new Map()
    this.bytes = 0
  }

  get(key) {
    const entry = this.entries.get(key)
    if (!entry) {
      return null
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  has(key) {
    return this.entries.has(key)
  }

  set(key, value, byteSize) {
    const size = Math.max(0, Number(byteSize) || 0)
    const previous = this.entries.get(key)
    if (previous) {
      this.entries.delete(key)
      this.bytes -= previous.byteSize
      this.dispose(previous.value)
    }
    this.entries.set(key, { value, byteSize: size })
    this.bytes += size
    this.evict()
    return value
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (!entry) {
      return false
    }
    this.entries.delete(key)
    this.bytes -= entry.byteSize
    this.dispose(entry.value)
    return true
  }

  clear() {
    this.entries.forEach((entry) => this.dispose(entry.value))
    this.entries.clear()
    this.bytes = 0
  }

  values() {
    return Array.from(this.entries.values()).map((entry) => entry.value)
  }

  stats() {
    return { entries: this.entries.size, bytes: this.bytes }
  }

  evict() {
    while (this.entries.size > 0 &&
      ((this.maximumEntries > 0 && this.entries.size > this.maximumEntries) ||
       (this.maximumBytes > 0 && this.bytes > this.maximumBytes))) {
      const oldest = this.entries.keys().next().value
      this.delete(oldest)
    }
  }
}

class RequestScheduler {
  constructor(maximumConcurrent) {
    this.maximumConcurrent = Math.max(1, maximumConcurrent || 1)
    this.active = new Map()
    this.queued = new Map()
  }

  enqueue(key, start) {
    if (this.active.has(key) || this.queued.has(key)) {
      return
    }
    this.queued.set(key, start)
    this.pump()
  }

  cancelExcept(desired) {
    const wanted = desired || new Set()
    this.queued.forEach((value, key) => {
      if (!wanted.has(key)) {
        this.queued.delete(key)
      }
    })
    this.active.forEach((request, key) => {
      if (!wanted.has(key)) {
        request.stale = true
        if (typeof request.abort === 'function') {
          request.abort()
        }
      }
    })
  }

  clear() {
    this.cancelExcept(new Set())
    this.queued.clear()
  }

  stats() {
    return { active: this.active.size, queued: this.queued.size }
  }

  pump() {
    while (this.active.size < this.maximumConcurrent && this.queued.size) {
      const next = this.queued.entries().next().value
      const key = next[0]
      const start = next[1]
      this.queued.delete(key)
      let started
      try {
        started = start()
      } catch (error) {
        continue
      }
      const request = {
        stale: false,
        abort: started && started.abort
      }
      this.active.set(key, request)
      Promise.resolve(started && started.promise)
        .catch(() => undefined)
        .then(() => {
          this.active.delete(key)
          this.pump()
        })
    }
  }
}

function deriveFrameBudget(viewport, capabilities) {
  const width = Math.max(1, Math.round(viewport.width || 1))
  const height = Math.max(1, Math.round(viewport.height || 1))
  const requestedDpr = Number(viewport.devicePixelRatio) || 1
  const maxTextureSize = Number(capabilities && capabilities.maxTextureSize) || 2048
  const area = width * height
  const dprCap = area > 700000 ? 1.25 : 2
  const devicePixelRatio = clamp(requestedDpr, 1, dprCap)
  const physicalWidth = Math.min(maxTextureSize,
    Math.max(1, Math.round(width * devicePixelRatio)))
  const physicalHeight = Math.min(maxTextureSize,
    Math.max(1, Math.round(height * devicePixelRatio)))
  const minimumDimension = Math.max(1, Math.min(physicalWidth, physicalHeight))
  return {
    cssWidth: width,
    cssHeight: height,
    physicalWidth,
    physicalHeight,
    devicePixelRatio: Math.min(physicalWidth / width, physicalHeight / height),
    lodThreshold: clamp(3.5 / minimumDimension, 0.0015, 0.02),
    maximumConcurrentRequests: area > 700000 ? 3 : 5,
    uploadBudgetMs: area > 700000 ? 4 : 7,
    geometryCacheBytes: area > 700000 ? 8 * 1024 * 1024 : 16 * 1024 * 1024,
    textureCacheBytes: area > 700000 ? 24 * 1024 * 1024 : 48 * 1024 * 1024
  }
}

function relativeProjectionView(rowMajorProjectionView, cameraPosition) {
  invariant(rowMajorProjectionView && rowMajorProjectionView.length === 16,
    'Projection-view matrix must contain 16 values')
  invariant(cameraPosition && cameraPosition.length === 3,
    'Camera position must contain three values')
  const result = new Float64Array(16)
  const x = finiteNumber(cameraPosition[0], 'Camera x')
  const y = finiteNumber(cameraPosition[1], 'Camera y')
  const z = finiteNumber(cameraPosition[2], 'Camera z')
  for (let row = 0; row < 4; ++row) {
    const offset = row * 4
    result[offset] = rowMajorProjectionView[offset]
    result[offset + 1] = rowMajorProjectionView[offset + 1]
    result[offset + 2] = rowMajorProjectionView[offset + 2]
    result[offset + 3] = rowMajorProjectionView[offset] * x +
      rowMajorProjectionView[offset + 1] * y +
      rowMajorProjectionView[offset + 2] * z +
      rowMajorProjectionView[offset + 3]
  }
  return result
}

function rowMajorToWebGlMatrix(rowMajor) {
  invariant(rowMajor && rowMajor.length === 16,
    'Matrix must contain 16 values')
  const result = new Float32Array(16)
  for (let row = 0; row < 4; ++row) {
    for (let column = 0; column < 4; ++column) {
      result[column * 4 + row] = rowMajor[row * 4 + column]
    }
  }
  return result
}

module.exports = {
  LruCache,
  RequestScheduler,
  clamp,
  deriveFrameBudget,
  finiteNumber,
  fnv1a64,
  getHeader,
  invariant,
  isAllowedServiceOrigin,
  joinServiceUrl,
  patchKeyString,
  relativeProjectionView,
  redactSensitiveText,
  replaceTemplate,
  rowMajorToWebGlMatrix,
  selectPlanarTextureDescriptor,
  selectTextureDescriptor,
  sanitizeDiagnosticDetail,
  textureKeyString,
  validateManifest,
  validatePlanarManifest,
  validateRecordPayload
}
