const {invariant} = require('../../sdk/js/core/terra_globe_common')
const {depthEncoding} = require('../../sdk/js/camera/depth_encoding')

// Perspective interpolation of clip W recovers fragment eye distance. Use an
// explicit highp varying: GLSL ES1 gl_FragCoord is only mediump by contract.
// Never interpolate logs or change homogeneous clipping coordinates.
const DEPTH_VARYING = `#ifdef LOG_DEPTH
varying highp float v_eye_depth;
#endif`
const DEPTH_VERTEX = `#ifdef LOG_DEPTH
v_eye_depth=gl_Position.w;
#endif`
const DEPTH_DECLARATION = `#ifdef LOG_DEPTH
uniform highp float u_log_depth;
#endif
${DEPTH_VARYING}`
const DEPTH_WRITE = `#ifdef LOG_DEPTH
gl_FragDepthEXT=clamp(log2(1.0+v_eye_depth)*u_log_depth,0.0,1.0);
#endif`

const UV_UNIFORMS = 'uniform vec2 u_cell_uv_scale,u_cell_uv_offset,u_uv_scale,u_uv_offset,u_old_uv_scale,u_old_uv_offset;'
// Centroid keeps MSAA interpolation inside the original primitive. WebGL1
// uses geometric clipping; fragment highp alone does not provide this guarantee.
const UV_VARYINGS = `#ifdef SOURCE_UV
centroid varying highp vec2 v_source,v_cell;
#else
varying mediump vec2 v_cell;
varying mediump vec2 v_uv;
varying mediump vec2 v_old;
#endif
varying mediump float v_height,v_fog;`

const VERTEX_SHADER = `attribute vec3 a_position;
attribute vec2 a_uv;
uniform mat4 u_projection_view;
uniform vec3 u_origin;
uniform float u_height_origin,u_fog_density;
${UV_UNIFORMS}
${UV_VARYINGS}
${DEPTH_VARYING}
void main() {
vec3 relative=a_position+u_origin;
gl_Position=u_projection_view*vec4(relative,1.0);
${DEPTH_VERTEX}
v_cell=a_uv*u_cell_uv_scale+u_cell_uv_offset;
#ifdef SOURCE_UV
v_source=a_uv;
#else
v_uv=v_cell*u_uv_scale+u_uv_offset;
v_old=v_cell*u_old_uv_scale+u_old_uv_offset;
#endif
v_height=a_position.z+u_height_origin;
v_fog=exp(-u_fog_density*length(relative));
}`

const FRAGMENT_SHADER = `#if defined(SOURCE_UV) || defined(LOG_DEPTH)
precision highp float;
#else
precision mediump float;
#endif
#ifdef SOURCE_UV
${UV_UNIFORMS}
uniform bool u_clip_cell;
#endif
${DEPTH_DECLARATION}
uniform sampler2D u_texture;
uniform sampler2D u_old_texture;
uniform float u_texture_mix,u_render_mode,u_debug_mode,u_texture_state;
uniform vec2 u_height_range;
uniform vec3 u_fog_color;
${UV_VARYINGS}
void main() {
if (u_render_mode>0.5) {
float value=clamp((v_height-u_height_range.x)/
max(0.001,u_height_range.y-u_height_range.x),0.0,1.0);
vec3 low=vec3(0.08,0.28,0.42);
vec3 middle=vec3(0.35,0.62,0.30);
vec3 high=vec3(0.94,0.91,0.78);
gl_FragColor=vec4(value<0.5?mix(low,middle,value*2.0):
mix(middle,high,(value-0.5)*2.0),1.0);
} else {
#ifdef SOURCE_UV
vec2 lo=-u_cell_uv_offset/u_cell_uv_scale;
vec2 hi=(1.0-u_cell_uv_offset)/u_cell_uv_scale;
vec2 cell=u_clip_cell?v_source*u_cell_uv_scale+u_cell_uv_offset:v_cell;
vec2 v_uv=cell*u_uv_scale+u_uv_offset;
vec2 v_old=cell*u_old_uv_scale+u_old_uv_offset;
#else
vec2 cell=v_cell;
#endif
vec4 color=texture2D(u_texture,v_uv);
if (u_texture_mix<1.0) color=mix(
texture2D(u_old_texture,v_old),color,u_texture_mix);
#ifdef SOURCE_UV
if (u_clip_cell&&((lo.x>0.0&&v_source.x<lo.x)||
(lo.y>0.0&&v_source.y<lo.y)||
(hi.x<1.0&&v_source.x>=hi.x)||
(hi.y<1.0&&v_source.y>=hi.y))) discard;
#endif
if (u_debug_mode>0.5) {
float edge=min(min(cell.x,1.0-cell.x),
min(cell.y,1.0-cell.y));
vec3 stateColor=u_texture_state<0.5?vec3(0.1,0.9,0.4):
(u_texture_state<1.5?vec3(1.0,0.65,0.1):vec3(1.0,0.2,0.2));
color.rgb=mix(color.rgb,stateColor,edge<0.008?0.85:0.12);
}
gl_FragColor=color;
}
gl_FragColor.rgb=mix(u_fog_color,gl_FragColor.rgb,
clamp(v_fog,0.0,1.0));
${DEPTH_WRITE}
}`

