'use strict'

const fs = require('fs')
const fsp = fs.promises
const http = require('http')
const https = require('https')
const path = require('path')

const YEAR_MS = 365 * 24 * 60 * 60 * 1000
const STALE_IF_ERROR_MS = 30 * 24 * 60 * 60 * 1000
const NEGATIVE_CACHE_MS = 5 * 60 * 1000
const CLIENT_CACHE_SECONDS = 365 * 24 * 60 * 60
const JPEG_CONTENT_TYPE = 'image/jpeg'
const JPEG_UPSTREAM_CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg'])

const STATIC_PROFILES = {
  'ps-1k': {
    id: 'ps-1k',
    kind: 'planar-tms',
    srs: 'EPSG:4326',
    bounds: [[0, 0], [1025, 1025]],
    tileSize: 256,
    levelZeroColumns: 1,
    levelZeroRows: 1,
    matrixLevelOffset: 0,
    maximumLevel: 2,
    relativeRoot: path.join('datasets', 'ps-1k', 'v1', 'imagery', 'ps-1k')
  },
  'blue-marble': {
    id: 'blue-marble',
    kind: 'global-geodetic',
    srs: 'EPSG:4326',
    bounds: [[-180, -90], [180, 90]],
    tileSize: 256,
    levelZeroColumns: 2,
    levelZeroRows: 1,
    matrixLevelOffset: 0,
    maximumLevel: 7,
    relativeRoot: path.join('datasets', 'globe', 'v1', 'imagery', 'blue-marble')
  }
}

const TIANDITU_PROFILE = {
  id: 'tianditu-img-c',
  kind: 'global-geodetic',
  srs: 'EPSG:4326',
  bounds: [[-180, -90], [180, 90]],
  tileSize: 256,
  levelZeroColumns: 2,
  levelZeroRows: 1,
  matrixLevelOffset: 1,
  maximumLevel: 17
}

class MemoryCache {
  constructor(maximumEntries, maximumBytes) {
    this.maximumEntries = maximumEntries
    this.maximumBytes = maximumBytes
    this.entries = new Map()
    this.bytes = 0
  }

