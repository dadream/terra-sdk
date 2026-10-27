const {textureKeyString:key} = require('../../sdk/js/core/terra_globe_common')
const {parentTextureTile,textureCellTransform,textureTileContains} = require('../../sdk/js/imagery/terra_texture_tiles')
const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const {MeasurementLoans} = require('../../sdk/js/terrain/measurement_rows')

// The terrain cut owns this normalized description. Camera/imagery goals do
// not change it; a different cut or source matrix offset creates a new one.
function terrainSourceDraws(surface, descriptor) {
  const offset=Number.isInteger(descriptor&&descriptor.matrix_level_offset)?descriptor.matrix_level_offset:0
  const previous=surface.imagerySourceState
  if(previous&&previous.draws===surface.draws&&previous.offset===offset)return previous.value
  const value=surface.draws.map(draw=>{
    if(!draw.texture||draw.texture.matrix===draw.texture.level+offset)return draw
    return Object.assign({},draw,{texture:Object.assign({},draw.texture,{matrix:draw.texture.level+offset})})
  })
  surface.imagerySourceState={draws:surface.draws,offset,value}
  return value
}

// A visible demand cut is not a world footprint. Keep its detailed goals and
// add one ready-ancestor footprint for the rest of each immutable source mesh.
// Source meshes come from the fixed terrain cut, including meshes omitted by
// this view's imagery list. An image-group quote can supply its own fixed scope.
function* completeWorldInputs(draws, sourceDraws, reserve = () => {}) {
  const result=[],sources=new Set(),covered=new Set()
  const sourceId=draw=>draw.geometryKey+':'+key(draw.sourceTexture||draw.texture)+':'+(draw.textureResourceId||0)
  const scope=new Set()
  for(const draw of sourceDraws) {
    yield
    if(draw.flags&1)continue
    const id=sourceId(draw)
    if(!scope.has(id)){reserve(64+id.length*2);scope.add(id)}
  }
  for(const draw of draws) {
    if(!scope.has(sourceId(draw)))continue
    yield;reserve(8);result.push(draw)
    if(textureTileContains(draw.texture,draw.sourceTexture||draw.texture)) {
      const id=sourceId(draw)
      if(!covered.has(id)){reserve(64+id.length*2);covered.add(id)}
    }
  }
  for(const draw of sourceDraws) {
    yield
    if(draw.flags&1)continue
    const source=draw.sourceTexture||draw.texture
    const id=draw.geometryKey+':'+key(source)+':'+(draw.textureResourceId||0)
    if(sources.has(id)||covered.has(id))continue
    reserve(512+id.length*2);sources.add(id)
    let root=source
    while(root.level>0){yield;root=parentTextureTile(root)}
    const t=textureCellTransform(source,root)
    const cover=Object.assign({},draw,{texture:root,sourceTexture:source,
      imageryCellScale:t.scale,imageryCellOffsetX:t.offsetX,imageryCellOffsetY:t.offsetY,
      imageryClipCell:false,imageryHandover:false})
    delete cover.imageryDirectClip;delete cover.imageryIndexCell;delete cover.imageryTarget
    result.push(cover)
  }
  return result
}

