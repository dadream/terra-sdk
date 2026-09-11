const common = require('./terra_globe_common')
const surfacePlan = require('./terra_surface_plan')

const DRAW_FLAG_COVERAGE = 1

const VERTEX_SHADER = [
  'attribute vec3 a_position;',
  'attribute vec2 a_uv;',
  'uniform mat4 u_projection_view;',
  'uniform vec3 u_origin;',
  'uniform float u_height_origin;',
  'uniform vec2 u_cell_uv_scale;',
  'uniform vec2 u_cell_uv_offset;',
  'uniform vec2 u_uv_scale;',
  'uniform vec2 u_uv_offset;',
  'uniform float u_clip_cell;',
  'uniform float u_debug_mode;',
  'uniform float u_texture_state;',
  'uniform float u_fog_density;',
  'varying mediump vec2 v_cell_uv;',
  'varying mediump vec2 v_uv;',
  'varying mediump float v_height;',
  'varying mediump float v_fog_visibility;',
  'void main() {',
  '  vec3 relativePosition = a_position + u_origin;',
  '  gl_Position = u_projection_view * vec4(relativePosition, 1.0);',
  '  v_cell_uv = a_uv * u_cell_uv_scale + u_cell_uv_offset;',
  '  v_uv = v_cell_uv * u_uv_scale + u_uv_offset;',
  '  v_height = a_position.z + u_height_origin;',
  '  v_fog_visibility = exp(-u_fog_density * length(relativePosition));',
  '}'
].join('\n')

const FRAGMENT_SHADER = [
  'precision mediump float;',
  'uniform sampler2D u_texture;',
  'uniform float u_render_mode;',
  'uniform vec2 u_height_range;',
  'uniform float u_clip_cell;',
  'uniform float u_debug_mode;',
  'uniform float u_texture_state;',
  'uniform vec3 u_fog_color;',
  'varying mediump vec2 v_cell_uv;',
  'varying mediump vec2 v_uv;',
  'varying mediump float v_height;',
  'varying mediump float v_fog_visibility;',
  'void main() {',
  '  if (u_render_mode > 0.5) {',
  '    float value = clamp((v_height - u_height_range.x) /',
  '      max(0.001, u_height_range.y - u_height_range.x), 0.0, 1.0);',
  '    vec3 low = vec3(0.08, 0.28, 0.42);',
  '    vec3 middle = vec3(0.35, 0.62, 0.30);',
  '    vec3 high = vec3(0.94, 0.91, 0.78);',
  '    gl_FragColor = vec4(value < 0.5 ? mix(low, middle, value * 2.0) :',
  '      mix(middle, high, (value - 0.5) * 2.0), 1.0);',
  '  } else {',
  '    if (u_clip_cell > 0.5 && (v_cell_uv.x < -0.0001 ||',
  '      v_cell_uv.x > 1.0001 || v_cell_uv.y < -0.0001 ||',
  '      v_cell_uv.y > 1.0001)) discard;',
  '    vec4 color = texture2D(u_texture, v_uv);',
  '    if (u_debug_mode > 0.5) {',
  '      float edge = min(min(v_cell_uv.x, 1.0 - v_cell_uv.x),',
  '        min(v_cell_uv.y, 1.0 - v_cell_uv.y));',
  '      vec3 stateColor = u_texture_state < 0.5 ? vec3(0.1, 0.9, 0.4) :',
  '        (u_texture_state < 1.5 ? vec3(1.0, 0.65, 0.1) : vec3(1.0, 0.2, 0.2));',
  '      color.rgb = mix(color.rgb, stateColor, edge < 0.008 ? 0.85 : 0.12);',
  '    }',
  '    gl_FragColor = color;',
  '  }',
  '  gl_FragColor.rgb = mix(u_fog_color, gl_FragColor.rgb,',
  '    clamp(v_fog_visibility, 0.0, 1.0));',
  '}'
].join('\n')

const ATMOSPHERE_VERTEX_SHADER = [
  'attribute vec2 a_clip_position;',
  'varying highp vec2 v_clip_position;',
  'void main() {',
  '  v_clip_position = a_clip_position;',
  '  gl_Position = vec4(a_clip_position, 1.0, 1.0);',
  '}'
].join('\n')

const ATMOSPHERE_FRAGMENT_SHADER = [
  'precision highp float;',
  'uniform mat4 u_inverse_projection_view;',
  'uniform vec3 u_camera_scaled;',
  'uniform vec3 u_east;',
  'uniform vec3 u_north;',
  'uniform vec3 u_up;',
  'uniform vec3 u_sun_direction;',
  'uniform float u_sun_visible;',
  'uniform sampler2D u_sky_texture;',
  'varying highp vec2 v_clip_position;',
  'void main() {',
  '  vec4 nearPoint = u_inverse_projection_view *',
  '    vec4(v_clip_position, -1.0, 1.0);',
  '  vec4 farPoint = u_inverse_projection_view *',
  '    vec4(v_clip_position, 1.0, 1.0);',
  '  vec3 nearWorld = nearPoint.xyz / nearPoint.w;',
  '  vec3 farWorld = farPoint.xyz / farPoint.w;',
  '  vec3 ray = normalize(farWorld - nearWorld);',
  '  vec3 localRay = vec3(dot(ray, u_east), dot(ray, u_north),',
  '    dot(ray, u_up));',
  '  float azimuth = fract(atan(localRay.x, localRay.y) /',
  '    6.28318530718 + 1.0);',
  '  float zenith = clamp(acos(clamp(localRay.z, -1.0, 1.0)) /',
  '    1.57079632679, 0.0, 1.0);',
  '  vec3 sky = texture2D(u_sky_texture, vec2(azimuth, zenith)).rgb;',
  '  float cameraRadius = length(u_camera_scaled);',
  '  float shellRadius = 1.025;',
  '  float rayOffset = dot(u_camera_scaled, ray);',
  '  float closestRadius = sqrt(max(0.0, dot(u_camera_scaled,',
  '    u_camera_scaled) - rayOffset * rayOffset));',
  '  float discriminant = rayOffset * rayOffset -',
  '    (dot(u_camera_scaled, u_camera_scaled) - shellRadius * shellRadius);',
  '  float exitDistance = -rayOffset + sqrt(max(0.0, discriminant));',
  '  float intersects = step(0.0, discriminant) * step(0.0, exitDistance);',
  '  float limb = pow(clamp((shellRadius - closestRadius) /',
  '    (shellRadius - 1.0), 0.0, 1.0), 0.35);',
  '  float atmosphere = cameraRadius <= shellRadius ? 1.0 : intersects * limb;',
  '  vec3 color = mix(vec3(0.003, 0.007, 0.016), sky, atmosphere);',
  '  float sunAngle = dot(localRay, normalize(u_sun_direction));',
  '  float sunHalo = smoothstep(0.9903, 0.9992, sunAngle) *',
  '    u_sun_visible;',
  '  float sunDisc = smoothstep(0.9992, 0.9999, sunAngle) *',
  '    u_sun_visible;',
  '  color += vec3(1.0, 0.58, 0.18) * sunHalo * 0.28;',
  '  color = mix(color, vec3(1.0, 0.94, 0.72), sunDisc);',
  '  gl_FragColor = vec4(color, 1.0);',
  '}'
].join('\n')

const OVERLAY_VERTEX_SHADER = [
  'attribute vec3 a_position;',
  'uniform mat4 u_projection_view;',
  'uniform float u_point_size;',
  'void main() {',
  '  gl_Position = u_projection_view * vec4(a_position, 1.0);',
  '  gl_PointSize = u_point_size;',
  '}'
].join('\n')

const OVERLAY_FRAGMENT_SHADER = [
  'precision mediump float;',
  'uniform vec4 u_color;',
  'void main() { gl_FragColor = u_color; }'
].join('\n')

function createShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'WebGL shader compilation failed'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function createProgram(gl) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  const program = gl.createProgram()
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'WebGL program link failed'
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

function createOverlayProgram(gl) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, OVERLAY_VERTEX_SHADER)
  const fragment = createShader(gl, gl.FRAGMENT_SHADER,
    OVERLAY_FRAGMENT_SHADER)
  const program = gl.createProgram()
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ||
      'WebGL overlay program link failed'
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

function createAtmosphereProgram(gl) {
  const vertex = createShader(gl, gl.VERTEX_SHADER,
    ATMOSPHERE_VERTEX_SHADER)
  const fragment = createShader(gl, gl.FRAGMENT_SHADER,
    ATMOSPHERE_FRAGMENT_SHADER)
  const program = gl.createProgram()
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ||
      'WebGL atmosphere program link failed'
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

function colorComponents(value, opacity) {
  const match = /^#([0-9a-f]{6})$/i.exec(value || '')
  const color = match ? parseInt(match[1], 16) : 0x2f7de1
  return [
    ((color >> 16) & 255) / 255,
    ((color >> 8) & 255) / 255,
    (color & 255) / 255,
    opacity === undefined ? 1 : common.clamp(opacity, 0, 1)
  ]
}

function invertMatrix4(value) {
  const rows = []
  for (let row = 0; row < 4; ++row) {
    rows[row] = []
    for (let column = 0; column < 4; ++column) {
      rows[row][column] = value[column * 4 + row]
    }
    for (let column = 0; column < 4; ++column) {
      rows[row][column + 4] = row === column ? 1 : 0
    }
  }
  for (let column = 0; column < 4; ++column) {
    let pivot = column
    for (let row = column + 1; row < 4; ++row) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) {
        pivot = row
      }
    }
    common.invariant(Math.abs(rows[pivot][column]) > 1e-12,
      'Projection-view matrix is singular')
    const swap = rows[column]
    rows[column] = rows[pivot]
    rows[pivot] = swap
    const scale = rows[column][column]
    for (let index = 0; index < 8; ++index) {
      rows[column][index] /= scale
    }
    for (let row = 0; row < 4; ++row) {
      if (row === column) continue
      const factor = rows[row][column]
      for (let index = 0; index < 8; ++index) {
        rows[row][index] -= factor * rows[column][index]
      }
    }
  }
  const result = new Float32Array(16)
  for (let row = 0; row < 4; ++row) {
    for (let column = 0; column < 4; ++column) {
      result[column * 4 + row] = rows[row][column + 4]
    }
  }
  return result
}

function normalized(value) {
  const length = Math.hypot(value[0], value[1], value[2]) || 1
  return value.map((component) => component / length)
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ]
}

function monotonicNow() {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function' ? performance.now() : Date.now()
}

function recordTiming(target, elapsedMs) {
  target.count += 1
  target.lastMs = elapsedMs
  target.averageMs += (elapsedMs - target.averageMs) / target.count
}

function defaultAtmosphere() {
  return {
    width: 2,
    height: 2,
    sunVisible: true,
    fogEnabled: false,
    fogDensityMultiplier: 1,
    sunDirection: normalized([0.41, -0.41, 0.82]),
    ambientColor: [0.35, 0.55, 0.8],
    diffuseColor: [1, 0.92, 0.72],
    fogColor: [0.62, 0.72, 0.82],
    seaLevelFogDensity: 0.00002,
    rgba: new Uint8Array([
      42, 92, 168, 255, 46, 98, 176, 255,
      156, 184, 211, 255, 170, 193, 218, 255
    ])
  }
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0
}

function geometryKey(draw) {
  // Submitted terrain records are immutable within a runtime, so the CBDAM
  // patch and fragment identity is also the stable GPU mesh identity.
  return `${common.patchKeyString('geometry', draw.key)}:${draw.fragment}`
}

function parentTextureTile(tile) {
  if (!tile || tile.level <= 0 || tile.matrix <= 0) {
    return null
  }
  return {
    level: tile.level - 1,
    matrix: tile.matrix - 1,
    row: Math.floor(tile.row / 2),
    column: Math.floor(tile.column / 2)
  }
}

function ancestorTextureTiles(tile) {
  const result = []
  let current = parentTextureTile(tile)
  while (current) {
    result.push(current)
    current = parentTextureTile(current)
  }
  return result
}

function texturePathFromRoot(tile) {
  return ancestorTextureTiles(tile).reverse().concat([tile])
}

function globalCoverageTextureTiles(texture, maximumCoverageLevel) {
  if (!texture || texture.kind !== 'global-geodetic') {
    return []
  }

  const matrixOffset = texture.matrix_level_offset
  const levelZeroColumns = texture.level_zero_columns
  const levelZeroRows = texture.level_zero_rows
  const maximumLevel = Math.min(texture.maximum_level,
    maximumCoverageLevel === undefined ? 1 : maximumCoverageLevel)
  if (!Number.isInteger(matrixOffset) || matrixOffset < 0 ||
    !Number.isInteger(levelZeroColumns) || levelZeroColumns <= 0 ||
    !Number.isInteger(levelZeroRows) || levelZeroRows <= 0 ||
    !Number.isInteger(maximumLevel) || maximumLevel < 0) {
    return []
  }
  const result = []
  for (let level = 0; level <= maximumLevel; ++level) {
    const scale = Math.pow(2, level)
    for (let row = 0; row < levelZeroRows * scale; ++row) {
      for (let column = 0; column < levelZeroColumns * scale; ++column) {
        result.push({ level, matrix: level + matrixOffset, row, column })
      }
    }
  }
  return result
}

function descendantTextureTile(tile, levelDelta, row, column) {
  const scale = Math.pow(2, levelDelta)
  return {
    level: tile.level + levelDelta,
    matrix: tile.matrix + levelDelta,
    row: tile.row * scale + row,
    column: tile.column * scale + column
  }
}

function textureTileAtDelta(tile, levelDelta, row, column) {
  if (levelDelta >= 0) {
    return descendantTextureTile(tile, levelDelta, row || 0, column || 0)
  }
  const amount = Math.min(tile.level, -levelDelta)
  const divisor = Math.pow(2, amount)
  return {
    level: tile.level - amount,
    matrix: tile.matrix - amount,
    row: Math.floor(tile.row / divisor),
    column: Math.floor(tile.column / divisor)
  }
}

function textureCellTransform(source, target) {
  const delta = target.level - source.level
  if (delta >= 0) {
    const scale = Math.pow(2, delta)
    return {
      scale,
      offsetX: source.column * scale - target.column,
      offsetY: source.row * scale - target.row
    }
  }
  return ancestorUvTransform(source, target)
}

function textureByteSize(width, height) {
  let mipWidth = Math.max(1, Number(width) || 1)
  let mipHeight = Math.max(1, Number(height) || 1)
  if (!isPowerOfTwo(mipWidth) || !isPowerOfTwo(mipHeight)) {
    return mipWidth * mipHeight * 4
  }
  let pixels = 0
  while (true) {
    pixels += mipWidth * mipHeight
    if (mipWidth === 1 && mipHeight === 1) break
    mipWidth = Math.max(1, Math.floor(mipWidth / 2))
    mipHeight = Math.max(1, Math.floor(mipHeight / 2))
  }
  return pixels * 4
}

