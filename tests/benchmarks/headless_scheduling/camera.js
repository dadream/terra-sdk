'use strict'
const assert=require('assert')
const {TerraGlobeRuntime}=require('../../../adapters/wasm/terra_globe_runtime')
const {cameraSnapshot}=require('../../../sdk/js/camera/terra_camera_snapshot')

// Reuse the public runtime's pure assignment operation. Constructing a
// runtime/renderer is unnecessary; duplicating its tilt convention was wrong.
function cameraForPose(pose) {
  const owner={camera:{}}
  TerraGlobeRuntime.prototype.assignView.call(owner,{schema:'terra.view-state.v2',mode:'globe',
    target:pose.target,rangeMeters:pose.rangeMeters,
    headingDegrees:pose.headingDegrees,tiltDegrees:pose.tiltDegrees})
  return owner.camera
}

function verifySnapshot(config,pose,actual) {
  const expected=cameraSnapshot({transform:'cylindrical',radius:config.radiusMeters},cameraForPose(pose),
    {...config.viewport,fovRadians:config.verticalFovRadians})
  for(const [field,size] of [['cameraPosition',3],['projectionView',16]])
    assert(actual[field]&&actual[field].length===size&&Array.from(actual[field]).every(Number.isFinite),
      'Benchmark camera snapshot is incomplete: '+pose.id)
  const positionErrorMeters=Math.max(...expected.cameraPosition.map((v,i)=>Math.abs(v-actual.cameraPosition[i])))
  const projectionViewRelativeError=Math.max(...expected.projectionView.map((v,i)=>
    Math.abs(v-actual.projectionView[i])/Math.max(1,Math.abs(v))))
  assert(positionErrorMeters<=1e-6&&projectionViewRelativeError<=1e-10,
    'Benchmark camera differs from the public SDK view: '+pose.id)
  return {id:pose.id,positionErrorMeters,projectionViewRelativeError}
}

function verifyReferenceCamera(config,pose,row) {
  assert(row&&row.id===pose.id&&row.projection?.length===16&&row.view?.length===16,
    'Native reference camera is incomplete: '+pose.id)
  const projectionView=Array.from({length:16},(_,i)=>[0,1,2,3].reduce((sum,k)=>
    sum+row.projection[Math.floor(i/4)*4+k]*row.view[4*k+i%4],0))
  return verifySnapshot(config,pose,{cameraPosition:row.position,projectionView})
}

module.exports={cameraForPose,verifySnapshot,verifyReferenceCamera}