  get(key, now) {
    const entry = this.entries.get(key)
    if (!entry || entry.expiresAt <= now) {
      if (entry) {
        this.delete(key)
      }
      return null
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.bytes
  }

  set(key, bytes, expiresAt) {
    this.delete(key)
    this.entries.set(key, { bytes, expiresAt })
    this.bytes += bytes.byteLength
    while (this.entries.size > this.maximumEntries ||
           this.bytes > this.maximumBytes) {
      this.delete(this.entries.keys().next().value)
    }
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (entry) {
      this.bytes -= entry.bytes.byteLength
      this.entries.delete(key)
    }
  }
}

function parseInteger(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function parseTilePath(urlPath) {
  const match = /^\/terra\/v1\/imagery\/tianditu\/img-c\/([0-9]+)\/([0-9]+)\/([0-9]+)(?:\.jpg)?$/.exec(
    urlPath)
  if (!match) {
    return null
  }
  const level = parseInteger(match[1])
  const column = parseInteger(match[2])
  const row = parseInteger(match[3])
  if (level === null || column === null || row === null || level > 17) {
    return null
  }
  const rows = 2 ** level
  const columns = rows * 2
  if (row >= rows || column >= columns) {
    return null
  }
  return { level, column, row }
}

function tileShape(profile, level) {
  const scale = 2 ** level
  return {
    columns: profile.levelZeroColumns * scale,
    rows: profile.levelZeroRows * scale
  }
}

function validTile(profile, level, column, row) {
  if (!profile || level === null || column === null || row === null ||
      level > profile.maximumLevel) {
    return false
  }
  const shape = tileShape(profile, level)
  return column < shape.columns && row < shape.rows
}

function parseStaticTilePath(urlPath) {
  const match = /^\/terra\/v1\/imagery\/(ps-1k|blue-marble)\/([0-9]+)\/([0-9]+)\/([0-9]+)\.jpg$/.exec(
    urlPath)
  if (!match) {
    return null
  }
  const profile = STATIC_PROFILES[match[1]]
  const level = parseInteger(match[2])
  const column = parseInteger(match[3])
  const row = parseInteger(match[4])
  return validTile(profile, level, column, row)
    ? { profile, level, column, row }
    : null
}

function paddedCoordinate(value) {
  return String(value).padStart(8, '0')
}

function vicTmsTilePath(dataRoot, tile) {
  const shape = tileShape(tile.profile, tile.level)
  const repositoryRow = shape.rows - 1 - tile.row
  const row = paddedCoordinate(repositoryRow)
  const column = paddedCoordinate(tile.column)
  return path.join(dataRoot, tile.profile.relativeRoot,
    String(tile.level).padStart(2, '0'), row.slice(0, 4), row.slice(4),
    column.slice(0, 4), `${column.slice(4)}.jpg`)
}

function requestOrigin(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0].trim().toLowerCase()
  const protocol = forwarded === 'https' ? 'https' : 'http'
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim()
  return `${protocol}://${host}`
}

function imageryManifest(profile, origin, routeId) {
  const id = routeId || profile.id
  return {
    schema: 'terra.imagery-manifest',
    schema_version: 1,
    id,
    kind: profile.kind,
    srs: profile.srs,
    bounds: profile.bounds,
    tile_size: profile.tileSize,
    matrix: {
      origin: 'top-left',
      matrix_level_offset: profile.matrixLevelOffset,
      level_zero_columns: profile.levelZeroColumns,
      level_zero_rows: profile.levelZeroRows,
      minimum_level: 0,
      maximum_level: profile.maximumLevel
    },
    format: 'image/jpeg',
    url_template: routeId === 'tianditu-img-c'
      ? `${origin}/terra/v1/imagery/tianditu/img-c/{z}/{x}/{y}.jpg`
      : `${origin}/terra/v1/imagery/${id}/{z}/{x}/{y}.jpg`
  }
}

function tileKey(tile) {
  return `${tile.level}/${tile.column}/${tile.row}`
}

function cachePaths(cacheRoot, tile) {
  const directory = path.join(cacheRoot, 'img-c', 'v1', 'z',
    String(tile.level), 'x', String(tile.column), 'y')
  const stem = path.join(directory, `${tile.row}.jpg`)
  return {
    directory,
    image: stem,
    metadata: `${stem}.json`
  }
}

function upstreamUrl(tile, token) {
  const subdomain = (tile.level + tile.column + tile.row) % 8
  const query = new URLSearchParams({
    SERVICE: 'WMTS',
    REQUEST: 'GetTile',
    VERSION: '1.0.0',
    LAYER: 'img',
    STYLE: 'default',
    TILEMATRIXSET: 'c',
    TILEMATRIX: String(tile.level + 1),
    TILEROW: String(tile.row),
    TILECOL: String(tile.column),
    FORMAT: 'tiles',
    tk: token
  })
  return `https://t${subdomain}.tianditu.gov.cn/img_c/wmts?${query}`
}

function isJpeg(bytes) {
  return bytes.byteLength >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function upstreamFailureReason(error) {
  const message = String(error && error.message || '')
  const httpStatus = /^Tianditu returned HTTP ([0-9]{3})$/.exec(message)
  if (httpStatus) {
    return `upstream_http_${httpStatus[1]}`
  }
  if (message === 'TIANDITU_TOKEN is not configured') {
    return 'token_not_configured'
  }
  if (message === 'Tianditu response is not JPEG') {
    return 'invalid_jpeg_response'
  }
  if (message.includes('timed out')) {
    return 'upstream_timeout'
  }
  return 'upstream_request_failed'
}

async function readMetadata(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (error) {
    return {}
  }
}

async function atomicWrite(file, bytes) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(temporary, bytes)
  await fsp.rename(temporary, file)
}

function responseHeaders(cacheStatus) {
  return {
    'Cache-Control':
      `public, max-age=${CLIENT_CACHE_SECONDS}, stale-if-error=2592000`,
    'Content-Type': JPEG_CONTENT_TYPE,
    'Access-Control-Allow-Origin': '*',
    'X-Terra-Cache': cacheStatus
  }
}

function send(res, status, headers, bytes) {
  const body = bytes || Buffer.alloc(0)
  res.writeHead(status, Object.assign({
    'Content-Length': String(body.byteLength)
  }, headers))
  res.end(body)
}

function requestWithHttps(url, options) {
  const requestOptions = options || {}
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: requestOptions.headers || {}
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const bytes = Buffer.concat(chunks)
        resolve({
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers: {
            get(name) {
              return response.headers[String(name).toLowerCase()] || null
            }
          },
          arrayBuffer() {
            return Promise.resolve(bytes.buffer.slice(
              bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
          }
        })
      })
    })
    request.setTimeout(requestOptions.timeout || 15000, () => {
      request.destroy(new Error('Tianditu request timed out'))
    })
    request.on('error', reject)
  })
}

