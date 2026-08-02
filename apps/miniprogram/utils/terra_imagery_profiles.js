const common = require('./terra_globe_common')

const PLANAR_1K_PROFILE = 'ps-1k'
const BLUE_MARBLE_PROFILE = 'blue-marble'
const TIANDITU_IMG_C_PROFILE = 'tianditu-img-c'
const TIANDITU_PROFILE_STORAGE_KEY = 'terra.imageryProfile'
const TIANDITU_TOKEN_STORAGE_KEY = 'terra.tiandituToken'
const BLUE_MARBLE_ATTRIBUTION = 'Imagery: NASA Blue Marble'
const TIANDITU_ATTRIBUTION = '\u00a9 \u5929\u5730\u56fe'

const PLANAR_1K_TEXTURE = {
  id: PLANAR_1K_PROFILE,
  kind: 'planar-tms',
  url_template: 'https://invalid.example/terra/v1/imagery/ps-1k/{z}/{x}/{y}.jpg',
  minimum_level: 0,
  maximum_level: 2,
  matrix_level_offset: 0,
  tile_size: 256,
  level_zero_columns: 1,
  level_zero_rows: 1,
  origin: 'top-left',
  bounds: [[0, 0], [1025, 1025]]
}

const BLUE_MARBLE_TEXTURE = {
  id: BLUE_MARBLE_PROFILE,
  kind: 'global-geodetic',
  url_template: 'https://invalid.example/terra/v1/imagery/blue-marble/{z}/{x}/{y}.jpg',
  minimum_level: 0,
  maximum_level: 7,
  matrix_level_offset: 0,
  tile_size: 256,
  level_zero_columns: 2,
  level_zero_rows: 1,
  origin: 'top-left',
  bounds: [[-180, -90], [180, 90]]
}

