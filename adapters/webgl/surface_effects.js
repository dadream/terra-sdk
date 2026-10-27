const {clamp} = require('../../sdk/js/core/terra_globe_common')
const {invertMatrix4} = require('../../sdk/js/math/matrix')

function colorComponents(value, opacity) {
  const match = /^#([0-9a-f]{6})$/i.exec(value || '')
  const color = match ? parseInt(match[1], 16) : 0x2f7de1
  return [
    ((color >> 16) & 255) / 255,
    ((color >> 8) & 255) / 255,
    (color & 255) / 255,
    opacity === undefined ? 1 : clamp(opacity, 0, 1)
  ]
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

function renderAtmosphere(renderer, projectionView, cameraPosition) {
  if (!renderer.atmosphereEnabled || !renderer.atmosphereProgram ||
    !renderer.atmosphereBuffer || !renderer.atmosphereTexture) {
    return
  }
  const gl = renderer.gl
  const inverse = invertMatrix4(projectionView)
  const up = normalized(cameraPosition)
  let east = normalized([up[2], 0, -up[0]])
  if (Math.hypot(east[0], east[1], east[2]) < 0.5) {
    east = [1, 0, 0]
  }
  const north = normalized(cross(up, east))
  gl.disable(gl.DEPTH_TEST)
  gl.depthMask(false)
  gl.useProgram(renderer.atmosphereProgram)
  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.atmosphereBuffer)
  gl.enableVertexAttribArray(renderer.atmosphereAttributes.clipPosition)
  gl.vertexAttribPointer(renderer.atmosphereAttributes.clipPosition,
    2, gl.FLOAT, false, 0, 0)
  gl.uniformMatrix4fv(
    renderer.atmosphereUniforms.inverseProjectionView, false, inverse)
  gl.uniform3f(renderer.atmosphereUniforms.cameraScaled,
    cameraPosition[0] / renderer.planetRadius,
    cameraPosition[1] / renderer.planetRadius,
    cameraPosition[2] / renderer.planetRadius)
  gl.uniform3f(renderer.atmosphereUniforms.east, east[0], east[1], east[2])
  gl.uniform3f(renderer.atmosphereUniforms.north,
    north[0], north[1], north[2])
  gl.uniform3f(renderer.atmosphereUniforms.up, up[0], up[1], up[2])
  gl.uniform3f(renderer.atmosphereUniforms.sunDirection,
    renderer.atmosphere.sunDirection[0], renderer.atmosphere.sunDirection[1],
    renderer.atmosphere.sunDirection[2])
  gl.uniform1f(renderer.atmosphereUniforms.sunVisible,
    renderer.atmosphere.sunVisible ? 1 : 0)
  gl.uniform1i(renderer.atmosphereUniforms.skyTexture, 0)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, renderer.atmosphereTexture)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  gl.depthMask(true)
  gl.enable(gl.DEPTH_TEST)
}

function renderOverlays(renderer, projectionView, cameraPosition) {
  if (!renderer.overlayData || renderer.overlayData.source !== renderer.overlays) return 0
  const gl = renderer.gl, route = renderer.overlays.route
  const routeCount = route && route.worlds.length >= 2 ? route.worlds.length : 0
  gl.useProgram(renderer.overlayProgram)
  if (renderer.depthState && renderer.depthState.factor)
    gl.uniform1f(renderer.overlayUniforms.logDepth, renderer.depthState.factor)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.uniformMatrix4fv(renderer.overlayUniforms.projectionView, false,
    projectionView)
  gl.uniform3f(renderer.overlayUniforms.origin, ...renderer.overlayData.camera.map((value, axis) => value - cameraPosition[axis]))
  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.overlayBuffer)
  gl.enableVertexAttribArray(renderer.overlayAttributes.position)
  gl.vertexAttribPointer(renderer.overlayAttributes.position, 3, gl.FLOAT,
    false, 0, 0)
  let submitted = 0
  if (routeCount) {
    const color = colorComponents(route.color, route.opacity)
    gl.uniform1f(renderer.overlayUniforms.pointSize, 1)
    gl.uniform4f(renderer.overlayUniforms.color,
      color[0], color[1], color[2], color[3])
    gl.lineWidth(clamp(route.widthPixels || 1, 1, 8))
    gl.drawArrays(gl.LINE_STRIP, 0, route.worlds.length)
    submitted += 1
  }
  if (renderer.overlays.points.length) {
    gl.uniform1f(renderer.overlayUniforms.pointSize, 12)
    gl.uniform4f(renderer.overlayUniforms.color, 0.1, 0.85, 0.95, 1)
    gl.drawArrays(gl.POINTS, routeCount, renderer.overlays.points.length)
    submitted += 1
  }
  gl.disable(gl.BLEND)
  gl.useProgram(renderer.program)
  return submitted
}

module.exports = {normalized, defaultAtmosphere, renderAtmosphere, renderOverlays}
