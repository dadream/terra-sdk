const assert = require('assert')
const requiredPayload = require('./native_residency')
const a = {resourceId:1,textureResourceId:9,vertexCount:6,positionFloatCount:18,textureFloatCount:12}
const b = {...a,resourceId:2}
assert.deepStrictEqual(requiredPayload([a,b,a]), {
  drawCount:3,meshCount:2,uvCount:1,positionBytes:144,uvBytes:48
})
assert.deepStrictEqual(requiredPayload([a,{...b,textureResourceId:10}]), {
  drawCount:2,meshCount:2,uvCount:2,positionBytes:144,uvBytes:96
})
for (const value of [[],null,[{...a,resourceId:0}],[{...a,textureResourceId:NaN}],
  [{...a,vertexCount:7}],[a,{...b,vertexCount:3,positionFloatCount:9,textureFloatCount:6}],
  [a,{...a,vertexCount:3,positionFloatCount:9,textureFloatCount:6,textureResourceId:10}]])
  assert.throws(()=>requiredPayload(value))
console.log('Resident payload counts shared XYZ/UV once and rejects ambiguous descriptors')
