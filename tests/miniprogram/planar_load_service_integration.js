const assert = require('assert')
const http = require('http')
const https = require('https')
const probe = require('../../apps/miniprogram/utils/terra_planar_load_probe')

function requestWithNode(options) {
  return new Promise((resolve, reject) => {
    const transport = options.url.startsWith('https:') ? https : http
    const request = transport.get(options.url, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const body = Buffer.concat(chunks)
        const data = options.responseType === 'arraybuffer'
          ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
          : body.toString('utf8')
        resolve({
          statusCode: response.statusCode,
          data,
          header: response.headers
        })
      })
    })
    request.setTimeout(options.timeout || 15000, () => {
      request.destroy(new Error(`Request timed out: ${options.url}`))
    })
    request.on('error', reject)
  })
}

async function main() {
  const serviceOrigin = process.argv[2] || 'http://127.0.0.1:18081'
  const report = await probe.runPlanarLoadProbe({
    serviceOrigin,
    request: requestWithNode
  })
  assert.strictEqual(report.passed, true)
  assert.strictEqual(report.dataset.id, 'ps-1k')
  assert.strictEqual(report.dataset.transform, 'planar')
  assert.strictEqual(report.scope.wasmDecode, false)
  assert.strictEqual(report.scope.planarRendering, false)
  console.log(`Planar service integration passed: ${probe.reportSummary(report)}`)
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
