const assert = require('assert')
const {regionError} = require('../../sdk/js/terrain/terra_surface_plan')
const {descendantTextureTile, textureCellTransform} = require('../../sdk/js/imagery/terra_texture_tiles')
const {ResourceLedger}=require('../../sdk/js/resources/resource_ledger')
const {MeasurementKernel,adoptMeasurementRows,writeMeasurementRow}=require('../../sdk/js/terrain/measurement_rows')

module.exports = function verifyTextureMeasurement(Renderer) {
  const renderer = Object.create(Renderer.prototype)
  renderer.options = {textureDescriptor: {tile_size: 256}}
  const source = {level: 2, matrix: 2, row: 1, column: 2}
  const triangle = [[0,0],[1,0],[0,1]], uv = {minimumU:0,maximumU:1,minimumV:0,maximumV:1}
  const projection = [3,200,13,-5,7,180,1,0.3,0.6]
  const plain = {triangle, uv, projection, pixelsPerUv: 500}
  let triangleReads = 0
  const region = Object.freeze({...plain, get triangle() { ++triangleReads; return triangle }})
  let measured = Object.freeze({visible:true, regions:Object.freeze([region]), pixelsPerUv:500})
  renderer.measureDraw = () => measured
  const draw = {sourceTexture: source, texture: source}
  const full = regionError(plain, uv)
  for (let level = 0; level < 12; ++level) {
    assert.strictEqual(renderer.measureTextureDraw(draw, level), full / (256 * 2 ** (level - source.level)))
  }
  assert.strictEqual(triangleReads, 1, 'Changing only texture resolution repeated projective clipping')

  // Another containing footprint shares the same complete-region density.
  const ancestor = {level:0,matrix:0,row:0,column:0}
  renderer.measureTextureDraw({...draw, texture:ancestor}, 0)
  assert.strictEqual(triangleReads, 1, 'A containing ancestor recomputed the same region density')
  // A partial footprint still needs exact node-local clipping, then scales for
  // every resident ancestor. It must not borrow the complete-region maximum.
  const leaf = descendantTextureTile(source, 2, 1, 0)
  const t = textureCellTransform(source, leaf)
  const cell = {minimumU:-t.offsetX/t.scale,maximumU:(1-t.offsetX)/t.scale,
    minimumV:-t.offsetY/t.scale,maximumV:(1-t.offsetY)/t.scale}
  const partial = regionError(plain, cell)
  assert.notStrictEqual(partial, full)
  for (let level = 0; level < 12; ++level) {
    assert.strictEqual(renderer.measureTextureDraw({...draw, texture:leaf}, level),
      partial / (256 * 2 ** (level - source.level)))
  }
  assert.strictEqual(triangleReads, 2, 'A partial footprint repeated projection work across texture levels')

  // The renderer attaches geometry bounds to a private copy whenever a new
  // terrain/imagery plan arrives. Those copies still carry the same immutable
  // projection vector; refreshing unrelated plan metadata must not reclip it.
  const copied = Object.create(Renderer.prototype)
  copied.options = {scheduledImagery:true, textureDescriptor:{tile_size:256}}
  copied.terrainBoundImagery = false
  copied.cameraVersion = copied.plannedCameraVersion = 1
  copied.measurements = new Map()
  copied.current = {measurementCameraVersion:1, workerMeasurements:new Map([[7,measured]])}
  copied.geometryForDraw = () => ({model:{bounds:uv,hull:triangle}})
  const rebound = {...draw,resourceId:7,geometryKey:'mesh:7'}
  assert.strictEqual(copied.measureTextureDraw(rebound,2), full / 256)
  const afterCopy = triangleReads
  for (let i=0;i<3;++i) {
    copied.measurements.clear()
    assert.strictEqual(copied.measureTextureDraw(rebound,2), full / 256)
  }
  assert.strictEqual(triangleReads, afterCopy,
    'Renderer metadata copies repeated immutable projection clipping')
  copied.current.workerMeasurements.set(7, {...measured,pixelsPerUv:1000,centerDistance:42})
  copied.measurements.clear()
  assert.strictEqual(copied.measureTextureDraw(rebound,2), full / 256)
  assert.strictEqual(triangleReads, afterCopy,
    'New scalar metadata invalidated an unchanged region-vector density')
  const replacement = {...plain,projection:[0,400,0,0,0,300,1,0.1,0.2]}
  copied.current.workerMeasurements.set(7, {regions:Object.freeze([replacement])})
  copied.current.measurementCameraVersion = ++copied.cameraVersion
  copied.measurements.clear()
  assert.strictEqual(copied.measureTextureDraw(rebound,2), regionError(replacement,uv) / 256,
    'A new view inherited another immutable projection vector\'s density')

  // A new camera owns a new measurement even for the same geometry/texture IDs.
  const changed = {...plain, projection:[0,400,0,0,0,300,1,0.1,0.2]}
  measured = {regions:[changed]}
  assert.strictEqual(renderer.measureTextureDraw(draw, 2), regionError(changed, uv) / 256)
  renderer.options.textureDescriptor.tile_size = 512
  assert.strictEqual(renderer.measureTextureDraw(draw, 2), regionError(changed, uv) / 512,
    'Source tile size reused an error instead of scaling the projected density')

  // A large horizon mesh has more regions than the memo can hold. Optional
  // whole-region reuse must not evict an already priced cell: revisiting two
  // containing imagery cells used to fit easily in the original error cache.
  let denseReads = 0
  measured = {regions:Array.from({length:300}, (_, i) => {
    const u = (i % 20) / 20, v = (i / 20 >> 0) / 20
    return {projection, pixelsPerUv:500,
      uv:{minimumU:u, maximumU:u+0.04, minimumV:v, maximumV:v+0.04},
      get triangle() { ++denseReads; return [[u,v],[u+0.04,v],[u,v+0.04]] }}
  })}
  const dense = renderer.measureTextureDraw(draw, 2)
  renderer.measureTextureDraw({...draw, texture:ancestor}, 0)
  const afterAncestor = denseReads
  assert.strictEqual(renderer.measureTextureDraw(draw, 2), dense)
  assert.strictEqual(denseReads, afterAncestor,
    'Auxiliary region densities evicted an already priced texture footprint')

  // Exercise eviction and mixed projection forms against uncached geometry.
  // Includes unknown near-plane density, a numerator bound, and a constant.
  for (const sample of [plain, {...plain, projection:[0,20,1,0,2,10,-0.1,0.5,0.2]},
    {...plain, numeratorBound:600}, {uv, pixelsPerUv:75}]) {
    measured = {regions:[sample]}
    for (let i = 0; i < 300; ++i) {
      const tile = descendantTextureTile(source, 5, i >> 5, i % 32)
      const transform = textureCellTransform(source, tile)
      const bounds = {minimumU:-transform.offsetX/transform.scale,maximumU:(1-transform.offsetX)/transform.scale,
        minimumV:-transform.offsetY/transform.scale,maximumV:(1-transform.offsetY)/transform.scale}
      const expected = regionError(sample, bounds)
      assert.strictEqual(renderer.measureTextureDraw({...draw, texture:tile}, 7), expected / (512 * 32))
    }
    assert.strictEqual(renderer.measureTextureDraw(draw, 2), regionError(sample, uv) / 512,
      'Eviction changed a previously queried footprint')
  }
  measured = {pixelsPerUv:Infinity}
  assert.strictEqual(renderer.measureTextureDraw(draw, 10), Infinity)
  renderer.visibility = {hidden: () => true}
  assert.strictEqual(renderer.measureTextureDraw(draw, 10), 0)
  renderer.visibility=null
  const ledger=new ResourceLedger(),kernel=renderer.measurementKernel=new MeasurementKernel(ledger)
  try {
    for(const sample of [plain,{...plain,projection:[0,20,1,0,2,10,-0.1,0.5,0.2]},
      {...plain,numeratorBound:600},{uv,pixelsPerUv:75}]) {
      const credit=ledger.reserve('fixture-mirror',176),data=new Uint8Array(176)
      writeMeasurementRow(sample,data,0)
      const owned=adoptMeasurementRows(data,credit)
      try {
        measured={regions:owned.rows}
        for(let i=0;i<300;++i) {
          const tile=descendantTextureTile(source,5,i>>5,i%32),transform=textureCellTransform(source,tile)
          const bounds={minimumU:-transform.offsetX/transform.scale,maximumU:(1-transform.offsetX)/transform.scale,
            minimumV:-transform.offsetY/transform.scale,maximumV:(1-transform.offsetY)/transform.scale}
          for(const level of [0,2,7,11])assert.strictEqual(renderer.measureTextureDraw({...draw,texture:tile},level),
            regionError(sample,bounds)/(512*2**(level-source.level)), 'Packed host footprint changed local SSE')
        }
      }finally{owned.release()}
    }
  }finally{kernel.close()}
  assert.strictEqual(ledger.bytes,0,'Packed footprint queries retained their scratch or rows')
}
