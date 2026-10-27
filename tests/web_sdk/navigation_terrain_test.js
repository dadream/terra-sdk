const assert = require('assert')
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const {create} = require('./navigation_terrain')
const {fnv1a64} = require('../../sdk/js/core/terra_globe_common')

async function main() {
  const root = path.join(__dirname, '../../testdata/miniprogram/navigation_terrain')
  const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'terrain-records.json')))
  const bytes = fs.readFileSync(path.join(root, 'terrain-records.bin'))
  const sha = b => crypto.createHash('sha256').update(b).digest('hex')
  assert.strictEqual(sha(bytes), catalogue.sha256)
  assert.strictEqual(catalogue.bytes, bytes.length)
  const roots = catalogue.records.filter(row => row.key[0] === 1)
  assert.strictEqual(roots.length, 8)
  assert(new Set(roots.map(row => row.sha256)).size > 1, 'Do not reuse one root everywhere')
  for (const row of catalogue.records) {
    const data = bytes.subarray(row.offset, row.offset + row.bytes)
    assert.strictEqual(sha(data), row.sha256, row.key.join('/'))
    if (row.status === 404) assert.strictEqual(JSON.parse(data).error.code, 'patch_not_found')
  }
  const fixture = () => create(catalogue, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), fnv1a64)
  const snapshot = fixture()
  const url = row => 'https://terrain.example/terra/v1/datasets/globe/' +
    (row.key[0] === 1 ? 'root/' : 'detail/') + row.key.slice(1).join('/')
  for (const row of [...roots, catalogue.records.find(row => row.key[0] === 2 && row.status === 200),
    catalogue.records.find(row => row.status === 404), catalogue.records[catalogue.records.length - 1]]) {
    const response = await snapshot.request({url: url(row)}).promise
    assert.strictEqual(response.statusCode, row.status)
    assert.strictEqual(sha(Buffer.from(response.data)), row.sha256)
    assert.strictEqual(response.header['X-Terra-Checksum'], 'fnv1a64:' + fnv1a64(new Uint8Array(response.data)))
    new Uint8Array(response.data).fill(0)
    assert.strictEqual(sha(Buffer.from((await snapshot.request({url: url(row)}).promise).data)), row.sha256,
      'Caller mutation must not corrupt later responses')
  }
  snapshot.assertComplete()
  assert(snapshot.stats().notFoundResponses > 0)
  const task = snapshot.request({url: url(roots[0])})
  task.abort()
  await assert.rejects(task.promise, /cancelled/)
  const incomplete = fixture()
  await assert.rejects(incomplete.request({url: 'https://terrain.example/terra/v1/datasets/globe/detail/1/2/3'}).promise,
    /Uncaptured/)
  assert.throws(() => incomplete.assertComplete(), /incomplete/)
  assert.deepStrictEqual(incomplete.stats().missingKeys, ['2/1/2/3'])
  const corrupt = JSON.parse(JSON.stringify(catalogue))
  corrupt.records[0].status = 404
  assert.throws(() => create(corrupt, new ArrayBuffer(bytes.length), fnv1a64), /Invalid navigation terrain record/)
  console.log('Navigation terrain snapshot integrity, exact keys, absence, cancellation and missing-key rejection passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