function drawUvBounds(draw, textureUv) {
  let minimumU = Number.POSITIVE_INFINITY
  let maximumU = Number.NEGATIVE_INFINITY
  let minimumV = Number.POSITIVE_INFINITY
  let maximumV = Number.NEGATIVE_INFINITY
  for (let vertex = 0; vertex < draw.vertexCount; ++vertex) {
    const offset = (draw.firstVertex + vertex) * 2
    minimumU = Math.min(minimumU, textureUv[offset])
    maximumU = Math.max(maximumU, textureUv[offset])
    minimumV = Math.min(minimumV, textureUv[offset + 1])
    maximumV = Math.max(maximumV, textureUv[offset + 1])
  }
  return {
    minimumU: common.clamp(minimumU, 0, 1),
    maximumU: common.clamp(maximumU, 0, 1),
    minimumV: common.clamp(minimumV, 0, 1),
    maximumV: common.clamp(maximumV, 0, 1)
  }
}

function projectedDrawDimensions(frame, draw, positions, viewport) {
  if (!frame || !frame.projectionView || !frame.cameraPosition ||
    !positions || !viewport) {
    return { width: 0, height: 0, unclippedWidth: 0, unclippedHeight: 0,
      centerDistance: Number.POSITIVE_INFINITY }
  }
  const matrix = frame.projectionView
  let minimumX = Number.POSITIVE_INFINITY
  let maximumX = Number.NEGATIVE_INFINITY
  let minimumY = Number.POSITIVE_INFINITY
  let maximumY = Number.NEGATIVE_INFINITY
  let projected = 0
  for (let vertex = 0; vertex < draw.vertexCount; ++vertex) {
    const offset = (draw.firstVertex + vertex) * 3
    const x = positions[offset] + draw.origin[0]
    const y = positions[offset + 1] + draw.origin[1]
    const z = positions[offset + 2] + draw.origin[2]
    const clipX = matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3]
    const clipY = matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7]
    const clipW = matrix[12] * x + matrix[13] * y + matrix[14] * z + matrix[15]
    if (!Number.isFinite(clipW) || clipW <= 0.000001) continue
    const nx = clipX / clipW
    const ny = clipY / clipW
    minimumX = Math.min(minimumX, nx)
    maximumX = Math.max(maximumX, nx)
    minimumY = Math.min(minimumY, ny)
    maximumY = Math.max(maximumY, ny)
    projected += 1
  }
  if (!projected || maximumX < -1 || minimumX > 1 || maximumY < -1 ||
    minimumY > 1) {
    return { width: 0, height: 0, unclippedWidth: 0, unclippedHeight: 0,
      centerDistance: Number.POSITIVE_INFINITY }
  }
  const dpr = Math.max(1, viewport.devicePixelRatio || 1)
  const width = Math.max(1, viewport.width || 1) / dpr
  const height = Math.max(1, viewport.height || 1) / dpr
  const clippedMinimumX = Math.max(-1, minimumX)
  const clippedMaximumX = Math.min(1, maximumX)
  const clippedMinimumY = Math.max(-1, minimumY)
  const clippedMaximumY = Math.min(1, maximumY)
  const centerX = (clippedMinimumX + clippedMaximumX) * 0.5
  const centerY = (clippedMinimumY + clippedMaximumY) * 0.5
  return {
    width: (clippedMaximumX - clippedMinimumX) * width * 0.5,
    height: (clippedMaximumY - clippedMinimumY) * height * 0.5,
    unclippedWidth: (maximumX - minimumX) * width * 0.5,
    unclippedHeight: (maximumY - minimumY) * height * 0.5,
    centerDistance: Math.sqrt(centerX * centerX + centerY * centerY)
  }
}

function projectedDrawExtent(frame, draw, positions, viewport) {
  const dimensions = projectedDrawDimensions(frame, draw, positions, viewport)
  return Math.max(dimensions.width, dimensions.height)
}

function childBounds(candidate, levelDelta) {
  const scale = Math.pow(2, levelDelta)
  const epsilon = 0.000000001
  return {
    minimumColumn: common.clamp(Math.floor(candidate.uv.minimumU * scale),
      0, scale - 1),
    maximumColumn: common.clamp(Math.floor(
      candidate.uv.maximumU * scale - epsilon), 0, scale - 1),
    minimumRow: common.clamp(Math.floor(candidate.uv.minimumV * scale),
      0, scale - 1),
    maximumRow: common.clamp(Math.floor(
      candidate.uv.maximumV * scale - epsilon), 0, scale - 1)
  }
}

function childCount(candidate, levelDelta) {
  if (levelDelta < 0) return 1
  const bounds = childBounds(candidate, levelDelta)
  return (bounds.maximumColumn - bounds.minimumColumn + 1) *
    (bounds.maximumRow - bounds.minimumRow + 1)
}

function candidateTextureTiles(candidate, allocation) {
  if (!candidate.tileCache) candidate.tileCache = new Map()
  if (candidate.tileCache.has(allocation)) return candidate.tileCache.get(allocation)
  if (allocation < 0) {
    return [textureTileAtDelta(candidate.draw.texture, allocation)]
  }
  const bounds = childBounds(candidate, allocation)
  const result = []
  for (let row = bounds.minimumRow; row <= bounds.maximumRow; ++row) {
    for (let column = bounds.minimumColumn;
      column <= bounds.maximumColumn; ++column) {
      const scale = Math.pow(2, allocation)
      if (candidate.model && !surfacePlan.intersectsCell(candidate.model.hull,
        column / scale, row / scale, (column + 1) / scale, (row + 1) / scale)) continue
      result.push(descendantTextureTile(candidate.draw.texture, allocation, row, column))
    }
  }
  candidate.tileCache.set(allocation, result)
  return result
}

function replaceTextureRefs(refs, previous, next) {
  previous.forEach((tile) => {
    const key = common.textureKeyString(tile)
    const count = refs.get(key) || 0
    if (count <= 1) refs.delete(key)
    else refs.set(key, count - 1)
  })
  next.forEach((tile) => {
    const key = common.textureKeyString(tile)
    refs.set(key, (refs.get(key) || 0) + 1)
  })
}

function replacementTextureCount(refs, previous, next) {
  const deltas = new Map()
  previous.forEach((tile) => {
    const key = common.textureKeyString(tile)
    deltas.set(key, (deltas.get(key) || 0) - 1)
  })
  next.forEach((tile) => {
    const key = common.textureKeyString(tile)
    deltas.set(key, (deltas.get(key) || 0) + 1)
  })
  let count = refs.size
  deltas.forEach((delta, key) => {
    const before = refs.get(key) || 0
    const after = before + delta
    if (before > 0 && after <= 0) count -= 1
    if (before <= 0 && after > 0) count += 1
  })
  return count
}

function candidatePriority(candidate) {
  const error = candidate.pixelError / Math.pow(2, candidate.allocated)
  const distance = Number.isFinite(candidate.centerDistance)
    ? candidate.centerDistance : 4
  return error / (1 + distance * 0.5)
}

function textureTileContains(ancestor, descendant) {
  if (!ancestor || !descendant || ancestor.level > descendant.level) {
    return false
  }
  const delta = descendant.level - ancestor.level
  const scale = Math.pow(2, delta)
  return Math.floor(descendant.row / scale) === ancestor.row &&
    Math.floor(descendant.column / scale) === ancestor.column
}

function maximumTerrainTextureLevel(draw, draws) {
  let result = draw.texture.level
  const candidates = draws || []
  candidates.forEach((candidate) => {
    if (!candidate.key || !candidate.texture ||
      !textureTileContains(draw.texture, candidate.texture)) {
      return
    }
    const geometryLevel = Math.max(0, Number(candidate.key.level) || 0)
    result = Math.max(result, Math.floor(geometryLevel / 2))
  })
  return result
}

function terrainTextureLevelIndex(draws) {
  const result = new Map()
  ;(draws || []).forEach((draw) => {
    if (!draw.key || !draw.texture) return
    const geometryLevel = Math.max(0, Number(draw.key.level) || 0)
    let tile = draw.texture
    while (tile) {
      const key = common.textureKeyString(tile)
      result.set(key, Math.max(result.get(key) || tile.level,
        Math.floor(geometryLevel / 2)))
      tile = parentTextureTile(tile)
    }
  })
  return result
}

function refineImageryDraws(frame, draws, positions, textureUv, viewport,
  descriptor, options) {
  const value = options || {}
  const targetPixelError = value.targetPixelError || 1.25
  const maximumSubdivisionLevels = Number.isInteger(
    value.maximumSubdivisionLevels) ? value.maximumSubdivisionLevels : 6
  const additionalDraws = Number.isInteger(value.maximumDraws)
    ? Math.max(0, value.maximumDraws) : 512
  const maximumDraws = draws.length + additionalDraws
  const maximumTextures = Number.isInteger(value.maximumTextures)
    ? Math.max(1, value.maximumTextures) : Number.MAX_SAFE_INTEGER
  const tileSize = Number(descriptor && descriptor.tile_size) || 256
  const maximumLevel = Number.isInteger(descriptor && descriptor.maximum_level)
    ? descriptor.maximum_level : 0
  const terrainLevels = value.terrainBound
    ? terrainTextureLevelIndex(draws) : null
  const candidates = draws.map((draw, index) => {
    const measurement = value.measureDraw ? value.measureDraw(draw) : null
    const dimensions = measurement ? null : projectedDrawDimensions(frame, draw, positions, viewport)
    const uv = measurement && measurement.bounds || drawUvBounds(draw, textureUv)
    const uvWidth = Math.max(1 / tileSize, uv.maximumU - uv.minimumU)
    const uvHeight = Math.max(1 / tileSize, uv.maximumV - uv.minimumV)
    const pixelError = measurement ? measurement.pixelsPerUv / tileSize : Math.max(
      dimensions.unclippedWidth / (tileSize * uvWidth),
      dimensions.unclippedHeight / (tileSize * uvHeight))
    const available = Math.max(0, maximumLevel - draw.texture.level)
    const minimumAllocation = -draw.texture.level
    const terrainAvailable = value.terrainBound
      ? Math.max(0, Math.max(draw.texture.level,
        terrainLevels.get(common.textureKeyString(draw.texture)) || 0) -
        draw.texture.level)
      : available
    const maximumAllocation = Math.min(maximumSubdivisionLevels, available,
      terrainAvailable)
    const required = pixelError > 0
      ? Math.ceil(Math.log(pixelError / targetPixelError) / Math.log(2))
      : minimumAllocation
    let desired = common.clamp(required, minimumAllocation, maximumAllocation)
    const previous = value.previousLevels && value.previousLevels.get(geometryKey(draw))
    const previousDelta = previous === undefined ? minimumAllocation : previous - draw.texture.level
    // Coarsening has a separate threshold; actual quality is never relaxed.
    if (previousDelta > desired && pixelError > 0) {
      desired = Math.min(previousDelta, maximumAllocation, Math.max(desired,
        Math.ceil(Math.log(pixelError / (targetPixelError * 0.7)) / Math.LN2)))
    }
    const allocated = common.clamp(previous === undefined ? Math.min(0, desired)
      : previousDelta, minimumAllocation, desired)
    const candidate = {
      draw,
      index,
      uv,
      model: measurement && measurement.model,
      pixelError,
      centerDistance: measurement ? measurement.centerDistance : dimensions.centerDistance,
      required,
      desired,
      allocated
    }
    candidate.tiles = candidateTextureTiles(candidate, allocated)
    return candidate
  })
  const textureRefs = new Map()
  candidates.forEach((candidate) =>
    replaceTextureRefs(textureRefs, [], candidate.tiles))
  let drawCost = candidates.reduce((sum, candidate) =>
    sum + candidate.tiles.length, 0)

  while (textureRefs.size > maximumTextures || drawCost > maximumDraws) {
    let selected = null
    candidates.forEach((candidate) => {
      if (candidate.allocated <= -candidate.draw.texture.level) return
      const allocation = candidate.allocated - 1
      const tiles = candidateTextureTiles(candidate, allocation)
      const textureCount = replacementTextureCount(textureRefs,
        candidate.tiles, tiles)
      const priority = candidatePriority(candidate)
      const reduction = textureRefs.size - textureCount
      if (!selected || priority < selected.priority ||
        (priority === selected.priority && reduction > selected.reduction) ||
        (priority === selected.priority && reduction === selected.reduction &&
          candidate.index > selected.candidate.index)) {
        selected = { candidate, allocation, tiles, textureCount,
          priority, reduction }
      }
    })
    if (!selected) break
    drawCost += selected.tiles.length - selected.candidate.tiles.length
    replaceTextureRefs(textureRefs, selected.candidate.tiles, selected.tiles)
    selected.candidate.allocated = selected.allocation
    selected.candidate.tiles = selected.tiles
  }

  while (drawCost < maximumDraws) {
    let selected = null
    candidates.forEach((candidate) => {
      if (candidate.allocated >= candidate.desired) return
      const allocation = candidate.allocated + 1
      const tiles = candidateTextureTiles(candidate, allocation)
      const textureCount = replacementTextureCount(textureRefs,
        candidate.tiles, tiles)
      const nextDrawCost = drawCost + tiles.length - candidate.tiles.length
      if (textureCount > maximumTextures || nextDrawCost > maximumDraws) return
      const priority = candidatePriority(candidate)
      if (!selected || priority > selected.priority ||
        (priority === selected.priority &&
          candidate.centerDistance < selected.candidate.centerDistance) ||
        (priority === selected.priority &&
          candidate.centerDistance === selected.candidate.centerDistance &&
          candidate.index < selected.candidate.index)) {
        selected = { candidate, allocation, tiles, textureCount,
          nextDrawCost, priority }
      }
    })
    if (!selected) break
    replaceTextureRefs(textureRefs, selected.candidate.tiles, selected.tiles)
    selected.candidate.allocated = selected.allocation
    selected.candidate.tiles = selected.tiles
    drawCost = selected.nextDrawCost
  }

  const idealTextures = new Set()
  const desiredCountBound = candidates.reduce((sum, candidate) =>
    sum + childCount(candidate, candidate.desired), 0)
  const countIsUpperBound = desiredCountBound > Math.max(4096, Math.min(16384, maximumTextures * 4))
  if (!countIsUpperBound) candidates.forEach((candidate) => {
    candidateTextureTiles(candidate, candidate.desired).forEach((tile) =>
      idealTextures.add(common.textureKeyString(tile)))
  })
  const textureBudgetLimited = candidates.some(candidate => candidate.allocated < candidate.desired &&
    replacementTextureCount(textureRefs, candidate.tiles,
      candidateTextureTiles(candidate, candidate.allocated + 1)) > maximumTextures)
  const result = []
  const coverageDraws = []
  let maximumMeasuredError = 0
  let limitedByBudget = false
  let coarsenedDrawCount = 0
  let minimumSelectedLevel = Number.POSITIVE_INFINITY
  let maximumSelectedLevel = Number.NEGATIVE_INFINITY
  candidates.forEach((candidate) => {
    const measuredError = candidate.pixelError /
      Math.pow(2, candidate.allocated)
    maximumMeasuredError = Math.max(maximumMeasuredError, measuredError)
    limitedByBudget = limitedByBudget || candidate.allocated < candidate.desired
    if (candidate.allocated < 0) coarsenedDrawCount += 1
    if (candidate.allocated > 0) {
      const coverageTile = textureTileAtDelta(candidate.draw.texture,
        -candidate.draw.texture.level)
      const coverageTransform = textureCellTransform(candidate.draw.texture,
        coverageTile)
      coverageDraws.push(Object.assign({}, candidate.draw, {
        texture: coverageTile,
        imageryCellScale: coverageTransform.scale,
        imageryCellOffsetX: coverageTransform.offsetX,
        imageryCellOffsetY: coverageTransform.offsetY,
        imageryClipCell: false,
        imageryCoverageDraw: true,
        imageryPixelError: measuredError,
        imageryPriority: 1000000,
        imageryDesiredLevel: candidate.draw.texture.level + candidate.desired
      }))
    }
    candidate.tiles.forEach((tile) => {
      const transform = textureCellTransform(candidate.draw.texture, tile)
      minimumSelectedLevel = Math.min(minimumSelectedLevel, tile.level)
      maximumSelectedLevel = Math.max(maximumSelectedLevel, tile.level)
      result.push(Object.assign({}, candidate.draw, {
        texture: tile,
        sourceTexture: candidate.draw.texture,
        imageryCellScale: transform.scale,
        imageryCellOffsetX: transform.offsetX,
        imageryCellOffsetY: transform.offsetY,
        imageryClipCell: candidate.allocated > 0,
        imageryCoverageDraw: false,
        imageryPixelError: measuredError,
        imageryPriority: candidatePriority(candidate),
        imageryDesiredLevel: candidate.draw.texture.level + candidate.desired
      }))
    })
  })
  return {
    draws: result,
    coverageDraws,
    levels: new Map(candidates.map(c => [geometryKey(c.draw), c.draw.texture.level + c.allocated])),
    quality: {
      targetPixelError,
      measuredMaxPixelError: maximumMeasuredError,
      desiredDrawCount: candidates.reduce((sum, candidate) =>
        sum + childCount(candidate, candidate.desired), 0),
      sourceDrawCount: candidates.length,
      renderedDrawCount: result.length,
      coverageDrawCount: coverageDraws.length,
      clippedDrawCount: result.reduce((count, draw) =>
        count + (draw.imageryClipCell ? 1 : 0), 0),
      coverageGuaranteed: coverageDraws.length === candidates.filter(
        (candidate) => candidate.allocated > 0).length,
      desiredTextureCount: countIsUpperBound ? desiredCountBound : idealTextures.size,
      desiredTextureCountIsUpperBound: countIsUpperBound,
      selectedTextureCount: textureRefs.size,
      maximumTextureCount: maximumTextures,
      coarsenedDrawCount,
      selectedLevelMinimum: Number.isFinite(minimumSelectedLevel)
        ? minimumSelectedLevel : null,
      selectedLevelMaximum: Number.isFinite(maximumSelectedLevel)
        ? maximumSelectedLevel : null,
      limitedByTextureBudget: textureBudgetLimited,
      limitedByBudget,
      limitedByProjection: candidates.some(candidate => !Number.isFinite(candidate.pixelError)),
      limitedByLevel: candidates.some((candidate) =>
        candidate.required > candidate.desired),
      meetsTarget: maximumMeasuredError <= targetPixelError * 1.001
    }
  }
}

