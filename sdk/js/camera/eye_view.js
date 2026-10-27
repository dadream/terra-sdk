const {finiteNumber, invariant, clamp} = require('../core/terra_globe_common')
const {wrapDegrees, interpolateCoordinate} = require('./terra_camera_motion')
const RAD = Math.PI / 180
const SCHEMA = 'terra.eye-view.v1'

function normalize(view, radius) {
  invariant(view.schema === SCHEMA && view.mode === 'globe', 'Eye view requires globe mode')
  const point = view.position || {}
  const longitudeDegrees = finiteNumber(point.longitudeDegrees, 'Eye longitude')
  const latitudeDegrees = finiteNumber(point.latitudeDegrees, 'Eye latitude')
  const heightMeters = finiteNumber(point.heightMeters, 'Eye height')
  const pitchDegrees = finiteNumber(view.pitchDegrees, 'Eye pitch')
  const headingDegrees = wrapDegrees(finiteNumber(view.headingDegrees, 'Eye heading'))
  invariant(longitudeDegrees >= -180 && longitudeDegrees <= 180 && latitudeDegrees >= -90 && latitudeDegrees <= 90 &&
    heightMeters > -radius && heightMeters <= radius * 20, 'Eye position outside globe limits')
  invariant(pitchDegrees >= -89.5 && pitchDegrees <= 89.5, 'Eye pitch outside [-89.5, 89.5]')
  return {schema: SCHEMA, mode: 'globe', position: {longitudeDegrees, latitudeDegrees, heightMeters},
    headingDegrees, pitchDegrees}
}

function toCamera(view) {
  return {model: 'eye', distance: 0, longitudeDegrees: view.position.longitudeDegrees,
    latitudeDegrees: view.position.latitudeDegrees, targetHeightMeters: view.position.heightMeters,
    yawRadians: view.headingDegrees * RAD, tiltRadians: -(90 + view.pitchDegrees) * RAD}
}

function fromCamera(camera) {
  return {schema: SCHEMA, mode: 'globe', position: {longitudeDegrees: camera.longitudeDegrees,
    latitudeDegrees: camera.latitudeDegrees, heightMeters: camera.targetHeightMeters},
    headingDegrees: wrapDegrees(camera.yawRadians / RAD), pitchDegrees: -camera.tiltRadians / RAD - 90}
}

function interpolate(start, target, t, headingDelta) {
  const p = view => [view.position.longitudeDegrees, view.position.latitudeDegrees, view.position.heightMeters]
  const [longitudeDegrees, latitudeDegrees, heightMeters] = interpolateCoordinate(p(start), p(target), t)
  return {schema: SCHEMA, mode: 'globe', position: {longitudeDegrees, latitudeDegrees, heightMeters},
    headingDegrees: start.headingDegrees + headingDelta * t,
    pitchDegrees: start.pitchDegrees + (target.pitchDegrees - start.pitchDegrees) * t}
}

// Ground-relative displacement in metres. The camera's pitch never changes the
// horizontal walking speed. Geodesic projection avoids degree/pole scale hacks.
function offset(view, forward, right, radius) {
  const lon = view.position.longitudeDegrees * RAD, lat = view.position.latitudeDegrees * RAD
  const heading = view.headingDegrees * RAD, length = Math.hypot(forward, right)
  if (!length) return normalize(view, radius)
  const east = forward * Math.sin(heading) + right * Math.cos(heading)
  const north = forward * Math.cos(heading) - right * Math.sin(heading)
  const up = [Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat)]
  const e = [Math.cos(lon), 0, -Math.sin(lon)], n = [-Math.sin(lon) * Math.sin(lat), Math.cos(lat), -Math.cos(lon) * Math.sin(lat)]
  const angle = length / radius
  const next = up.map((v, i) => v * Math.cos(angle) + (east * e[i] + north * n[i]) / length * Math.sin(angle))
  return Object.assign({}, view, {position: {longitudeDegrees: Math.atan2(next[0], next[2]) / RAD,
    latitudeDegrees: Math.asin(clamp(next[1], -1, 1)) / RAD, heightMeters: view.position.heightMeters}})
}

module.exports = {SCHEMA, normalize, toCamera, fromCamera, interpolate, offset}
