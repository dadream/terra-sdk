const assert=require('assert')
const {FakeGl,FakeCanvas}=require('./support/webgl_fixture')
const {descendantTextureTile,textureCellTransform}=require('../../sdk/js/imagery/terra_texture_tiles')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')

module.exports=function(Renderer) {
  const r=new Renderer(new FakeCanvas(new FakeGl()),{urlForTile:()=>null,
    textureDescriptor:{kind:'global-geodetic',level_zero_columns:2,level_zero_rows:1,
      matrix_level_offset:1,tile_size:16,maximum_level:17}})
  const root={level:0,matrix:1,row:0,column:0}
  const ancestor=descendantTextureTile(root,5,3,7),source=descendantTextureTile(ancestor,3,2,4)
  const pending=descendantTextureTile(ancestor,1,0,1)
  const seed=(tile,ready)=>r.textures.cache.set(key(tile),{texture:ready?{}:null,width:16,height:16},1364)
  try {
    seed(root,true);seed(ancestor,true);seed(pending,false)
    assert(!r.textures.availableKeys.has(key(ancestor)))
    const draw={texture:source,resourceId:1,geometryKey:'new-mesh'}
    const coverage=(r.residentImageryDraw||r.rootImageryDraw).call(r,draw)
    assert.deepStrictEqual(coverage.texture,ancestor,
      'New terrain discarded a ready cached ancestor while awaiting its current-view measurement')
    assert.deepStrictEqual(coverage.sourceTexture,source)
    const t=textureCellTransform(source,ancestor)
    assert.strictEqual(coverage.imageryCellScale,t.scale)
    assert.strictEqual(coverage.imageryCellOffsetX,t.offsetX)
    assert.strictEqual(coverage.imageryCellOffsetY,t.offsetY)
    assert.strictEqual(coverage.imageryClipCell,false)
    assert.strictEqual(coverage.imageryPixelError,undefined,'Resident coverage invented a precision proof')
    assert.deepStrictEqual(r.rootImageryDraw(draw).texture,root,'Root recovery lost its stable contract')
    r.textures.cache.delete(key(ancestor))
    assert.deepStrictEqual(r.residentImageryDraw(draw).texture,root,'Pending GPU upload became usable coverage')
  } finally {r.destroy()}
  assert.strictEqual(r.resourceLedger.bytes,0)
}
if(require.main===module)module.exports(require('../../adapters/webgl/terra_webgl_renderer').TerraWebGlRenderer)