// One spatial imagery cut for the whole visible surface. Geometry fragments
// only contribute bounds; they never independently choose a parent or child.
function planImageryFrontier(frame, draws, positions, textureUv, viewport, descriptor, options) {
  const value = options || {}
  const target = value.targetPixelError || 1.25
  const tileSize = Number(descriptor && descriptor.tile_size) || 256
  const maxLevel = Number(descriptor && descriptor.maximum_level) || 0
  const maxTextures = value.maximumTextures || Number.MAX_SAFE_INTEGER
  const maxDraws = draws.length + (Number.isInteger(value.maximumDraws) ? value.maximumDraws : 512)
  const previous = value.previousLevels || new Set()
  const roots = new Map()
  const intersects = (a, b) => a.minimumU < b.maximumU && a.maximumU > b.minimumU &&
    a.minimumV < b.maximumV && a.maximumV > b.minimumV
  const cellBounds = (source, tile) => {
    const t = textureCellTransform(source, tile)
    return { minimumU: -t.offsetX / t.scale, maximumU: (1 - t.offsetX) / t.scale,
      minimumV: -t.offsetY / t.scale, maximumV: (1 - t.offsetY) / t.scale }
  }
  const candidates = []
  draws.forEach(draw => {
    const m = value.measureDraw(draw)
    if (!m.visible) return
    const candidate = { draw, model: m.model, regions: m.regions || [{ uv: m.bounds ||
      drawUvBounds(draw, textureUv), pixelsPerUv: m.pixelsPerUv }] }
    candidates.push(candidate)
    const tile = textureTileAtDelta(draw.texture, -draw.texture.level)
    const key = common.textureKeyString(tile)
    if (!roots.has(key)) roots.set(key, { tile, refs: [] })
    roots.get(key).refs.push({ candidate, regions: candidate.regions })
  })
  const makeNode = (tile, refs) => {
    let error = 0
    refs.forEach(ref => ref.regions.forEach(region => {
      error = Math.max(error, region.pixelsPerUv /
        (tileSize * Math.pow(2, tile.level - ref.candidate.draw.texture.level)))
    }))
    return { tile, refs, error, key: common.textureKeyString(tile), children: null }
  }
  const childrenOf = node => {
    if (node.children) return node.children
    const children = []
    for (let row = 0; row < 2; ++row) for (let column = 0; column < 2; ++column) {
      const tile = descendantTextureTile(node.tile, 1, row, column)
      const refs = []
      node.refs.forEach(ref => {
        const c = ref.candidate, bounds = cellBounds(c.draw.texture, tile)
        if (c.model && !surfacePlan.intersectsCell(c.model.hull,
          bounds.minimumU, bounds.minimumV, bounds.maximumU, bounds.maximumV)) return
        const regions = ref.regions.filter(region => intersects(region.uv, bounds))
        if (regions.length) refs.push({ candidate: c, regions })
      })
      if (refs.length) children.push(makeNode(tile, refs))
    }
    node.children = children
    return children
  }
  const leaves = new Map(Array.from(roots.values(), r => {
    const node = makeNode(r.tile, r.refs)
    return [node.key, node]
  }))
  let drawCount = candidates.length
  const splits = new Set()
  let limitedByBudget = false, limitedByTextureBudget = false, limitedByLevel = false
  // Rebuild deterministically from roots. History is keyed by imagery region,
  // so changes to terrain topology cannot change the allocation order.
  while (true) {
    let selected = null
    leaves.forEach(node => {
      const threshold = previous.has(node.key) ? target * 0.8 : target
      if (node.error <= threshold) return
      if (node.tile.level >= maxLevel) { limitedByLevel = node.error > target; return }
      const children = childrenOf(node)
      if (!children.length) return
      const nextTextures = leaves.size - 1 + children.length
      const nextDraws = drawCount - node.refs.length + children.reduce((n, c) => n + c.refs.length, 0)
      if (nextTextures > maxTextures || nextDraws > maxDraws) {
        if (node.error > target) limitedByBudget = true
        if (nextTextures > maxTextures && node.error > target) limitedByTextureBudget = true
        return
      }
      if (!selected || node.error > selected.node.error ||
          (node.error === selected.node.error && node.key < selected.node.key)) {
        selected = { node, children, nextDraws }
      }
    })
    if (!selected) break
    leaves.delete(selected.node.key)
    selected.children.forEach(child => leaves.set(child.key, child))
    splits.add(selected.node.key)
    drawCount = selected.nextDraws
  }
  const result = []
  let measuredMaxPixelError = 0, minimumLevel = Infinity, maximumLevel = -Infinity
  Array.from(leaves.values()).sort((a, b) => a.key.localeCompare(b.key)).forEach(node => {
    measuredMaxPixelError = Math.max(measuredMaxPixelError, node.error)
    minimumLevel = Math.min(minimumLevel, node.tile.level)
    maximumLevel = Math.max(maximumLevel, node.tile.level)
    node.refs.forEach(ref => {
      const draw = ref.candidate.draw, t = textureCellTransform(draw.texture, node.tile)
      result.push(Object.assign({}, draw, { texture: node.tile, sourceTexture: draw.texture,
        imageryCellScale: t.scale, imageryCellOffsetX: t.offsetX, imageryCellOffsetY: t.offsetY,
        imageryClipCell: node.tile.level > draw.texture.level, imageryCoverageDraw: false,
        imageryPixelError: node.error, imageryPriority: node.error,
        imageryDesiredLevel: node.tile.level }))
    })
  })
  return { draws: result, coverageDraws: [], levels: splits, quality: {
    targetPixelError: target, measuredMaxPixelError, sourceDrawCount: candidates.length,
    renderedDrawCount: result.length, desiredDrawCount: result.length,
    selectedTextureCount: leaves.size, maximumTextureCount: maxTextures,
    desiredTextureCount: leaves.size, desiredTextureCountIsUpperBound: false,
    selectedLevelMinimum: Number.isFinite(minimumLevel) ? minimumLevel : null,
    selectedLevelMaximum: Number.isFinite(maximumLevel) ? maximumLevel : null,
    clippedDrawCount: result.filter(draw => draw.imageryClipCell).length,
    coarsenedDrawCount: result.filter(draw => draw.texture.level < draw.sourceTexture.level).length,
    coverageDrawCount: 0, coverageGuaranteed: true, limitedByBudget, limitedByTextureBudget,
    limitedByLevel, limitedByProjection: !Number.isFinite(measuredMaxPixelError),
    meetsTarget: measuredMaxPixelError <= target * 1.001, spatialCut: true
  } }
}

function ancestorUvTransform(tile, ancestor) {
  const delta = tile.level - ancestor.level
  const divisor = Math.pow(2, delta)
  return {
    scale: 1 / divisor,
    offsetX: (tile.column - ancestor.column * divisor) / divisor,
    offsetY: (tile.row - ancestor.row * divisor) / divisor
  }
}

function imageTask(canvas, url) {
  let image = null
  let settled = false
  let rejectPromise = null
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject
    if (!canvas || typeof canvas.createImage !== 'function') {
      reject(new Error('Canvas image API is unavailable'))
      return
    }
    image = canvas.createImage()
    image.onload = () => {
      if (!settled) {
        settled = true
        resolve(image)
      }
    }
    image.onerror = (error) => {
      if (!settled) {
        settled = true
        reject(new Error('Texture image failed'))
      }
    }
    image.src = url
  })
  return {
    promise,
    abort() {
      if (!settled) {
        settled = true
        if (image) {
          image.src = ''
        }
        rejectPromise(new Error('Texture image request was cancelled'))
      }
    }
  }
}

class TextureStore {
  constructor(renderer, options) {
    this.renderer = renderer
    this.canvas = renderer.canvas
    this.onDiagnostic = options.onDiagnostic || (() => {})
    this.scheduler = new common.RequestScheduler(options.maximumConcurrent || 3)
    this.protectedKeys = new Set()
    this.cache = new common.LruCache({
      maximumEntries: options.maximumEntries || 128,
      maximumBytes: options.maximumBytes || 32 * 1024 * 1024,
      dispose: (asset) => this.disposeAsset(asset),
      canEvict: (key) => !this.protectedKeys.has(key)
    })
    this.maximumRetries = Number.isInteger(options.maximumRetries)
      ? common.clamp(options.maximumRetries, 0, 3)
      : 2
    this.retryDelayMs = options.retryDelayMs === undefined
      ? 400
      : Math.max(0, common.finiteNumber(options.retryDelayMs,
        'Texture retry delay'))
    this.desired = new Map()
    this.targetDesired = new Map()
    this.retainedTargets = new Map()
    this.requiredChildren = new Map()
    this.requiredPriorities = new Map()
    this.currentRoots = new Map()
    this.committedKeys = new Set()
    this.presentationKeys = new Set()
    this.frontierKeys = new Set()
    this.stagedKeys = new Set()
    this.transitionGroupParents = new Set()
    this.blockedByCapacity = false
    this.blockedGroupCount = 0
    this.blockedTileCount = 0
    this.transitionReserved = 0
    this.retries = new Map()
    this.failed = new Map()
    this.prefetchAncestors = options.prefetchAncestors !== false
    this.directTargets = options.directTargets === true
    this.configureSource(options.urlForTile, options.coverageTiles)
    this.retryTimers = new Map()
    this.retainedUntil = new Map()
    this.staleRequestGraceMs = options.staleRequestGraceMs === undefined
      ? 250
      : Math.max(0, common.finiteNumber(options.staleRequestGraceMs,
        'Texture request grace'))
    this.estimatedTileBytes = Math.max(1,
      Number(options.estimatedTileBytes) || textureByteSize(256, 256))
    this.transitionReserveEntries = Number.isInteger(
      options.transitionReserveEntries)
      ? Math.max(0, options.transitionReserveEntries) : null
    this.retainedTimer = null
    this.advanceTimer = null
    this.frameUsage = { exact: 0, fallback: 0, missing: 0 }
    this.generation = 0
  }

  configureSource(urlForTile, coverageTiles) {
    common.invariant(typeof urlForTile === 'function',
      'Texture URL resolver is required')
    this.urlForTile = urlForTile
    this.coverageTiles = Array.isArray(coverageTiles)
      ? coverageTiles.slice() : []
    this.coverageKeys = new Set(this.coverageTiles.map((tile) =>
      common.textureKeyString(tile)))
    const rootLevel = this.coverageTiles.reduce((result, tile) =>
      Math.min(result, tile.level), Number.POSITIVE_INFINITY)
    this.configuredRootTiles = this.coverageTiles.filter((tile) =>
      tile.level === rootLevel)
    this.configuredRootKeys = new Set(this.configuredRootTiles.map((tile) =>
      common.textureKeyString(tile)))
  }

  setSource(urlForTile, coverageTiles) {
    this.clear()
    this.configureSource(urlForTile, coverageTiles)
  }

  cacheCapacity() {
    const entryCapacity = this.cache.maximumEntries > 0
      ? this.cache.maximumEntries : Number.POSITIVE_INFINITY
    const byteCapacity = this.cache.maximumBytes > 0
      ? Math.floor(this.cache.maximumBytes / this.estimatedTileBytes)
      : Number.POSITIVE_INFINITY
    const capacity = Math.min(entryCapacity, byteCapacity)
    return Number.isFinite(capacity) ? Math.max(1, capacity) : Number.MAX_SAFE_INTEGER
  }

  targetCapacity() {
    const capacity = this.cacheCapacity()
    const coverageCount = Math.max(this.coverageKeys.size,
      this.prefetchAncestors ? 1 : 0)
    const coverage = Math.min(coverageCount,
      Math.max(0, capacity - 1))
    const configuredReserve = this.transitionReserveEntries === null
      ? (capacity >= 16 ? Math.floor(capacity / 8) : 0)
      : this.transitionReserveEntries
    const requestedReserve = Math.max(configuredReserve,
      this.prefetchAncestors ? 4 : 0)
    const transition = Math.min(requestedReserve,
      Math.max(0, capacity - coverage - 1))
    return Math.max(1, capacity - coverage - transition)
  }

