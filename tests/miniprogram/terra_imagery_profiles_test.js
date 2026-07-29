const assert = require('assert')

const profiles = require('../../apps/miniprogram/utils/terra_imagery_profiles')

function main() {
  const token = '0123456789abcdef0123456789abcdef'
  const blue = profiles.resolveImageryProfile('blue-marble', '', 'blue-marble')
  assert.strictEqual(blue.textureId, 'blue-marble')
  assert.strictEqual(blue.texture, null)
  assert.strictEqual(blue.attribution, '')

  const tianditu = profiles.resolveImageryProfile('tianditu-img-c', token)
  assert.strictEqual(tianditu.texture.matrix_level_offset, 1)
  assert.strictEqual(tianditu.texture.maximum_level, 17)
  assert.strictEqual(JSON.stringify(tianditu).indexOf(token), -1)
  assert.strictEqual(tianditu.urlForTile({
    level: 0,
    matrix: 1,
    row: 0,
    column: 0
  }), 'https://t0.tianditu.gov.cn/img_c/wmts?' +
    'SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&' +
    'TILEMATRIXSET=c&FORMAT=tiles&TILEMATRIX=1&TILEROW=0&TILECOL=0&tk=' + token)
  assert.strictEqual(tianditu.urlForTile({
    level: 0,
    matrix: 1,
    row: 0,
    column: 1
  }).indexOf('https://t1.tianditu.gov.cn/'), 0)
  const proxied = profiles.resolveImageryProfile(
    'tianditu-img-c', '', '', 'https://terra-tianditu.example.com')
  assert.strictEqual(proxied.urlForTile({
    level: 2,
    matrix: 3,
    row: 1,
    column: 3
  }), 'https://terra-tianditu.example.com/terra/v1/imagery/tianditu/' +
    'img-c/2/3/1.jpg')
  assert.throws(() => profiles.resolveImageryProfile(
    'tianditu-img-c', '', '', 'http://terra-tianditu.example.com'),
  /HTTPS/)
  assert.throws(() => profiles.resolveImageryProfile('tianditu-img-c', 'bad'),
    /credential/)
  assert.throws(() => profiles.tiandituUrlForTile({
    level: 1,
    matrix: 1,
    row: 0,
    column: 0
  }, token), /matrix/)
  assert.throws(() => profiles.resolveImageryProfile('unsupported', token),
    /Unsupported/)
  console.log('Mini Program imagery profile tests passed.')
}

try {
  main()
} catch (error) {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
}
