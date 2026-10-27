const { invariant } = require('../core/terra_globe_common')

// The only Web boundary between internal CBDAM texture nodes and source tiles.
// Resource rows stay north-first for sampling; requestTile applies service row
// orientation. A source tile is never used as an internal node identifier.
class ImageryAdapter {
  constructor(descriptor) {
    invariant(descriptor && ['global-geodetic', 'planar-tms', 'planar-single'].includes(descriptor.kind),
      'Unsupported imagery coordinate model')
    invariant(Number.isInteger(descriptor.maximum_level) && descriptor.maximum_level >= 0 &&
      descriptor.maximum_level <= 28 && descriptor.minimum_level === 0 &&
      Number.isInteger(descriptor.matrix_level_offset) && descriptor.matrix_level_offset >= 0 &&
      Number.isInteger(descriptor.tile_size) && descriptor.tile_size > 0,
    'Invalid imagery level or tile size')
    invariant(!descriptor.crs || descriptor.kind !== 'global-geodetic' ||
      ['EPSG:4326', 'EPSG:4490', 'CRS:84'].includes(descriptor.crs),
    'Global imagery requires a geodetic grid; reprojection belongs in a source adapter')
    this.source = descriptor
    this.global = descriptor.kind === 'global-geodetic'
    const columns = this.global ? 4 : 1, rows = this.global ? 2 : 1
    const shift = Math.log2(columns / descriptor.level_zero_columns)
    invariant(Number.isInteger(shift) && shift >= 0 &&
      rows / descriptor.level_zero_rows === Math.pow(2, shift),
    'Imagery grid must align with the CBDAM texture model')
    invariant(['top-left', 'bottom-left'].includes(descriptor.origin || 'top-left'),
      'Unsupported imagery row origin')
    const b = descriptor.bounds
    invariant(!this.global || b && b[0][0] === -180 && b[0][1] === -90 &&
      b[1][0] === 180 && b[1][1] === 90, 'Global imagery grid must cover the geodetic world')
    this.levelOffset = shift
    this.maximumDepth = Math.max(0, descriptor.maximum_level - shift)
    invariant(this.maximumDepth <= 27, 'Imagery level exceeds the internal model')
    this.tileSize = descriptor.tile_size / Math.pow(2, Math.max(0, shift - descriptor.maximum_level))
  }

  matrix(level) {
    const ids = this.source.matrix_ids
    return ids && level < ids.length ? ids[level] : level + this.source.matrix_level_offset
  }

  samplingTile(node) {
    invariant(node && Number.isInteger(node.level) && node.level >= 0 && node.level <= 27,
      'Invalid internal texture node')
    const scale = Math.pow(2, node.level)
    invariant(Number.isInteger(node.column) && Number.isInteger(node.row) && node.column >= 0 && node.column < (this.global ? 4 : 1) * scale &&
      node.row >= 0 && node.row < (this.global ? 2 : 1) * scale, 'Texture node is outside the model')
    const level = node.level + this.levelOffset
    return {level, matrix: level + this.source.matrix_level_offset, row: node.row, column: node.column}
  }

  bind(node, sourceLevel) {
    const sampling = this.samplingTile(node)
    const level = sourceLevel === undefined ? Math.min(sampling.level, this.source.maximum_level) : sourceLevel
    invariant(Number.isInteger(level) && level >= 0 && level <= sampling.level &&
      level <= this.source.maximum_level, 'Invalid imagery binding level')
    const scale = Math.pow(2, sampling.level - level)
    const row = Math.floor(sampling.row / scale), column = Math.floor(sampling.column / scale)
    return {node, resource: {level, matrix: level + this.source.matrix_level_offset, row, column},
      uvScale: 1 / scale, uvOffset: [(sampling.column % scale) / scale, (sampling.row % scale) / scale],
      sourceId: this.source.id, effectivePixels: this.source.tile_size / scale}
  }

  nodesForResource(tile) {
    const depth = tile.level - this.levelOffset
    if (depth >= 0) {
      const scale = Math.pow(2, depth)
      return [{level: depth, root: Math.floor(tile.row / scale) * (this.global ? 4 : 1) +
        Math.floor(tile.column / scale), row: tile.row, column: tile.column}]
    }
    const scale = Math.pow(2, -depth), result = []
    for (let row = tile.row * scale; row < (tile.row + 1) * scale; ++row) {
      for (let column = tile.column * scale; column < (tile.column + 1) * scale; ++column) {
        result.push({level: 0, root: row * (this.global ? 4 : 1) + column, row, column})
      }
    }
    return result
  }

  requestTile(tile) {
    return Object.assign({}, tile, {matrix: this.matrix(tile.level),
      row: this.source.origin === 'bottom-left'
        ? this.source.level_zero_rows * Math.pow(2, tile.level) - 1 - tile.row : tile.row})
  }

  prepareDraw(draw) {
    invariant(draw.textureNode, 'Mesh has no fixed CBDAM texture anchor')
    return Object.assign({}, draw, {texture: this.samplingTile(draw.textureNode)})
  }
}

function sourceOptions(options) {
  invariant(options && typeof options.id === 'string' && options.id &&
    typeof options.url === 'string', 'Imagery source id and URL are required')
  const texture = Object.assign({id: options.id, kind: 'global-geodetic',
    bounds: [[-180,-90],[180,90]], tile_size: 256, level_zero_columns: 2,
    level_zero_rows: 1, origin: 'top-left', minimum_level: 0,
    maximum_level: 17, matrix_level_offset: 0, url_template: options.url}, options.texture || {})
  texture.id = options.id
  new ImageryAdapter(texture)
  return {id: options.id, attribution: options.attribution || '', tileScheme: texture.kind,
    minimumLevel: texture.minimum_level, maximumLevel: texture.maximum_level,
    matrixLevelOffset: texture.matrix_level_offset, texture}
}

// resolveTile receives service coordinates from ImageryAdapter.requestTile.
function createTmsImagerySource(options) {
  const source = sourceOptions(options)
  source.resolveTile = tile => options.url.replace(/\{(z|x|y)\}/g,
    (_, key) => encodeURIComponent({z: tile.matrix, x: tile.column, y: tile.row}[key]))
  return source
}

function createWmtsImagerySource(options) {
  const source = sourceOptions(options)
  invariant(typeof options.layer === 'string' && typeof options.matrixSet === 'string',
    'WMTS layer and matrixSet are required')
  source.resolveTile = tile => {
    const parameters = Object.assign({}, options.parameters, {SERVICE:'WMTS', REQUEST:'GetTile',
      VERSION:'1.0.0', LAYER:options.layer, STYLE:options.style || 'default',
      FORMAT:options.format || 'image/jpeg', TILEMATRIXSET:options.matrixSet,
      TILEMATRIX:tile.matrix, TILECOL:tile.column, TILEROW:tile.row})
    return options.url + (options.url.includes('?') ? '&' : '?') + Object.keys(parameters)
      .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(parameters[key])).join('&')
  }
  return source
}

module.exports = {ImageryAdapter, createTmsImagerySource, createWmtsImagerySource}