  transitionCapacity() {
    const capacity = this.cacheCapacity()
    const coverageCount = Math.max(this.coverageKeys.size,
      this.prefetchAncestors ? 1 : 0)
    const coverage = Math.min(coverageCount,
      Math.max(0, capacity - 1))
    return Math.max(1, capacity - coverage - this.targetCapacity())
  }

  addRequiredPath(tile, priority) {
    let path = this.prefetchAncestors ? texturePathFromRoot(tile) : [tile]
    if (this.directTargets && path.length > 2) {
      // Bootstrap with the root, then request the selected target directly.
      // Keep the closest already-resident fallback; do not download every
      // intermediate level while the camera passes through it.
      const resident = path.slice(1, -1).reverse().find(node =>
        this.cache.has(common.textureKeyString(node)))
      path = resident ? [path[0], resident, tile] : [path[0], tile]
    }
    path.forEach((node, index) => {
      const key = common.textureKeyString(node)
      if (!this.desired.has(key)) this.desired.set(key, node)
      this.requiredPriorities.set(key, Math.max(
        this.requiredPriorities.get(key) || Number.NEGATIVE_INFINITY,
        Number(priority) || 0))
      if (index === 0) this.currentRoots.set(key, node)
      if (index === 0) return
      const parent = path[index - 1]
      const parentKey = common.textureKeyString(parent)
      let children = this.requiredChildren.get(parentKey)
      if (!children) {
        children = new Map()
        this.requiredChildren.set(parentKey, children)
      }
      children.set(key, node)
    })
  }

  buildRequirementTree(draws, retainedDraws) {
    this.desired.clear()
    this.targetDesired.clear()
    this.retainedTargets.clear()
    this.requiredChildren.clear()
    this.requiredPriorities.clear()
    this.currentRoots.clear()

    this.coverageTiles.forEach((tile) =>
      this.addRequiredPath(tile, 100000 - tile.level * 1000))
    draws.forEach((draw) => {
      const tile = draw.texture
      const key = common.textureKeyString(tile)
      if (!draw.imageryCoverageDraw) {
        this.targetDesired.set(key, tile)
      }
      this.addRequiredPath(tile, 1000 + (Number(draw.imageryPriority) || 0))
    })
    const retained = Array.isArray(retainedDraws) ? retainedDraws : []
    retained.forEach((draw) => {
      const tile = draw.texture
      const key = common.textureKeyString(tile)
      if (!draw.imageryCoverageDraw) {
        this.retainedTargets.set(key, tile)
      }
      this.addRequiredPath(tile, Number(draw.imageryPriority) || 0)
    })
    this.configuredRootTiles.forEach((tile) =>
      this.addRequiredPath(tile, 200000))
  }

  coverageReady() {
    if (!this.currentRoots.size) return true
    for (const key of this.currentRoots.keys()) {
      if (!this.committedKeys.has(key) || !this.cache.has(key)) return false
    }
    return true
  }

  coarseCoverageReady() {
    if (!this.coverageKeys.size) return this.coverageReady()
    for (const key of this.coverageKeys) {
      if (!this.committedKeys.has(key) || !this.cache.has(key)) return false
    }
    return true
  }

  requiresResident(key) {
    return this.targetDesired.has(key) || this.retainedTargets.has(key) ||
      this.coverageKeys.has(key) || this.currentRoots.has(key)
  }

  recomputeCommitted() {
    const previous = this.committedKeys
    const committed = new Set()
    let rootsReady = this.currentRoots.size > 0
    this.currentRoots.forEach((tile, key) => {
      rootsReady = rootsReady && this.cache.has(key) && !this.failed.has(key)
    })
    if (rootsReady) {
      this.currentRoots.forEach((tile, key) => committed.add(key))
    }

    const groups = Array.from(this.requiredChildren.entries()).sort(
      (left, right) => {
        const leftChild = left[1].values().next().value
        const rightChild = right[1].values().next().value
        return leftChild.level - rightChild.level
      })
    groups.forEach(([parentKey, children]) => {
      if (!committed.has(parentKey)) return
      children.forEach((tile, key) => {
        const resident = this.cache.has(key) && !this.failed.has(key)
        const logicalParent = previous.has(key) &&
          !this.requiresResident(key)
        if (resident || logicalParent) committed.add(key)
      })
    })
    this.committedKeys = committed
  }

  presentationKeyFor(tile) {
    const candidates = [tile].concat(ancestorTextureTiles(tile))
    for (let index = 0; index < candidates.length; ++index) {
      const key = common.textureKeyString(candidates[index])
      if (this.committedKeys.has(key) && this.cache.has(key)) return key
    }
    return null
  }

  refreshProtection() {
    this.protectedKeys.clear()
    this.presentationKeys.clear()
    this.stagedKeys.clear()
    this.transitionGroupParents.clear()
    this.transitionReserved = 0
    this.currentRoots.forEach((tile, key) => this.protectedKeys.add(key))
    this.coverageKeys.forEach((key) => {
      if (this.committedKeys.has(key)) this.protectedKeys.add(key)
    })
    const protectPresentation = (tile) => {
      const key = this.presentationKeyFor(tile)
      if (!key) return
      this.presentationKeys.add(key)
      this.protectedKeys.add(key)
    }
    this.targetDesired.forEach(protectPresentation)
    this.retainedTargets.forEach(protectPresentation)

    if (this.coverageReady()) {
      const capacity = this.transitionCapacity()
      this.frontierGroups().forEach((group) => {
        if (this.transitionReserved + group.groupSize > capacity) return
        this.transitionGroupParents.add(group.parentKey)
        this.transitionReserved += group.groupSize
        group.allChildren.forEach((tile, key) => {
          if (this.cache.has(key) && !this.committedKeys.has(key)) {
            this.stagedKeys.add(key)
            this.protectedKeys.add(key)
          }
        })
      })
    }
    this.protectedKeys.forEach((key) => {
      if (this.cache.has(key)) this.cache.get(key)
    })
    this.cache.evict()
  }

  frontierGroups() {
    if (!this.coverageReady()) {
      const roots = new Map()
      this.currentRoots.forEach((tile, key) => {
        if (!this.cache.has(key) && !this.failed.has(key)) {
          roots.set(key, tile)
        }
      })
      return roots.size ? [{ parentKey: null, children: roots,
        level: 0, priority: 1000000 }] : []
    }

    const groups = []
    this.requiredChildren.forEach((children, parentKey) => {
      if (!this.committedKeys.has(parentKey)) return
      let complete = children.size > 0
      const missing = new Map()
      let priority = Number.NEGATIVE_INFINITY
      let level = Number.POSITIVE_INFINITY
      let staged = 0
      let inFlight = 0
      children.forEach((tile, key) => {
        complete = complete && this.committedKeys.has(key) &&
          (!this.requiresResident(key) || this.cache.has(key))
        priority = Math.max(priority, this.requiredPriorities.get(key) || 0)
        level = Math.min(level, tile.level)
        if (this.cache.has(key) && !this.committedKeys.has(key)) staged += 1
        if (this.scheduler.active.has(key) || this.scheduler.queued.has(key)) {
          inFlight += 1
        }
        const needsResident = this.requiresResident(key)
        if (!this.failed.has(key) && !this.cache.has(key) &&
          (!this.committedKeys.has(key) || needsResident)) {
          missing.set(key, tile)
        }
      })
      if (!complete && missing.size) {
        if (this.directTargets) {
          // Terminal targets are independently committable. A direct jump can
          // have hundreds of descendants, so it must not reserve them as one
          // sibling group larger than the entire transition budget.
          missing.forEach((tile, key) => {
            const single = new Map([[key, tile]])
            groups.push({ parentKey: parentKey + '>' + key, children: single,
              allChildren: single, groupSize: 1, level: tile.level,
              priority: this.requiredPriorities.get(key) || 0, staged: 0,
              inFlight: this.scheduler.active.has(key) || this.scheduler.queued.has(key) ? 1 : 0 })
          })
        } else {
          groups.push({ parentKey, children: missing, allChildren: children,
            groupSize: children.size, level, priority, staged, inFlight })
        }
      }
    })
    groups.sort((left, right) =>
      Number(right.staged + right.inFlight > 0) -
        Number(left.staged + left.inFlight > 0) ||
      right.staged - left.staged ||
      left.level - right.level || right.priority - left.priority)
    return groups
  }

  scheduleFrontier() {
    this.frontierKeys.clear()
    this.blockedByCapacity = false
    this.blockedGroupCount = 0
    this.blockedTileCount = 0
    const groups = this.frontierGroups()
    if (!groups.length) return

    const bootstrapping = !this.coverageReady()
    groups.forEach((group) => {
      group.children.forEach((tile, key) => this.frontierKeys.add(key))
      if (!bootstrapping &&
        !this.transitionGroupParents.has(group.parentKey)) {
        this.blockedByCapacity = true
        this.blockedGroupCount += 1
        this.blockedTileCount += group.children.size
        return
      }
      const unscheduled = []
      group.children.forEach((tile, key) => {
        if (!this.scheduler.active.has(key) &&
          !this.scheduler.queued.has(key)) {
          unscheduled.push({ key, tile })
        }
      })
      unscheduled.sort((left, right) =>
        (this.requiredPriorities.get(right.key) || 0) -
        (this.requiredPriorities.get(left.key) || 0))
      unscheduled.forEach(({ key, tile }) => {
        const priority = bootstrapping ? 1000000 :
          500000 - group.level * 10000 +
          (this.requiredPriorities.get(key) || 0)
        this.schedule(key, tile, priority)
      })
    })
  }

  advance() {
    this.recomputeCommitted()
    this.refreshProtection()
    this.scheduleFrontier()
    this.renderer.requestRender()
  }

  scheduleAdvance() {
    if (this.advanceTimer) return
    this.advanceTimer = setTimeout(() => {
      this.advanceTimer = null
      this.advance()
    }, 0)
  }

  sync(draws, retainedDraws) {
    const previous = new Map(this.desired)
    this.buildRequirementTree(draws, retainedDraws)
    const desired = new Set(this.desired.keys())
    const now = Date.now()
    previous.forEach((tile, key) => {
      if (!desired.has(key) && this.staleRequestGraceMs > 0) {
        this.retainedUntil.set(key, now + this.staleRequestGraceMs)
      }
    })
    desired.forEach((key) => this.retainedUntil.delete(key))
    const wanted = this.wantedKeys(now)
    this.scheduler.cancelExcept(wanted)
    this.cancelStaleRetries(wanted)
    this.advance()
    this.scheduleRetainedPrune()
  }

  wantedKeys(now) {
    const wanted = new Set(this.desired.keys())
    this.retainedUntil.forEach((expiresAt, key) => {
      if (expiresAt > now) {
        wanted.add(key)
      } else {
        this.retainedUntil.delete(key)
      }
    })
    return wanted
  }

  isWanted(key) {
    return this.desired.has(key) ||
      (this.retainedUntil.get(key) || 0) > Date.now()
  }

  scheduleRetainedPrune() {
    if (this.retainedTimer || !this.retainedUntil.size) {
      return
    }
    let next = Number.POSITIVE_INFINITY
    this.retainedUntil.forEach((expiresAt) => { next = Math.min(next, expiresAt) })
    this.retainedTimer = setTimeout(() => {
      this.retainedTimer = null
      const wanted = this.wantedKeys(Date.now())
      this.scheduler.cancelExcept(wanted)
      this.cancelStaleRetries(wanted)
      this.scheduleRetainedPrune()
    }, Math.max(1, next - Date.now()))
  }

  priorityForKey(key) {
    return this.requiredPriorities.get(key) || 0
  }

  schedule(key, tile, priority) {
    const generation = this.generation
    this.scheduler.enqueue(key, () => {
      let url
      let task
      try {
        url = this.urlForTile(tile)
        task = imageTask(this.canvas, url)
      } catch (error) {
        this.failed.set(key, tile)
        this.onDiagnostic('texture_request_failed', {
          key,
          message: error.message || String(error)
        })
        return {
          promise: Promise.resolve().then(() => this.scheduleAdvance()),
          abort() {}
        }
      }
      task.promise.then((image) => {
        if (generation !== this.generation || !this.isWanted(key)) {
          return
        }
        const asset = {
          image,
          texture: null,
          width: Number(image.width) || 1,
          height: Number(image.height) || 1,
          url
        }
        this.retries.delete(key)
        this.failed.delete(key)
        this.cache.set(key, asset, textureByteSize(asset.width, asset.height))
        this.scheduleAdvance()
      }).catch((error) => {
        if (generation !== this.generation) {
          return
        }
        const message = error.message || String(error)
        if (/cancelled/.test(message) || !this.isWanted(key)) {
          return
        }
        const attempt = (this.retries.get(key) || 0) + 1
        this.retries.set(key, attempt)
        if (attempt <= this.maximumRetries) {
          this.scheduleRetry(key, tile, attempt)
          this.onDiagnostic('texture_retry', { key, attempt, message })
          this.renderer.requestRender()
          return
        }
        this.failed.set(key, tile)
        this.onDiagnostic('texture_load_failed', { key, message })
        this.scheduleAdvance()
      })
      return task
    }, priority)
  }

