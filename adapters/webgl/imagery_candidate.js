const {imageryDrawWork} = require('./imagery_draws')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {textureTileContains, parentTextureTile} = require('../../sdk/js/imagery/terra_texture_tiles')
const {ImageryPresentation} = require('../../sdk/js/imagery/terra_imagery_presentation')
const {availableImageryCutWork} = require('../../sdk/js/imagery/imagery_availability')
const {completeWorldInputs} = require('./world_display_inputs')

function imageryMembers(draws, children) {
  const work = imageryMembersWork(draws, children)
  let result
  do { result = work.next() } while (!result.done)
  return result.value
}

function* imageryMembersWork(draws, children, reserve = () => {}) {
  const members = new Set()
  for (const draw of draws) {
    yield
    const source = draw.sourceTexture || draw.texture
    for (const tile of children.values()) {
      yield
      if (textureTileContains(source, tile) || textureTileContains(tile, source)) {
        if (!members.has(draw.geometryKey)) reserve(64 + String(draw.geometryKey).length * 2)
        members.add(draw.geometryKey); break
      }
    }
  }
  return members
}

// Immediate entry to the same world-footprint producer used by background
// admission. Its private presentation cannot change the submitted blend states.
function imageryCandidate(renderer, children) {
  const work = imageryCandidateWork(renderer, children, {footprintCache: renderer.imageryFootprints})
  let result
  do { result = work.next() } while (!result.done)
  return result.value
}

// Price complete immutable UV footprints. A projected subset is insufficient:
// another view of the same mesh may need the rest before the image publishes.
// Infinity is a conservative production envelope, never a displayed SSE result.
function* imageryCandidateWork(renderer, children, options = {}) {
  const store = renderer.textures
  const reserve = options.reserve || (() => {})
  const ready = id => children.has(id) || store.gpuReady(id)
  const availableKeys = yield* availableImageryCutWork(store.currentRoots, store.resourceGroups(), store.availableKeys, {
    ready, failed: id => store.failed.has(id), required: id => store.requiresResident(id), direct: store.directTargets}, reserve)
  // No memo can survive a yield with a live readiness predicate. Background
  // admission supplies a fixed numeric view, and immediate callers stay exact
  // too: every lookup stops at the first currently eligible ancestor.
  const resolve = (tile, fallback) => {
    let root = tile
    for (let current = tile; current; current = parentTextureTile(current)) {
      root = current
      const id = key(current)
      if ((availableKeys.has(id) || renderer.presentedTextures.has(id)) && ready(id)) return current
    }
    return fallback ? root : null
  }
  const view = {
    targetDesired: store.targetDesired, admissionBlocked: store.admissionBlocked,
    blockedByCapacity: store.blockedByCapacity, availableKeys,
    cache: {has: id => children.has(id) || store.cache.has(id)}, gpuReady: ready,
    get: tile => ({resolvedTile: resolve(tile, false)}),
    presentationTileFor: tile => resolve(tile, true)
  }
  const presentation = new ImageryPresentation(renderer.presentation.duration)
  presentation.cells = renderer.presentation.cells
  yield* presentation.beginFrameWork(0, reserve)
  const sourceDraws = options.draws || renderer.renderDraws
  const inputs = yield* completeWorldInputs(sourceDraws,sourceDraws,reserve)
  const members = yield* imageryMembersWork(inputs, children, reserve)
  const production = Object.create(renderer)
  production.plannedCameraVersion = -1
  production.measureDraw = draw => {
    const geometry = renderer.geometry.get(draw.geometryKey)
    return {visible:true, hull:geometry && geometry.model && geometry.model.hull}
  }
  production.measureTextureDraw = () => Infinity
  const draws = yield* imageryDrawWork(production, inputs, view, presentation,
    new Map(), {members, membersOnly:true, world:true, reserve, footprintCache: options.footprintCache})
  const meshes = new Set()
  for (const draw of draws) {
    yield
    if (draw.imageryTarget && children.has(key(draw.imageryTarget))) meshes.add(draw.geometryKey)
  }
  // A mesh switches only when its complete UV footprint is ready. Include its
  // unchanged cells too; they are borrowed, not allocated or charged twice.
  const result = []
  for (const draw of draws) { yield; if (meshes.has(draw.geometryKey)) result.push(draw) }
  return result
}

module.exports = {imageryCandidate, imageryCandidateWork, imageryMembers, imageryMembersWork}
