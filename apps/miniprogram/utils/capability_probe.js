const VERTEX_SHADER = [
  'attribute vec2 a_position;',
  'attribute vec3 a_color;',
  'varying lowp vec3 v_color;',
  'void main() {',
  '  gl_Position = vec4(a_position, 0.0, 1.0);',
  '  v_color = a_color;',
  '}'
].join('\n')

const FRAGMENT_SHADER = [
  'precision mediump float;',
  'varying lowp vec3 v_color;',
  'void main() {',
  '  gl_FragColor = vec4(v_color, 1.0);',
  '}'
].join('\n')

function errorMessage(error) {
  if (!error) {
    return 'Unknown error'
  }
  return error.message || String(error)
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Shader compilation failed'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

function createProgram(gl) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  const program = gl.createProgram()
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  gl.deleteShader(vertexShader)
  gl.deleteShader(fragmentShader)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Program link failed'
    gl.deleteProgram(program)
    throw new Error(message)
  }
  return program
}

function fnv1aSample(bytes, stride) {
  let hash = 0x811c9dc5
  const step = Math.max(1, stride || 1)
  for (let index = 0; index < bytes.length; index += step) {
    hash ^= bytes[index]
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function framebufferStats(pixels) {
  const pixelStride = 64
  const byteStride = pixelStride * 4
  let varyingSamples = 0
  const reference = [pixels[0], pixels[1], pixels[2], pixels[3]]

  for (let index = 0; index < pixels.length; index += byteStride) {
    const difference =
      Math.abs(pixels[index] - reference[0]) +
      Math.abs(pixels[index + 1] - reference[1]) +
      Math.abs(pixels[index + 2] - reference[2]) +
      Math.abs(pixels[index + 3] - reference[3])
    if (difference > 8) {
      varyingSamples += 1
    }
  }

  return {
    checksum: fnv1aSample(pixels, byteStride),
    samplePixelStride: pixelStride,
    varyingSamples
  }
}

function collectSystemInfo() {
  const hasModernInfo =
    typeof wx.getDeviceInfo === 'function' &&
    typeof wx.getAppBaseInfo === 'function' &&
    typeof wx.getWindowInfo === 'function'
  const fallback = !hasModernInfo &&
    typeof wx.getSystemInfoSync === 'function'
    ? wx.getSystemInfoSync()
    : {}
  const device = typeof wx.getDeviceInfo === 'function'
    ? wx.getDeviceInfo()
    : fallback
  const app = typeof wx.getAppBaseInfo === 'function'
    ? wx.getAppBaseInfo()
    : fallback
  const windowInfo = typeof wx.getWindowInfo === 'function'
    ? wx.getWindowInfo()
    : fallback

  return {
    platform: device.platform || '',
    brand: device.brand || '',
    model: device.model || '',
    system: device.system || '',
    benchmarkLevel: device.benchmarkLevel,
    SDKVersion: app.SDKVersion || '',
    version: app.version || '',
    language: app.language || '',
    pixelRatio: windowInfo.pixelRatio || 1,
    screenWidth: windowInfo.screenWidth,
    screenHeight: windowInfo.screenHeight,
    windowWidth: windowInfo.windowWidth,
    windowHeight: windowInfo.windowHeight
  }
}

function runWebGlProbe(canvas, width, height) {
  const system = collectSystemInfo()
  const dpr = Math.min(Math.max(system.pixelRatio || 1, 1), 2)
  const physicalWidth = Math.max(1, Math.round(width * dpr))
  const physicalHeight = Math.max(1, Math.round(height * dpr))
  canvas.width = physicalWidth
  canvas.height = physicalHeight

  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: true,
    depth: true
  })
  if (!gl) {
    throw new Error('WebGL context creation failed')
  }

  const program = createProgram(gl)
  const buffer = gl.createBuffer()
  const vertices = new Float32Array([
    0.0, 0.72, 0.96, 0.33, 0.24,
    -0.72, -0.58, 0.18, 0.78, 0.56,
    0.72, -0.58, 0.20, 0.48, 0.96
  ])

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
  gl.useProgram(program)

  const position = gl.getAttribLocation(program, 'a_position')
  const color = gl.getAttribLocation(program, 'a_color')
  gl.enableVertexAttribArray(position)
  gl.enableVertexAttribArray(color)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 20, 0)
  gl.vertexAttribPointer(color, 3, gl.FLOAT, false, 20, 8)

  gl.viewport(0, 0, physicalWidth, physicalHeight)
  gl.clearColor(0.035, 0.055, 0.075, 1.0)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  gl.finish()

  const pixels = new Uint8Array(physicalWidth * physicalHeight * 4)
  gl.readPixels(
    0,
    0,
    physicalWidth,
    physicalHeight,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels
  )
  const stats = framebufferStats(pixels)
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
  const extensions = (gl.getSupportedExtensions() || []).slice().sort()
  const glError = gl.getError()

  gl.deleteBuffer(buffer)
  gl.deleteProgram(program)

  return {
    passed: stats.varyingSamples > 0 && glError === gl.NO_ERROR,
    width: physicalWidth,
    height: physicalHeight,
    devicePixelRatio: dpr,
    version: gl.getParameter(gl.VERSION),
    shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    vendor: debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
      : gl.getParameter(gl.VENDOR),
    renderer: debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    extensions,
    glError,
    framebuffer: stats
  }
}

function runWasmProbe() {
  if (typeof WXWebAssembly === 'undefined') {
    return Promise.reject(new Error('WXWebAssembly is unavailable'))
  }

  return WXWebAssembly.instantiate('wasm/probe.wasm', {}).then((loaded) => {
    const instance = loaded.instance || loaded
    if (!instance.exports || typeof instance.exports.add !== 'function') {
      throw new Error('Wasm probe does not export add')
    }
    const value = instance.exports.add(20, 22)
    if (value !== 42) {
      throw new Error('Wasm probe returned an unexpected value')
    }
    return {
      passed: true,
      result: value
    }
  })
}

function runArrayBufferProbe(url) {
  if (!url) {
    return Promise.resolve({
      passed: false,
      skipped: true,
      reason: 'No credential-free HTTPS probe URL configured'
    })
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: 10000,
      success(response) {
        const data = response.data
        const byteLength = data && typeof data.byteLength === 'number'
          ? data.byteLength
          : 0
        resolve({
          passed: response.statusCode >= 200 &&
            response.statusCode < 300 &&
            byteLength > 0,
          statusCode: response.statusCode,
          byteLength
        })
      },
      fail(error) {
        reject(new Error(errorMessage(error)))
      }
    })
  })
}

function reportSummary(report) {
  const webgl = report.webgl && report.webgl.passed ? 'WebGL pass' : 'WebGL fail'
  const wasm = report.wasm && report.wasm.passed ? 'Wasm pass' : 'Wasm fail'
  let network = 'Network fail'
  if (report.network && report.network.passed) {
    network = 'Network pass'
  } else if (report.network && report.network.skipped) {
    network = 'Network skipped'
  }
  return [webgl, wasm, network].join(' | ')
}

module.exports = {
  collectSystemInfo,
  errorMessage,
  fnv1aSample,
  reportSummary,
  runArrayBufferProbe,
  runWasmProbe,
  runWebGlProbe
}