const ATMOSPHERE_VERTEX_SHADER = `attribute vec2 a_clip_position;
varying highp vec2 v_clip_position;
void main() {
v_clip_position=a_clip_position;
gl_Position=vec4(a_clip_position,1.0,1.0);
}`

const ATMOSPHERE_FRAGMENT_SHADER = `precision highp float;
uniform mat4 u_inverse_projection_view;
uniform vec3 u_camera_scaled,u_east,u_north,u_up,u_sun_direction;
uniform float u_sun_visible;
uniform sampler2D u_sky_texture;
varying highp vec2 v_clip_position;
void main() {
vec4 nearPoint=u_inverse_projection_view*
vec4(v_clip_position,-1.0,1.0);
vec4 farPoint=u_inverse_projection_view*
vec4(v_clip_position,1.0,1.0);
vec3 nearWorld=nearPoint.xyz/nearPoint.w;
vec3 farWorld=farPoint.xyz/farPoint.w;
vec3 ray=normalize(farWorld-nearWorld);
vec3 localRay=vec3(dot(ray,u_east),dot(ray,u_north),
dot(ray,u_up));
float azimuth=fract(atan(localRay.x,localRay.y)/
6.28318530718+1.0);
float zenith=clamp(acos(clamp(localRay.z,-1.0,1.0))/
1.57079632679,0.0,1.0);
vec3 sky=texture2D(u_sky_texture,vec2(azimuth,zenith)).rgb;
float radius=length(u_camera_scaled);
float shellRadius=1.025;
float offset=dot(u_camera_scaled,ray);
float closest=sqrt(max(0.0,dot(u_camera_scaled,
u_camera_scaled)-offset*offset));
float discriminant=offset*offset -
(dot(u_camera_scaled,u_camera_scaled)-shellRadius*shellRadius);
float exitDistance=-offset+sqrt(max(0.0,discriminant));
float intersects=step(0.0,discriminant)*step(0.0,exitDistance);
float limb=pow(clamp((shellRadius-closest)/
(shellRadius-1.0),0.0,1.0),0.35);
float atmosphere=radius<=shellRadius?1.0:intersects*limb;
vec3 color=mix(vec3(0.003,0.007,0.016),sky,atmosphere);
float sunAngle=dot(localRay,normalize(u_sun_direction));
float sunHalo=smoothstep(0.9903,0.9992,sunAngle)*
u_sun_visible;
float sunDisc=smoothstep(0.9992,0.9999,sunAngle)*
u_sun_visible;
color+=vec3(1.0,0.58,0.18)*sunHalo*0.28;
color=mix(color,vec3(1.0,0.94,0.72),sunDisc);
gl_FragColor=vec4(color,1.0);
}`

const OVERLAY_VERTEX_SHADER = `attribute vec3 a_position;
uniform vec3 u_origin;
uniform mat4 u_projection_view;
uniform float u_point_size;
${DEPTH_VARYING}
void main() {
gl_Position=u_projection_view*vec4(a_position+u_origin,1.0);
${DEPTH_VERTEX}
gl_PointSize=u_point_size;
}`

const OVERLAY_FRAGMENT_SHADER = `#ifdef LOG_DEPTH
precision highp float;
#else
precision mediump float;
#endif
uniform vec4 u_color;
${DEPTH_DECLARATION}
void main() { gl_FragColor=u_color;
${DEPTH_WRITE}
}`

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

function createProgram(gl, vertexSource = VERTEX_SHADER, fragmentSource = FRAGMENT_SHADER) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
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

