const assert = require('assert')

const common = require('../../apps/miniprogram/utils/terra_globe_common')
const imagery = require('../../apps/miniprogram/utils/terra_imagery_profiles')

function main() {
  assert.strictEqual(common.isAllowedResourceUrl(
    'https://example.com/tiles/0/0/0.jpg'), true)
  assert.strictEqual(common.isAllowedResourceUrl(
    'http://127.0.0.1:18766/imagery/tiles/0/0/0.jpg'), true)
  assert.strictEqual(common.isAllowedResourceUrl(
    'http://localhost:18766/imagery/tiles/0/0/0.jpg'), true)
  assert.strictEqual(common.isAllowedResourceUrl(
    'http://example.com/tiles/0/0/0.jpg'), false)
  assert.strictEqual(common.isAllowedResourceUrl(
    'http://127.0.0.1:70000/tiles/0/0/0.jpg'), false)

  const profile = imagery.resolveImageryProfile('tianditu-img-c', '',
    'tianditu-img-c', 'http://127.0.0.1:18766/imagery')
  assert.strictEqual(profile.resolveTile({
    level: 0, matrix: 1, column: 0, row: 0
  }), 'http://127.0.0.1:18766/imagery/terra/v1/imagery/' +
    'tianditu/img-c/0/0/0.jpg')
  assert.throws(() => imagery.resolveImageryProfile('tianditu-img-c', '',
    'tianditu-img-c', 'http://example.com/imagery'), /must use HTTPS/)
  assert.throws(() => imagery.resolveImageryProfile('tianditu-img-c', '',
    'tianditu-img-c', 'http://127.0.0.1:70000/imagery'),
  /loopback HTTP/)
  console.log('Local resource URL safety tests passed.')
}

main()