  scheduleRetry(key, tile, attempt) {
    if (this.retryTimers.has(key)) {
      return
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      if (this.isWanted(key) && !this.cache.has(key) &&
        !this.failed.has(key)) {
        this.schedule(key, tile, this.priorityForKey(key))
      }
    }, attempt * this.retryDelayMs)
    this.retryTimers.set(key, timer)
  }

  cancelStaleRetries(desired) {
    this.retryTimers.forEach((timer, key) => {
      if (!desired.has(key)) {
        clearTimeout(timer)
        this.retryTimers.delete(key)
      }
    })
    this.retries.forEach((value, key) => {
      if (!desired.has(key)) {
        this.retries.delete(key)
      }
    })
    this.failed.forEach((value, key) => {
      if (!desired.has(key)) {
        this.failed.delete(key)
      }
    })
  }

  retryFailed() {
    if (!this.failed.size && !this.retries.size) {
      return false
    }
    this.retryTimers.forEach((timer) => clearTimeout(timer))
    this.retryTimers.clear()
    this.retries.clear()
    this.failed.clear()
    this.advance()
    return true
  }

  uploadedTexture(asset) {
    if (!asset.texture && !this.renderer.contextLost) {
      asset.texture = this.renderer.uploadTexture(asset.image,
        asset.width, asset.height)
    }
    return asset.texture || this.renderer.fallbackTexture
  }

  beginFrame() {
    this.frameUsage = { exact: 0, fallback: 0, missing: 0 }
  }

  get(tile) {
    const candidates = [tile].concat(ancestorTextureTiles(tile))
    for (let index = 0; index < candidates.length; ++index) {
      const candidate = candidates[index]
      const key = common.textureKeyString(candidate)
      if (!this.committedKeys.has(key) && !this.renderer.presentedTextures.has(key)) continue
      const asset = this.cache.get(key)
      if (!asset) continue
      if (index === 0) {
        this.frameUsage.exact += 1
        return {
          texture: this.uploadedTexture(asset),
          scale: 1,
          offsetX: 0,
          offsetY: 0,
          exact: true,
          kind: 'exact',
          resolvedTile: candidate,
          resolvedLevel: tile.level
        }
      }
      const transform = ancestorUvTransform(tile, candidate)
      this.frameUsage.fallback += 1
      return Object.assign({
        texture: this.uploadedTexture(asset),
        exact: false,
        kind: 'fallback',
        resolvedTile: candidate,
        resolvedLevel: candidate.level
      }, transform)
    }
    this.frameUsage.missing += 1
    return {
      texture: this.renderer.fallbackTexture,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      exact: false,
      kind: 'missing',
      resolvedLevel: -1
    }
  }

  restoreContext() {
    this.cache.values().forEach((asset) => {
      asset.texture = null
    })
  }

  disposeAsset(asset) {
    if (asset && asset.texture && this.renderer.gl) {
      this.renderer.gl.deleteTexture(asset.texture)
    }
  }

  clear() {
    const maximumConcurrent = this.scheduler.maximumConcurrent
    const previousScheduler = this.scheduler
    this.generation += 1
    this.scheduler = new common.RequestScheduler(maximumConcurrent)
    previousScheduler.clear()
    if (this.retainedTimer) {
      clearTimeout(this.retainedTimer)
      this.retainedTimer = null
    }
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer)
      this.advanceTimer = null
    }
    this.retryTimers.forEach((timer) => clearTimeout(timer))
    this.retryTimers.clear()
    this.desired.clear()
    this.targetDesired.clear()
    this.retainedTargets.clear()
    this.requiredChildren.clear()
    this.requiredPriorities.clear()
    this.currentRoots.clear()
    this.committedKeys.clear()
    this.presentationKeys.clear()
    this.frontierKeys.clear()
    this.stagedKeys.clear()
    this.transitionGroupParents.clear()
    this.protectedKeys.clear()
    this.blockedByCapacity = false
    this.blockedGroupCount = 0
    this.blockedTileCount = 0
    this.transitionReserved = 0
    this.retries.clear()
    this.failed.clear()
    this.retainedUntil.clear()
    this.cache.clear()
  }

  stats() {
    const capacity = this.cacheCapacity()
    let cachedDesired = 0
    this.desired.forEach((tile, key) => {
      if (this.cache.has(key)) cachedDesired += 1
    })
    const used = this.frameUsage.exact + this.frameUsage.fallback +
      this.frameUsage.missing
    let residentTarget = 0
    let cachedTarget = 0
    this.targetDesired.forEach((tile, key) => {
      if (this.cache.has(key)) residentTarget += 1
      if (this.cache.has(key) && this.committedKeys.has(key)) {
        cachedTarget += 1
      }
    })
    let cachedCoverage = 0
    this.coverageKeys.forEach((key) => {
      if (this.cache.has(key) && this.committedKeys.has(key)) {
        cachedCoverage += 1
      }
    })
    let cachedRoots = 0
    this.currentRoots.forEach((tile, key) => {
      if (this.cache.has(key) && this.committedKeys.has(key)) cachedRoots += 1
    })
    let blockedByFailure = false
    this.failed.forEach((tile, key) => {
      blockedByFailure = blockedByFailure || this.desired.has(key)
    })
    const scheduler = this.scheduler.stats()
    const coverageReady = this.coverageReady()
    const targetMissing = this.targetDesired.size - cachedTarget
    const stalledByCapacity = this.blockedByCapacity &&
      scheduler.active === 0 && scheduler.queued === 0 && targetMissing > 0
    const state = blockedByFailure ? 'degraded'
      : (!coverageReady ? 'bootstrapping'
        : (targetMissing === 0 ? 'settled'
          : (stalledByCapacity ? 'blocked-capacity' : 'refining')))
    return Object.assign(this.cache.stats(), scheduler, {
      state,
      desired: this.desired.size,
      cachedDesired,
      desiredMissing: this.desired.size - cachedDesired,
      targetDesired: this.targetDesired.size,
      residentTarget,
      cachedTarget,
      targetMissing,
      supportDesired: Math.max(0,
        this.desired.size - this.targetDesired.size),
      rootDesired: this.currentRoots.size,
      cachedRoots,
      coverageReady,
      coarseCoverageReady: this.coarseCoverageReady(),
      coverageDesired: this.coverageKeys.size,
      cachedCoverage,
      committed: this.committedKeys.size,
      presentationTiles: this.presentationKeys.size,
      frontierTiles: this.frontierKeys.size,
      stagedTiles: this.stagedKeys.size,
      capacity,
      targetCapacity: this.targetCapacity(),
      transitionCapacity: this.transitionCapacity(),
      transitionGroups: this.transitionGroupParents.size,
      transitionReserved: this.transitionReserved,
      protected: this.protectedKeys.size,
      limitedByCapacity: this.targetDesired.size > this.targetCapacity(),
      limitedByPhysicalCapacity: this.targetDesired.size > capacity,
      blockedByCapacity: this.blockedByCapacity,
      blockedGroupCount: this.blockedGroupCount,
      blockedTileCount: this.blockedTileCount,
      blockedByFailure,
      failed: this.failed.size,
      fallbackRatio: used ? this.frameUsage.fallback / used : 0,
      missingRatio: used ? this.frameUsage.missing / used : 0,
      idle: scheduler.active === 0 && scheduler.queued === 0
    })
  }
}

class TerraWebGlRenderer {
  constructor(canvas, options) {
    this.canvas = canvas
    this.options = options || {}
    this.terrainBoundImagery =
      this.options.terrainBoundImagery !== false
    this.mode = this.options.mode === 'height' ? 'height' : 'texture'
    this.heightRange = Array.isArray(this.options.heightRange)
      ? this.options.heightRange.slice(0, 2)
      : [-50, 350]
    this.onDiagnostic = this.options.onDiagnostic || (() => {})
    this.onContextChange = this.options.onContextChange || (() => {})
    this.requestRenderCallback = this.options.requestRender || (() => {})
    this.atmosphereCapable = this.options.atmosphereCapable === true
    this.atmosphereEnabled = this.options.atmosphereEnabled === true
    this.planetRadius = Number(this.options.planetRadius) || 6371000
    this.contextLost = false
    this.gl = null
    this.program = null
    this.attributes = null
    this.uniforms = null
    this.indexBuffer = null
    this.atmosphere = defaultAtmosphere()
    this.atmosphereProgram = null
    this.atmosphereBuffer = null
    this.atmosphereTexture = null
    this.atmosphereAttributes = null
    this.atmosphereUniforms = null
    this.overlayProgram = null
    this.overlayBuffer = null
    this.overlayAttributes = null
    this.overlayUniforms = null
    this.overlays = { points: [], route: null }
    this.fallbackTexture = null
    this.uploadQueue = []
    this.current = null
    this.renderDraws = []
    this.coverageDraws = []
    this.geometryCoverageDraws = []
    this.displaySurface = null
    this.presentedTextures = new Map()
    this.imageryLevels = new Map()
    this.cameraVersion = 0
    this.presentedCameraVersion = -1
    this.plannedCameraVersion = -1
    this.measurements = new Map()
    this.partitionBytes = 0
    this.interactionActive = false
    this.debugOptions = { textureState: false }
    this.geometryPinnedKeys = new Set()
    this.qualityStats = {
      targetPixelError: this.options.imageryPixelError || 1.25,
      measuredMaxPixelError: 0,
      desiredDrawCount: 0,
      renderedDrawCount: 0,
      limitedByBudget: false,
      terrainBound: this.terrainBoundImagery
    }
    this.pendingQualityStats = this.qualityStats
    this.performanceStats = {
      textureUploads: 0,
      partitionBuilds: 0,
      render: { count: 0, lastMs: 0, averageMs: 0 },
      geometryPrepare: { count: 0, lastMs: 0, averageMs: 0 },
      imageryRebuild: { count: 0, lastMs: 0, averageMs: 0 },
      frameIntervalMs: 0,
      framesPerSecond: 0,
      lastFrameAt: 0
    }
    this.drawStats = { submitted: 0, queued: 0 }
    this.geometry = new common.LruCache({
      maximumEntries: this.options.maximumGeometryEntries || 192,
      maximumBytes: this.options.geometryCacheBytes || 16 * 1024 * 1024,
      dispose: (value) => this.disposeGeometry(value),
      canEvict: (key) => !this.geometryPinnedKeys.has(key)
    })
    this.textures = new TextureStore(this, {
      urlForTile: this.options.urlForTile,
      onDiagnostic: this.onDiagnostic,
      maximumConcurrent: this.options.maximumTextureRequests || 3,
      maximumEntries: this.options.maximumTextureEntries || 128,
      maximumBytes: this.options.textureCacheBytes || 32 * 1024 * 1024,
      estimatedTileBytes: textureByteSize(
        (this.options.textureDescriptor &&
          this.options.textureDescriptor.tile_size) || 256,
        (this.options.textureDescriptor &&
          this.options.textureDescriptor.tile_size) || 256),
      transitionReserveEntries: this.options.textureTransitionReserveEntries,
      maximumRetries: this.options.maximumTextureRetries,
      retryDelayMs: this.options.textureRetryDelayMs,
      staleRequestGraceMs: this.options.textureRequestGraceMs,
      prefetchAncestors: this.options.prefetchTextureAncestors !== false,
      directTargets: this.options.directTextureTargets !== false,
      coverageTiles: globalCoverageTextureTiles(
        this.options.textureDescriptor)
    })
    this.handleContextLost = (event) => this.contextWasLost(event)
    this.handleContextRestored = () => this.contextWasRestored()
    if (canvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextlost', this.handleContextLost)
      canvas.addEventListener('webglcontextrestored', this.handleContextRestored)
    }
    this.initialize(this.options.gl)
  }

