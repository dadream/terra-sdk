// Immediate camera presentation mirrors sdk/src/frame/camera.cpp. The Worker
// remains the owner of the terrain cut; camera changes need no terrain round trip.
function identity() {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

function multiply(a, b) {
  const result = new Float64Array(16)
  for (let row = 0; row < 4; ++row) {
    for (let column = 0; column < 4; ++column) {
      for (let inner = 0; inner < 4; ++inner) {
        result[row * 4 + column] += a[row * 4 + inner] * b[inner * 4 + column]
      }
    }
  }
  return result
}

function translation(x, y, z) {
  const result = identity()
  result[3] = x; result[7] = y; result[11] = z
  return result
}

function rotation(angle, axis) {
  const result = identity(), c = Math.cos(angle), s = Math.sin(angle)
  if (axis === 'x') {
    result[5] = c; result[6] = -s; result[9] = s; result[10] = c
  } else {
    result[0] = c; result[1] = -s; result[4] = s; result[5] = c
  }
  return result
}

function cameraSnapshot(manifest, camera, viewport) {
  const globe = manifest.transform === 'cylindrical'
  const radius = Math.fround(manifest.radius || 0)
  const distance = camera.distance, height = camera.targetHeightMeters || 0
  const tilt = rotation(camera.tiltRadians, 'x')
  const yaw = rotation(camera.yawRadians, 'z')
  let view, near, far
  if (globe) {
    const lon = camera.longitudeDegrees * Math.PI / 180
    const lat = camera.latitudeDegrees * Math.PI / 180
    const sl = Math.sin(lon), cl = Math.cos(lon), sp = Math.sin(lat), cp = Math.cos(lat)
    const alignment = new Float64Array([
      cl, 0, -sl, 0, -sl * sp, cp, -cl * sp, 0,
      sl * cp, sp, cl * cp, 0, 0, 0, 0, 1
    ])
    view = multiply(multiply(multiply(translation(0, 0, -distance), tilt),
      translation(0, 0, -(radius + height))), multiply(yaw, alignment))
  } else {
    view = multiply(multiply(multiply(translation(0, 0, -distance), tilt), yaw),
      translation(-camera.x, -camera.y, -height))
  }
  const position = [0, 1, 2].map(column => -(view[column] * view[3] +
    view[4 + column] * view[7] + view[8 + column] * view[11]))
  if (globe) {
    const anchor = radius + height
    const q = distance * (distance + 2 * anchor * Math.cos(camera.tiltRadians))
    const altitude = Math.max(0, height + q / (Math.sqrt(anchor * anchor + q) + anchor))
    const horizon = Math.sqrt(altitude * (2 * radius + altitude))
    far = Math.max(distance * 1.1, horizon * 1.1, horizon + radius * Math.sqrt(0.0201))
    near = camera.model === 'eye' ? 0.1 : Math.max(0.01, Math.min(far / 10000, distance / 1000))
  } else {
    const diagonal = Math.hypot(manifest.maximumU - manifest.minimumU,
      manifest.maximumV - manifest.minimumV)
    near = Math.max(0.01, distance / 10000)
    far = distance + Math.abs(height) + 2 * diagonal
  }
  const aspect = Math.fround(Math.fround(viewport.width) / Math.fround(viewport.height))
  const cotangent = 1 / Math.tan(Math.fround(viewport.fovRadians) / 2)
  const projection = new Float64Array([
    cotangent / aspect, 0, 0, 0, 0, cotangent, 0, 0,
    0, 0, -(far + near) / (far - near), -2 * far * near / (far - near),
    0, 0, -1, 0
  ])
  return { cameraPosition: position, projectionView: multiply(projection, view),
    viewMatrix: view, nearPlane: near, farPlane: far, distance, tiltRadians: camera.tiltRadians }
}

module.exports = { cameraSnapshot }