function createImageryServer(options = {}) {
  const host = options.host || process.env.HOST || '0.0.0.0'
  const port = Number(options.port || process.env.PORT || 8080)
  const dataRoot = options.dataRoot || process.env.DATA_ROOT ||
    '/mnt/terra-data'
  const cacheRoot = options.cacheRoot || process.env.CACHE_ROOT ||
    '/mnt/terra-cache'
  const token = options.token === undefined
    ? process.env.TIANDITU_TOKEN
    : options.token
  const fetchImpl = options.fetch ||
    (typeof global.fetch === 'function' ? global.fetch : requestWithHttps)
  const now = options.now || (() => Date.now())
  const ttlMs = options.ttlMs === undefined ? YEAR_MS : options.ttlMs
  const staleIfErrorMs = options.staleIfErrorMs === undefined
    ? STALE_IF_ERROR_MS
    : options.staleIfErrorMs
  const negativeCacheMs = options.negativeCacheMs === undefined
    ? NEGATIVE_CACHE_MS
    : options.negativeCacheMs
  const memory = new MemoryCache(
    options.maximumMemoryEntries || 128,
    options.maximumMemoryBytes || 32 * 1024 * 1024)
  const inFlight = new Map()
  const negative = new Map()
  const stats = {
    requests: 0,
    staticHits: 0,
    memoryHits: 0,
    diskHits: 0,
    misses: 0,
    revalidated: 0,
    staleHits: 0,
    failures: 0
  }

  async function fetchUpstream(tile, metadata) {
    if (!token) {
      throw new Error('TIANDITU_TOKEN is not configured')
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch is unavailable')
    }
    const headers = {}
    if (metadata.etag) {
      headers['If-None-Match'] = metadata.etag
    }
    if (metadata.lastModified) {
      headers['If-Modified-Since'] = metadata.lastModified
    }
    return fetchImpl(upstreamUrl(tile, token), {
      headers,
      timeout: 15000
    })
  }

  async function loadTile(tile) {
    const key = tileKey(tile)
    const currentTime = now()
    const memoryBytes = memory.get(key, currentTime)
    if (memoryBytes) {
      stats.memoryHits += 1
      return { bytes: memoryBytes, cacheStatus: 'HIT-MEMORY' }
    }
    if ((negative.get(key) || 0) > currentTime) {
      const error = new Error('Tile is temporarily unavailable')
      error.status = 404
      throw error
    }

    const files = cachePaths(cacheRoot, tile)
    let disk = null
    let age = Number.POSITIVE_INFINITY
    try {
      const fileStat = await fsp.stat(files.image)
      disk = await fsp.readFile(files.image)
      if (!isJpeg(disk)) {
        throw new Error('Cached tile is not JPEG')
      }
      age = Math.max(0, currentTime - fileStat.mtimeMs)
      if (age <= ttlMs) {
        memory.set(key, disk, currentTime + Math.max(1, ttlMs - age))
        stats.diskHits += 1
        return { bytes: disk, cacheStatus: 'HIT' }
      }
    } catch (error) {
      disk = null
      age = Number.POSITIVE_INFINITY
    }

    const metadata = await readMetadata(files.metadata)
    try {
      const response = await fetchUpstream(tile, metadata)
      if (response.status === 304 && disk) {
        const time = new Date(currentTime)
        await fsp.utimes(files.image, time, time)
        memory.set(key, disk, currentTime + Math.max(1, ttlMs))
        stats.revalidated += 1
        return { bytes: disk, cacheStatus: 'REVALIDATED' }
      }
      if (response.status === 404) {
        negative.set(key, currentTime + negativeCacheMs)
        const error = new Error('Tianditu tile was not found')
        error.status = 404
        throw error
      }
      if (!response.ok) {
        throw new Error(`Tianditu returned HTTP ${response.status}`)
      }
      const contentType = (response.headers.get('content-type') || '')
        .split(';')[0].trim().toLowerCase()
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!JPEG_UPSTREAM_CONTENT_TYPES.has(contentType) || !isJpeg(bytes)) {
        throw new Error('Tianditu response is not JPEG')
      }
      await fsp.mkdir(files.directory, { recursive: true })
      await atomicWrite(files.image, bytes)
      const nextMetadata = Buffer.from(JSON.stringify({
        etag: response.headers.get('etag') || '',
        lastModified: response.headers.get('last-modified') || '',
        fetchedAt: new Date(currentTime).toISOString()
      }) + '\n')
      await atomicWrite(files.metadata, nextMetadata)
      memory.set(key, bytes, currentTime + Math.max(1, ttlMs))
      stats.misses += 1
      return { bytes, cacheStatus: 'MISS' }
    } catch (error) {
      if (disk && age <= ttlMs + staleIfErrorMs) {
        memory.set(key, disk, currentTime + 60000)
        stats.staleHits += 1
        return { bytes: disk, cacheStatus: 'STALE' }
      }
      stats.failures += 1
      throw error
    }
  }

  async function loadSingleFlight(tile) {
    const key = tileKey(tile)
    if (!inFlight.has(key)) {
      const pending = loadTile(tile).finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    return inFlight.get(key)
  }

  async function ready() {
    if (!token) {
      return { ok: false, reason: 'token_not_configured' }
    }
    const profiles = Object.values(STATIC_PROFILES)
    for (let index = 0; index < profiles.length; ++index) {
      const profile = profiles[index]
      const root = path.join(dataRoot, profile.relativeRoot)
      try {
        const stat = await fsp.stat(root)
        if (!stat.isDirectory()) {
          return { ok: false, reason: `imagery_data_missing:${profile.id}` }
        }
      } catch (error) {
        return { ok: false, reason: `imagery_data_missing:${profile.id}` }
      }
    }
    try {
      await fsp.mkdir(cacheRoot, { recursive: true })
      const probe = path.join(cacheRoot, `.ready-${process.pid}`)
      await fsp.writeFile(probe, 'ok\n')
      await fsp.unlink(probe)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'cache_not_writable' }
    }
  }

  async function loadStaticTile(tile) {
    const file = vicTmsTilePath(dataRoot, tile)
    let bytes
    try {
      bytes = await fsp.readFile(file)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const missing = new Error('Static imagery tile was not found')
        missing.status = 404
        throw missing
      }
      throw error
    }
    if (!isJpeg(bytes)) {
      const invalid = new Error('Static imagery tile is not JPEG')
      invalid.status = 500
      throw invalid
    }
    stats.staticHits += 1
    return bytes
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/healthz') {
      send(res, 200, { 'Content-Type': 'application/json',
        'Cache-Control': 'no-store' },
      Buffer.from(JSON.stringify({ status: 'ok', stats }) + '\n'))
      return
    }
    if (req.method === 'GET' && url.pathname === '/readyz') {
      const status = await ready()
      send(res, status.ok ? 200 : 503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }, Buffer.from(JSON.stringify(status) + '\n'))
      return
    }
    const head = req.method === 'HEAD'
    if (req.method !== 'GET' && !head) {
      send(res, 405, { 'Content-Type': 'application/json' },
        Buffer.from('{"error":"method_not_allowed"}\n'))
      return
    }
    const manifestMatch = /^\/terra\/v1\/imagery\/(ps-1k|blue-marble|tianditu-img-c)\/manifest$/.exec(
      url.pathname)
    if (manifestMatch) {
      const id = manifestMatch[1]
      const profile = id === 'tianditu-img-c'
        ? TIANDITU_PROFILE : STATIC_PROFILES[id]
      const body = Buffer.from(JSON.stringify(
        imageryManifest(profile, requestOrigin(req), id), null, 2) + '\n')
      send(res, 200, {
        'Content-Type': 'application/vnd.terra.imagery+json;version=1',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*'
      }, head ? Buffer.alloc(0) : body)
      return
    }
    const staticTile = parseStaticTilePath(url.pathname)
    if (staticTile) {
      stats.requests += 1
      try {
        const bytes = await loadStaticTile(staticTile)
        send(res, 200, responseHeaders('STATIC'),
          head ? Buffer.alloc(0) : bytes)
      } catch (error) {
        const status = error.status || 500
        console.error(
          `[imagery][error] static_tile_failed status=${status} profile=${staticTile.profile.id}`)
        send(res, status, { 'Content-Type': 'application/json',
          'Cache-Control': 'no-store' },
        Buffer.from(`{"error":"imagery_unavailable","status":${status}}\n`))
      }
      return
    }
    const tile = parseTilePath(url.pathname)
    if (!tile) {
      send(res, 404, { 'Content-Type': 'application/json',
        'Cache-Control': 'no-store' },
      Buffer.from('{"error":"tile_not_found"}\n'))
      return
    }
    stats.requests += 1
    try {
      const result = await loadSingleFlight(tile)
      send(res, 200, responseHeaders(result.cacheStatus),
        head ? Buffer.alloc(0) : result.bytes)
    } catch (error) {
      const status = error.status || 502
      const reason = upstreamFailureReason(error)
      console.error(
        `[imagery][error] upstream_failed status=${status} reason=${reason}`)
      send(res, status, { 'Content-Type': 'application/json',
        'Cache-Control': 'no-store' },
      Buffer.from(`{"error":"imagery_unavailable","status":${status}}\n`))
    }
  })

  return { server, host, port, ready, stats }
}

if (require.main === module) {
  const imagery = createImageryServer()
  imagery.server.listen(imagery.port, imagery.host, () => {
    console.log(`[imagery] ready address=${imagery.host} port=${imagery.port}`)
  })
}

module.exports = {
  BLUE_MARBLE_PROFILE: STATIC_PROFILES['blue-marble'],
  JPEG_CONTENT_TYPE,
  PLANAR_1K_PROFILE: STATIC_PROFILES['ps-1k'],
  TIANDITU_PROFILE,
  cachePaths,
  createImageryServer,
  createProxyServer: createImageryServer,
  imageryManifest,
  isJpeg,
  parseStaticTilePath,
  parseTilePath,
  upstreamUrl,
  vicTmsTilePath
}