// Validate each program's declared interface in one place. Shader names stay
// explicit; camel-case properties are only the host-side binding convention.
function locations(gl, program, attributes, uniforms, label) {
  const bind = (names, attribute) => {
    const result = {}
    for (const name of names.split(' ')) {
      const value = attribute ? gl.getAttribLocation(program, 'a_' + name) : gl.getUniformLocation(program, 'u_' + name)
      invariant(attribute ? value >= 0 : value !== null, 'WebGL ' + label + ' shader locations are incomplete')
      result[name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    }
    return result
  }
  return {attributes: bind(attributes, true), uniforms: bind(uniforms, false)}
}

function initializePrograms(renderer, providedGl) {
  const attributes = {
    alpha: false,
    antialias: true,
    depth: true,
    stencil: true,
    preserveDrawingBuffer: false
  }
  let gl = providedGl
  for (const type of ['webgl2', 'webgl']) {
    if (gl) break
    try { gl = renderer.canvas.getContext(type, attributes) } catch (_) { /* unsupported context type */ }
  }
  if (!gl) {
    throw new Error('WebGL context creation failed')
  }
  renderer.gl = gl
  // A canvas can return the context used by a destroyed renderer. Deleting
  // its buffers does not disable vertex arrays, so the first sky draw would
  // inherit enabled inputs with no live buffer (INVALID_OPERATION). Establish
  // the initial input state once, including when a context is restored.
  for (let index = 0; index < gl.getParameter(gl.MAX_VERTEX_ATTRIBS); ++index) {
    gl.disableVertexAttribArray(index)
  }
  renderer.asyncGpu = ['fenceSync', 'clientWaitSync', 'deleteSync', 'flush'].every(name => typeof gl[name] === 'function')
  const precision = gl.getShaderPrecisionFormat && gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)
  renderer.sourceUvPartitions = !!gl.texStorage2D && !!precision && precision.precision >= 23
  renderer.depthSupported = Boolean(precision && precision.precision >= 23 &&
    (gl.texStorage2D || gl.getExtension && gl.getExtension('EXT_frag_depth')))
  renderer.surfacePrograms = []
  for (const logarithmic of renderer.depthSupported ? [false, true] : [false]) {
    const modern = Boolean(gl.texStorage2D), define = logarithmic ? '#define LOG_DEPTH\n' : ''
    const program = (vertex, fragment, uv) => {
      const defines = define + (uv && renderer.sourceUvPartitions ? '#define SOURCE_UV\n' : '')
      if (modern) return createProgram(gl,
        '#version 300 es\n' + defines + vertex.replace(/attribute/g, 'in').replace(/varying/g, 'out'),
        '#version 300 es\n' + defines + 'out highp vec4 pixel;\n' + fragment.replace(/varying/g, 'in')
          .replace(/texture2D/g, 'texture').replace(/gl_FragColor/g, 'pixel').replace(/gl_FragDepthEXT/g, 'gl_FragDepth'))
      return createProgram(gl, defines + vertex,
        (logarithmic ? '#extension GL_EXT_frag_depth : require\n' : '') + defines + fragment)
    }
    const terrainProgram = program(VERTEX_SHADER, FRAGMENT_SHADER, true)
    // Register handles immediately so initialization failure can retire them.
    const value = {program: terrainProgram}
    renderer.surfacePrograms.push(value)
    value.overlayProgram = program(OVERLAY_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER, false)
    const terrain = locations(gl, terrainProgram, 'position uv',
      'projection_view origin height_origin cell_uv_scale cell_uv_offset uv_scale uv_offset texture old_texture old_uv_scale old_uv_offset texture_mix render_mode height_range debug_mode texture_state fog_density fog_color' +
      (renderer.sourceUvPartitions ? ' clip_cell' : '') + (logarithmic ? ' log_depth' : ''), 'terrain')
    value.attributes = terrain.attributes; value.uniforms = terrain.uniforms
    const overlay = locations(gl, value.overlayProgram, 'position',
      'origin projection_view point_size color' + (logarithmic ? ' log_depth' : ''), 'overlay')
    value.overlayAttributes = overlay.attributes; value.overlayUniforms = overlay.uniforms
  }
  Object.assign(renderer, renderer.surfacePrograms[0])
  renderer.visibility = renderer.options.createTerrainVisibility && renderer.options.createTerrainVisibility(renderer)
  if (renderer.atmosphereCapable) {
    renderer.atmosphereProgram = createProgram(gl, ATMOSPHERE_VERTEX_SHADER, ATMOSPHERE_FRAGMENT_SHADER)
  }
  if (renderer.atmosphereProgram) {
    const sky = locations(gl, renderer.atmosphereProgram, 'clip_position',
      'inverse_projection_view camera_scaled east north up sun_direction sun_visible sky_texture', 'atmosphere')
    renderer.atmosphereAttributes = sky.attributes; renderer.atmosphereUniforms = sky.uniforms
  }
  renderer.overlayBuffer = null
  renderer.overlayData = null
  renderer.fallbackTexture = renderer.createFallbackTexture()
  if (renderer.atmosphereProgram) {
    renderer.atmosphereBuffer = renderer.allocateResources('atmosphere', resources =>
      resources.buffer(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 3, -1, -1, 3
      ])))
    renderer.atmosphereTexture = renderer.createAtmosphereTexture()
    renderer.uploadedAtmosphere = renderer.atmosphere
  }
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)
  gl.disable(gl.CULL_FACE)
  gl.clearColor(0.025, 0.045, 0.07, 1.0)
}

function selectDepthPrograms(renderer, frame) {
  renderer.depthState = depthEncoding(frame, renderer.depthSupported)
  Object.assign(renderer, renderer.surfacePrograms[renderer.depthState.factor ? 1 : 0])
}

module.exports = {initializePrograms, selectDepthPrograms}
