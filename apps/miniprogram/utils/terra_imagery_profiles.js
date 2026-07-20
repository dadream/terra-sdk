const common = require('./terra_globe_common')

const BLUE_MARBLE_PROFILE = 'blue-marble'
const TIANDITU_IMG_C_PROFILE = 'tianditu-img-c'
const TIANDITU_PROFILE_STORAGE_KEY = 'terra.imageryProfile'
const TIANDITU_TOKEN_STORAGE_KEY = 'terra.tiandituToken'
const TIANDITU_ATTRIBUTION = '\u00a9 \u5929\u5730\u56fe'

const TIANDITU_TEXTURE = {
  id: TIANDITU_IMG_C_PROFILE,
  kind: 'global-geodetic',
  url_template: 'https://t{s}.tianditu.gov.cn/img_c/wmts',
  matrix_level_offset: 1,
  maximum_level: 17
}

function validateTiandituToken(credential) {
  common.invariant(typeof credential === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(credential),
  'Tianditu frontend credential format is invalid')
  return credential
}

function validateTiandituTile(tile) {
  common.invariant(tile && typeof tile === 'object',
    'Tianditu tile is required')
  const level = tile.level
  const matrix = tile.matrix
  const row = tile.row
  const column = tile.column
  common.invariant(Number.isInteger(level) && level >= 0 && level <= 17,
    'Tianditu tile level is invalid')
  common.invariant(Number.isInteger(matrix) && matrix === level + 1,
    'Tianditu tile matrix is invalid')
  const rows = Math.pow(2, level)
  common.invariant(Number.isInteger(row) && row >= 0 && row < rows,
    'Tianditu tile row is invalid')
  common.invariant(Number.isInteger(column) && column >= 0 &&
    column < rows * 2, 'Tianditu tile column is invalid')
  return { level, matrix, row, column }
}

function tiandituUrlForTile(tile, credential) {
  const value = validateTiandituTile(tile)
  const token = validateTiandituToken(credential)
  const subdomain = (value.row + value.column) % 8
  return 'https://t' + subdomain + '.tianditu.gov.cn/img_c/wmts?' +
    'SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&' +
    'TILEMATRIXSET=c&FORMAT=tiles&TILEMATRIX=' + value.matrix +
    '&TILEROW=' + value.row + '&TILECOL=' + value.column +
    '&tk=' + encodeURIComponent(token)
}

function resolveImageryProfile(profileName, credential, fallbackTextureId) {
  const name = profileName || BLUE_MARBLE_PROFILE
  if (name === BLUE_MARBLE_PROFILE) {
    const textureId = fallbackTextureId || BLUE_MARBLE_PROFILE
    common.invariant(typeof textureId === 'string' && textureId.length > 0,
      'Blue Marble texture ID is required')
    return {
      id: BLUE_MARBLE_PROFILE,
      textureId,
      attribution: '',
      texture: null,
      urlForTile: null
    }
  }
  if (name === TIANDITU_IMG_C_PROFILE) {
    const token = validateTiandituToken(credential)
    return {
      id: TIANDITU_IMG_C_PROFILE,
      textureId: TIANDITU_IMG_C_PROFILE,
      tileScheme: 'global-geodetic',
      minimumLevel: 0,
      maximumLevel: 17,
      matrixLevelOffset: 1,
      attribution: TIANDITU_ATTRIBUTION,
      texture: Object.assign({}, TIANDITU_TEXTURE),
      resolveTile(tile) {
        return tiandituUrlForTile(tile, token)
      },
      urlForTile(tile) {
        return tiandituUrlForTile(tile, token)
      }
    }
  }
  throw new Error('Unsupported imagery profile')
}

module.exports = {
  BLUE_MARBLE_PROFILE,
  TIANDITU_ATTRIBUTION,
  TIANDITU_IMG_C_PROFILE,
  TIANDITU_PROFILE_STORAGE_KEY,
  TIANDITU_TEXTURE,
  TIANDITU_TOKEN_STORAGE_KEY,
  resolveImageryProfile,
  tiandituUrlForTile,
  validateTiandituTile,
  validateTiandituToken
}