const TIANDITU_TEXTURE = {
  id: TIANDITU_IMG_C_PROFILE,
  kind: 'global-geodetic',
  url_template: 'https://t{s}.tianditu.gov.cn/img_c/wmts',
  minimum_level: 0,
  matrix_level_offset: 1,
  maximum_level: 17,
  tile_size: 256,
  level_zero_columns: 2,
  level_zero_rows: 1,
  origin: 'top-left',
  bounds: [[-180, -90], [180, 90]]
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

function validateImageryOrigin(origin) {
  const secure = typeof origin === 'string' &&
    /^https:\/\/[^/?#]+(?::[0-9]+)?(?:\/[^?#]*)?$/.test(origin)
  const loopbackMatch = typeof origin === 'string'
    ? /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?(?:\/[^?#]*)?$/.exec(
      origin)
    : null
  const loopback = Boolean(loopbackMatch &&
    (!loopbackMatch[1] || Number(loopbackMatch[1]) <= 65535))
  common.invariant(secure || loopback,
  'Imagery service origin must use HTTPS or loopback HTTP')
  return origin.replace(/\/+$/, '')
}

function validateStaticTile(tile, texture) {
  common.invariant(tile && typeof tile === 'object',
    'Imagery tile is required')
  const level = tile.level
  const matrix = tile.matrix
  const row = tile.row
  const column = tile.column
  common.invariant(Number.isInteger(level) && level >= 0 &&
    level <= texture.maximum_level, 'Imagery tile level is invalid')
  common.invariant(Number.isInteger(matrix) &&
    matrix === level + texture.matrix_level_offset,
  'Imagery tile matrix is invalid')
  const scale = Math.pow(2, level)
  const rows = texture.level_zero_rows * scale
  const columns = texture.level_zero_columns * scale
  common.invariant(Number.isInteger(row) && row >= 0 && row < rows,
    'Imagery tile row is invalid')
  common.invariant(Number.isInteger(column) && column >= 0 && column < columns,
    'Imagery tile column is invalid')
  return { level, matrix, row, column }
}

function staticImageryUrlForTile(profile, tile, origin) {
  const texture = profile === PLANAR_1K_PROFILE
    ? PLANAR_1K_TEXTURE : BLUE_MARBLE_TEXTURE
  const value = validateStaticTile(tile, texture)
  return validateImageryOrigin(origin) + '/terra/v1/imagery/' + profile + '/' +
    value.level + '/' + value.column + '/' + value.row + '.jpg'
}

function tiandituProxyUrlForTile(tile, proxyOrigin) {
  const value = validateTiandituTile(tile)
  const origin = validateImageryOrigin(proxyOrigin)
  return origin + '/terra/v1/imagery/tianditu/img-c/' +
    value.level + '/' + value.column + '/' + value.row + '.jpg'
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

function resolvePlanarImageryProfile(imageryOrigin) {
  const origin = validateImageryOrigin(imageryOrigin)
  const tileResolver = (tile) => staticImageryUrlForTile(
    PLANAR_1K_PROFILE, tile, origin)
  return {
    id: PLANAR_1K_PROFILE,
    textureId: PLANAR_1K_PROFILE,
    tileScheme: 'planar-tms',
    minimumLevel: 0,
    maximumLevel: 2,
    matrixLevelOffset: 0,
    attribution: '',
    texture: Object.assign({}, PLANAR_1K_TEXTURE),
    resolveTile: tileResolver,
    urlForTile: tileResolver
  }
}

function resolveImageryProfile(
  profileName, credential, fallbackTextureId, proxyOrigin) {
  const name = profileName || BLUE_MARBLE_PROFILE
  if (name === BLUE_MARBLE_PROFILE) {
    const textureId = fallbackTextureId || BLUE_MARBLE_PROFILE
    common.invariant(typeof textureId === 'string' && textureId.length > 0,
      'Blue Marble texture ID is required')
    if (proxyOrigin) {
      const origin = validateImageryOrigin(proxyOrigin)
      const tileResolver = (tile) => staticImageryUrlForTile(
        BLUE_MARBLE_PROFILE, tile, origin)
      return {
        id: BLUE_MARBLE_PROFILE,
        textureId: BLUE_MARBLE_PROFILE,
        tileScheme: 'global-geodetic',
        minimumLevel: 0,
        maximumLevel: 7,
        matrixLevelOffset: 0,
        attribution: BLUE_MARBLE_ATTRIBUTION,
        texture: Object.assign({}, BLUE_MARBLE_TEXTURE),
        resolveTile: tileResolver,
        urlForTile: tileResolver
      }
    }
    return {
      id: BLUE_MARBLE_PROFILE,
      textureId,
      attribution: BLUE_MARBLE_ATTRIBUTION,
      texture: null,
      urlForTile: null
    }
  }
  if (name === TIANDITU_IMG_C_PROFILE) {
    let tileResolver
    if (proxyOrigin) {
      const origin = validateImageryOrigin(proxyOrigin)
      tileResolver = (tile) => tiandituProxyUrlForTile(tile, origin)
    } else {
      const token = validateTiandituToken(credential)
      tileResolver = (tile) => tiandituUrlForTile(tile, token)
    }
    return {
      id: TIANDITU_IMG_C_PROFILE,
      textureId: TIANDITU_IMG_C_PROFILE,
      tileScheme: 'global-geodetic',
      minimumLevel: 0,
      maximumLevel: 17,
      matrixLevelOffset: 1,
      attribution: TIANDITU_ATTRIBUTION,
      texture: Object.assign({}, TIANDITU_TEXTURE),
      resolveTile: tileResolver,
      urlForTile: tileResolver
    }
  }
  throw new Error('Unsupported imagery profile')
}

module.exports = {
  BLUE_MARBLE_ATTRIBUTION,
  BLUE_MARBLE_TEXTURE,
  BLUE_MARBLE_PROFILE,
  PLANAR_1K_PROFILE,
  PLANAR_1K_TEXTURE,
  TIANDITU_ATTRIBUTION,
  TIANDITU_IMG_C_PROFILE,
  TIANDITU_PROFILE_STORAGE_KEY,
  TIANDITU_TEXTURE,
  TIANDITU_TOKEN_STORAGE_KEY,
  resolveImageryProfile,
  resolvePlanarImageryProfile,
  staticImageryUrlForTile,
  tiandituProxyUrlForTile,
  tiandituUrlForTile,
  validateImageryOrigin,
  validateStaticTile,
  validateTiandituTile,
  validateTiandituToken
}
