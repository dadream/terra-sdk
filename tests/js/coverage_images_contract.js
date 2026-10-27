const assert=require('assert')
const {FakeGl,FakeCanvas}=require('./support/webgl_fixture')
const {descendantTextureTile}=require('../../sdk/js/imagery/terra_texture_tiles')
const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {GlSubmission}=require('../../adapters/webgl/gl_allocation')

module.exports=function(Renderer) {
  const gl=new FakeGl(),r=new Renderer(new FakeCanvas(gl),{urlForTile:()=>null})
  r.sourceUvPartitions=true;r.sourceUvScale=()=>2048
  const root={level:0,matrix:1,row:0,column:0},child=descendantTextureTile(root,8,3,7)
  const deep=descendantTextureTile(child,9,0,0)
  const draw={geometryKey:'coverage',texture:root,flags:1,firstIndex:0,indexCount:4,origin:[0,0,0]}
  r.geometryCoverageDraws=[draw]
  const seed=tile=>r.textures.cache.set(key(tile),{texture:{},width:16,height:16},1364)
  try {
    for(const tile of [root,child,deep])seed(tile)
    const layer=r.coverageImages
    layer.advance(Infinity)
    assert(!layer.credit&&!layer.job,'Unused geometry fallback competed with current imagery production')
    layer.read([draw]);layer.advance(Infinity)
    const rows=layer.read([draw])
    assert.strictEqual(rows.length,2,'Unsafe deep UV or redundant root entered coverage overlays')
    assert.deepStrictEqual(rows[0].texture,child,'Cached region did not precede root-image fallback')
    assert.strictEqual(rows[1],draw)
    assert.strictEqual(rows[0].flags&1,1,'Imagery made coarse geometry look precise')
    assert(rows[0].imageryDirectClip&&rows[0].imageryResidentCoverage)
    assert.strictEqual(rows[0].imageryCellScale,256)
    const clipped={origin:[0,0,0],coverageBounds:{minimum:[.1,.1,0],maximum:[.2,.2,0]}}
    const frame={projectionView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}
    r.canvas.width=r.canvas.height=1000
    const rect=layer.scissor(clipped,frame)
    assert.strictEqual(layer.scissor(clipped,frame),rect,'Stationary coverage repeated its projection work')
    ++r.cameraVersion
    const shifted={projectionView:frame.projectionView.slice()};shifted.projectionView[3]=1
    assert.notDeepStrictEqual(layer.scissor(clipped,shifted),rect,'Camera change kept a stale screen crop')
    assert.strictEqual(r.presentedTextures.size,0,'Coverage overlays contaminated the fine presentation cut')
    layer.use(child)
    const batch=new GlSubmission(gl);layer.submit(batch)
    r.textures.cache.delete(key(child))
    assert(r.textures.cache.retained.size,'Submitted optional image lost physical ownership before its receipt')
    assert.strictEqual(layer.read([draw]).length,1,'Retired cached coverage remained a display dependency')
    batch.cancel(true)
    assert.strictEqual(r.textures.cache.retained.size,0)
    layer.read([])
    assert(!layer.credit&&!layer.job,'Completed terrain retained optional fallback production')
    seed(child);layer.advance(Infinity)
    assert(!layer.credit&&!layer.job,'Image arrival restarted unused fallback work')
    layer.read([draw])
    layer.advance(-Infinity);layer.clear()
    assert.strictEqual(layer.job,null)
  } finally {r.destroy()}
  assert.strictEqual(r.resourceLedger.bytes,0,'Coverage metadata or submitted imagery leaked')
}
if(require.main===module)module.exports(require('../../adapters/webgl/terra_webgl_renderer').TerraWebGlRenderer)