// The caller owns the credited workspace and closes these loans after the
// iterator finishes/cancels. Only this fixed view can cross CPU work slices.
function* captureWorldView(renderer, draws, reserve, cleanup) {
  const r=renderer,store=r.textures,snapshot=Object.create(r)
  const measurements=new MeasurementLoans(),geometry=new Map(),seen=new Set()
  reserve(1536+(r.current.workerMeasurements?r.current.workerMeasurements.size:0)*80)
  snapshot.current={imageryPlan:r.current.imageryPlan,
    workerMeasurements:new Map(r.current.workerMeasurements||[]),
    measurementCameraVersion:r.current.measurementCameraVersion}
  measurements.replace(snapshot.current.workerMeasurements.values())
  cleanup.push(()=>measurements.clear())
  snapshot.projectionContext=r.projectionContext
  snapshot.cameraVersion=r.cameraVersion;snapshot.plannedCameraVersion=r.plannedCameraVersion
  snapshot.measurements=new Map();snapshot.uploadQueue=[]
  snapshot.options=Object.assign({},r.options)
  snapshot.geometry={get:id=>geometry.get(id)}
  // Capture every numerical camera/goal input before the first yield. The
  // physical cache loans below may take several turns; newer views must not
  // supply half of this earlier snapshot during those turns.
  reserve(1024+192*(store.targetDesired.size+store.availableKeys.size+r.presentedTextures.size+
    r.presentation.cells.size+r.presentationBridges.length+store.admissionBlocked.size+(r.capacityHandover||new Map()).size))
  snapshot.presentedTextures=new Map(r.presentedTextures)
  Object.defineProperty(snapshot,'presentationBridges',{value:Array.from(r.presentationBridges)})
  Object.defineProperty(snapshot,'capacityHandover',{value:new Map(r.capacityHandover||[])})
  snapshot.presentation={duration:r.presentation.duration,cells:r.presentation.cells}
  const targets=new Map(store.targetDesired),available=new Set(store.availableKeys)
  const quality=snapshot.current.imageryPlan&&snapshot.current.imageryPlan.quality
  const authoritative=snapshot.plannedCameraVersion===snapshot.cameraVersion&&quality&&quality.planningComplete===true
  const admissionBlocked=new Set(store.admissionBlocked),blockedByCapacity=store.blockedByCapacity
  const restoring=new Set(r.restoringPresentation?r.presentedTextures.keys():[])
  const measure=r.measureDraw
  snapshot.measureDraw=function(draw,tight) {
    const m=measure.call(this,draw,tight)
    if(!seen.has(m)) {
      reserve(128);seen.add(m)
      const loan=new MeasurementLoans();cleanup.push(()=>loan.clear());loan.replace([m])
    }
    return m
  }
  for(const draw of draws) {
    yield
    if(geometry.has(draw.geometryKey))continue
    reserve(192)
    const value=r.geometryForDraw(draw)
    if(!value)continue
    geometry.set(draw.geometryKey,value)
    if(r.geometry.entries.has(draw.geometryKey))cleanup.push(r.geometry.retain(draw.geometryKey))
    cleanup.push(holdMeshes([value.resource]))
  }
  const ready=new Set(),resident=new Set()
  reserve(store.cache.entries.size*8)
  const keys=Array.from(store.cache.entries.keys())
  for(const id of keys) {
    yield
    reserve(160+id.length*2)
    const entry=store.cache.entries.get(id),release=entry&&store.cache.retain(id)
    if(!release)continue
    cleanup.push(release);resident.add(id)
    if(store.gpuReady(id))ready.add(id)
  }
  // Prepare the target topology before image I/O. These are numerical goals,
  // never usable GPU assets; publication checks actual renderer readiness.
  snapshot.textures={targetDesired:targets,availableKeys:new Set([...available,...targets.keys()]),
    admissionBlocked,blockedByCapacity,
    cache:{has:id=>resident.has(id)||targets.has(id)},
    gpuReady:id=>ready.has(id)||targets.has(id)||restoring.has(id)&&resident.has(id),
    presentationTileFor:tile=>resolve(tile,true),get:tile=>({resolvedTile:resolve(tile,true)})}
  snapshot.textures.branchView={availableKeys:available,cache:{has:id=>resident.has(id)},gpuReady:id=>ready.has(id)}
  snapshot.textures.capacityView={gpuReady:id=>ready.has(id),
    presentationTileFor:tile=>resolve(tile,true,false),get:tile=>({resolvedTile:resolve(tile,false,false)})}
  function resolve(tile,fallback,prospective=true) {
    let root=tile
    for(let current=tile;current;current=parentTextureTile(current)) {
      root=current;const id=key(current)
      // Historical images may preserve cell footprints and blend endpoints,
      // but cannot become new publication prerequisites. Once off-view they
      // can be evicted while current goals are still uploading. Price only
      // demanded materials (or explicitly owned restoration) and root coverage.
      // An unfinished camera/model plan still inherits submitted detail; it
      // cannot authorize replacing that presentation with provisional roots.
      if(prospective&&authoritative) {
        if(targets.has(id)||restoring.has(id)&&resident.has(id))return current
      }else if(((prospective?snapshot.textures.availableKeys:available).has(id)||snapshot.presentedTextures.has(id))&&
          (ready.has(id)||prospective&&(targets.has(id)||restoring.has(id)&&resident.has(id))))return current
    }
    return fallback?root:null
  }
  return snapshot
}

module.exports={terrainSourceDraws,completeWorldInputs,captureWorldView}
