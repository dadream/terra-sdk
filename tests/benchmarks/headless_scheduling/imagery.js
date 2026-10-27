'use strict'
const assert=require('assert')
const {TIANDITU_TEXTURE}=require('../../../sdk/js/imagery/terra_imagery_profiles')
const {ImageryAdapter}=require('../../../sdk/js/imagery/terra_imagery_adapter')
const {difference}=require('./compare')

function profile(config) {
  const source={...TIANDITU_TEXTURE},adapter=new ImageryAdapter(source)
  assert(source.maximum_level===17&&source.matrix_level_offset===1&&
    adapter.levelOffset===1&&adapter.maximumDepth===16&&adapter.tileSize===256&&
    config.nominalMaximumInternalLevel===16&&config.tileSize===256,
    'Native imagery demand fixture differs from current source/case')
  return {source,maximumInternalLevel:adapter.maximumDepth,
    availability:'Declared all-available offline profile; not measured Tianditu availability',
    binding:'Nominal source level = internal level + 1; WMTS matrix = internal level + 2. Optional coarse root alias disabled.',
    budget:'Demand only; 65536 textures/262144 draws/512MiB tool guards, not production budgets',
    geometry:'Same effective terrain error as terrain benchmark; desktop texture-width terrain scaling remains disabled',
    measurement:'Real Float32 mesh, clipped/back-face-culled, tight canonical projection; models rebuilt per pose',
    scope:'Persistent native target schedulers only; no latency replay, decoding, GPU, visual or joint-memory acceptance'}
}
function validate(row,config) {
  assert(row.schema==='terra.imagery-target.v1'&&row.status==='ready')
  assert(Number.isFinite(row.maximumPixelError)&&row.maximumPixelError>=0)
  assert.strictEqual(row.requestedPixelError,config.imageryPixelError)
  assert.strictEqual(row.targetMet,row.maximumPixelError<=row.requestedPixelError*(1+1e-6))
  const adapter=new ImageryAdapter(TIANDITU_TEXTURE)
  const physical=row.visibleKeys.map(value=>{
    const [level,y,x]=value.split('/').map(Number)
    assert(level<=adapter.maximumDepth)
    const resource=adapter.requestTile(adapter.bind({level,row:y,column:x}).resource)
    return TIANDITU_TEXTURE.id+'/'+resource.matrix+'/'+resource.row+'/'+resource.column
  }).sort()
  assert.deepStrictEqual(row.physicalKeys,physical,'Native/JS external source bindings differ')
  assert.strictEqual(row.visibleNominalRgbaBytes,physical.length*256*256*4)
  assert.deepStrictEqual(Object.keys(row.pixelErrors).sort(),row.visibleKeys)
  assert.strictEqual(Math.max(...Object.values(row.pixelErrors)),row.maximumPixelError)
  const limited=Object.entries(row.pixelErrors).filter(([,error])=>error>row.requestedPixelError*(1+1e-6))
  const sourceLimited=limited.filter(([key])=>Number(key.split('/')[0])===adapter.maximumDepth).length
  assert.strictEqual(row.levelLimitedTiles,sourceLimited)
  assert.strictEqual(row.policyLimitedTiles,limited.length-sourceLimited)
  assert.strictEqual(row.sourceLimited,sourceLimited>0)
  assert(Number.isInteger(row.coverageRegions)&&row.coverageRegions>0&&
    Number.isFinite(row.uncoveredUvArea)&&row.uncoveredUvArea>=0&&
    row.uncoveredUvArea<=row.coverageRegions*1e-9,'Uncovered measured imagery region')
  assert(row.visibleKeys.every(key=>row.allKeys.includes(key))&&row.measuredSurfaces>0)
  for(const name of ['allKeys','visibleKeys','physicalKeys','terrainAnchors'])
    assert.strictEqual(new Set(row[name]).size,row[name].length)
  return row
}
function compare(first,second) {
  const sets={}
  for(const name of ['terrainAnchors','allKeys','visibleKeys','physicalKeys'])
    sets[name]=difference(first[name],second[name])
  return {sets,firstPixelError:first.maximumPixelError,secondPixelError:second.maximumPixelError,
    bothTargetsMet:first.targetMet&&second.targetMet,
    sameVisibleSets:!sets.visibleKeys.onlyFirst.length&&!sets.visibleKeys.onlySecond.length}
}
module.exports={profile,validate,compare}