  initialize(providedGl) {
    const gl = providedGl || this.canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      depth: true,
      stencil: true,
      preserveDrawingBuffer: false
    })
    if (!gl) {
      throw new Error('WebGL context creation failed')
    }
    this.gl = gl
    this.program = createProgram(gl)
    if (this.atmosphereCapable) {
      this.atmosphereProgram = createAtmosphereProgram(gl)
    }
    this.overlayProgram = createOverlayProgram(gl)
    this.attributes = {
      position: gl.getAttribLocation(this.program, 'a_position'),
      uv: gl.getAttribLocation(this.program, 'a_uv')
    }
    this.uniforms = {
      projectionView: gl.getUniformLocation(this.program, 'u_projection_view'),
      origin: gl.getUniformLocation(this.program, 'u_origin'),
      heightOrigin: gl.getUniformLocation(this.program, 'u_height_origin'),
      cellUvScale: gl.getUniformLocation(this.program, 'u_cell_uv_scale'),
      cellUvOffset: gl.getUniformLocation(this.program, 'u_cell_uv_offset'),
      uvScale: gl.getUniformLocation(this.program, 'u_uv_scale'),
      uvOffset: gl.getUniformLocation(this.program, 'u_uv_offset'),
      clipCell: gl.getUniformLocation(this.program, 'u_clip_cell'),
      texture: gl.getUniformLocation(this.program, 'u_texture'),
      renderMode: gl.getUniformLocation(this.program, 'u_render_mode'),
      heightRange: gl.getUniformLocation(this.program, 'u_height_range'),
      debugMode: gl.getUniformLocation(this.program, 'u_debug_mode'),
      textureState: gl.getUniformLocation(this.program, 'u_texture_state'),
      fogDensity: gl.getUniformLocation(this.program, 'u_fog_density'),
      fogColor: gl.getUniformLocation(this.program, 'u_fog_color')
    }
    if (this.atmosphereProgram) {
      this.atmosphereAttributes = {
        clipPosition: gl.getAttribLocation(
          this.atmosphereProgram, 'a_clip_position')
      }
      this.atmosphereUniforms = {
        inverseProjectionView: gl.getUniformLocation(
          this.atmosphereProgram, 'u_inverse_projection_view'),
        cameraScaled: gl.getUniformLocation(
          this.atmosphereProgram, 'u_camera_scaled'),
        east: gl.getUniformLocation(this.atmosphereProgram, 'u_east'),
        north: gl.getUniformLocation(this.atmosphereProgram, 'u_north'),
        up: gl.getUniformLocation(this.atmosphereProgram, 'u_up'),
        sunDirection: gl.getUniformLocation(
          this.atmosphereProgram, 'u_sun_direction'),
        sunVisible: gl.getUniformLocation(
          this.atmosphereProgram, 'u_sun_visible'),
        skyTexture: gl.getUniformLocation(
          this.atmosphereProgram, 'u_sky_texture')
      }
      common.invariant(this.atmosphereAttributes.clipPosition >= 0 &&
        this.atmosphereUniforms.inverseProjectionView &&
        this.atmosphereUniforms.cameraScaled &&
        this.atmosphereUniforms.east && this.atmosphereUniforms.north &&
        this.atmosphereUniforms.up &&
        this.atmosphereUniforms.sunDirection &&
        this.atmosphereUniforms.sunVisible &&
        this.atmosphereUniforms.skyTexture,
      'WebGL atmosphere shader locations are incomplete')
    }
    this.overlayAttributes = {
      position: gl.getAttribLocation(this.overlayProgram, 'a_position')
    }
    this.overlayUniforms = {
      projectionView: gl.getUniformLocation(this.overlayProgram,
        'u_projection_view'),
      pointSize: gl.getUniformLocation(this.overlayProgram, 'u_point_size'),
      color: gl.getUniformLocation(this.overlayProgram, 'u_color')
    }
    common.invariant(this.attributes.position >= 0 && this.attributes.uv >= 0 &&
      this.uniforms.projectionView && this.uniforms.origin &&
      this.uniforms.heightOrigin && this.uniforms.uvScale &&
      this.uniforms.cellUvScale && this.uniforms.cellUvOffset &&
      this.uniforms.uvOffset && this.uniforms.clipCell &&
      this.uniforms.texture &&
      this.uniforms.renderMode && this.uniforms.heightRange &&
      this.uniforms.fogDensity && this.uniforms.fogColor,
    'WebGL terrain shader locations are incomplete')
    this.indexBuffer = gl.createBuffer()
    this.overlayBuffer = gl.createBuffer()
    this.fallbackTexture = this.createFallbackTexture()
    if (this.atmosphereProgram) {
      this.atmosphereBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, this.atmosphereBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 3, -1, -1, 3
      ]), gl.STATIC_DRAW)
      this.atmosphereTexture = this.createAtmosphereTexture()
    }
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.disable(gl.CULL_FACE)
    gl.clearColor(0.025, 0.045, 0.07, 1.0)
  }

  capabilities() {
    const gl = this.gl
    return {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      version: gl.getParameter(gl.VERSION)
    }
  }

  resize(width, height) {
    if (!this.gl || this.contextLost) {
      return
    }
    this.gl.viewport(0, 0, width, height)
    this.requestRender()
  }

  setBudget(budget) {
    const value = budget || {}
    if (Number.isFinite(value.devicePixelRatio) &&
      value.devicePixelRatio > 0) {
      this.options.devicePixelRatio = value.devicePixelRatio
    }
    if (Number.isFinite(value.uploadBudgetMs) && value.uploadBudgetMs > 0) {
      this.options.uploadBudgetMs = value.uploadBudgetMs
    }
    if (Number.isFinite(value.geometryCacheBytes) &&
      value.geometryCacheBytes > 0) {
      this.geometry.maximumBytes = value.geometryCacheBytes
      this.geometry.evict()
    }
    if (Number.isFinite(value.maximumTextureEntries) &&
      value.maximumTextureEntries > 0) {
      this.textures.cache.maximumEntries = Math.max(1,
        Math.floor(value.maximumTextureEntries))
      this.textures.cache.evict()
    }
    if (Number.isFinite(value.textureCacheBytes) &&
      value.textureCacheBytes > 0) {
      this.textures.cache.maximumBytes = value.textureCacheBytes
      this.textures.cache.evict()
    }
    if (Number.isFinite(value.maximumTextureRequests) &&
      value.maximumTextureRequests > 0) {
      this.textures.scheduler.maximumConcurrent = Math.max(1,
        Math.floor(value.maximumTextureRequests))
    }
    if (this.current) {
      this.rebuildImageryDraws()
      this.requestRender()
    }
  }

  retryTextures() {
    return this.textures.retryFailed()
  }

  setMode(mode) {
    common.invariant(mode === 'texture' || mode === 'height',
      'Renderer mode is unsupported')
    this.mode = mode
    this.requestRender()
  }

  setAtmosphereEnabled(enabled) {
    common.invariant(!enabled || this.atmosphereCapable,
      'Atmosphere is unavailable for this renderer')
    this.atmosphereEnabled = Boolean(enabled)
    this.requestRender()
  }

  setAtmosphere(value) {
    common.invariant(value && Number.isInteger(value.width) &&
      value.width > 0 && Number.isInteger(value.height) && value.height > 0 &&
      value.rgba && value.rgba.length === value.width * value.height * 4,
    'Atmosphere lookup texture is invalid')
    this.atmosphere = {
      width: value.width,
      height: value.height,
      sunVisible: Boolean(value.sunVisible),
      fogEnabled: Boolean(value.fogEnabled),
      fogDensityMultiplier: Number.isFinite(value.fogDensityMultiplier)
        ? value.fogDensityMultiplier : 1,
      sunDirection: normalized(value.sunDirection),
      ambientColor: value.ambientColor.slice(0, 3),
      diffuseColor: value.diffuseColor.slice(0, 3),
      fogColor: value.fogColor.slice(0, 3),
      seaLevelFogDensity: value.seaLevelFogDensity,
      rgba: value.rgba
    }
    if (this.gl && this.atmosphereProgram) {
      if (this.atmosphereTexture) this.gl.deleteTexture(this.atmosphereTexture)
      this.atmosphereTexture = this.createAtmosphereTexture()
    }
    this.requestRender()
  }

  setInteractionActive(active) {
    const next = Boolean(active)
    if (this.interactionActive === next) return
    this.interactionActive = next
    this.requestRender()
  }

  setDebugOptions(options) {
    this.debugOptions = Object.assign({}, this.debugOptions, options || {})
    this.requestRender()
  }

  setImagerySource(textureDescriptor, urlForTile) {
    common.invariant(textureDescriptor &&
      typeof urlForTile === 'function',
      'Imagery texture descriptor and URL resolver are required')
    this.options.textureDescriptor = textureDescriptor
    this.options.urlForTile = urlForTile
    this.textures.setSource(urlForTile,
      globalCoverageTextureTiles(textureDescriptor))
    this.displaySurface = null
    this.presentedTextures.clear()
    this.imageryLevels.clear()
    this.rebuildImageryDraws()
    this.requestRender()
  }

  measureDraw(draw) {
    const key = draw.geometryKey || geometryKey(draw)
    if (this.measurements.has(key)) return this.measurements.get(key)
    const geometry = this.geometry.get(key) || this.uploadQueue.find(item => item.key === key)
    const measured = geometry && geometry.model && this.projectionContext
      ? surfacePlan.measureSurface(geometry.model, draw.origin, this.projectionContext)
      : { pixelsPerUv: Infinity, visible: true, centerDistance: 0 }
    if (geometry && geometry.model) {
      measured.bounds = geometry.model.bounds
      measured.model = geometry.model
    }
    this.measurements.set(key, measured)
    return measured
  }

  measureTextureDraw(draw, resolvedLevel) {
    const m = this.measureDraw(draw)
    const source = draw.sourceTexture || draw.texture
    const t = textureCellTransform(source, draw.texture)
    const loU = -t.offsetX / t.scale, hiU = (1 - t.offsetX) / t.scale
    const loV = -t.offsetY / t.scale, hiV = (1 - t.offsetY) / t.scale
    const pixels = m.regions ? m.regions.reduce((maximum, region) => {
      const b = region.uv
      return b.maximumU > loU && b.minimumU < hiU && b.maximumV > loV && b.minimumV < hiV
        ? Math.max(maximum, region.pixelsPerUv) : maximum
    }, 0) : m.pixelsPerUv
    return pixels / ((Number(this.options.textureDescriptor && this.options.textureDescriptor.tile_size) || 256) *
      Math.pow(2, resolvedLevel - source.level))
  }

  presentationDraws(draws) {
    const branches = new Set()
    this.presentedTextures.forEach(tile => {
      if (!this.textures.cache.has(common.textureKeyString(tile))) return
      let parent = parentTextureTile(tile)
      while (parent) {
        branches.add(common.textureKeyString(parent))
        parent = parentTextureTile(parent)
      }
    })
    const result = []
    draws.forEach(draw => {
      const source = draw.sourceTexture || draw.texture
      const visit = tile => {
        if (!textureTileContains(source, tile) && !textureTileContains(tile, source)) return
        const model = this.measureDraw(draw).model
        const t = textureCellTransform(source, tile)
        if (model && !surfacePlan.intersectsCell(model.hull, -t.offsetX / t.scale,
          -t.offsetY / t.scale, (1 - t.offsetX) / t.scale, (1 - t.offsetY) / t.scale)) return
        const key = common.textureKeyString(tile)
        const exact = this.textures.committedKeys.has(key) && this.textures.cache.has(key)
        if (!exact && branches.has(key)) {
          for (let row = 0; row < 2; ++row) for (let column = 0; column < 2; ++column) {
            visit(descendantTextureTile(tile, 1, row, column))
          }
          return
        }
        const transform = textureCellTransform(source, tile)
        result.push(Object.assign({}, draw, {
          texture: tile, sourceTexture: source,
          imageryCellScale: transform.scale,
          imageryCellOffsetX: transform.offsetX,
          imageryCellOffsetY: transform.offsetY,
          imageryClipCell: tile.level > source.level
        }))
      }
      visit(draw.texture)
    })
    return this.preparePartitions(result)
  }

  preparePartitions(draws) {
    const groups = new Map()
    draws.forEach(draw => {
      const key = draw.geometryKey
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(draw)
    })
    const result = []
    this.partitionBudgetLimited = false
    groups.forEach((items, key) => {
      const geometry = this.geometry.get(key)
      if (!geometry) { result.push(...items); return }
      items.sort((a, b) => common.textureKeyString(a.texture).localeCompare(common.textureKeyString(b.texture)))
      const signature = items.map(draw => common.textureKeyString(draw.texture)).join('|')
      if (geometry.partitionSignature === signature) { result.push(...items); return }
      const cells = items.filter(draw => draw.imageryClipCell).map(draw => {
        const scale = draw.imageryCellScale
        return { key: common.textureKeyString(draw.texture), bounds: {
          minimumU: -draw.imageryCellOffsetX / scale,
          maximumU: (1 - draw.imageryCellOffsetX) / scale,
          minimumV: -draw.imageryCellOffsetY / scale,
          maximumV: (1 - draw.imageryCellOffsetY) / scale
        } }
      })
      const parts = cells.length ? surfacePlan.partitionSurface(geometry.model, cells) : []
      const effectiveSignature = parts.map(p => p.cell.key).sort().join('|')
      if (geometry.partitionEffectiveSignature === effectiveSignature) {
        geometry.partitionSignature = signature
        geometry.partitionDraws = items
        result.push(...items)
        return
      }
      const bytes = parts.reduce((sum, p) => sum + p.positions.byteLength + p.uv.byteLength +
        p.indices.byteLength, 0)
      const previousBytes = geometry.partitionBytes || 0
      const budget = this.options.geometryCacheBytes || 16 * 1024 * 1024
      if (this.partitionBytes - previousBytes + bytes > budget) {
        this.geometry.entries.forEach((entry, cachedKey) => {
          if (!groups.has(cachedKey)) {
            this.releasePartitions(entry.value)
            entry.value.partitionSignature = null
            entry.value.partitionEffectiveSignature = null
            entry.value.partitionDraws = null
          }
        })
      }
      if (this.partitionBytes - previousBytes + bytes > budget) {
        this.partitionBudgetLimited = true
        if (geometry.partitionDraws) result.push(...geometry.partitionDraws)
        else {
          const source = items[0].sourceTexture || items[0].texture
          result.push(Object.assign({}, items[0], { texture: source, sourceTexture: source,
            imageryCellScale: 1, imageryCellOffsetX: 0, imageryCellOffsetY: 0, imageryClipCell: false }))
        }
        return
      }
      this.releasePartitions(geometry)
      const gl = this.gl
      parts.forEach(part => {
        const positionBuffer = gl.createBuffer(), uvBuffer = gl.createBuffer()
        const indexBuffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, part.positions, gl.STATIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, part.uv, gl.STATIC_DRAW)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, part.indices, gl.STATIC_DRAW)
        geometry.partitions.set(part.cell.key, { positionBuffer, uvBuffer, indexBuffer,
          indexCount: part.indices.length, vertexCount: part.positions.length / 3 })
      })
      geometry.partitionBytes = bytes
      this.partitionBytes += bytes
      geometry.partitionSignature = signature
      geometry.partitionEffectiveSignature = effectiveSignature
      geometry.partitionDraws = items
      this.performanceStats.partitionBuilds += parts.length ? 1 : 0
      result.push(...items)
    })
    return result
  }

  partitionForDraw(geometry, draw) {
    return geometry.partitions.get(common.textureKeyString(draw.texture)) ||
      { vertexCount: 0, indexCount: 0 }
  }

  releasePartitions(geometry) {
    if (geometry.partitions) geometry.partitions.forEach(part => {
      if (part.positionBuffer) this.gl.deleteBuffer(part.positionBuffer)
      if (part.uvBuffer) this.gl.deleteBuffer(part.uvBuffer)
      if (part.indexBuffer) this.gl.deleteBuffer(part.indexBuffer)
    })
    geometry.partitions = new Map()
    this.partitionBytes -= geometry.partitionBytes || 0
    geometry.partitionBytes = 0
  }

  rebuildImageryDraws() {
    if (!this.current) return
    const descriptor = this.options.textureDescriptor
    const matrixLevelOffset = Number.isInteger(
      descriptor && descriptor.matrix_level_offset)
      ? descriptor.matrix_level_offset : 0
    const sourceDraws = this.current.draws.map((draw) => {
      if (!draw.texture) return draw
      const matrix = draw.texture.level + matrixLevelOffset
      if (draw.texture.matrix === matrix) return draw
      return Object.assign({}, draw, {
        texture: Object.assign({}, draw.texture, { matrix })
      })
    })
    this.geometryCoverageDraws = sourceDraws.filter((draw) =>
      (draw.flags & DRAW_FLAG_COVERAGE) !== 0)
      .map((draw) => Object.assign({}, draw, {
        imageryCoverageDraw: true,
        imageryClipCell: false
      }))
    const targetDraws = sourceDraws.filter((draw) =>
      (draw.flags & DRAW_FLAG_COVERAGE) === 0)
    this.measurements.clear()
    this.projectionContext = surfacePlan.projectionContext(this.current.frame, {
      width: this.canvas.width, height: this.canvas.height,
      devicePixelRatio: this.options.devicePixelRatio || 1
    }, invertMatrix4(this.current.frame.projectionView))
    const result = (this.terrainBoundImagery ? refineImageryDraws : planImageryFrontier)(this.current.frame, targetDraws,
      this.current.positions, this.current.textureUv, {
        width: this.canvas.width,
        height: this.canvas.height,
        devicePixelRatio: this.options.devicePixelRatio || 1
      }, descriptor, {
        targetPixelError: this.options.imageryPixelError || 1.25,
        maximumSubdivisionLevels: this.options.maximumImagerySubdivisionLevels,
        maximumDraws: this.options.maximumImageryDraws,
        maximumTextures: this.textures.targetCapacity(),
        terrainBound: this.terrainBoundImagery,
        previousLevels: this.imageryLevels,
        measureDraw: draw => this.measureDraw(draw)
      })
    this.imageryLevels = result.levels
    this.plannedCameraVersion = this.cameraVersion
    this.renderDraws = result.draws
    // Resolve fallback per region instead of overlaying a whole coarse mesh.
    this.coverageDraws = []
    result.quality.terrainBound = this.terrainBoundImagery
    result.quality.coverageDrawCount = 0
    this.pendingQualityStats = result.quality
    const retainedDraws = this.displaySurface &&
      this.displaySurface.current !== this.current
      ? (this.displaySurface.geometryCoverageDraws || []).concat(
        this.displaySurface.coverageDraws || [],
        this.displaySurface.renderDraws) : null
    this.textures.sync(this.geometryCoverageDraws.concat(
      this.coverageDraws, this.renderDraws), (retainedDraws || []).concat(
        Array.from(this.presentedTextures.values()).map(texture => ({ texture }))))
    this.promoteCurrentSurfaceIfReady()
  }

  currentGeometryKeys() {
    if (!this.current) return new Set()
    return new Set(this.current.draws.map((draw) => draw.geometryKey)
      .filter((key) => Boolean(key)))
  }

  missingCurrentGeometryCount() {
    let missing = 0
    this.currentGeometryKeys().forEach((key) => {
      if (!this.geometry.has(key)) missing += 1
    })
    return missing
  }

  currentCoverageGeometryKeys() {
    return new Set(this.geometryCoverageDraws
      .map((draw) => draw.geometryKey)
      .filter((key) => Boolean(key)))
  }

  missingCurrentCoverageGeometryCount() {
    let missing = 0
    this.currentCoverageGeometryKeys().forEach((key) => {
      if (!this.geometry.has(key)) missing += 1
    })
    return missing
  }

  omittedCurrentGeometryCount() {
    return this.current && this.current.frame
      ? Math.max(0, Number(this.current.frame.omittedDrawCount) || 0) : 0
  }

  currentGeometryCoverageReady() {
    if (!this.current || !this.current.frame) return false
    if (typeof this.current.frame.coverageComplete === 'boolean') {
      return this.current.frame.coverageComplete
    }
    return this.omittedCurrentGeometryCount() === 0
  }

  currentGeometryReady() {
    if (!this.current || this.current.draws.length === 0) return false
    if (this.geometryCoverageDraws.length > 0) {
      if (!this.displaySurface) {
        return this.currentGeometryCoverageReady() &&
          this.missingCurrentCoverageGeometryCount() === 0
      }
      return this.currentGeometryCoverageReady() &&
        this.missingCurrentGeometryCount() === 0 &&
        this.omittedCurrentGeometryCount() === 0
    }
    return this.missingCurrentGeometryCount() === 0 &&
      this.omittedCurrentGeometryCount() === 0
  }

  currentTargetGeometryReady() {
    return Boolean(this.current && this.current.draws.length > 0) &&
      this.missingCurrentGeometryCount() === 0 &&
      this.omittedCurrentGeometryCount() === 0
  }

  updateGeometryPins() {
    const pinned = new Set()
    if (this.displaySurface && this.displaySurface.current) {
      this.displaySurface.current.draws.forEach((draw) => {
        if (draw.geometryKey) pinned.add(draw.geometryKey)
      })
    }
    this.currentGeometryKeys().forEach((key) => pinned.add(key))
    this.geometryPinnedKeys = pinned
    this.geometry.evict()
  }

  ensureCurrentGeometryQueued() {
    if (!this.current || this.missingCurrentGeometryCount() === 0) return
    const queued = new Set(this.uploadQueue.map((item) => item.key))
    let requiresQueue = false
    this.currentGeometryKeys().forEach((key) => {
      if (!this.geometry.has(key) && !queued.has(key)) requiresQueue = true
    })
    if (requiresQueue) {
      this.enqueueGeometry(this.current.draws, this.current.positions,
        this.current.textureUv)
    }
  }

  promoteCurrentSurfaceIfReady() {
    if (!this.currentGeometryReady()) return false
    const useGeometryCoverage = !this.currentTargetGeometryReady()
    if (this.displaySurface &&
      this.displaySurface.current === this.current &&
      this.displaySurface.renderDraws === this.renderDraws &&
      this.displaySurface.coverageDraws === this.coverageDraws &&
      this.displaySurface.geometryCoverageDraws ===
        this.geometryCoverageDraws &&
      this.displaySurface.useGeometryCoverage === useGeometryCoverage) {
      return true
    }
    this.uploadIndexBuffer(this.current.indices)
    this.displaySurface = {
      current: this.current,
      renderDraws: this.renderDraws,
      coverageDraws: this.coverageDraws,
      geometryCoverageDraws: this.geometryCoverageDraws,
      useGeometryCoverage,
      quality: this.pendingQualityStats
    }
    this.updateGeometryPins()
    this.qualityStats = Object.assign({}, this.pendingQualityStats)
    this.textures.sync(this.geometryCoverageDraws.concat(
      this.coverageDraws, this.renderDraws),
      Array.from(this.presentedTextures.values()).map(texture => ({ texture })))
    return true
  }

  setFrame(frame, draws, positions, textureUv, indices) {
    common.invariant(frame && draws && positions && textureUv && indices,
      'Renderer frame data is incomplete')
    this.cameraVersion += 1
    this.current = { frame, draws, positions, textureUv, indices }
    let startedAt = monotonicNow()
    this.enqueueGeometry(draws, positions, textureUv)
    this.updateGeometryPins()
    recordTiming(this.performanceStats.geometryPrepare,
      monotonicNow() - startedAt)
    startedAt = monotonicNow()
    this.rebuildImageryDraws()
    recordTiming(this.performanceStats.imageryRebuild,
      monotonicNow() - startedAt)
    this.requestRender()
  }

  setCameraFrame(snapshot) {
    common.invariant(this.current && snapshot && snapshot.cameraPosition &&
      snapshot.projectionView, 'Renderer camera snapshot is incomplete')
    this.cameraVersion += 1
    this.measurements.clear()
    this.current.frame = Object.assign({}, this.current.frame, {
      cameraPosition: snapshot.cameraPosition.slice(),
      projectionView: new Float64Array(snapshot.projectionView)
    })
    this.projectionContext = surfacePlan.projectionContext(this.current.frame, {
      width: this.canvas.width, height: this.canvas.height,
      devicePixelRatio: this.options.devicePixelRatio || 1
    }, invertMatrix4(this.current.frame.projectionView))
    this.requestRender()
  }

  setOverlays(overlays) {
    const value = overlays || {}
    this.overlays = {
      points: Array.isArray(value.points) ? value.points.slice() : [],
      route: value.route || null
    }
    this.requestRender()
  }

  requestRender() {
    this.requestRenderCallback()
  }

  render() {
    if (!this.gl || this.contextLost || !this.current) {
      return this.drawStats
    }
    const startedAt = monotonicNow()
    this.processUploads()
    const gl = this.gl
    const current = this.current
    this.promoteCurrentSurfaceIfReady()
    const surface = this.displaySurface
    const viewFrame = current.frame
    const relative = common.rowMajorToWebGlMatrix(
      common.relativeProjectionView(viewFrame.projectionView,
        viewFrame.cameraPosition))
    const stencil = typeof gl.stencilFunc === 'function'
    if (stencil) { gl.stencilMask(255); gl.clearStencil(0) }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | (stencil ? gl.STENCIL_BUFFER_BIT : 0))
    this.renderAtmosphere(relative, viewFrame.cameraPosition)
    if (!surface) {
      this.drawStats = { submitted: 0, queued: this.uploadQueue.length }
      this.recordRender(startedAt)
      return this.drawStats
    }
    gl.useProgram(this.program)
    gl.uniformMatrix4fv(this.uniforms.projectionView, false, relative)
    gl.uniform1i(this.uniforms.texture, 0)
    gl.uniform1f(this.uniforms.renderMode, this.mode === 'height' ? 1 : 0)
    gl.uniform2f(this.uniforms.heightRange,
      this.heightRange[0], this.heightRange[1])
    const altitude = Math.max(0,
      Math.hypot.apply(null, viewFrame.cameraPosition) - this.planetRadius)
    const fogDensity = this.atmosphereEnabled && this.atmosphere.fogEnabled
      ? this.atmosphere.seaLevelFogDensity *
        this.atmosphere.fogDensityMultiplier * Math.exp(-altitude / 8000)
      : 0
    gl.uniform1f(this.uniforms.fogDensity, fogDensity)
    gl.uniform3f(this.uniforms.fogColor,
      this.atmosphere.fogColor[0], this.atmosphere.fogColor[1],
      this.atmosphere.fogColor[2])
    gl.activeTexture(gl.TEXTURE0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    this.textures.beginFrame()
    const textureStatsBeforeRender = this.textures.stats()
    const targetTexturesReady = surface.current === current &&
      textureStatsBeforeRender.coverageReady &&
      textureStatsBeforeRender.targetMissing === 0 &&
      textureStatsBeforeRender.failed === 0
    const previewCoverage = !surface.useGeometryCoverage &&
      (this.plannedCameraVersion !== this.cameraVersion || surface.current !== current)
    const geometryCoverageDraws = surface.useGeometryCoverage || previewCoverage
      ? (surface.geometryCoverageDraws || []) : []
    const imageryCoverageDraws = this.mode === 'texture' &&
      !targetTexturesReady ? (surface.coverageDraws || []) : []
    const targetTerrainDraws = surface.useGeometryCoverage ? [] : (this.mode === 'texture'
      ? this.presentationDraws(surface.renderDraws)
      : surface.current.draws.filter((draw) =>
        (draw.flags & DRAW_FLAG_COVERAGE) === 0))
    let submitted = 0
    const terrainDraws = targetTerrainDraws.concat(geometryCoverageDraws)
      .filter(draw => this.terrainBoundImagery || this.measureDraw(draw).visible)
    if (previewCoverage && stencil) {
      gl.enable(gl.STENCIL_TEST)
      gl.stencilFunc(gl.ALWAYS, 1, 255)
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
    }
    const geometryCoverageDrawCount = geometryCoverageDraws.length
    const imageryCoverageDrawCount = imageryCoverageDraws.length
    const nextPresentedTextures = new Map()
    let maximumResolvedError = 0
    let fallbackCount = 0
    let missingCount = 0
    let minimumResolvedLevel = Number.POSITIVE_INFINITY
    let maximumResolvedLevel = Number.NEGATIVE_INFINITY
    for (let index = 0; index < terrainDraws.length; ++index) {
      const draw = terrainDraws[index]
      if (previewCoverage && stencil && (draw.flags & DRAW_FLAG_COVERAGE)) {
        // Fill only newly exposed pixels. A coarse root must never overwrite
        // detailed terrain or create z-fighting during camera-only motion.
        gl.stencilFunc(gl.EQUAL, 0, 255)
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP)
      }
      const geometry = this.geometry.get(draw.geometryKey)
      if (!geometry || !geometry.positionBuffer || !geometry.uvBuffer) {
        continue
      }
      const part = this.mode === 'texture' && draw.imageryClipCell
        ? this.partitionForDraw(geometry, draw) : null
      if (part && part.vertexCount === 0 && part.indexCount === 0) continue
      gl.bindBuffer(gl.ARRAY_BUFFER, geometry.positionBuffer)
      gl.enableVertexAttribArray(this.attributes.position)
      gl.vertexAttribPointer(this.attributes.position, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, geometry.uvBuffer)
      gl.enableVertexAttribArray(this.attributes.uv)
      gl.vertexAttribPointer(this.attributes.uv, 2, gl.FLOAT, false, 0, 0)
      gl.uniform3f(this.uniforms.origin,
        draw.origin[0] - viewFrame.cameraPosition[0],
        draw.origin[1] - viewFrame.cameraPosition[1],
        draw.origin[2] - viewFrame.cameraPosition[2])
      gl.uniform1f(this.uniforms.heightOrigin, draw.origin[2])
      gl.uniform2f(this.uniforms.cellUvScale,
        draw.imageryCellScale || 1, draw.imageryCellScale || 1)
      gl.uniform2f(this.uniforms.cellUvOffset,
        draw.imageryCellOffsetX || 0, draw.imageryCellOffsetY || 0)
      gl.uniform1f(this.uniforms.clipCell,
        0)
      const binding = this.textures.get(draw.texture)
      gl.uniform2f(this.uniforms.uvScale, binding.scale, binding.scale)
      gl.uniform2f(this.uniforms.uvOffset,
        binding.offsetX, binding.offsetY)
      gl.uniform1f(this.uniforms.debugMode,
        this.debugOptions.textureState ? 1 : 0)
      gl.uniform1f(this.uniforms.textureState,
        binding.kind === 'exact' ? 0 : (binding.kind === 'fallback' ? 1 : 2))
      if (binding.kind === 'fallback') fallbackCount += 1
      if (binding.kind === 'missing') missingCount += 1
      if (binding.resolvedLevel >= 0) {
        minimumResolvedLevel = Math.min(minimumResolvedLevel,
          binding.resolvedLevel)
        maximumResolvedLevel = Math.max(maximumResolvedLevel,
          binding.resolvedLevel)
        maximumResolvedError = Math.max(maximumResolvedError,
          this.measureTextureDraw(draw, binding.resolvedLevel))
        if (binding.resolvedTile) nextPresentedTextures.set(
          common.textureKeyString(binding.resolvedTile), binding.resolvedTile)
      } else {
        maximumResolvedError = Number.POSITIVE_INFINITY
      }
      gl.bindTexture(gl.TEXTURE_2D, binding.texture)
      if (part) {
        if (part.indexCount) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.indexBuffer)
          gl.drawElements(gl.TRIANGLES, part.indexCount, gl.UNSIGNED_SHORT, 0)
        }
        if (part.vertexCount) {
          gl.bindBuffer(gl.ARRAY_BUFFER, part.positionBuffer)
          gl.vertexAttribPointer(this.attributes.position, 3, gl.FLOAT, false, 0, 0)
          gl.bindBuffer(gl.ARRAY_BUFFER, part.uvBuffer)
          gl.vertexAttribPointer(this.attributes.uv, 2, gl.FLOAT, false, 0, 0)
          gl.drawArrays(gl.TRIANGLES, 0, part.vertexCount)
        }
      } else {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
        gl.drawElements(gl.TRIANGLE_STRIP, draw.indexCount, gl.UNSIGNED_SHORT, draw.firstIndex * 2)
      }
      submitted += 1
    }
    if (previewCoverage && stencil) gl.disable(gl.STENCIL_TEST)
    this.presentedCameraVersion = this.cameraVersion
    const changedPresentation = nextPresentedTextures.size !== this.presentedTextures.size ||
      Array.from(nextPresentedTextures.keys()).some(key => !this.presentedTextures.has(key))
    this.presentedTextures = nextPresentedTextures
    if (changedPresentation) {
      this.textures.sync(this.geometryCoverageDraws.concat(this.renderDraws),
        Array.from(nextPresentedTextures.values()).map(texture => ({ texture })))
    }
    const coverageSubmitted = geometryCoverageDrawCount
    if (coverageSubmitted > 0) {
      maximumResolvedError = Number.POSITIVE_INFINITY
    }
    const terrainSubmitted = submitted
    submitted += this.renderOverlays(relative, viewFrame.cameraPosition)
    const error = gl.getError()
    if (error !== gl.NO_ERROR) {
      this.onDiagnostic('webgl_error', { error })
    }
    this.drawStats = { submitted, queued: this.uploadQueue.length }
    this.qualityStats = Object.assign({}, surface.quality, {
      resolvedMaxPixelError: maximumResolvedError,
      renderedDrawCount: terrainSubmitted,
      meetsTarget: Number.isFinite(maximumResolvedError) && maximumResolvedError <=
        surface.quality.targetPixelError * 1.001,
      limitedByGeometryBudget: this.partitionBudgetLimited,
      coverageSubmitted,
      geometryCoverageSubmitted: geometryCoverageDrawCount,
      imageryCoverageSubmitted: imageryCoverageDrawCount,
      fallbackCount,
      missingCount,
      resolvedLevelMinimum: Number.isFinite(minimumResolvedLevel)
        ? minimumResolvedLevel : null,
      resolvedLevelMaximum: Number.isFinite(maximumResolvedLevel)
        ? maximumResolvedLevel : null
    })
    this.recordRender(startedAt)
    return this.drawStats
  }

  recordRender(startedAt) {
    const now = monotonicNow()
    recordTiming(this.performanceStats.render, now - startedAt)
    if (this.performanceStats.lastFrameAt > 0) {
      const interval = now - this.performanceStats.lastFrameAt
      if (interval > 0 && interval <= 250) {
        const previous = this.performanceStats.frameIntervalMs
        this.performanceStats.frameIntervalMs = previous > 0
          ? previous * 0.85 + interval * 0.15 : interval
        this.performanceStats.framesPerSecond =
          1000 / this.performanceStats.frameIntervalMs
      } else if (interval > 250) {
        this.performanceStats.frameIntervalMs = 0
        this.performanceStats.framesPerSecond = 0
      }
    }
    this.performanceStats.lastFrameAt = now
  }

  renderAtmosphere(projectionView, cameraPosition) {
    if (!this.atmosphereEnabled || !this.atmosphereProgram ||
      !this.atmosphereBuffer || !this.atmosphereTexture) {
      return
    }
    const gl = this.gl
    const inverse = invertMatrix4(projectionView)
    const up = normalized(cameraPosition)
    let east = normalized([up[2], 0, -up[0]])
    if (Math.hypot(east[0], east[1], east[2]) < 0.5) {
      east = [1, 0, 0]
    }
    const north = normalized(cross(up, east))
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.useProgram(this.atmosphereProgram)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.atmosphereBuffer)
    gl.enableVertexAttribArray(this.atmosphereAttributes.clipPosition)
    gl.vertexAttribPointer(this.atmosphereAttributes.clipPosition,
      2, gl.FLOAT, false, 0, 0)
    gl.uniformMatrix4fv(
      this.atmosphereUniforms.inverseProjectionView, false, inverse)
    gl.uniform3f(this.atmosphereUniforms.cameraScaled,
      cameraPosition[0] / this.planetRadius,
      cameraPosition[1] / this.planetRadius,
      cameraPosition[2] / this.planetRadius)
    gl.uniform3f(this.atmosphereUniforms.east, east[0], east[1], east[2])
    gl.uniform3f(this.atmosphereUniforms.north,
      north[0], north[1], north[2])
    gl.uniform3f(this.atmosphereUniforms.up, up[0], up[1], up[2])
    gl.uniform3f(this.atmosphereUniforms.sunDirection,
      this.atmosphere.sunDirection[0], this.atmosphere.sunDirection[1],
      this.atmosphere.sunDirection[2])
    gl.uniform1f(this.atmosphereUniforms.sunVisible,
      this.atmosphere.sunVisible ? 1 : 0)
    gl.uniform1i(this.atmosphereUniforms.skyTexture, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.atmosphereTexture)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.depthMask(true)
    gl.enable(gl.DEPTH_TEST)
  }

  renderOverlays(projectionView, cameraPosition) {
    const gl = this.gl
    if (!this.overlays || (!this.overlays.points.length &&
      !(this.overlays.route && this.overlays.route.worlds.length))) {
      return 0
    }
    gl.useProgram(this.overlayProgram)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.uniformMatrix4fv(this.overlayUniforms.projectionView, false,
      projectionView)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuffer)
    gl.enableVertexAttribArray(this.overlayAttributes.position)
    gl.vertexAttribPointer(this.overlayAttributes.position, 3, gl.FLOAT,
      false, 0, 0)
    let submitted = 0
    const relativeValues = (worlds) => {
      const values = new Float32Array(worlds.length * 3)
      worlds.forEach((world, index) => {
        values[index * 3] = world[0] - cameraPosition[0]
        values[index * 3 + 1] = world[1] - cameraPosition[1]
        values[index * 3 + 2] = world[2] - cameraPosition[2]
      })
      return values
    }
    const route = this.overlays.route
    if (route && route.worlds.length >= 2) {
      const values = relativeValues(route.worlds)
      const color = colorComponents(route.color, route.opacity)
      gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW)
      gl.uniform1f(this.overlayUniforms.pointSize, 1)
      gl.uniform4f(this.overlayUniforms.color,
        color[0], color[1], color[2], color[3])
      gl.lineWidth(common.clamp(route.widthPixels || 1, 1, 8))
      gl.drawArrays(gl.LINE_STRIP, 0, route.worlds.length)
      submitted += 1
    }
    if (this.overlays.points.length) {
      const values = relativeValues(this.overlays.points.map(
        (point) => point.world))
      gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW)
      gl.uniform1f(this.overlayUniforms.pointSize, 12)
      gl.uniform4f(this.overlayUniforms.color, 0.1, 0.85, 0.95, 1)
      gl.drawArrays(gl.POINTS, 0, this.overlays.points.length)
      submitted += 1
    }
    gl.disable(gl.BLEND)
    gl.useProgram(this.program)
    return submitted
  }

  enqueueGeometry(draws, positions, textureUv) {
    const wanted = new Set()
    const queued = new Set(this.uploadQueue.map((item) => item.key))
    const additions = []
    for (let index = 0; index < draws.length; ++index) {
      const draw = draws[index]
      const key = geometryKey(draw)
      draw.geometryKey = key
      wanted.add(key)
      if (this.geometry.has(key) || queued.has(key)) {
        continue
      }
      const positionStart = draw.firstVertex * 3
      const positionEnd = positionStart + draw.vertexCount * 3
      const uvStart = draw.firstVertex * 2
      const uvEnd = uvStart + draw.vertexCount * 2
      const localPositions = positions.slice(positionStart, positionEnd)
      const localUv = textureUv.slice(uvStart, uvEnd)
      const model = surfacePlan.prepareSurface(localPositions, localUv,
        this.current.indices, draw.firstIndex, draw.indexCount)
      additions.push({ key, positions: localPositions, uv: localUv, model })
      queued.add(key)
    }
    this.uploadQueue = this.uploadQueue.filter((item) => wanted.has(item.key))
    this.uploadQueue.push(...additions)
  }

  processUploads() {
    const deadline = Date.now() + (this.options.uploadBudgetMs || 6)
    while (this.uploadQueue.length && Date.now() <= deadline) {
      const item = this.uploadQueue.shift()
      if (this.geometry.has(item.key)) {
        continue
      }
      const gl = this.gl
      const positionBuffer = gl.createBuffer()
      const uvBuffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, item.positions, gl.STATIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, item.uv, gl.STATIC_DRAW)
      this.geometry.set(item.key, {
        positionBuffer,
        uvBuffer,
        positions: item.positions,
        uv: item.uv,
        model: item.model,
        partitions: new Map()
      }, item.positions.byteLength + item.uv.byteLength)
    }
    this.ensureCurrentGeometryQueued()
    if (this.uploadQueue.length) {
      this.requestRender()
    }
  }

  uploadIndexBuffer(indices) {
    if (!this.gl || !this.indexBuffer) {
      return
    }
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, indices, this.gl.STATIC_DRAW)
  }

  createFallbackTexture() {
    const gl = this.gl
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
      gl.UNSIGNED_BYTE, new Uint8Array([25, 68, 98, 255]))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return texture
  }

  createAtmosphereTexture() {
    const gl = this.gl
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA,
      this.atmosphere.width, this.atmosphere.height, 0, gl.RGBA,
      gl.UNSIGNED_BYTE, this.atmosphere.rgba)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return texture
  }

  uploadTexture(image, width, height) {
    this.performanceStats.textureUploads += 1
    const gl = this.gl
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    // Surface-mesh V=0 is north; preserving the source's top row keeps rows aligned.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    const mipmapped = isPowerOfTwo(width) && isPowerOfTwo(height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
      mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (mipmapped) {
      gl.generateMipmap(gl.TEXTURE_2D)
    }
    return texture
  }

  contextWasLost(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault()
    }
    this.contextLost = true
    this.onContextChange({ lost: true })
  }

  contextWasRestored() {
    try {
      this.contextLost = false
      this.geometry.clear()
      this.uploadQueue = []
      this.displaySurface = null
      this.presentedTextures.clear()
      this.presentedCameraVersion = -1
      this.initialize()
      this.textures.restoreContext()
      if (this.current) {
        this.enqueueGeometry(this.current.draws, this.current.positions,
          this.current.textureUv)
        this.updateGeometryPins()
      }
      this.onContextChange({ lost: false })
      this.requestRender()
    } catch (error) {
      this.contextLost = true
      this.onDiagnostic('webgl_context_restore_failed', {
        message: error.message || String(error)
      })
    }
  }

  disposeGeometry(value) {
    if (!value || !this.gl) {
      return
    }
    this.releasePartitions(value)
    if (value.positionBuffer) {
      this.gl.deleteBuffer(value.positionBuffer)
    }
    if (value.uvBuffer) {
      this.gl.deleteBuffer(value.uvBuffer)
    }
  }

  destroy() {
    this.textures.clear()
    this.geometry.clear()
    this.uploadQueue = []
    if (this.canvas && typeof this.canvas.removeEventListener === 'function') {
      this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
      this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored)
    }
    if (this.gl) {
      if (this.indexBuffer) {
        this.gl.deleteBuffer(this.indexBuffer)
      }
      if (this.overlayBuffer) {
        this.gl.deleteBuffer(this.overlayBuffer)
      }
      if (this.atmosphereBuffer) {
        this.gl.deleteBuffer(this.atmosphereBuffer)
      }
      if (this.atmosphereTexture) {
        this.gl.deleteTexture(this.atmosphereTexture)
      }
      if (this.atmosphereProgram) {
        this.gl.deleteProgram(this.atmosphereProgram)
      }
      if (this.fallbackTexture) {
        this.gl.deleteTexture(this.fallbackTexture)
      }
      if (this.program) {
        this.gl.deleteProgram(this.program)
      }
      if (this.overlayProgram) {
        this.gl.deleteProgram(this.overlayProgram)
      }
    }
    this.gl = null
  }

  stats() {
    const textureStats = this.textures.stats()
    const targetCoverage = textureStats.targetDesired > 0
      ? textureStats.cachedTarget / textureStats.targetDesired : 1
    const resolvedError = this.qualityStats.resolvedMaxPixelError
    const hasResolvedError = typeof resolvedError === 'number'
    const withinTransitionTolerance = !hasResolvedError ||
      (Number.isFinite(resolvedError) && resolvedError <=
        this.qualityStats.targetPixelError * 2)
    const displayingCurrent = Boolean(this.displaySurface &&
      this.displaySurface.current === this.current)
    const geometryCoverageReady = this.currentGeometryCoverageReady()
    const geometryTargetComplete = this.omittedCurrentGeometryCount() === 0 &&
      Boolean(this.current) && this.current.frame.decisionsComplete !== false &&
      !(this.current.frame.requestCount > 0)
    const transitionCoverageSubmitted =
      (this.qualityStats.coverageSubmitted || 0) > 0
    const covered = textureStats.coverageReady &&
      textureStats.missingRatio === 0 && displayingCurrent &&
      this.currentGeometryReady()
    const resourceStable = textureStats.targetMissing === 0 &&
      textureStats.stagedTiles === 0 && textureStats.frontierTiles === 0 &&
      geometryTargetComplete
    const requestIdle = textureStats.active === 0 && textureStats.queued === 0
    const cameraCurrent = this.presentedCameraVersion === this.cameraVersion &&
      this.plannedCameraVersion === this.cameraVersion
    const targetMet = cameraCurrent && hasResolvedError && Number.isFinite(resolvedError) &&
      resolvedError <= this.qualityStats.targetPixelError * 1.001
    const ready = !this.interactionActive &&
      covered &&
      geometryTargetComplete &&
      this.currentTargetGeometryReady() &&
      !transitionCoverageSubmitted &&
      targetMet &&
      !textureStats.blockedByFailure &&
      textureStats.state !== 'blocked-capacity' &&
      !textureStats.limitedByCapacity &&
      targetCoverage >= 0.95 &&
      textureStats.fallbackRatio <= 0.05 &&
      (!hasResolvedError || Number.isFinite(resolvedError)) &&
      textureStats.failed === 0
    const settled = ready && resourceStable &&
      textureStats.fallbackRatio === 0
    const state = textureStats.blockedByFailure ? 'degraded'
      : (this.interactionActive ? 'interacting'
        : (textureStats.state === 'blocked-capacity' ? 'blocked-capacity'
          : (ready ? 'ready' : (!covered ? 'loading'
            : (!resourceStable || !cameraCurrent ? 'refining' : 'limited')))))
    const quality = Object.assign({}, this.qualityStats, {
      cameraCurrent,
      cameraVersion: this.cameraVersion,
      presentedCameraVersion: this.presentedCameraVersion,
      plannedCameraVersion: this.plannedCameraVersion,
      interactionActive: this.interactionActive,
      textureState: textureStats.state,
      coverageReady: textureStats.coverageReady,
      coarseCoverageReady: textureStats.coarseCoverageReady,
      limitedByCache: textureStats.limitedByCapacity,
      withinTransitionTolerance,
      targetCoverage,
      geometryCoverageReady,
      geometryTargetComplete,
      transitionCoverageSubmitted,
      covered,
      resourceStable,
      requestIdle,
      quiescent: resourceStable && requestIdle && cameraCurrent && !this.interactionActive,
      targetMet,
      state,
      ready,
      settled
    })
    return {
      geometry: this.geometry.stats(),
      textures: textureStats,
      quality,
      draws: this.drawStats,
      overlays: {
        points: this.overlays.points.length,
        routeVertices: this.overlays.route ?
          this.overlays.route.worlds.length : 0
      },
      atmosphere: {
        capable: this.atmosphereCapable,
        enabled: this.atmosphereEnabled,
        sunVisible: this.atmosphere.sunVisible,
        fogEnabled: this.atmosphere.fogEnabled,
        source: this.atmosphere.width > 2 ? 'terra-core' : 'fallback'
      },
      performance: {
        textureUploads: this.performanceStats.textureUploads,
        partitionBuilds: this.performanceStats.partitionBuilds,
        partitionBytes: this.partitionBytes,
        render: Object.assign({}, this.performanceStats.render),
        geometryPrepare: Object.assign({},
          this.performanceStats.geometryPrepare),
        imageryRebuild: Object.assign({},
          this.performanceStats.imageryRebuild),
        frameIntervalMs: this.performanceStats.frameIntervalMs,
        framesPerSecond: this.performanceStats.framesPerSecond
      },
      transition: {
        displayingPreviousFrame: Boolean(this.displaySurface &&
          this.displaySurface.current !== this.current),
        pendingGeometry: this.missingCurrentGeometryCount(),
        pendingCoverageGeometry: this.missingCurrentCoverageGeometryCount(),
        omittedGeometry: this.omittedCurrentGeometryCount(),
        expectedGeometry: this.current && this.current.frame
          ? Number(this.current.frame.expectedDrawCount) || 0 : 0,
        coverageGeometry: this.current && this.current.frame
          ? Number(this.current.frame.coverageDrawCount) || 0 : 0,
        coverageComplete: this.currentGeometryCoverageReady(),
        queuedGeometry: this.uploadQueue.length,
        pinnedGeometry: this.geometryPinnedKeys.size
      },
      mode: this.mode
    }
  }
}

module.exports = {
  ancestorTextureTiles,
  ancestorUvTransform,
  descendantTextureTile,
  globalCoverageTextureTiles,
  invertMatrix4,
  projectedDrawExtent,
  textureTileContains,
  maximumTerrainTextureLevel,
  refineImageryDraws,
  planImageryFrontier,
  TerraWebGlRenderer,
  geometryKey,
  isPowerOfTwo
}
