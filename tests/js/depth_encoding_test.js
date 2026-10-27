const assert = require('assert')
const {depthEncoding} = require('../../sdk/js/camera/depth_encoding')
const {cameraSnapshot} = require('../../sdk/js/camera/terra_camera_snapshot')
const {visibilityBounds} = require('../../sdk/js/terrain/visibility_bounds')
const manifest = {transform: 'cylindrical', radius: 6378000}
for (const height of [2, 510, 20000, 1e7]) for (const heading of [0, 1.7, 4.1]) {
  const frame = cameraSnapshot(manifest, {model: 'eye', distance: 0, targetHeightMeters: height,
    longitudeDegrees: 116.5, latitudeDegrees: 40.7, tiltRadians: -1.57, yawRadians: heading},
    {width: 640, height: 360, fovRadians: 0.6})
  const depth = depthEncoding(frame, true)
  assert.equal(depth.mode, 'logarithmic')
  assert(Math.abs(depth.nearMeters / frame.nearPlane - 1) < 1e-6)
  assert(Math.abs(depth.farMeters / frame.farPlane - 1) < 1e-6)
  assert.equal(depthEncoding(frame, false).limitedReason, 'fragment-depth-unavailable')
}
const n = .1, f = 2e6
const frame = {cameraPosition: [0,0,0], projectionView: [1,0,0,0,0,1,0,0,
  0,0,-(f+n)/(f-n),-2*f*n/(f-n),0,0,-1,0]}
const depth = depthEncoding(frame, true)
for (const distance of [1, 10, 1e3, 1e5]) {
  const model = {faces: [0,1,2], blocks: [{minimum: [-.01,-.01,-distance-1],
    maximum: [.01,.01,-distance], faces: [0]}]}
  const bound = visibilityBounds(model, {origin:[0,0,0]}, frame, {width:128,height:128}, depth)[0]
  assert(bound[4] < 2*Math.log2(1+distance)*depth.factor-1,
    'Visibility query was behind the nearest log-depth surface')
  assert(bound[4] > 2*Math.log2(1+distance)*depth.factor-1-2e-5,
    'Visibility depth bias was not local')
}
const normal = {...frame,projectionView:[1,0,0,0,0,1,0,0,0,0,-1.002,-2.002,0,0,-1,0]}
assert.equal(depthEncoding(normal,true).mode,'perspective')
assert.equal(depthEncoding(normal,false).limitedReason,null)
const identity={cameraPosition:[0,0,0],projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}
assert.equal(depthEncoding(identity,true).factor,0)
console.log('Double perspective interval, capability limitation and conservative logarithmic query depths passed')
