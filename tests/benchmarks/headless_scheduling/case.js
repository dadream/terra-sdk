'use strict'
const {scales} = require('../vertical_scale')

function validate(input) {
  if (input.schema !== 'terra.scheduling-case.v1' || input.datasetId !== 'globe' ||
      input.maximumTopologyChanges !== 32 || input.maximumManagedBytes !== 176160768 ||
      input.viewport.devicePixelRatio !== 1 || input.terrainPixelError !== 1.25 || input.imageryPixelError !== 1.25)
    throw new Error('Unsupported scheduling case contract')
  const values = [input.radiusMeters,input.heightScale,input.viewport.width,input.viewport.height,
    input.verticalFovRadians,input.tileSize]
  if (values.some(value => !Number.isFinite(value) || value <= 0) ||
      !Number.isInteger(input.patchDimension) || input.patchDimension < 2 || input.patchDimension > 128 ||
      !Number.isInteger(input.nominalMaximumInternalLevel) || input.nominalMaximumInternalLevel < 1 ||
      input.nominalMaximumInternalLevel > 24 || input.verticalFovRadians >= Math.PI ||
      !Number.isInteger(input.viewport.width) || !Number.isInteger(input.viewport.height) ||
      !Number.isFinite(input.target.longitudeDegrees) || Math.abs(input.target.longitudeDegrees)>180 ||
      !Number.isFinite(input.target.latitudeDegrees) || Math.abs(input.target.latitudeDegrees)>90 ||
      !input.obliqueNominalLevels.every(value => Number.isInteger(value) && value>=1 && value<=input.nominalMaximumInternalLevel) ||
      !input.obliqueTiltsDegrees.every(value => Number.isFinite(value) && value>=0 && value<90))
    throw new Error('Invalid scheduling case input')
  return input
}

function route(input, name, heightMeters) {
  validate(input)
  if (!Number.isFinite(heightMeters)) throw new Error('A captured ground height is required')
  const samples = scales({radiusMeters:input.radiusMeters,cssHeight:input.viewport.height,
    fovRadians:input.verticalFovRadians,tileSize:input.tileSize,imageryPixelError:input.imageryPixelError,
    globalRangeMeters:4*input.radiusMeters,minimumRangeMeters:1,
    maximumInternalLevel:input.nominalMaximumInternalLevel})
  const target = {...input.target,heightMeters}
  const pose = (sample, id, tiltDegrees=0) => ({id,scaleId:sample.id,nominalLevel:sample.level,
    target,rangeMeters:sample.rangeMeters,headingDegrees:0,tiltDegrees})
  if (name === 'global-contract') return [pose(samples[0],'global-first'),pose(samples[0],'global-repeat')]
  if (name === 'global-coarsening-contract') return [pose(samples[0],'global-first'),
    pose(samples[1],'closer'),pose(samples[0],'global-return')]
  if (name === 'taian-nadir-roundtrip-v1') return samples.map(sample => pose(sample,sample.id+'-down')).concat(
    samples.slice(0,-1).reverse().map(sample => pose(sample,sample.id+'-up')))
  if (name === 'taian-oblique-fixed-v1') return input.obliqueNominalLevels.flatMap(level => {
    const sample=samples.find(value=>value.level===level)
    if (!sample) throw new Error('Oblique scale is outside the route')
    return input.obliqueTiltsDegrees.map((tilt,index)=>pose(sample,sample.id+'-tilt-'+index,tilt))
  })
  throw new Error('Unknown scheduling case: '+name)
}

function argumentsFor(input, backend) {
  validate(input)
  const args=[backend,input.radiusMeters,input.patchDimension,input.heightScale,input.viewport.width,
    input.viewport.height,input.verticalFovRadians,input.terrainPixelError,input.benchmarkMeshBytes||0].map(String)
  if(input.benchmarkImagery)args.push('imagery-demand')
  return args
}
function commandFor(pose) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(pose.id)) throw new Error('Invalid pose identity')
  const t=pose.target, values=[t.longitudeDegrees,t.latitudeDegrees,t.heightMeters,pose.rangeMeters,
    pose.headingDegrees,pose.tiltDegrees]
  if (!values.every(Number.isFinite) || pose.rangeMeters<=0 || pose.tiltDegrees<0 || pose.tiltDegrees>=90)
    throw new Error('Invalid pose command')
  return 'pose '+JSON.stringify(pose.id)+' '+values.join(' ')+'\n'
}
module.exports={validate,route,argumentsFor,commandFor}
