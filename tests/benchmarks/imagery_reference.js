'use strict'

// Offline consumer of the exact converged terrain surface. Reuse production
// projection/visibility, the native imagery tree and source adapter. No network,
// renderer, image cache, transition policy or alternate JS LOD selector.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert')
const {performance} = require('perf_hooks')
const loader = require('../../adapters/wasm/terra_wasm')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {TerraGlobeRuntime} = require('../../adapters/wasm/terra_globe_runtime')
const {ImageryAdapter} = require('../../sdk/js/imagery/terra_imagery_adapter')
const {globalCoverageTextureTiles} = require('../../sdk/js/imagery/terra_texture_tiles')
const {textureKeyString} = require('../../sdk/js/core/terra_globe_common')
const {textureByteSize} = require('../../adapters/webgl/texture_store')
const surface = require('../../sdk/js/terrain/terra_surface_plan')
const {invertMatrix4} = require('../../sdk/js/math/matrix')
const {moduleGraph} = require('../../scripts/sdk_modules')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const unique = values => [...new Set(values)].sort()

async function measure(input) {
  const {configuration:config, sample, terrain, wasm} = input
  const modules = moduleGraph(path.resolve(__dirname,'../..'), {
    surface:'sdk/js/terrain/terra_surface_plan.js', runtime:'adapters/wasm/terra_globe_runtime.js',
    textures:'adapters/webgl/texture_store.js', matrix:'sdk/js/math/matrix.js'})
  const javascriptSha256 = hash(JSON.stringify([...modules].sort(([a],[b])=>a.localeCompare(b))
    .map(([name,value])=>[name,hash(value.source)])))
  const capture = sample.surfaceSnapshot, bytes = fs.readFileSync(capture.file)
  assert(capture.schema === 'terra.reference-surfaces.v1' && bytes.length === capture.bytes &&
    hash(bytes) === capture.sha256, 'Surface capture identity mismatch')
  assert(capture.meshes.length === sample.visibleMeshes && capture.meshes.length > 0, 'Incomplete surface membership')
  assert(capture.projectionView.length === 16 && capture.projectionView.every(Number.isFinite), 'Invalid captured projection')
  const typed = (Type, offset, count) => {
    assert(Number.isSafeInteger(offset) && Number.isSafeInteger(count) && offset >= 0 && count > 0 &&
      offset % Type.BYTES_PER_ELEMENT === 0 && offset + count * Type.BYTES_PER_ELEMENT <= bytes.length,
    'Surface range outside capture')
    return new Type(bytes.buffer, bytes.byteOffset + offset, count)
  }
  const indices = typed(Uint16Array, capture.indices.offset, capture.indices.count)
  const viewport = {width:config.viewport.physicalWidth, height:config.viewport.physicalHeight,
    devicePixelRatio:config.viewport.devicePixelRatio}
  const context = surface.projectionContext({projectionView:capture.projectionView}, viewport,
    invertMatrix4(capture.projectionView))
  const adapter = new ImageryAdapter(config.source), models = new Map(), measurements = new Map(), uvViews = new Map()
  const draws = [], timing = {surfacePreparationMs:0, projectionMs:0, planningMs:0, partitionPricingMs:0}
  for (const [i, row] of capture.meshes.entries()) {
    let at = performance.now()
    const positions = typed(Float32Array, row.positions, row.vertices * 3)
    if (!uvViews.has(row.uv)) uvViews.set(row.uv, typed(Float32Array, row.uv, row.vertices * 2))
    const uv = uvViews.get(row.uv)
    assert(uv.length === row.vertices * 2 && positions.every(Number.isFinite) && uv.every(Number.isFinite), 'Invalid surface values')
    const model = surface.prepareSurface(positions, uv, indices, 0, indices.length)
    timing.surfacePreparationMs += performance.now() - at; at = performance.now()
    // Tighten every visible measurement once; no transient capacity policy may
    // change the reference target or stop measurement early.
    const measured = surface.measureSurface(model, row.origin, context, true)
    Object.assign(measured, {bounds:model.bounds, hull:model.hull})
    timing.projectionMs += performance.now() - at
    assert(!measured.refinable, 'Reference retained an unfinished measurement')
    const [level,iKey,j,k] = row.key
    const draw = adapter.prepareDraw({resourceId:i+1, key:{level,i:iKey,j,k}, fragment:row.fragment,
      origin:row.origin, textureNode:row.textureNode})
    draws.push(draw); models.set(draw.resourceId, model); measurements.set(draw.resourceId, measured)
  }
  const wasmBytes = fs.readFileSync(wasm), abi = new TerraAbi(await loader.instantiateTerraWasmBytes(wasmBytes))
  let evidence
  try {
    abi.loadManifest({formatVersion:1, patchDimension:terrain.patchDimension, transform:'cylindrical',
      heightScale:terrain.heightScale, minimumU:-180, minimumV:-90, maximumU:180, maximumV:90,
      radius:config.radiusMeters, texture:config.source})
    assert(sample.view && sample.view.schema==='terra.view-state.v2', 'Capture needs an explicit reference pose; regenerate terrain surfaces')
    const camera={camera:{}}
    TerraGlobeRuntime.prototype.assignView.call(camera,sample.view)
    abi.setViewport(viewport.width,viewport.height,config.fovRadians)
    abi.setGlobeTarget(camera.camera.longitudeDegrees,camera.camera.latitudeDegrees)
    abi.setCamera(camera.camera)
    const expected=abi.getCameraSnapshot().projectionView
    assert(capture.projectionView.every((v,i)=>Math.abs(v-expected[i])<=2e-9*Math.max(1,Math.abs(v),Math.abs(expected[i]))),
      'Captured projection differs from the SDK public view')
    const at = performance.now()
    const plan = abi.planImagery(draws, draw => measurements.get(draw.resourceId), {
      descriptor:config.source, targetPixelError:config.imageryPixelError,
      maximumTextures:65536, maximumDraws:65536 - draws.length, detached:true})
    timing.planningMs = performance.now() - at
    const quality = plan.quality
    assert(quality.planningComplete && !quality.rebuilding, 'Imagery reference did not finish planning')
    const internal = unique(plan.draws.map(draw => {
      const n = draw.textureNode; return [n.level,n.root,n.row,n.column].join('/')
    }))
    const images = unique(plan.draws.map(draw => textureKeyString(draw.texture)))
    const roots = globalCoverageTextureTiles(config.source).map(textureKeyString)
    const physical = unique(images.concat(roots)), imageBytes = textureByteSize(config.source.tile_size,config.source.tile_size)
    const groups = new Map()
    for (const draw of plan.draws) {
      if (!draw.imageryClipCell) continue
      if (!groups.has(draw.resourceId)) groups.set(draw.resourceId,new Map())
      const scale = draw.imageryCellScale
      groups.get(draw.resourceId).set(textureKeyString(draw.texture), {key:textureKeyString(draw.texture), scale,
        bounds:{minimumU:-draw.imageryCellOffsetX/scale, maximumU:(1-draw.imageryCellOffsetX)/scale,
          minimumV:-draw.imageryCellOffsetY/scale, maximumV:(1-draw.imageryCellOffsetY)/scale}})
    }
    const partitionBytes = {sourceUv:0, clippedUv:0}
    const started = performance.now()
    for (const [id, cells] of groups) for (const mode of ['sourceUv','clippedUv']) {
      const work = surface.createPartitionPlanTask(models.get(id), [...cells.values()].map(cell => ({...cell,
        sourceUv:mode === 'sourceUv' && cell.scale <= 2 ** 19 / config.source.tile_size})))
      let step
      do { step = work.step() } while (!step.done)
      partitionBytes[mode] += step.value.reduce((sum,row) => sum + row.bytes,0)
    }
    timing.partitionPricingMs = performance.now() - started
    evidence = {schema:'terra.imagery-reference.v1', quality,
      targetMet:quality.meetsTarget && !quality.limitedByBudget && !quality.limitedByLevel && !quality.limitedByProjection,
      visibleSurfaceCount:[...measurements.values()].filter(m=>m.visible).length,
      measurementRegions:[...measurements.values()].reduce((sum,m)=>sum+(m.regions||[]).length,0),
      internalNodes:internal, sourceImages:images, imagesWithRoots:physical,
      imageBytes, targetImageBytes:images.length*imageBytes, imageBytesWithRoots:physical.length*imageBytes,
      partitionPayloadBytes:partitionBytes, timing, wasmSha256:hash(wasmBytes), javascriptSha256,
      surfaceSha256:capture.sha256, cameraVerified:true, wasmHeapBytes:abi.module.memoryBytes(),
      limits:{maximumTextures:65536,maximumDraws:65536},
      scope:'Fixed exact terrain, fully tightened production measurements and fresh native imagery tree; same algorithm, not an independent oracle',
      memoryScope:'RGBA/mipmap payload plus physical roots; UV partition payload per one CPU/GPU copy. Excludes image decode, drivers, other owners and old/new transition overlap',
      networkRequests:0}
  } finally {abi.destroy()}
  evidence.cleanup = {nativeContextDestroyed:!abi.context}
  return evidence
}

if (require.main === module) measure(JSON.parse(fs.readFileSync(process.argv[2])))
  .then(result => fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2)))
  .catch(error => {
    fs.writeFileSync(process.argv[3],JSON.stringify({status:'failed',error:error.stack || String(error)},null,2))
    process.exitCode=1
  })
module.exports = {measure}
