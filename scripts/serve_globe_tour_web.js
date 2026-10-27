'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')

const siteRoot = path.resolve(process.env.SITE_ROOT || process.argv[2] || '.')
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 18766)
const terrainPort = Number(process.env.TERRAIN_PORT || 18082)
const imageryPort = Number(process.env.IMAGERY_PORT || 18083)
const imageryProfile = process.env.IMAGERY_PROFILE || 'tianditu-img-c'

if (imageryProfile !== 'tianditu-img-c' && imageryProfile !== 'blue-marble') {
  throw new Error('Unsupported imagery profile: ' + imageryProfile)
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
}

function proxyRequest(req, res, prefix, upstreamPort) {
  const targetPath = req.url.slice(prefix.length) || '/'
  const upstream = http.request({
    host: '127.0.0.1',
    port: upstreamPort,
    method: req.method,
    path: targetPath,
    headers: { accept: req.headers.accept || '*/*' }
  }, (response) => {
    const headers = Object.assign({}, response.headers)
    delete headers.connection
    delete headers['keep-alive']
    res.writeHead(response.statusCode || 502, headers)
    response.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
    }
    res.end('{"error":"local_upstream_unavailable"}\n')
  })
  req.pipe(upstream)
}

function staticFile(req, res) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' })
    res.end()
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch (error) {
    res.writeHead(400)
    res.end()
    return
  }
  if (pathname === '/') pathname = '/index.html'
  const file = path.resolve(siteRoot, `.${pathname}`)
  if (file !== siteRoot && !file.startsWith(`${siteRoot}${path.sep}`)) {
    res.writeHead(403)
    res.end()
    return
  }
  fs.stat(file, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found\n')
      return
    }
    res.writeHead(200, {
      'Content-Type': contentTypes[path.extname(file)] ||
        'application/octet-stream',
      'Cache-Control': pathname === '/index.html'
        ? 'no-store' : 'public, max-age=60'
    })
    if (req.method === 'HEAD') {
      res.end()
    } else {
      fs.createReadStream(file).pipe(res)
    }
  })
}

function redirectDefaultImagery(req, res) {
  const url = new URL(req.url, 'http://localhost')
  if ((url.pathname !== '/' && url.pathname !== '/index.html') ||
    url.searchParams.has('imagery')) {
    return false
  }
  url.searchParams.set('imagery', imageryProfile)
  res.writeHead(302, {
    Location: url.pathname + url.search,
    'Cache-Control': 'no-store'
  })
  res.end()
  return true
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  if (redirectDefaultImagery(req, res)) {
    return
  }
  if (req.url.startsWith('/terra/v1/datasets/')) {
    proxyRequest(req, res, '', terrainPort)
    return
  }
  if (req.url.startsWith('/terrain/')) {
    proxyRequest(req, res, '/terrain', terrainPort)
    return
  }
  if (req.url.startsWith('/imagery/')) {
    proxyRequest(req, res, '/imagery', imageryPort)
    return
  }
  staticFile(req, res)
})

function stop() {
  server.close(() => process.exit(0))
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
server.listen(port, host, () => {
  console.log('[globe-tour-web] ready address=' + host + ' port=' + port +
    ' imagery=' + imageryProfile)
})
