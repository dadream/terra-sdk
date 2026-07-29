'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { cachePaths, createProxyServer, parseTilePath } = require('./server')

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9])

function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }))
    }).on('error', reject)
  })
}

async function withProxy(options, callback) {
  const proxy = createProxyServer(Object.assign({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token'
  }, options))
  await new Promise((resolve) => proxy.server.listen(0, '127.0.0.1', resolve))
  try {
    await callback(proxy.server.address().port, proxy)
  } finally {
    await new Promise((resolve) => proxy.server.close(resolve))
  }
}

function jpegResponse(status = 200, headers = {}) {
  return new Response(status === 200 ? JPEG : null, {
    status,
    headers: Object.assign({ 'Content-Type': 'image/jpeg' }, headers)
  })
}

test('validates img-c tile coordinates', () => {
  assert.deepEqual(parseTilePath(
    '/terra/v1/imagery/tianditu/img-c/3/15/7.jpg'),
  { level: 3, column: 15, row: 7 })
  assert.equal(parseTilePath(
    '/terra/v1/imagery/tianditu/img-c/3/16/7.jpg'), null)
  assert.equal(parseTilePath(
    '/terra/v1/imagery/tianditu/img-c/3/15/8.jpg'), null)
})

test('stores JPEG with jpg suffix and serves the second request from cache',
  async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'terra-tdt-'))
    let fetchCount = 0
    try {
      await withProxy({
        cacheRoot: root,
        fetch: async () => {
          fetchCount += 1
          return jpegResponse(200, {
            'Content-Type': 'image/jpg',
            ETag: '"tile-v1"'
          })
        }
      }, async (port) => {
        const url = '/terra/v1/imagery/tianditu/img-c/3/10/4.jpg'
        const first = await request(port, url)
        const second = await request(port, url)
        assert.equal(first.status, 200)
        assert.equal(first.headers['content-type'], 'image/jpeg')
        assert.equal(first.headers['x-terra-cache'], 'MISS')
        assert.equal(second.headers['x-terra-cache'], 'HIT-MEMORY')
        assert.equal(fetchCount, 1)
        const files = cachePaths(root,
          { level: 3, column: 10, row: 4 })
        assert.equal(fs.existsSync(files.image), true)
        assert.equal(files.image.endsWith('.jpg'), true)
        assert.deepEqual(await fsp.readFile(files.image), JPEG)
      })
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

test('uses an expired JPEG when upstream is unavailable', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'terra-tdt-'))
  try {
    const tile = { level: 2, column: 3, row: 1 }
    const files = cachePaths(root, tile)
    await fsp.mkdir(files.directory, { recursive: true })
    await fsp.writeFile(files.image, JPEG)
    const expired = new Date(Date.now() - 2000)
    await fsp.utimes(files.image, expired, expired)
    await withProxy({
      cacheRoot: root,
      ttlMs: 1000,
      staleIfErrorMs: 5000,
      fetch: async () => { throw new Error('offline') }
    }, async (port) => {
      const response = await request(port,
        '/terra/v1/imagery/tianditu/img-c/2/3/1.jpg')
      assert.equal(response.status, 200)
      assert.equal(response.headers['x-terra-cache'], 'STALE')
      assert.deepEqual(response.body, JPEG)
    })
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
