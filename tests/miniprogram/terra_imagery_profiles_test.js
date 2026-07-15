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
