const adoptPacket = require('./reference/mesh_packet')
function replacementPresentation(renderer, after) {
  const before = renderer.displaySurface && renderer.displaySurface.current
  let replacementPlan = null
  if (before) {
    const task = require('./reference/surface_replacement').createReplacementTask(before, after, false)
    let result
    do { result = task.step() } while (!result.done)
    if (result.value) replacementPlan = {groups: result.value.map(group => ({
      before: group.before.map(draw => draw.resourceId), after: group.after.map(draw => draw.resourceId)}))}
  }
  return {replacementPlan, selectionCurrent: true, camera: {}}
}

const assert = require('assert')
const {FakeGl,FakeCanvas,AsyncGl,frame} = require('./support/webgl_fixture')

const {OutputTransaction} = require('../../sdk/js/resources/output_transaction')
function stagePartitionJob(renderer, geometry, cells, parts) {
  const bytes = parts.reduce((n, p) => n+p.positions.byteLength+p.uv.byteLength+p.indices.byteLength, 0)
  const output = OutputTransaction.reserve(renderer.resourceLedger, bytes, bytes, 'partition-output', 'partition-gpu')
  assert(output, 'Fixture partition output was not admitted')
  output.input.mark('resident')
  renderer.partitionCpuBytes += bytes; renderer.partitionReservedBytes += bytes
  geometry.partitionPending = new Set(cells.map(cell => cell.key))
  renderer.partitionUploads.push({geometry, cells, parts, output, cpuBytes: bytes,
    releaseMesh() {}, generation: renderer.partitionGeneration})
  renderer.requestResources()
}

const rendererModule = require('../../adapters/webgl/terra_webgl_renderer')
const textureTiles = require('../../sdk/js/imagery/terra_texture_tiles')
const {invertMatrix4} = require('../../sdk/js/math/matrix')
const {isPowerOfTwo} = require('../../adapters/webgl/texture_store')
const textureUploadRenderers = new Set()
const imageryReference = require('./reference/imagery_selection')
const {planImageryFrontier} = require('./reference/imagery_frontier')
const RawRenderer = rendererModule.TerraWebGlRenderer
function testPresentationBridgeDemandClock() {
  const coarse = {level: 1, matrix: 1, row: 0, column: 0}
  const fine = {level: 3, matrix: 3, row: 0, column: 0}
  const state = {cell: fine, a: fine, b: fine}
  let wakes = 0
  const renderer = {
    mode: 'texture', options: {imageryPixelError: 1.25},
    presentation: {duration: 200, cells: new Map([['fine', state]])},
    presentationBridges: [], displaySurface: {current: {draws: []}}, current: {},
    plannedCameraVersion: 4, cameraVersion: 4,
    renderDraws: [{texture: coarse}], partitionQueue: [],
    measureDraw: () => ({visible: true}), measureTextureDraw: () => 0.5,
    textures: {gpuReady: () => true}, requestResources: () => ++wakes
  }
  const update = () => RawRenderer.prototype.updatePresentationBridges.call(renderer)
  renderer.presentationBridgeGoals = () => RawRenderer.prototype.presentationBridgeGoals.call(renderer)
  // All image inputs and uploads have already completed. Changing the goals
  // on the display clock must independently notify world-cut preparation.
  update()
  assert.deepStrictEqual(renderer.presentationBridges, [coarse])
  assert.strictEqual(wakes, 1, 'Resident coarse goals did not wake world-cut preparation')
  renderer.renderDraws = [{texture: Object.assign({}, coarse)}]
  update()
  assert.strictEqual(wakes, 1, 'Unchanged bridge goals kept restarting preparation')
  state.a = state.b = coarse
  update()
  assert.deepStrictEqual(renderer.presentationBridges, [])
  assert.strictEqual(wakes, 2, 'Completed bridge goals did not release their demand')
  update()
  assert.strictEqual(wakes, 2)
  state.a = state.b = fine
  update()
  assert.strictEqual(wakes, 3)
  renderer.meshOutputPlan = {valid: () => true}
  update()
  assert.deepStrictEqual(renderer.presentationBridges, [])
  assert.strictEqual(wakes, 4, 'An admitted mesh plan did not invalidate old bridge demand')
  update()
  assert.strictEqual(wakes, 4)
  renderer.meshOutputPlan = null
  renderer.plannedCameraVersion = 3
  update()
  assert.strictEqual(wakes, 4, 'An old camera created a bridge demand')
}
testPresentationBridgeDemandClock()
function testPresentationBridgeInsideCoarseFootprint() {
  const {ImageryPresentation} = require('../../sdk/js/imagery/terra_imagery_presentation')
  const {imageryCoverWork} = require('../../adapters/webgl/imagery_draws')
  const root = {level: 0, matrix: 0, row: 0, column: 0}
  const bridge = {level: 1, matrix: 1, row: 0, column: 0}
  const fine = {level: 2, matrix: 2, row: 0, column: 0}
  const id = tile => [tile.level, tile.matrix, tile.row, tile.column].join('/')
  const previous = {cell: fine, a: fine, b: fine, alpha: 1, goal: 1, at: 0}
  const presentation = new ImageryPresentation(200)
  presentation.cells.set(id(fine), previous)
  presentation.beginFrame(0)
  // The old immutable mesh can have a root footprint even when the new
  // camera's ready destination covers only one of its quadrants.
  const renderer = {presentationBridges: [bridge], geometry: {get: () => null}}
  const work = imageryCoverWork(renderer, [{geometryKey: 'old-mesh', texture: root, sourceTexture: root}],
    {get: () => ({resolvedTile: root})}, presentation)
  let result
  do { result = work.next() } while (!result.done)
  const row = result.value.find(draw => id(draw.texture) === id(fine))
  assert(row, 'Coarsening removed the submitted fine UV footprint before its fade')
  assert.strictEqual(id(row.imageryTarget), id(bridge),
    'A bridge inside an old coarse footprint faded to its root instead of its ready goal')
  assert(row.imageryHandover)
  assert(result.value.some(draw => !textureTiles.textureTileContains(bridge, draw.texture) &&
    id(draw.imageryTarget) === id(root)), 'A local bridge changed unrelated root coverage')
  assert.strictEqual(presentation.cells.get(id(fine)), previous,
    'Preparing bridge goals modified the submitted presentation')
}
testPresentationBridgeInsideCoarseFootprint()
process.stdout.write('World bridge goals: semantic clock changes, nested coarse footprints and submitted UV ownership passed\n')
require('./texture_measurement_contract')(RawRenderer)
require('./imagery_resolution_contract')()
require('./imagery_footprint_contract')()
require('./world_payload_readiness_contract')()
class Renderer extends RawRenderer {
  constructor(canvas, options) {
    // Existing fixtures keep their previous initial total explicitly. Changing
    // a local test pool must not accidentally weaken its shared admission gate.
    const value = options || {}
    super(canvas, value.resourceLedger || value.maximumResourceBytes !== undefined ? value :
      Object.assign({maximumResourceBytes: (value.geometryCacheBytes || 16 * 1024 * 1024) +
        (value.partitionCacheBytes || value.geometryCacheBytes || 16 * 1024 * 1024) +
        (value.textureCacheBytes || 32 * 1024 * 1024)}, value))
    if (!this.options.planImagery) this.options.planImagery = (draws, measureDraw, settings) =>
      (this.terrainBoundImagery ? imageryReference.refineImageryDraws : planImageryFrontier)(
        this.current.frame, draws, null, null, {width: canvas.width, height: canvas.height},
        settings.descriptor, Object.assign({}, settings, {measureDraw, previousLevels: this.imageryLevels}))
  }
  // Functional fixtures drive both host clocks explicitly. Clock-isolation
  // contracts use RawRenderer, including world_display_contract.
  render(force = true) {
    const input=this.renderedSurface&&(force&&this.pendingSubmission||
      this.cameraVersion!==this.presentedCameraVersion)?super.render(force):null
    this.advanceResources()
    if(!this.asyncGpu)this.prepareResources()
    const result=input||super.render(force)
    if(this.asyncGpu&&this.resourcesRequested&&this.pendingSubmission&&
        this.pendingSubmission.drawn&&!this.submissions.uploading)this.advanceResources()
    return result
  }
}
rendererModule.TerraWebGlRenderer = class extends Renderer {
  constructor(canvas, options) {
    super(canvas, Object.assign({textureTransitionMs: 0}, options))
    textureUploadRenderers.add(this)
  }
  destroy() { textureUploadRenderers.delete(this); super.destroy() }
}

// Fixtures enter through the same immutable resource API as the SDK runtime.
const fixtureFrames = new WeakMap()
function publishFrame(renderer, view, draws, positions, uv, indices) {
  let state = fixtureFrames.get(renderer)
  if (!state) {state = {sequence: 0, nextId: 1, resources: new Map()}; fixtureFrames.set(renderer, state)}
  const resources = new Map()
  draws = draws.map(input => {
    const key = JSON.stringify([input.key, input.fragment])
    const p = positions.slice(input.firstVertex * 3, (input.firstVertex + input.vertexCount) * 3)
    const t = uv.slice(input.firstVertex * 2, (input.firstVertex + input.vertexCount) * 2)
    let resource = state.resources.get(key)
    const same = (a,b) => a.length === b.length && a.every((v,i) => v === b[i])
    if (!resource || !same(p, resource.positions) || !same(t, resource.textureUv)) {
      resource = {resourceId: state.nextId++, positions: p, textureUv: t}
      state.resources.set(key, resource)
    }
    input.resourceId = resource.resourceId
    input.textureResourceId = 4294967296 + resource.resourceId
    input.geometryKey = rendererModule.geometryKey(input)
    resources.set(resource.resourceId, resource)
    return Object.assign({}, input)
  })
  const sequence = ++state.sequence
  renderer.setMeshFrame(Object.assign({},view,{sequence}), draws, resources, indices, {modelRevision:sequence})
}

function draw(column) {
  return {
    key: { level: 0, i: 1, j: 2, k: 3 },
    fragment: 0,
    texture: { level: 2, matrix: 2, row: 3, column },
    firstVertex: 0,
    vertexCount: 3,
    firstIndex: 0,
    indexCount: 3,
    origin: [100, 200, 300]
  }
}

function settle() {
  return new Promise((resolve) => setTimeout(() => {
    // Simulate the bounded upload phase independently of issuing draw calls.
    textureUploadRenderers.forEach(renderer => {
      renderer.processPartitionUploads(Infinity)
      renderer.textures.processUploads(Infinity)
    })
    resolve()
  }, 0))
}

async function waitForImageCount(canvas, count) {
  for (let attempt = 0; attempt < 20 && canvas.images.length < count;
    ++attempt) {
    await settle()
  }
  assert(canvas.images.length >= count,
    `Expected ${count} texture requests, received ${canvas.images.length}`)
}

async function waitUntil(message, predicate) {
  for (let attempt = 0; attempt < 20 && !predicate(); ++attempt) {
    await settle()
  }
  assert(predicate(), message)
}

async function preparedDraws(renderer) {
  if(!renderer.renderDraws.length)return []
  for(let turn=0;turn<40;++turn) {
    renderer.advanceResources()
    const rows=renderer.presentationDraws(renderer.renderDraws,false)
    const displayed=renderer.displaySurface&&renderer.worldDisplay.prepared(renderer.displaySurface.renderDraws)
    if(rows&&renderer.worldDisplay.targetPrepared()&&(!displayed||displayed.stamp===renderer.worldDisplay.signature(displayed)))return rows
    await settle()
  }
  throw Error('Target world footprint did not prepare')
}

async function loadAllImages(canvas, startIndex) {
  let index = startIndex || 0
  let loaded = 0,quiet=0
  const renderer=Array.from(textureUploadRenderers).find(value=>value.canvas===canvas)
  for(let turn=0;turn<1000;++turn) {
    if(renderer)renderer.advanceResources()
    if(index<canvas.images.length) {
      const image=canvas.images[index++]
      if(image.onload)image.onload()
      quiet=0;++loaded
      assert(loaded<1000,'Texture refinement did not converge')
    } else ++quiet
    await settle();await settle()
    const preparing=renderer&&(renderer.worldDisplay.job||renderer.partitionActive||renderer.partitionQueue.length||
      renderer.partitionGroups.current&&renderer.partitionGroups.current.task)
    if(index===canvas.images.length&&quiet>=3&&!preparing)return index
  }
  assert.fail('Texture input/preparation clock did not become idle')
}

async function testIndependentImageryRoots(direct) {
  const canvas = new FakeCanvas(new FakeGl())
  const key = tile => `${tile.level}/${tile.matrix}/${tile.row}/${tile.column}`
  const url = tile => `https://tiles.example/${key(tile)}.jpg`
  const tile = (level, column) => ({level, matrix: level, row: 0, column})
  const roots = [tile(0, 0), tile(0, 1)]
  const leaves = [0, 1, 2, 3].map(column => tile(1, column))
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    urlForTile: url, directTextureTargets: direct, maximumTextureRequests: 2,
    maximumTextureRetries: 0, maximumTextureEntries: 16, textureCacheBytes: 16 * 349524
  })
  const store = renderer.textures
  const request = async value => {
    await waitUntil(`Missing regional request ${key(value)}`, () =>
      canvas.images.some(image => image.src === url(value) && image.onload))
    return canvas.images.find(image => image.src === url(value) && image.onload)
  }
  const loaded = async value => { (await request(value)).onload(); await settle(); await settle() }
  try {
    store.sync(leaves.map(texture => ({texture})))
    const delayed = await request(roots[1])
    await loaded(roots[0])
    assert(store.availableKeys.has(key(roots[0])), 'One pending root hid a GPU-ready independent root')
    assert.strictEqual(store.coverageReady(), false)
    await loaded(leaves[0])
    assert(!store.availableKeys.has(key(leaves[0])), 'New siblings published before their replacement group was ready')
    await loaded(leaves[1])
    assert.strictEqual(store.get(leaves[0]).kind, 'exact', 'A pending root stopped unrelated refinement')
    assert.strictEqual(store.get(leaves[1]).kind, 'exact')
    delayed.onerror(new Error('controlled root failure'))
    await settle(); await settle()
    await loaded(leaves[2])
    ;(await request(leaves[3])).onerror(new Error('controlled sibling failure'))
    await waitUntil('Failed sibling blocked an available region', () => store.availableKeys.has(key(leaves[2])))
    assert.strictEqual(store.get(leaves[2]).kind, 'exact', 'A failed root prevented descendant recovery')
    assert.strictEqual(store.transitionReserved, 0, 'Terminal groups held refinement slots indefinitely')
    assert.strictEqual(store.stats().state, 'degraded')
    store.retryFailed()
    assert.strictEqual(store.get(leaves[2]).kind, 'exact', 'Retry withdrew an already available sibling')
    assert.strictEqual(store.get(leaves[0]).kind, 'exact', 'Root retry withdrew an independent region')
    await loaded(roots[1])
    await loaded(leaves[3])
    assert(store.coverageReady())
    assert.strictEqual(store.stats().state, 'settled')
    assert.strictEqual(store.stats().targetMissing, 0)
  } finally { renderer.destroy(); await settle() }
  assert.strictEqual(store.scheduler.active.size, 0)
  assert.strictEqual(store.cache.stats().reservedBytes, 0)
}

async function testWorkerFinePresentationContinuity(handoverOnly = false, nestedGoals = false) {
  const canvas = new FakeCanvas(new FakeGl())
  canvas.width = canvas.height = 1024
  const receipts = []
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    urlForTile: tile => `https://tiles.example/${tile.level}/${tile.column}/${tile.row}`,
    textureDescriptor: {kind: 'global-geodetic', matrix_level_offset: 1,
      maximum_level: 8, level_zero_columns: 2, level_zero_rows: 1, tile_size: 256},
    terrainBoundImagery: false, maximumTextureEntries: 64,
    textureCacheBytes: 64 * 349524, maximumTextureRequests: 64,
    maximumTextureRetries: 0, prefetchTextureAncestors: false,
    onPresented: sequence => receipts.push(sequence)
  })
  try {
    const target = Object.assign(draw(4), {resourceId: 51, textureResourceId: 4294967347,
      texture:{level:2,matrix:3,row:3,column:4},origin: [0,0,0], vertexCount: 4, indexCount: 4})
    const coverage = Object.assign({}, target, {flags: 1,
      texture: {level: 0, matrix: 1, row: 0, column: 1}})
    const resource = {resourceId: 51, positions: new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]),
      textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])}
    const resources = new Map([[51, resource]])
    const indices = new Uint16Array([0,2,1,3])
    const state = {modelRevision: 1, pendingPriorityUpdateCount: 0}
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 1, coverageComplete: true}),
      [target, coverage], resources, indices, state)
    renderer.render()
    await loadAllImages(canvas)
    await waitUntil('Fine initial presentation did not settle', () => {
      renderer.render()
      return renderer.stats().quality.ready
    })
    const fine = Array.from(renderer.presentedTextures.keys())
    const fineTiles = new Map(renderer.presentedTextures)
    if (handoverOnly) {
      let clock = 0
      renderer.presentation.duration = 200
      renderer.options.textureClock = () => clock
      renderer.options.scheduledImagery = true
      const oldSurface = renderer.displaySurface
      const imageStart = canvas.images.length
      const nextTarget = Object.assign({}, target, {resourceId: 52})
      const neighbor = Object.assign({}, nextTarget, {resourceId: 53,
        texture: Object.assign({}, nextTarget.texture, {column: 5})})
      renderer.setMeshFrame(Object.assign(frame(), {sequence: 2, coverageComplete: true}),
        (nestedGoals ? [nextTarget, neighbor] : [nextTarget]).concat(coverage),
        new Map([[51, resource], [52, resource], [53, resource]]), indices, {modelRevision: 2})
      renderer.processUploads(Infinity)
      const coarseTarget = renderer.rootImageryDraw(renderer.current.draws[0])
      const planned = nestedGoals ? [Object.assign({}, coarseTarget, {
        texture: require('../../sdk/js/imagery/terra_texture_tiles').parentTextureTile(coarseTarget.sourceTexture)}),
        renderer.rootImageryDraw(renderer.current.draws[1])] : [coarseTarget]
      renderer.setImageryPlan(2, {draws: planned, levels: new Set(), quality: {
        planningComplete: true, cameraCurrent: true, coarsening: false, targetPixelError: 1.25}},
        [52,53].map(resourceId => ({resourceId, pixelsPerUv: 1, visible: true, centerDistance: 0})))
      if (nestedGoals) await loadAllImages(canvas, imageStart)
      await preparedDraws(renderer)
      renderer.render()
      assert.strictEqual(renderer.displaySurface, oldSurface,
        'Coarse geometry replaced the display mesh before its texture fade')
      assert(renderer.presentationBridges.length > 0 && renderer.presentation.active > 0,
        'A settled-direction plan did not fade resident coarse imagery on the old mesh')
      clock = 201
      // No request/decode event may be needed to publish after the last fade.
      // All images are resident; silence incidental cache wake-ups here.
      const sync = renderer.textures.sync
      const advance = renderer.advanceResources
      const residentImages = canvas.images.length
      renderer.textures.sync = () => {}
      try {
        // Draws can precede the next background preparation slice. Completing
        // a fade must wake publication, not synchronously finish its world cut
        // within an assumed two calls on every host/clock resolution.
        renderer.advanceResources = () => {}
        renderer.render(false)
        assert.strictEqual(renderer.presentation.active, 0)
        assert(renderer.renderRequested, 'Completed texture fade did not wake pending terrain publication')
        renderer.render(false)
        renderer.advanceResources = advance
        await waitUntil('Coarse geometry did not take over after old-mesh texture handover', () => {
          renderer.render(false)
          return renderer.displaySurface.current === renderer.current
        })
        assert.strictEqual(canvas.images.length, residentImages,
          'Resident handover started another image request to wake publication')
      } finally { renderer.advanceResources = advance; renderer.textures.sync = sync }
      assert.strictEqual(renderer.geometry.get(nextTarget.geometryKey).partitions.size, 0,
        'The new coarse mesh reconstructed the retiring fine texture cells')
      if (nestedGoals) {
        // Both fragments intersect the same world cell but demand nested
        // images. Their submission order must not choose a different fade.
        for (let i=0; i<4; ++i) {
          renderer.renderDraws.reverse()
          clock += 201
          renderer.render()
        }
        const key = require('../../sdk/js/core/terra_globe_common').textureKeyString
        const shared = renderer.presentation.cells.get(key(planned[0].texture))
        assert(shared && key(shared.a) === key(planned[0].texture) && key(shared.b) === key(planned[0].texture),
          'Shared cell presentation followed the coarser fragment or oscillated with draw order: ' +
            JSON.stringify(Array.from(renderer.presentation.cells.values())))
        assert.strictEqual(receipts.filter(sequence => sequence === 2).length, 1,
          'Nested handoff did not produce exactly one real submission receipt')
      }
      return
    }
    assert(renderer.stats().quality.resolvedLevelMinimum > 0)
    renderer.options.scheduledImagery = true
    const preciseDraws = renderer.renderDraws.slice()
    renderer.setImageryPlan(1, {draws: preciseDraws, levels: new Set(), quality: {
      planningComplete: true, spatialCut: true, cameraCurrent: true, targetPixelError: 1.25}},
      [{resourceId: 51, pixelsPerUv: 1024, visible: true, centerDistance: 0}])
    const stableDemand = Array.from(renderer.textures.targetDesired.keys()).sort()
    renderer.current.imageryPlan.quality.provisional = true
    renderer.setImageryPlan(1, renderer.current.imageryPlan, [])
    assert.strictEqual(renderer.current.workerMeasurements.get(51).pixelsPerUv, 1024,
      'An unchanged Worker delta erased measurements from a provisional cut')
    renderer.current.imageryPlan.quality.provisional = false
    renderer.partitionAdmissionRevision = (renderer.partitionAdmissionRevision || 0) + 1
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 1, coverageComplete: true}),
      [target, coverage], resources, indices, state)
    assert.deepStrictEqual(Array.from(renderer.textures.targetDesired.keys()).sort(), stableDemand,
      'Partition cache eviction invalidated unchanged camera/mesh precision demand')
    renderer.setImageryPlan(1, {draws: [renderer.rootImageryDraw(renderer.current.draws[0])],
      levels: new Set(), quality: {measurementPending: true, planningComplete: false,
        cameraCurrent: true, targetPixelError: 1.25}},
      [{resourceId: 51, pixelsPerUv: 1024, visible: true, centerDistance: 0}])
    assert.deepStrictEqual(Array.from(renderer.textures.targetDesired.keys()).sort(), stableDemand,
      'A preview without coarse precision proof cancelled fitted imagery demand')
    assert.strictEqual(renderer.current.workerMeasurements.get(51).pixelsPerUv, 1024,
      'A preview replaced the measurement supporting the retained precision cut')
    const provenCoarse=renderer.rootImageryDraw(renderer.current.draws[0])
    renderer.setImageryPlan(1, {draws:[provenCoarse],levels:new Set(),quality:{
      measurementPending:true,planningComplete:false,cameraCurrent:true,targetPixelError:1.25}},
    [{resourceId:51,pixelsPerUv:1,visible:true,centerDistance:0}])
    assert.deepStrictEqual(Array.from(renderer.textures.targetDesired.keys()),
      [require('../../sdk/js/core/terra_globe_common').textureKeyString(provenCoarse.texture)],
      'A current coarse SSE proof left obsolete fine images in the request target')
    assert.strictEqual(renderer.current.workerMeasurements.get(51).pixelsPerUv,1)
    assert(!renderer.current.imageryPlan.quality.planningComplete,
      'A local coarse proof marked the whole imagery plan complete')
    renderer.setImageryPlan(1, {draws: preciseDraws, levels: new Set(), quality: {
      planningComplete: true, spatialCut: true, cameraCurrent: true, targetPixelError: 1.25}},
      [{resourceId: 51, pixelsPerUv: 768, visible: true, centerDistance: 0}])
    assert.strictEqual(renderer.current.workerMeasurements.get(51).pixelsPerUv, 768,
      'Completed demand retained the old measurement for an already-known resource ID')
    renderer.setImageryPlan(1, {draws: [], levels: new Set(), quality: {
      planningComplete: true, cameraCurrent: true, targetPixelError: 1.25}},
      [{resourceId: 51, pixelsPerUv: 0, visible: false, centerDistance: 0}])
    assert(!Array.from(renderer.textures.targetDesired.values()).some(tile => tile.level > 0),
      'Retained demand overrode an authoritative invisible-surface result')
    await preparedDraws(renderer)
    assert.strictEqual(renderer.worldDisplay.read(renderer.renderDraws).length, 0,
      'Invisible geometry retained a partition barrier for the displayed fine imagery')
    renderer.setImageryPlan(1, {draws: preciseDraws, levels: new Set(), quality: {
      planningComplete: true, spatialCut: true, cameraCurrent: true, targetPixelError: 1.25}},
      [{resourceId: 51, pixelsPerUv: 1024, visible: true, centerDistance: 0}])
    for (let sequence = 2; sequence < 5; ++sequence) {
      renderer.setMeshFrame(Object.assign(frame(), {sequence, coverageComplete: true,
        cameraPosition: [10 + sequence,20,30]}), [target, coverage], resources, indices, state)
      renderer.render()
      assert(fine.every(key => renderer.presentedTextures.has(key)),
        'A pending Worker imagery plan discarded resident fine presentation')
      assert.strictEqual(renderer.stats().quality.ready, false)
      assert(canvas.gl.calls.some(call => call.name === 'stencilFunc' && call.args[0] === canvas.gl.EQUAL),
        'Coarse roots must fill uncovered pixels after fine terrain')
    }
    const oldDisplay = renderer.displaySurface
    const replacement = Object.assign({}, target, {resourceId: 52})
    const partitionTasks = []
    renderer.options.createPartitionTask = (id, cells, geometry, maximumBytes) => {
      const task = require('../../sdk/js/terrain/terra_surface_plan').createPartitionTask(
        geometry.model, cells, maximumBytes)
      if (id !== 52) return task
      let release
      const gate = new Promise(resolve => { release = resolve })
      partitionTasks.push(release)
      return {promise: gate.then(() => task.run()), cancel() { task.cancel(); release() }}
    }
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 5, coverageComplete: true}),
      [replacement, coverage], new Map([[51, resource], [52, resource]]), indices, {modelRevision: 2},
      null, [], {camera: {}, selectionCurrent: true,
        replacementPlan: {groups: [{before: [51], after: [52]}]}})
    renderer.processUploads(Infinity)
    assert.strictEqual(renderer.promoteCurrentSurfaceIfReady(), false)
    assert.strictEqual(renderer.displaySurface, oldDisplay)
    assert(!receipts.includes(5), 'Candidate was acknowledged before reaching the GPU')
    await waitUntil('Replacement geometry and partition production did not start', () => {
      renderer.render()
      return renderer.geometry.has('mesh:52') && partitionTasks.length
    })
    // Resident geometry alone is insufficient. Readiness must inspect the
    // missing fine cells, not a coarse fallback produced by preparePartitions.
    const required = (await preparedDraws(renderer))
    assert(required.some(item => item.resourceId === 52 && item.imageryClipCell),
      'Readiness replaced required UV cells with a coarse rendering fallback')
    assert.strictEqual(renderer.promoteCurrentSurfaceIfReady(), false,
      'Whole-cut publication bypassed pending fine UV output')
    assert.strictEqual(renderer.localReplacementSurface(), oldDisplay,
      'Local publication bypassed pending fine UV output')
    assert.strictEqual(renderer.displaySurface, oldDisplay)
    assert(!receipts.includes(5), 'Unready UV output retired the old displayed cut')
    delete renderer.options.createPartitionTask
    partitionTasks.forEach(release => release())
    await waitUntil('Fine partitions did not prepare the new terrain', () => {
      renderer.render()
      return renderer.displaySurface.current === renderer.current
    })
    assert(receipts.includes(5), 'Submitted terrain did not receive its presentation receipt')
    assert(fine.every(key => renderer.presentedTextures.has(key)))
    const stalePlan = {draws: oldDisplay.renderDraws, levels: new Set(),
      quality: {planningComplete: true, targetPixelError: 1.25}}
    renderer.setImageryPlan(5, stalePlan, [])
    assert(renderer.current.imageryPlan.draws.every(item => item.resourceId === 52),
      'An old imagery snapshot introduced retired terrain resources')
    assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete, false)
    const compatible = {draws: renderer.current.imageryPlan.draws.slice(), levels: new Set(),
      quality: {planningComplete: true, cameraCurrent: true, coarsening: true, targetPixelError: 1.25}}
    renderer.setImageryPlan(5, compatible, [])
    assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete, false,
      'An imagery cut without current model measurements was treated as complete')
    renderer.setImageryPlan(5, compatible,
      [{resourceId: 52, pixelsPerUv: 1024, visible: true, centerDistance: 0}])
    assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete, true,
      'A complete coarse cut covering all current resource IDs was rejected')
    renderer.setImageryPlan(5, stalePlan, [])
    assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete, false,
      'Coarse compatibility accepted an unmeasured replacement model')
    renderer.render()
    assert(fine.every(key => renderer.presentedTextures.has(key)))
    assert(renderer.stats().quality.geometryCoverageSubmitted > 0,
      'A partial imagery plan disabled the coarse coverage of newly exposed regions')
    const currentGeometry = renderer.geometry.get(renderer.renderDraws[0].geometryKey)
    const obsolete = {key:'obsolete-zoom-cell',bounds:{minimumU:0,maximumU:0.01,minimumV:0,maximumV:0.01}}
    renderer.requestPartitionSet(currentGeometry,[obsolete])
    renderer.setImageryPlan(5,{draws:renderer.renderDraws,levels:new Set(),quality:{
      planningComplete:false,cameraCurrent:true,coarsening:true,targetPixelError:1.25}},
      [{resourceId:52,pixelsPerUv:1,visible:true,centerDistance:0}])
    await preparedDraws(renderer)
    assert(!renderer.partitionQueue.some(job=>job.cells.some(cell=>cell.key===obsolete.key)),
      'Valid coarse coverage kept preparing obsolete fine partitions')
    renderer.requestPartitionSet(currentGeometry, [obsolete])
    const visibleFrame = renderer.current.frame
    const outsideFrame = Object.assign({}, visibleFrame, {projectionView: visibleFrame.projectionView.slice()})
    outsideFrame.projectionView[3] = 20
    renderer.setCameraFrame(outsideFrame)
    await preparedDraws(renderer)
    assert.strictEqual(renderer.worldDisplay.read(renderer.renderDraws).length, 0,
      'Camera preview retained an offscreen terrain barrier while waiting for Worker measurement')
    assert(!renderer.partitionQueue.some(job => job.geometry === currentGeometry),
      'Camera movement kept preparing offscreen partition cells')
    renderer.setCameraFrame(visibleFrame)
    assert((await preparedDraws(renderer)).length > 0,
      'Returning to the view reused stale invisible bounds')
    renderer.setImageryPlan(5,{draws:renderer.renderDraws,levels:new Set(),quality:{
      planningComplete:false,cameraCurrent:true,coarsening:true,targetPixelError:1.25}},
      [{resourceId:52,pixelsPerUv:1,visible:true,centerDistance:0}])
    let fadeTime = 0
    renderer.presentation.duration = 200
    renderer.options.textureClock = () => fadeTime
    renderer.render()
    assert(renderer.presentation.active > 0, 'Coarsening bypassed the display transition')
    assert(fine.every(key => renderer.presentedTextures.has(key)), 'Transition evicted its fine source')
    assert.strictEqual(renderer.stats().quality.ready, false)
    fadeTime = 100
    renderer.render()
    assert(Array.from(renderer.presentation.cells.values()).some(s => s.alpha === 0.5),
      'Coarsening did not sample the intermediate mixture')
    assert(canvas.gl.calls.some(call => call.name === 'uniform1f' &&
      call.args[0].name === 'u_texture_mix' && call.args[1] === 0.5), 'Blend weight did not reach the shader')
    assert(fine.every(key => renderer.textures.protectedKeys.has(key)), 'GPU admission unpinned a blend endpoint')
    fadeTime = 201
    renderer.render()
    assert.strictEqual(renderer.presentation.active, 0)
    renderer.presentation.duration = 0
    assert(fine.every(key=>!renderer.presentedTextures.has(key)),
      'Latest conservative measurement could not release oversampled fine imagery')
    assert(fine.every(key=>renderer.textures.cache.has(key)),
      'Coarsening erased reusable fine imagery instead of retiring its demand')
    assert.strictEqual(renderer.stats().quality.planningComplete, false,
      'Ready coarse coverage was mistaken for a completed precision plan')
    assert.strictEqual(renderer.stats().quality.ready, false)
    assert(fine.every(key=>!renderer.textures.desired.has(key) && !renderer.textures.isWanted(key)),
      'Retained presentation continued obsolete texture requests after coarse takeover')
    const {parentTextureTile,textureCellTransform} = require('../../sdk/js/imagery/terra_texture_tiles')
    const parents = new Map()
    fineTiles.forEach(tile => {
      const parent=parentTextureTile(tile), key=`${parent.level}/${parent.matrix}/${parent.row}/${parent.column}`
      parents.set(key,parent)
      renderer.textures.cache.delete(key)
    })
    renderer.presentedTextures = new Map(Array.from(parents.values(),parent =>
      Array.from(fineTiles).find(([,tile])=>textureTiles.textureTileContains(parent,tile))))
    renderer.presentation.clear()
    renderer.presentation.duration = 200
    renderer.presentation.beginFrame(fadeTime)
    renderer.presentedTextures.forEach(tile => renderer.presentation.resolve(tile, tile, () => true))
    renderer.presentation.endFrame()
    const pressureFineCount = renderer.presentedTextures.size
    const immutableSource=renderer.current.draws.find(draw=>draw.resourceId===52).texture
    const coarseDraws = Array.from(parents.values(),texture => {
      const t=textureCellTransform(immutableSource,texture)
      return Object.assign({},replacement,{geometryKey:currentGeometry.key,texture,sourceTexture:immutableSource,
        imageryCellScale:t.scale,imageryCellOffsetX:t.offsetX,imageryCellOffsetY:t.offsetY,
        imageryClipCell:true,imageryCapacityCoarsened:true})
    })
    renderer.textures.cache.maximumEntries = renderer.textures.requestedMaximumEntries = renderer.textures.cache.entries.size
    const pendingStart = canvas.images.length
    renderer.setImageryPlan(5,{draws:coarseDraws,levels:new Set(),quality:{
      planningComplete:false,cameraCurrent:true,coarsening:true,targetPixelError:1.25,feasiblePixelError:2,limitedByBudget:true}},
      [{resourceId:52,pixelsPerUv:1024,visible:true,centerDistance:0}])
    const advanceCapacity=renderer.textures.advance
    renderer.textures.advance=()=>{} // Hold this controlled admission result across selector slices.
    renderer.textures.admissionBlocked.clear()
    renderer.textures.blockedByCapacity = true
    renderer.current.imageryPlan.quality.coarsening = false
    renderer.capacityHandover.clear()
    await preparedDraws(renderer)
    assert.strictEqual(renderer.capacityHandover.size, 0,
      'An ordinary refinement frontier triggered the zoom capacity bridge')
    renderer.current.imageryPlan.quality.coarsening = true
    const measured = renderer.measureDraw, error = renderer.measureTextureDraw
    renderer.measureDraw = function(draw) { return draw.resourceId===99 ? {visible:false} : measured.call(this,draw) }
    renderer.measureTextureDraw = function(draw,level) { return draw.resourceId===99 ? 0 : error.call(this,draw,level) }
    const hidden = Object.assign({},renderer.renderDraws[0],{resourceId:99,geometryKey:'hidden',texture:coverage.texture})
    const visibleDemand=renderer.renderDraws
    renderer.renderDraws=[hidden].concat(visibleDemand)
    const handover=await preparedDraws(renderer)
    renderer.renderDraws=visibleDemand
    renderer.measureDraw=measured;renderer.measureTextureDraw=error
    assert.strictEqual(renderer.capacityHandover.size,1,'Capacity handover must select one visible cell')
    assert(Array.from(renderer.capacityHandover.values()).every(tile=>tile.level===3),
      'A hidden root hijacked capacity handover for visible fine imagery')
    const visibleHandover=handover.filter(draw=>draw.resourceId===52)
    assert(visibleHandover.some(draw=>draw.imageryTarget&&draw.imageryTarget.level<4) &&
      visibleHandover.some(draw=>draw.imageryTarget&&draw.imageryTarget.level===4),
      'Capacity handover must free one local cell while retaining other fine regions')
    renderer.textures.advance=advanceCapacity
    await waitUntil('Local ancestor handover did not free presentation slots',()=>{
      fadeTime += 50
      renderer.render()
      assert(renderer.textures.cache.entries.size <= renderer.textures.requestedMaximumEntries,
        'Pinned transition endpoints exceeded the full cache budget')
      return fine.filter(key=>renderer.presentedTextures.has(key)).length<pressureFineCount
    })
    await loadAllImages(canvas,pendingStart)
    await waitUntil('New coarse demand remained blocked after local handover',()=>{
      fadeTime += 50
      renderer.render()
      return renderer.stats().textures.targetMissing===0
    })
    assert.strictEqual(renderer.stats().textures.missingRatio,0)
    assert.strictEqual(renderer.current.imageryPlan.quality.targetPixelError,1.25,
      'A temporary capacity bridge changed the precision demand')

  } finally { renderer.destroy() }
}

async function testCoarseGeometryAdmission(workLimited = false) {
  const ground = require('../../sdk/js/terrain/terra_ground')
  const snapshots = []
  const canvas = new FakeCanvas(new FakeGl())
  canvas.width = canvas.height = 1024
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    urlForTile: tile => `https://tiles.example/${tile.level}/${tile.column}/${tile.row}`,
    textureDescriptor: {kind: 'global-geodetic', matrix_level_offset: 1,
      maximum_level: 8, level_zero_columns: 2, level_zero_rows: 1, tile_size: 256},
    terrainBoundImagery: false, managedResources: true, geometryCacheBytes: 1024 * 1024,
    maximumTextureEntries: 64, textureCacheBytes: 64 * 611668,
    maximumTextureRequests: 64, maximumTextureRetries: 0, prefetchTextureAncestors: false,
    onDrawsSubmitted: value => snapshots.push(value)
  })
  try {
    const target = Object.assign(draw(4), {resourceId: 51, textureResourceId: 4294967347, origin: [0,0,0], vertexCount: 4, indexCount: 4})
    const coverage = Object.assign({}, target, {resourceId: 53, flags: 1,
      texture: {level: 0, matrix: 1, row: 0, column: 1}})
    const resource = {positions: new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]),
      textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])}
    const indices = new Uint16Array([0,2,1,3])
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 1, coverageComplete: true}),
      [target, coverage], new Map([[51, resource], [53, resource]]), indices, {modelRevision: 1})
    renderer.render()
    await loadAllImages(canvas)
    await waitUntil('Geometry pressure fixture did not display fine imagery', () => {
      renderer.render(); return renderer.stats().quality.ready
    })
    const fine = Array.from(renderer.presentedTextures.keys())
    const oldKey = target.geometryKey
    if (!workLimited) renderer.geometry.maximumBytes = renderer.options.geometryCacheBytes = renderer.geometry.bytes
    renderer.options.scheduledImagery = true
    const replacement = Object.assign({}, target, {resourceId: 52})
    const raised = Object.assign({}, resource, {positions: resource.positions.map((v, i) => i % 3 === 2 ? 0.25 : v)})
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 2, coverageComplete: true}),
      [replacement, coverage], new Map([[52, raised], [53, resource]]), indices, {modelRevision: 2})
    const allocated = renderer.gl.calls.filter(call => call.name === 'bufferData').length
    if (workLimited) {
      const {GlSubmission, UploadBudget} = require('../../adapters/webgl/gl_allocation')
      const budget = new UploadBudget(1, 1)
      budget.take(1, 1)
      renderer.uploadBatch = new GlSubmission(renderer.gl, null, budget)
    }
    const admissionRevision = renderer.resourceLedger.revision
    renderer.processUploads(Infinity)
    if (workLimited) assert.strictEqual(renderer.resourceLedger.revision, admissionRevision,
      'Exhausted upload work credit mutated resident capacity')
    renderer.uploadBatch = null
    assert(renderer.missingCurrentGeometryCount() > 0, 'Unadmitted geometry reached the display cut')
    assert.strictEqual(renderer.gl.calls.filter(call => call.name === 'bufferData').length, allocated,
      'Rejected GPU admission allocated a buffer before checking capacity')
    assert.strictEqual(renderer.geometry.stats().reservedBytes, 0)
    assert.strictEqual(renderer.promoteCurrentSurfaceIfReady(), false)
    assert.strictEqual(renderer.stats().transition.handoff.phase, workLimited ? 'geometry-upload' : 'geometry-capacity')
    assert(renderer.geometryPinnedKeys.has(oldKey))
    const plan = {draws: [renderer.rootImageryDraw(renderer.current.draws[0])], levels: new Set(),
      quality: {planningComplete: false, cameraCurrent: false, coarsening: true, targetPixelError: 1.25}}
    const measurements = [{resourceId: 52, pixelsPerUv: 1, visible: true, centerDistance: 0}]
    renderer.setImageryPlan(2, plan, measurements)
    assert.strictEqual(renderer.promoteCurrentSurfaceIfReady(), false, 'An old camera retired the fine geometry pins')
    plan.quality.cameraCurrent = true
    const presentationKeyFor = renderer.textures.presentationKeyFor
    renderer.textures.presentationKeyFor = () => null
    renderer.setImageryPlan(2, plan, measurements)
    assert.strictEqual(renderer.promoteCurrentSurfaceIfReady(), false, 'Missing GPU roots retired the fine geometry pins')
    renderer.textures.presentationKeyFor = presentationKeyFor
    renderer.textures.coverageReady = () => false
    renderer.current.frame.coverageComplete = false
    assert.strictEqual(renderer.promoteCurrentSurfaceIfReady(), false, 'Incomplete terrain coverage retired the old cut')
    renderer.current.frame.coverageComplete = true
    const oldSurface = renderer.displaySurface
    renderer.setImageryPlan(2, plan, measurements)
    assert.strictEqual(renderer.displaySurface, oldSurface, 'Planning replaced display before its clock ran')
    assert(renderer.promoteCurrentSurfaceIfReady(false), 'Ready coarse coverage waited for unrelated detail uploads')
    assert(renderer.geometryPinnedKeys.has(oldKey), 'Preparation retired the displayed geometry')
    assert(fine.every(key => renderer.textures.protectedKeys.has(key)), 'Old images were released before submission')
    // Separate command submission from the next allocation batch: only the
    // coarse mesh is resident at this exact handoff boundary.
    renderer.renderSurface()
    assert(renderer.displaySurface.useGeometryCoverage)
    assert.strictEqual(renderer.displaySurface.renderDraws.length, 0,
      'Coarse admission rebuilt fine partitions before replacement geometry was resident')
    assert(renderer.stats().quality.geometryCoverageSubmitted > 0)
    const coarseSurface = renderer.renderedSurface
    assert(coarseSurface, 'GPU coarse coverage emitted no actual draw snapshot')
    assert.deepStrictEqual(Array.from(coarseSurface.resources.keys()), [53],
      'Unuploaded detail leaked into the submitted surface')
    assert.strictEqual(ground.surfaceHeight(coarseSurface, [0, 0], 0), 0)
    assert.strictEqual(renderer.stats().textures.missingRatio, 0)
    renderer.processUploads(Infinity)
    assert.strictEqual(renderer.missingCurrentGeometryCount(), 0, 'Ready coarse coverage did not unblock geometry admission')
    assert(!renderer.geometryPinnedKeys.has(oldKey))
    assert(renderer.geometry.bytes <= renderer.options.geometryCacheBytes)
    assert.strictEqual(renderer.stats().quality.ready, false)
    const coveredSurface = renderer.displaySurface
    let displayRequests = 0
    renderer.requestRenderCallback = () => { ++displayRequests }
    renderer.renderRequested = false
    renderer.advanceResources()
    assert.strictEqual(renderer.displaySurface, coveredSurface, 'Background work published ahead of the display clock')
    assert(renderer.renderRequested && displayRequests > 0,
      'The last upload did not wake the same-frame coverage-to-target publication')
    renderer.render(false)
    assert.notStrictEqual(renderer.renderedSurface, coarseSurface,
      'The same candidate did not publish its newly drawn detail')
    assert.strictEqual(ground.surfaceHeight(renderer.renderedSurface, [0, 0], 0), 0.25)
    renderer.renderRequested = false
    assert(renderer.promoteCurrentSurfaceIfReady(false))
    assert.strictEqual(renderer.renderRequested, false, 'Unchanged target kept waking the display clock')
    const snapshotCount = snapshots.length, detailed = renderer.renderedSurface
    renderer.render()
    assert.strictEqual(snapshots.length, snapshotCount, 'Identical draw sets invalidated surface-bound features')
    renderer.resetWorker()
    assert.strictEqual(renderer.renderedSurface, detailed, 'Worker reset discarded still-visible GPU terrain')
    renderer.contextWasLost()
    assert.strictEqual(snapshots[snapshots.length - 1], null, 'Context loss retained an apparently rendered surface')
  } finally {renderer.destroy()}
}

function testSubmittedSurfaceClipping() {
  const {renderedSurface} = require('../../sdk/js/terrain/rendered_surface')
  const ground = require('../../sdk/js/terrain/terra_ground')
  const mesh = z => ({positions: new Float32Array([0,0,z, 10,0,z, 0,10,z, 10,10,z]),
    textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])})
  const owner = {indices: new Uint16Array([0,2,1,3]),
    meshResources: new Map([[1, mesh(10)], [2, mesh(15)], [3, mesh(20)]])}
  const draw = {geometryKey: 'mesh:1', resourceId: 1, textureResourceId: 4294967297, origin: [0,0,0],
    firstIndex: 0, indexCount: 4, vertexCount: 4, flags: 0, imageryClipCell: true,
    imageryCellScale: 2, imageryCellOffsetX: -1, imageryCellOffsetY: -1}
  const submitted = [[draw, true]]
  const clipped = renderedSurface(null, owner, submitted, false)
  assert.strictEqual(ground.surfaceHeight(clipped, [7.5,7.5], 0), 10)
  assert.strictEqual(ground.surfaceHeight(clipped, [2.5,2.5], 0), null,
    'A not-yet-drawn UV cell returned a candidate height')
  assert.deepStrictEqual(Array.from(clipped.resources.keys()), [1], 'Unused meshes retained query ownership')
  assert.strictEqual(renderedSurface(clipped, owner, submitted, false), clipped)
  const adjacent = Object.assign({}, draw, {imageryCellOffsetX: 0})
  const joined = renderedSurface(clipped, owner, submitted.concat([[adjacent, true]]), false)
  assert.strictEqual(joined.draws.length, 1)
  assert.strictEqual(ground.surfaceHeight(joined, [2.5,7.5], 0), 10)
  assert.strictEqual(ground.surfaceHeight(joined, [2.5,2.5], 0), null)
  const whole = renderedSurface(joined, owner, [[draw, false]], false)
  assert.strictEqual(ground.surfaceHeight(whole, [2.5,2.5], 0), 10,
    'Height rendering inherited texture-only clipping')
  const backgrounds = [2,3].map(id => [Object.assign({}, draw, {resourceId: id, geometryKey: 'mesh:' + id, flags: 1}), false])
  for (const commands of [submitted.concat(backgrounds), backgrounds.concat(submitted)]) {
    const cut = renderedSurface(null, owner, commands, true)
    assert.strictEqual(ground.surfaceHeight(cut, [7.5,7.5], 0), 10,
      'Stencil-only coarse coverage obscured submitted detail')
    assert.strictEqual(ground.surfaceHeight(cut, [2.5,2.5], 0), 20,
      'The first coarse hit hid a nearer coarse surface')
    const depthOnly = renderedSurface(cut, owner, commands, false)
    assert.strictEqual(ground.surfaceHeight(depthOnly, [7.5,7.5], 0), 20,
      'Non-stencil rendering ignored the depth-tested coarse surface')
  }
  const empty = renderedSurface(whole, owner, [], false)
  assert.strictEqual(ground.surfaceHeight(empty, [2.5,2.5], 0), null)
  assert.strictEqual(empty.resources.size, 0)
}

async function testLocalGeometryReplacement(coupled = false, changeGeneration = false, scanning = false) {
  const {patch, surface} = require('./terrain_surface_fixture')
  const canvas = new FakeCanvas(new FakeGl()), receipts = [], submissions = [], local = [], snapshots = []
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    mode: 'height', managedResources: true, geometryCacheBytes: 900,
    urlForTile: () => 'https://tiles.example/0.jpg',
    onPresented: sequence => receipts.push(sequence),
    onDrawsSubmitted: value => snapshots.push(value),
    onSurfaceSubmitted: (current, partial) => {
      submissions.push(current.draws.map(draw => draw.resourceId))
      if (partial) local.push(Array.from(current.meshResources.keys()))
    }
  })
  const corners = [[0, 0], [1, 0], [0, 1]]
  const nextCorners = [[1, 1], [0, 1], [1, 0]]
  const old = surface([patch(51, corners, undefined, 4), patch(52, nextCorners, undefined, 4)])
  const raisedInterior = (p, x, y, n) => coupled ? (x + y === n ? 0.1 : 0) :
    (x > 0 && y > 0 && x + y < n ? 0.1 : 0)
  const next = surface([patch(53, corners, raisedInterior, 4), patch(54, nextCorners, raisedInterior, 4)])
  // One patch is 300 bytes. The old cut and one replacement fit, both do not.
  const publish = (sequence, value) => renderer.setMeshFrame(
    Object.assign(frame(), {sequence, coverageComplete: true}), value.draws,
    value.meshResources, old.indices, {modelRevision: sequence, pendingPriorityUpdateCount: scanning ? 1 : 0,
      workerGeneration: changeGeneration ? sequence : 1}, null, [], replacementPresentation(renderer, value))
  const gl = canvas.gl, bindBuffer = gl.bindBuffer, attrib = gl.vertexAttribPointer, issue = gl.drawElements
  let bound, position, drawnBuffers = []
  gl.bindBuffer = function (target, value) {
    if (target === gl.ARRAY_BUFFER) bound = value
    bindBuffer.apply(this, arguments)
  }
  gl.vertexAttribPointer = function (location) {
    if (location === 0) position = bound
    attrib.apply(this, arguments)
  }
  gl.drawElements = function () { drawnBuffers.push(position); issue.apply(this, arguments) }
  try {
    publish(1, old); renderer.render()
    assert.deepStrictEqual(receipts, [1])
    assert.strictEqual(renderer.displaySurface.useGeometryCoverage, false,
      'A resident retained cut was mislabeled coarse because selection was still scanning')
    if (scanning) assert.strictEqual(renderer.stats().quality.terrainSelectionCurrent, false)
    const previousSurface = renderer.renderedSurface
    const previousBuffer = renderer.geometry.get('mesh:51').positionBuffer
    publish(2, next)
    if (!coupled && !changeGeneration && renderer.localReplacementSurface) {
      const gl = canvas.gl, drawElements = gl.drawElements
      let drawing = false
      renderer.setDebugOptions({webglErrors: true})
      gl.drawElements = function () { drawElements.apply(this, arguments); drawing = true }
      gl.getError = () => drawing ? 0x0502 : 0
      for (let i = 0; i < 30; ++i) { drawing = false; renderer.render(); await settle() }
      assert.strictEqual(renderer.stats().transition.localReplacement.submitted, 0,
        'Rejected GPU submission committed local ownership')
      assert.deepStrictEqual(submissions, [[51, 52]], 'Rejected partial surface reached ground queries')
      assert.strictEqual(local.length, 0, 'Failed GPU draw emitted a local retirement receipt')
      assert.strictEqual(renderer.renderedSurface, previousSurface, 'Failed draw changed the query surface')
      gl.drawElements = drawElements; gl.getError = () => 0
      renderer.setDebugOptions({webglErrors: false})
    }
    for (let i = 0; i < 30 && !submissions.some(ids => ids.includes(53)); ++i) {
      drawnBuffers = []; renderer.render(); await settle()
    }
    if (coupled || changeGeneration) {
      assert.deepStrictEqual(submissions, [[51, 52]], 'A dependent boundary was torn by partial replacement')
    } else {
      assert(drawnBuffers.includes(renderer.geometry.get('mesh:53').positionBuffer) &&
        drawnBuffers.includes(renderer.geometry.get('mesh:52').positionBuffer) &&
        !drawnBuffers.includes(previousBuffer),
      'The ready replacement was uploaded but the renderer continued drawing the complete old cut')
      assert(submissions.some(ids => ids.includes(53) && ids.includes(52) && !ids.includes(51) && !ids.includes(54)),
        'An unrelated blocked upload prevented a ready region from replacing its old surface')
      assert.deepStrictEqual(local, [[53, 52]], 'Local receipt did not describe the actually retained cut')
      const ground = require('../../sdk/js/terrain/terra_ground')
      const mesh = renderer.renderedSurface
      assert(Math.abs(ground.surfaceHeight(mesh, [0.25, 0.25], 0) - 0.1) < 1e-6)
      assert.strictEqual(ground.surfaceHeight(mesh, [0.75, 0.75], 0), 0,
        'The blocked neighbour was reported as already rendered')
    }
    assert.deepStrictEqual(receipts, [1], 'Partial rendering prematurely released native frame ownership')
    if (changeGeneration) assert.strictEqual(renderer.stats().transition.localReplacement, null,
      'Local surface ownership crossed a Worker resource generation')
    else assert.strictEqual(renderer.stats().transition.localReplacement.submitted, coupled ? 0 : 1)
    assert(renderer.geometryPinnedKeys.has('mesh:52'), 'Unsubmitted neighbour lost its GPU ownership')
    if (!coupled && !changeGeneration) {
      // A same-model refresh still has a new old-cut proof after partial display.
      const presentation = replacementPresentation(renderer, next)
      renderer.plannedCameraVersion = renderer.cameraVersion
      const snapshot = renderer.current
      renderer.setMeshFrame(Object.assign(frame(), {sequence: 2, coverageComplete: true}),
        next.draws, next.meshResources, old.indices,
        {modelRevision: 2, workerGeneration: 1, pendingPriorityUpdateCount: scanning ? 1 : 0},
        null, [], presentation)
      assert.strictEqual(renderer.current, snapshot, 'Fixture did not exercise same-model reuse')
      assert.strictEqual(renderer.current.replacementPlan, presentation.replacementPlan,
        'Same-model reuse kept a proof for an obsolete displayed cut')
    }
    if (coupled || changeGeneration) renderer.geometry.maximumBytes = 1200
    else assert(!renderer.geometryPinnedKeys.has('mesh:51'), 'A locally replaced mesh still blocks GPU admission')
    for(let turn=0;turn<3&&receipts.length<2;++turn){renderer.requestResources();renderer.render()}
    assert.deepStrictEqual(receipts, [1, 2])
    assert.deepStrictEqual(submissions[submissions.length - 1], [53, 54])
    assert.strictEqual(renderer.stats().transition.localReplacement, null)
  } finally { renderer.destroy() }
}

async function testSameCameraDemandContinuity() {
  const canvas = new FakeCanvas(new FakeGl())
  let inlinePlans = 0
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    urlForTile: tile => `https://tiles.example/${tile.level}/${tile.column}/${tile.row}`,
    textureDescriptor: {kind: 'global-geodetic', matrix_level_offset: 1,
      maximum_level: 8, level_zero_columns: 2, level_zero_rows: 1, tile_size: 256},
    terrainBoundImagery: false, scheduledImagery: true, textureRequestGraceMs: 0,
    maximumTextureRequests: 64, maximumTextureRetries: 0,
    // Direct Wasm still exposes this callback. Scheduled publication must use
    // its provisional coverage rather than enter an unbounded synchronous plan.
    planImagery() { ++inlinePlans; throw Error('Scheduled imagery entered the synchronous planner') }
  })
  try {
    const target = Object.assign(draw(4), {resourceId: 51, textureResourceId: 4294967347, origin: [0,0,0], vertexCount: 4, indexCount: 4})
    const coverage = Object.assign({}, target, {flags: 1,
      texture: {level: 0, matrix: 1, row: 0, column: 1}})
    const resource = {positions: new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]),
      textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])}
    const resources = new Map([[51, resource]])
    const indices = new Uint16Array([0,2,1,3])
    const publish = (sequence, generation, targets = [target, coverage]) => {
      renderer.setMeshFrame(Object.assign(frame(), {sequence, coverageComplete: true}),
        targets, resources, indices, {modelRevision: sequence, workerGeneration: generation})
    }
    publish(1, 1)
    assert.strictEqual(renderer.pendingQualityStats.planningComplete, false,
      'Provisional coverage claimed completed imagery planning')
    renderer.render()
    await loadAllImages(canvas)
    const fine = Object.assign({}, target, {
      texture: {level: 6, matrix: 7, row: 8, column: 16}})
    const key = '6/7/8/16'
    const plan = {draws: [fine], levels: new Set(), quality: {
      cameraCurrent: true, coarsening: true, planningComplete: true, targetPixelError: 1.25}}
    const measurements = [{resourceId: 51, visible: true, pixelsPerUv: 1024, centerDistance: 0}]
    const install = () => renderer.setImageryPlan(renderer.current.frame.sequence, plan, measurements)
    install()
    await settle()
    assert(renderer.textures.targetDesired.has(key), 'The fixture must demand a fine target')
    const requests = new Map(renderer.textures.scheduler.active)
    assert(requests.size, 'The fixture must have unfinished pyramid downloads')
    const intact = () => requests.forEach((request, key) =>
      assert.strictEqual(renderer.textures.scheduler.active.get(key), request,
        'A same-camera terrain publication cancelled an applicable download'))
    const retainedCut = renderer.current
    publish(2, 1)
    assert.strictEqual(renderer.current, retainedCut,
      'Unrelated topology revision restarted the unchanged rendered cut')
    assert.strictEqual(renderer.current.updateState.modelRevision, 2,
      'Immutable cut reuse retained obsolete publication metadata')
    intact()
    assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete, true)
    assert(renderer.current.workerMeasurements.has(51))
    const replacement = Object.assign({}, target, {resourceId: 52})
    resources.set(52, resource)
    publish(3, 1, [target, replacement, coverage])
    intact()
    assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete, false,
      'A new unmeasured model incorrectly inherited complete precision')
    assert(renderer.current.imageryPlan.draws.some(d => d.resourceId === 52 && d.texture.level === 0))
    const replacementPlan = {draws: [fine, Object.assign({}, fine, {
      resourceId: 52, geometryKey: renderer.current.draws.find(d => d.resourceId === 52).geometryKey})],
      levels: new Set(), quality: {cameraCurrent: true, planningComplete: true, targetPixelError: 1.25}}
    renderer.setImageryPlan(3, replacementPlan, [])
    assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete, false,
      'Complete demand incorrectly acknowledged a dropped measurement delta')
    renderer.setImageryPlan(3, replacementPlan, measurements.concat([
      {resourceId: 52, visible: false, pixelsPerUv: 0, centerDistance: 0}]))
    assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete, true,
      'Replayed full measurements did not complete the recovered demand')
    publish(4, 1, [replacement, coverage])
    assert(!renderer.current.imageryPlan.draws.some(d => d.resourceId === 51),
      'A retired model remained in the demand cut')
    publish(5, 1)
    install()
    renderer.setCameraFrame({cameraPosition: [11,20,30], projectionView: frame().projectionView})
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 6, cameraPosition: [11,20,30]}),
      [target, coverage], resources, indices, {modelRevision: 6, workerGeneration: 1})
    assert(renderer.textures.targetDesired.has(key), 'Camera/model publication revoked reusable image work')
    assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete, false,
      'Reusing spatial demand claimed current-view precision')
    assert.strictEqual(renderer.current.workerMeasurements.size, 0, 'A new camera reused old projection measurements')
    publish(7, 1)
    install()
    renderer.options.devicePixelRatio = 2
    publish(8, 1)
    assert.strictEqual(renderer.current.imageryPlan, undefined, 'DPR changes reused an obsolete SSE cut')
    install()
    renderer.options.textureDescriptor = Object.assign({}, renderer.options.textureDescriptor, {maximum_level: 7})
    publish(9, 1)
    assert.strictEqual(renderer.current.imageryPlan, undefined, 'Changed imagery source reused old demand')
    install()
    publish(10, 2)
    assert.strictEqual(renderer.current.imageryPlan, undefined, 'Worker generations shared model measurements')
    assert.strictEqual(inlinePlans, 0, 'A scheduled publication performed inline imagery planning')
  } finally { renderer.destroy() }
}

async function testMovingCameraDemandOwnership() {
  const canvas = new FakeCanvas(new FakeGl())
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    urlForTile: tile => `https://tiles.example/${tile.level}/${tile.column}/${tile.row}`,
    textureDescriptor: {kind:'global-geodetic', matrix_level_offset:1, maximum_level:8, minimum_level:0, bounds:[[-180,-90],[180,90]],
      level_zero_columns:2, level_zero_rows:1, tile_size:256},
    terrainBoundImagery:false, scheduledImagery:true, textureRequestGraceMs:0,
    maximumTextureRequests:64, maximumTextureRetries:0
  })
  try {
    const target = Object.assign(draw(4), {textureNode:{level:1,root:6,row:3,column:4},resourceId:51, textureResourceId:4294967347, origin:[0,0,0], vertexCount:4, indexCount:4})
    const resource = {positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),
      textureUv:new Float32Array([0,0,1,0,0,1,1,1])}
    const resources = new Map([[51,resource]]), indices = new Uint16Array([0,2,1,3])
    renderer.setMeshFrame(Object.assign(frame(), {sequence:1,coverageComplete:true}),
      [target], resources, indices, {modelRevision:1,workerGeneration:1})
    renderer.render()
    await loadAllImages(canvas)
    const fine = Object.assign({}, target, {sourceTexture:target.texture,imageryPixelError:1,
      texture:{level:6,matrix:7,row:48,column:64}})
    const plan = (draws, quality) => ({draws,levels:new Set(),quality:Object.assign({
      targetPixelError:1.25,planningComplete:false,cameraCurrent:true},quality)})
    const measured = pixelsPerUv => [{resourceId:51,visible:true,pixelsPerUv,centerDistance:0}]
    const install = (p, m = []) => renderer.setImageryPlan(renderer.current.frame.sequence,p,m)
    const demand = () => Array.from(renderer.textures.targetDesired.keys()).sort()
    install(plan([fine],{planningComplete:true}),measured(1024))
    await settle()
    const expected = demand(), requests = new Map(renderer.textures.scheduler.active)
    assert(requests.size, 'Moving-camera fixture needs unfinished image work')
    renderer.setCameraFrame({cameraPosition:[11,20,30],projectionView:frame().projectionView})
    install(plan([fine],{cameraCurrent:false}))
    assert.strictEqual(renderer.current.workerMeasurements.size,0,'Old camera supplied fresh measurements')
    const preview = () => plan([renderer.rootImageryDraw(target)],{measurementPending:true})
    for (let i=0;i<3;++i) {
      install(preview(),measured(16384))
      assert.deepStrictEqual(demand(),expected,'New-view preview revoked fitted immutable demand')
      requests.forEach((request,key) => assert.strictEqual(renderer.textures.scheduler.active.get(key),request,
        'Preview cancelled an applicable in-flight request'))
      install(plan([fine],{cameraCurrent:false}))
      assert.strictEqual(renderer.current.workerMeasurements.get(51).pixelsPerUv,16384,
        'Late demand erased current-view measurement ownership')
      assert.strictEqual(renderer.measureDraw(fine).pixelsPerUv,16384,
        'Old plan identity invalidated a current camera measurement')
      assert.strictEqual(renderer.current.imageryPlan.quality.planningComplete,false)
    }
    // A snapshot from a slightly earlier camera still advances useful work
    // while the actual view requires finer imagery; continuous motion must not
    // wait until the pointer stops before refinement can progress.
    const finer = Object.assign({},fine,{texture:{level:7,matrix:8,row:96,column:128}})
    install(plan([finer],{cameraCurrent:false}))
    assert(demand().includes('7/8/96/128'),'Late usable refinement waited for a stationary camera')
    const advanced = demand()
    install(preview(),measured(16384))
    assert.deepStrictEqual(demand(),advanced,'Coverage preview replaced useful late refinement')
    // Certified large-ascent coverage must release oversized target demand,
    // and another late fine result must not resurrect that oversampling.
    renderer.setCameraFrame({cameraPosition:[12,20,30],projectionView:frame().projectionView})
    install(plan([renderer.rootImageryDraw(target)],{measurementPending:true,coarsening:true}),measured(0.5))
    const coarse = demand()
    assert(!coarse.includes('7/8/96/128'),'A safe coarse bound could not retire obsolete fine demand')
    install(plan([finer],{cameraCurrent:false}))
    assert.deepStrictEqual(demand(),coarse,'A late snapshot resurrected obsolete fine demand')
    assert.strictEqual(renderer.current.workerMeasurements.get(51).pixelsPerUv,0.5)
    renderer.setCameraFrame({cameraPosition:[13,20,30],projectionView:frame().projectionView})
    install(plan([finer],{cameraCurrent:false}))
    install(preview(),measured(Infinity))
    assert(demand().includes('7/8/96/128'),'Unknown near-plane projection discarded useful demand')
    install(preview(),measured(16384))
    assert.strictEqual(renderer.current.workerMeasurements.get(51).pixelsPerUv,16384,
      'Retaining spatial demand froze an unknown preview instead of accepting its tighter measurement')
    install(plan([],{measurementPending:true}),[{resourceId:51,visible:false,pixelsPerUv:0}])
    await preparedDraws(renderer)
    assert(!renderer.worldDisplay.read(renderer.renderDraws).length,
      'Retained spatial demand overrode current invisibility')
    renderer.setImagerySource(Object.assign({},renderer.options.textureDescriptor,{maximum_level:7}),
      tile => `https://other.example/${tile.level}/${tile.column}/${tile.row}`)
    assert.strictEqual(renderer.current.workerMeasurements.size,0,'Source replacement retained projection evidence')
  } finally {renderer.destroy();await settle()}
  assert.strictEqual(renderer.textures.scheduler.active.size,0)
}

async function testPanPartitionCoverage() {
  const canvas = new FakeCanvas(new FakeGl())
  canvas.width = canvas.height = 1024
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    urlForTile: tile => `https://tiles.example/${tile.level}/${tile.column}/${tile.row}`,
    textureDescriptor: {kind: 'global-geodetic', matrix_level_offset: 1,
      maximum_level: 8, level_zero_columns: 2, level_zero_rows: 1, tile_size: 256},
    terrainBoundImagery: false, maximumTextureEntries: 64,
    textureCacheBytes: 64 * 349524, maximumTextureRequests: 64,
    maximumTextureRetries: 0, prefetchTextureAncestors: false
  })
  try {
    const target = Object.assign(draw(4), {resourceId: 51, textureResourceId: 4294967347, origin: [0,0,0], vertexCount: 4, indexCount: 4})
    const coverage = Object.assign({}, target, {flags: 1, texture: {level: 0, matrix: 1, row: 0, column: 1}})
    const resource = {resourceId: 51, positions: new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]),
      textureUv: new Float32Array([0,0, 1,0, 0,1, 1,1])}
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 1, coverageComplete: true}),
      [target, coverage], new Map([[51, resource]]), new Uint16Array([0,2,1,3]),
      {modelRevision: 1, pendingPriorityUpdateCount: 0})
    renderer.render()
    await loadAllImages(canvas)
    await waitUntil('Pan fixture failed to warm fine imagery', () => {
      renderer.render(); return renderer.stats().quality.ready
    })
    const draws = renderer.renderDraws.slice()
    const geometry = renderer.geometry.get(draws[0].geometryKey)
    const projection = renderer.measureDraw(draws[0])
    assert(!('model' in projection), 'Renderer measurement kept a second owner of the terrain model')
    assert.strictEqual(projection.hull, geometry.model.hull)
    const displayed = geometry.partitionDraws.slice()
    const pending = displayed[1], key = keyOf(pending.texture)
    const part = geometry.partitions.get(key)
    assert(part, 'The fixture requires cached UV partitions')
    geometry.partitions.delete(key)
    renderer.partitionBytes -= part.byteSize
    geometry.partitionBytes -= part.byteSize
    part.allocation.release()
    for (const buffer of [part.positionBuffer, part.uvBuffer, part.indexBuffer]) canvas.gl.deleteBuffer(buffer)
    geometry.partitionDraws = [displayed[0]]
    renderer.options.scheduledImagery = true
    renderer.setImageryPlan(1, {draws, levels: new Set(), quality: {
      planningComplete: true, cameraCurrent: true, targetPixelError: 1.25}},
      [{resourceId: 51, visible: true, pixelsPerUv: 1024, centerDistance: 0}])
    renderer.render()
    assert(renderer.stats().quality.geometryCoverageSubmitted > 0,
      'A complete plan hid coarse coverage before its newly visible UV cells were ready')
    assert.strictEqual(renderer.stats().textures.missingRatio, 0)
    assert(renderer.presentedTextures.has(keyOf(displayed[0].texture)), 'Coarse coverage overwrote retained detail')
    await waitUntil('Completed UV partitions did not retire temporary coverage', () => {
      renderer.render(); return renderer.stats().quality.geometryCoverageSubmitted === 0
    })
    assert.strictEqual(renderer.stats().quality.renderedDrawCount, draws.length)
    const fine = Array.from(renderer.presentedTextures.keys())
    renderer.capacityHandover = new Map([[keyOf(draws[0].texture), draws[0].texture]])
    renderer.setCameraFrame(Object.assign(frame(), {cameraPosition: [11,20,30]}))
    let cancelledAsCoarsening = false
    const sync = renderer.textures.sync
    renderer.textures.sync = function (wanted, retained, coarsening) {
      cancelledAsCoarsening = cancelledAsCoarsening || coarsening
      return sync.call(this, wanted, retained, coarsening)
    }
    const advance = renderer.worldDisplay.advance
    let prepare = false
    renderer.worldDisplay.advance = function () {if (prepare) return advance.call(this)}
    try {
      renderer.setImageryPlan(1, {draws, levels: new Set(), quality: {
        planningComplete: false, cameraCurrent: false, coarsening: true, targetPixelError: 1.25}}, [])
      renderer.render()
      assert.notStrictEqual(renderer.plannedCameraVersion, renderer.cameraVersion)
      assert(!cancelledAsCoarsening, 'Pan inherited obsolete zoom cancellation')
      assert(fine.every(key => renderer.presentedTextures.has(key)), 'Pending pan preparation discarded fine coverage')
      assert(renderer.stats().quality.geometryCoverageSubmitted > 0)
      // The old numeric handover is replaced with the new prepared world cut,
      // not according to whether that work happened to fit in one 4ms slice.
      prepare = true
      await preparedDraws(renderer)
      renderer.render()
      assert.strictEqual(renderer.capacityHandover.size, 0, 'Prepared pan kept the previous camera capacity bridge')
      assert(!cancelledAsCoarsening, 'Prepared pan inherited obsolete zoom cancellation')
      assert(fine.every(key => renderer.presentedTextures.has(key)))
    } finally {renderer.worldDisplay.advance = advance}
  } finally { renderer.destroy() }
  function keyOf(tile) { return `${tile.level}/${tile.matrix}/${tile.row}/${tile.column}` }
}

async function testPartitionPriorityAndCancellation() {
  const canvas = new FakeCanvas(new FakeGl()), tasks = []
  const renderer = new Renderer(canvas, {fetchTextures: false, urlForTile: () => '',
    createPartitionPlanTask(id, cells) {
      return {promise: Promise.resolve(cells.map(cell => ({key:cell.key,bytes:66}))), cancel() {}}
    },
    createPartitionTask(resourceId, cells, geometry, maximumBytes) {
      const task = {resourceId, cells, maximumBytes, cancelled: false}
      task.promise = new Promise(resolve => { task.finish = resolve })
      task.cancel = () => { task.cancelled = true }
      tasks.push(task)
      return task
    }})
  const a = {key: 'a', resourceId: 1, partitions: new Map()}
  const b = {key: 'b', resourceId: 2, partitions: new Map()}
  const cell = key => ({key, bounds: {minimumU: 0, maximumU: 1, minimumV: 0, maximumV: 1}})
  const advance = async () => {
    renderer.pumpPartitionRequests(); await settle()
    renderer.pumpPartitionRequests(); await settle()
  }
  try {
    renderer.geometry.set(a.key, a, 0); renderer.geometry.set(b.key, b, 0)
    renderer.geometryPinnedKeys = new Set([a.key, b.key])
    renderer.partitionPublication.handoff = new Set(['a:background', 'b:ordinary', 'b:handoff'])
    renderer.requestPartitionSet(a, [cell('background')])
    renderer.requestPartitionSet(b, [cell('ordinary'), cell('handoff'), cell('handoff')])
    renderer.requestPartitionSet(b, [cell('handoff')], 3)
    await advance()
    assert.deepStrictEqual(tasks[0].cells.map(value => value.key), ['handoff'],
      'Handoff priority did not overtake older work, or promoted unrelated cells')
    const charged = renderer.partitionCpuBytes
    assert(charged >= tasks[0].maximumBytes && tasks[0].maximumBytes > 0)
    assert.strictEqual(renderer.resourceLedger.stats().owners['partition-output'].reserved, charged)
    assert.strictEqual(renderer.resourceLedger.stats().owners['partition-gpu'].reserved, charged)
    renderer.setPaused(true)
    assert(tasks[0].cancelled, 'Pausing retained partition CPU work')
    assert(!b.partitionPending.has('handoff'))
    assert.strictEqual(renderer.partitionCpuBytes, tasks[0].maximumBytes, 'Cancellation refunded a producer before it stopped')
    assert.strictEqual(renderer.resourceLedger.stats().owners['partition-output'].retired, tasks[0].maximumBytes)
    tasks[0].finish([])
    await settle()
    assert(!renderer.partitionActive && !renderer.partitionUploads.length)
    assert.strictEqual(renderer.partitionCpuBytes, 0)
    assert(!b.partitions.has('handoff'), 'Cancelled completion cached an empty ready cell')
    renderer.setPaused(false)
    renderer.partitionPublication.handoff.add('b:handoff')
    renderer.requestPartitionSet(b, [cell('handoff')], 3)
    await advance()
    assert.strictEqual(tasks[1].cells[0].key, 'handoff', 'Cancelled work could not be requested again')
    renderer.resetWorker()
    assert(tasks[1].cancelled)
    assert.strictEqual(a.partitionPending.size + b.partitionPending.size, 0,
      'Worker replacement left unscheduled partition ownership behind')
    tasks[1].finish([])
    await settle()
    assert.strictEqual(renderer.partitionUploads.length, 0)
    renderer.geometry.set(a.key, a, 0)
    renderer.geometryPinnedKeys.add(a.key)
    renderer.partitionPublication.handoff.add('a:limited')
    renderer.requestPartitionSet(a, [cell('limited')])
    await advance()
    tasks[2].finish({limited: true, requiredBytes: tasks[2].maximumBytes + 1})
    await settle()
    assert.strictEqual(renderer.partitionCpuBytes, 0)
    assert(a.partitionBlocked.has('limited'))
    renderer.requestPartitionSet(a, [cell('limited')])
    await advance()
    assert.strictEqual(tasks.length, 3, 'Refunding rejected output caused an unbounded admission retry loop')
  } finally { renderer.destroy() }
  assert.strictEqual(renderer.resourceLedger.bytes, 0, 'Destroyed renderer retained shared allocations')
}

function testGeometryUnpinAvailability() {
  const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
  const {ownPayload, holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
  const ledger = new ResourceLedger(120)
  const renderer = new RawRenderer(new FakeCanvas(new FakeGl()), {resourceLedger: ledger,
    mode: 'height', geometryCacheBytes: 256, urlForTile: () => ''})
  try {
    const resource = ownPayload({}, ledger.reserve('mesh-host', 60), 60)
    const reservation = renderer.geometry.reserve('old', 60), releaseMesh = holdMeshes([resource])
    releaseMesh.ownedBy(reservation.lease)
    assert(reservation.commit({releaseMesh, partitions: new Map()}))
    renderer.geometryPinnedKeys.add('old')
    renderer.meshHolds.set(resource, holdMeshes([resource]))
    resource.ownership.retire()
    assert.strictEqual(ledger.canReserve(120), false)
    const before = ledger.availabilityRevision
    // Display ownership is released before the pin set changes. The new
    // availability notification must describe the resulting state, not that
    // temporary loan return while the old pin still applies.
    renderer.updateGeometryPins()
    assert(ledger.canReserve(120))
    assert(ledger.availabilityRevision > before, 'Unpinning geometry failed to wake capacity waiters')
    const idle = ledger.availabilityRevision
    renderer.updateGeometryPins()
    assert.strictEqual(ledger.availabilityRevision, idle, 'Unchanged idle geometry woke capacity waiters')
    const next = ledger.reserve('successor', 120)
    assert(next && !renderer.geometry.has('old'))
    next.release()
  } finally { renderer.destroy() }
  assert.strictEqual(ledger.bytes, 0)
}

function testResourceLimitOwnership() {
  const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
  const ledger = new ResourceLedger(128)
  const displayed = ledger.reserve('external-display', 92), input = ledger.reserve('external-input', 32)
  let renderer
  try {
    renderer = new RawRenderer(new FakeCanvas(new FakeGl()), {resourceLedger: ledger,
      mode: 'height', geometryCacheBytes: 256, partitionCacheBytes: 256, textureCacheBytes: 256,
      urlForTile: () => ''})
    assert.strictEqual(ledger.maximumBytes, 128, 'Renderer construction overwrote its owner\'s total limit')
    renderer.setBudget({geometryCacheBytes: 1024, partitionCacheBytes: 1024, textureCacheBytes: 1024})
    assert.strictEqual(ledger.maximumBytes, 128, 'Local cache growth enlarged the shared envelope')
    assert.strictEqual(ledger.reserve('competitor', 5), null)
    renderer.setMeshFrame(frame(), [], new Map(), new Uint16Array(), {}, null, null,
      {selectionCurrent: true})
    renderer.updateGeometryPins()
    assert.strictEqual(ledger.maximumBytes, 128, 'Display adoption silently changed the resource limit')
    input.mark('retired')
    ledger.setLimit(96)
    renderer.setBudget({textureCacheBytes: 2048})
    assert.strictEqual(ledger.maximumBytes, 96)
    assert.strictEqual(ledger.stats().retiredBytes, 32, 'Reallocation refunded an in-flight external owner')
    assert.strictEqual(ledger.reserve('competitor', 1), null)
    input.release()
    const admitted = ledger.reserve('competitor', 4)
    assert(admitted, 'A real completion did not return the retired allocation')
    admitted.release()
    renderer.destroy(); renderer = null
    assert.strictEqual(ledger.bytes, 92, 'Renderer destruction released another owner\'s display')
  } finally { if (renderer) renderer.destroy(); input.release(); displayed.release() }
  assert.strictEqual(ledger.bytes, 0)

  const owned = new RawRenderer(new FakeCanvas(new FakeGl()), {maximumResourceBytes: 128,
    mode: 'height', urlForTile: () => ''})
  try {
    owned.setBudget({textureCacheBytes: 4096})
    assert.strictEqual(owned.resourceLedger.maximumBytes, 128)
  } finally { owned.destroy() }
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '128']) {
    assert.throws(() => new RawRenderer(new FakeCanvas(new FakeGl()), {
      maximumResourceBytes: value, mode: 'height', urlForTile: () => ''}), /positive safe integer/)
  }
  assert.throws(() => new RawRenderer(new FakeCanvas(new FakeGl()), {
    resourceLedger: ledger, maximumResourceBytes: 256, mode: 'height', urlForTile: () => ''}), /owned.*ledger/)
}

async function testPartitionOutputAdmission() {
  const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
  const ledger = new ResourceLedger(132), plans = [], outputs = [], diagnostics = []
  const renderer = new Renderer(new FakeCanvas(new FakeGl()), {resourceLedger: ledger, partitionCacheBytes: 180,
    urlForTile: () => '', onDiagnostic: (kind, detail) => diagnostics.push({kind, detail}),
    createPartitionPlanTask(id, cells) {
      const task = {cells, cancelled: false, cancel() { this.cancelled = true }}
      task.promise = new Promise(resolve => { task.finish = resolve })
      plans.push(task); return task
    },
    createPartitionTask(id, cells, geometry, maximumBytes) {
      assert.strictEqual(maximumBytes, 66)
      assert.strictEqual(ledger.bytes, 132)
      assert.strictEqual(ledger.reserve('competitor', 1), null, 'GPU destination was not protected during production')
      const task = {cells, cancel() {}}
      task.promise = new Promise(resolve => { task.finish = resolve })
      outputs.push(task); return task
    }})
  const geometry = {key: 'held', resourceId: 1, partitions: new Map()}
  const cell = {key: 'region', bounds: {minimumU: 0, maximumU: 1, minimumV: 0, maximumV: 1}}
  let occupied
  try {
    assert.strictEqual(ledger.maximumBytes, 132)
    renderer.geometry.set(geometry.key, geometry, 0)
    renderer.geometryPinnedKeys.add(geometry.key)
    const request = async () => {
      renderer.partitionPublication.handoff.add(geometry.key + ':' + cell.key)
      renderer.requestPartitionSet(geometry, [cell]); renderer.pumpPartitionRequests(); await settle()
    }
    await request()
    assert.strictEqual(ledger.bytes, 0, 'Cost-only planning allocated producer output')
    renderer.setPaused(true)
    assert(plans[0].cancelled)
    plans[0].finish([{key: cell.key, bytes: 66}]); await settle()
    assert.strictEqual(outputs.length, 0, 'Cancelled plan started production')
    renderer.setPaused(false)
    occupied = ledger.reserve('display', 66)
    await request()
    plans[1].finish([{key: cell.key, bytes: 66}]); await settle()
    assert.strictEqual(outputs.length, 0, 'CPU-only space admitted work with no GPU destination')
    assert.strictEqual(ledger.bytes, 66)
    assert(geometry.partitionBlocked && geometry.partitionBlocked.has(cell.key), JSON.stringify({diagnostics, plans: plans.length, active: Boolean(renderer.partitionActive), pins: Array.from(renderer.geometryPinnedKeys)}))
    await request()
    assert.strictEqual(plans.length, 2, 'Capacity refusal caused an unchanged-capacity retry loop')
    occupied.release(); occupied = null
    await request()
    plans[2].finish([{key: cell.key, bytes: 66}]); await settle()
    renderer.pumpPartitionRequests(); await settle()
    assert.strictEqual(outputs.length, 1, 'Capacity change failed to wake blocked work')
    // Equal aggregate bytes must not permit an output for a different cell.
    outputs[0].finish([{cell: {key: 'wrong'}, positions: new Float32Array(9),
      uv: new Float32Array(6), indices: new Uint16Array(3)}]); await settle()
    assert.strictEqual(ledger.bytes, 0)
    assert(!renderer.partitionUploads.length && !geometry.partitions.size)
    assert(diagnostics.some(d => d.kind === 'partition_prepare_failed' && /admitted plan/.test(d.detail.message)))
    renderer.options.createPartitionTask = (id, cells, model, bytes) => {
      assert.strictEqual(bytes, 0)
      return {promise: Promise.resolve([]), cancel() {}}
    }
    await request()
    plans[3].finish([{key: cell.key, bytes: 0}]); await settle()
    renderer.pumpPartitionRequests(); await settle()
    assert.strictEqual(geometry.partitions.get(cell.key).indexCount, 0)
    assert(!renderer.partitionActive && !renderer.partitionUploads.length && !geometry.partitionPending.size,
      'Empty intersections waited forever for a nonempty GPU batch')
    assert.strictEqual(ledger.bytes, 0)
  } finally { if (occupied) occupied.release(); renderer.destroy() }
  assert.strictEqual(ledger.bytes, 0)
}

function testGeometryOutputAdmission() {
  const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
  const {ownPayload} = require('../../sdk/js/resources/mesh_ownership')
  const ledger = new ResourceLedger(180), renderer = new RawRenderer(new FakeCanvas(new FakeGl()), {
    resourceLedger: ledger, geometryCacheBytes: 120, mode: 'height', urlForTile: () => ''})
  let output, resource
  try {
    renderer.geometry.set('mesh:1', {key: 'mesh:1', partitions: new Map()}, 60)
    renderer.geometryPinnedKeys.add('mesh:1')
    const draws = [Object.assign(draw(0), {resourceId: 2, textureResourceId: 4294967298, vertexCount: 3})]
    ledger.setLimit(179)
    assert.strictEqual(renderer.reserveMeshOutputs({draws}, 60), null,
      'Mesh production was admitted without its GPU destination')
    assert(renderer.geometry.has('mesh:1') && renderer.geometry.reservedBytes === 0)
    ledger.setLimit(180)
    output = renderer.reserveMeshOutputs({draws}, 60)
    assert(output && output.valid() && renderer.geometry.reservedBytes === 60)
    assert.strictEqual(ledger.reserve('competitor', 1), null)
    resource = ownPayload({resourceId: 2, positions: new Float32Array([0,0,0,1,0,0,0,1,0]),
      textureUv: new Float32Array([0,0,1,0,0,1])}, output.credit.split(60, 'reserved', 'mesh-host'), 60)
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 1}), draws, new Map([[2, resource]]),
      new Uint16Array([0,2,1]), {modelRevision: 1}, null, null, {outputs: output, selectionCurrent: true})
    output.release(); output.credit.release()
    assert.strictEqual(renderer.uploadQueue.length, 2, 'Pre-admitted geometry was mistaken for an active upload')
    const reserve = renderer.geometry.reserve
    renderer.geometry.reserve = () => assert.fail('GPU upload attempted a second resource admission')
    try { renderer.processUploads(Infinity) } finally { renderer.geometry.reserve = reserve }
    assert(renderer.geometry.has('mesh:2'))
    assert.strictEqual(renderer.geometry.reservedBytes, 0)
    assert.strictEqual(ledger.bytes, 180)
    output = null

    ledger.setLimit(300)
    output = renderer.reserveMeshOutputs({draws: [Object.assign({}, draws[0], {resourceId: 3})]}, 60)
    assert(output && output.valid())
    renderer.contextWasLost({preventDefault() {}})
    assert(!output.valid(), 'Lost GL context still accepted new mesh production')
    const before = ledger.bytes
    output.release()
    assert.strictEqual(ledger.bytes, before - 36 - renderer.current.indices.byteLength,
      'Cancelling geometry/index destinations refunded the active producer')
    output.credit.release(); output = null
  } finally {
    if (output) { output.release(); output.credit.release() }
    if (resource) resource.ownership.retire()
    renderer.destroy()
  }
  assert.strictEqual(ledger.bytes, 0)
}

function testGlAllocationAndSubmission() {
  const gl = new FakeGl(), canvas = new FakeCanvas(gl), receipts = [], losses = []
  let checks = 0, nextError = 0, lost = false
  gl.getError = () => { ++checks; const error = nextError; nextError = 0; return error }
  gl.isContextLost = () => lost
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    mode: 'height', managedResources: true, urlForTile: () => 'unused',
    onPresented: sequence => receipts.push(sequence), onContextChange: event => losses.push(event)
  })
  const positions = new Float32Array([0,0,0, 1,0,0, 0,1,0])
  const textureUv = new Float32Array([0,0, 1,0, 0,1])
  const indices = new Uint16Array([0,2,1])
  const resource = {positions, textureUv}, meshDraw = Object.assign(draw(0), {resourceId: 51, textureResourceId: 4294967347})
  const publish = sequence => {
    const outputs = renderer.reserveMeshOutputs({draws: [meshDraw]}, 0)
    assert(outputs)
    try { renderer.setMeshFrame(Object.assign(frame(), {sequence}),
      [meshDraw], new Map([[51, resource]]), indices, {modelRevision: 1}, null, null,
      {outputs, selectionCurrent: true}) }
    finally { outputs.release(); outputs.credit.release() }
  }
  try {
    const {GlSubmission} = require('../../adapters/webgl/gl_allocation')
    const batch = new GlSubmission(gl), published = [], cancelled = []
    batch.stage('first', resources => resources.buffer(gl.ARRAY_BUFFER, positions),
      value => published.push(value), () => cancelled.push('first'))
    batch.stage('second', resources => resources.buffer(gl.ARRAY_BUFFER, textureUv),
      value => published.push(value), () => cancelled.push('second'))
    assert.strictEqual(published.length, 0, 'Unvalidated GPU objects escaped the upload transaction')
    const beforeBatch = checks
    const releasedBeforeBatch = gl.calls.filter(call => call.name === 'deleteBuffer').length
    nextError = 0x0505
    assert.throws(() => batch.commit(), /allocation failed/)
    batch.cancel()
    assert.strictEqual(checks, beforeBatch + 1, 'A batch queried GL once per resource')
    assert.strictEqual(published.length, 0)
    assert.deepStrictEqual(cancelled, ['second','first'])
    assert.strictEqual(gl.calls.filter(call => call.name === 'deleteBuffer').length - releasedBeforeBatch, 2)
    batch.cancel()
    assert.deepStrictEqual(cancelled, ['second','first'], 'Cancelled batch released ownership twice')
    const partial = new GlSubmission(gl), kept = [], released = []
    partial.stage('accepted', resources => resources.buffer(gl.ARRAY_BUFFER, positions),
      value => kept.push(value), () => released.push('accepted'))
    partial.stage('rejected', resources => resources.buffer(gl.ARRAY_BUFFER, positions),
      () => { throw new Error('owner failed') }, () => released.push('rejected'))
    partial.stage('pending', resources => resources.buffer(gl.ARRAY_BUFFER, positions),
      () => assert.fail('Publication continued after a failed owner'), () => released.push('pending'))
    assert.throws(() => partial.commit(), /owner failed/)
    partial.cancel()
    assert.deepStrictEqual(released, ['rejected', 'pending'])
    assert(!gl.calls.some(call => call.name === 'deleteBuffer' && call.args[0] === kept[0]),
      'Later publication failure deleted an already accepted GPU resource')
    gl.deleteBuffer(kept[0])
    publish(1)
    nextError = 0x0505 // OUT_OF_MEMORY is returned by GL, not thrown by bufferData.
    const deleted = gl.calls.filter(call => call.name === 'deleteBuffer').length
    assert.throws(() => renderer.processUploads(Infinity), /allocation failed/)
    assert(!renderer.geometry.has('mesh:51'))
    assert.strictEqual(renderer.geometry.stats().reservedBytes, 60,
      'A retryable allocation failure refunded its guaranteed destination')
    assert.strictEqual(renderer.uploadQueue.length, 2)
    assert.strictEqual(gl.calls.filter(call => call.name === 'deleteBuffer').length - deleted, 1)
    assert.deepStrictEqual(receipts, [], 'Failed geometry allocation issued a receipt')
    renderer.render()
    assert.deepStrictEqual(receipts, [1])
    const steadyChecks = checks
    renderer.render(); renderer.render()
    assert.strictEqual(checks, steadyChecks, 'An unchanged frame synchronously queried GL errors')
    renderer.setOverlays({points: [{world: [1,2,3]}]})
    renderer.render()
    const overlayChecks = checks
    renderer.render()
    assert.strictEqual(checks, overlayChecks, 'Unchanged overlays reallocated and synchronized every frame')
    renderer.setOverlays({})

    const performance = global.performance, advanced = [], methods =
      [renderer.stageAuxiliaryResources, renderer.processUploads, renderer.processPartitionUploads, renderer.textures.processUploads]
    let clock = 1000
    global.performance = {now: () => clock}
    const stage = name => deadline => { if (clock < deadline) { advanced.push(name); clock += 20 } }
    try {
      renderer.stageAuxiliaryResources = () => { advanced.push('auxiliary'); clock += 20 }
      renderer.processUploads = stage('geometry')
      renderer.processPartitionUploads = stage('partition')
      renderer.textures.processUploads = stage('imagery')
      for(let turn=0;turn<4;++turn){renderer.requestResources();renderer.render()}
      assert.deepStrictEqual(advanced.slice().sort(), ['auxiliary','geometry','imagery','partition'],
        'A stage consuming the upload deadline starved another owner across frames')
    } finally {
      global.performance = performance
      ;[renderer.stageAuxiliaryResources, renderer.processUploads, renderer.processPartitionUploads, renderer.textures.processUploads] = methods
    }

    const oldIndices = renderer.indexBuffer
    nextError = 0x0505
    assert.throws(() => renderer.indices.stage(new Uint16Array([2,1,0])), /allocation failed/)
    assert.strictEqual(renderer.indexBuffer, oldIndices, 'Failed index replacement retired the displayed buffer')
    assert.strictEqual(renderer.uploadedIndices, indices)
    assert(!gl.calls.some(call => call.name === 'deleteBuffer' && call.args[0] === oldIndices))

    const geometry = renderer.geometry.get('mesh:51'), cell = {key: '2/2/0/0'}
    stagePartitionJob(renderer, geometry, [cell], [{cell, positions, uv: textureUv, indices}])
    nextError = 0x0505
    assert.throws(() => renderer.processPartitionUploads(Infinity), /allocation failed/)
    assert(!geometry.partitions.has(cell.key))
    assert.strictEqual(renderer.partitionBytes, 0)
    assert.strictEqual(renderer.partitionUploads.length, 1, 'Failed partition lost its retry input')
    assert.strictEqual(renderer.partitionReservedBytes, 66, 'Failed upload lost its destination credit')
    assert.strictEqual(renderer.resourceLedger.stats().owners['partition-gpu'].reserved, 66)
    renderer.processPartitionUploads(Infinity)
    assert(geometry.partitions.has(cell.key))

    // Repeated cells can share the same geometry/tile key. Replacing one must
    // retire its previous buffers and charge, even within a single GPU batch.
    const duplicate = {cell, positions, uv: textureUv, indices}
    stagePartitionJob(renderer, geometry, [cell], [duplicate, duplicate])
    renderer.processPartitionUploads(Infinity)
    const partitionBytes = positions.byteLength + textureUv.byteLength + indices.byteLength
    assert.strictEqual(renderer.partitionBytes, partitionBytes)
    assert.strictEqual(renderer.resourceLedger.stats().owners['partition-gpu'].resident, partitionBytes)

    const deletedTextures = gl.calls.filter(call => call.name === 'deleteTexture').length
    nextError = 0x0505
    assert.throws(() => renderer.uploadTexture({}, 256, 256, () => {}), /allocation failed/)
    assert.strictEqual(gl.calls.filter(call => call.name === 'deleteTexture').length - deletedTextures, 1)

    publish(2)
    renderer.setDebugOptions({webglErrors: true})
    nextError = 0x0502
    const displayedImages = renderer.presentedTextures, displayedCells = renderer.presentation.cells
    renderer.render()
    assert.deepStrictEqual(receipts, [1], 'Rejected diagnostic frame issued a receipt')
    assert.strictEqual(renderer.presentedTextures, displayedImages)
    assert.strictEqual(renderer.presentation.cells, displayedCells)
    renderer.setDebugOptions({webglErrors: false})
    renderer.render()
    assert.deepStrictEqual(receipts, [1,2])

    publish(3)
    const drawElements = gl.drawElements
    gl.drawElements = function () { drawElements.apply(this, arguments); lost = true }
    renderer.render()
    assert.deepStrictEqual(receipts, [1,2], 'Context loss during drawing issued a receipt')
    canvas.emit('webglcontextlost', {preventDefault() {}})
    assert.strictEqual(losses.length, 1, 'Polled loss and event duplicated recovery ownership')
    gl.drawElements = drawElements; lost = false
    const restoredGeneration = gl.nextId, deleteBuffer = gl.deleteBuffer
    gl.deleteBuffer = function (buffer) {
      assert(buffer.id >= restoredGeneration, 'Old context buffer was deleted through the restored context')
      deleteBuffer.call(this, buffer)
    }
    canvas.emit('webglcontextrestored')
    renderer.render()
    assert.deepStrictEqual(receipts, [1,2,3])
    assert(renderer.stats().performance.allocationValidation.count > 0)
  } finally { renderer.destroy() }
}

function testStandaloneGeometryAdmission() {
  const gl = new FakeGl(), renderer = new Renderer(new FakeCanvas(gl), {
    mode: 'height', geometryCacheBytes: 60, urlForTile: () => 'unused'
  })
  const positions = new Float32Array([0,0,0, 1,0,0, 0,1,0]), uv = new Float32Array([0,0, 1,0, 0,1])
  const busy = renderer.geometry.reserve('busy', 60)
  try {
    renderer.uploadQueue.push({kind: 'uv', key: 'uv:0:1', uv,
      releaseMesh: require('../../sdk/js/resources/mesh_ownership').holdMeshes([])},
      {kind: 'mesh', key: 'next', uvKey: 'uv:0:1', positions, uv, model: {},
      releaseMesh: require('../../sdk/js/resources/mesh_ownership').holdMeshes([])})
    const before = gl.calls.filter(call => call.name === 'bufferData').length
    renderer.processUploads(Infinity)
    assert.strictEqual(gl.calls.filter(call => call.name === 'bufferData').length, before,
      'Standalone geometry allocated GPU buffers before obtaining capacity')
    assert.strictEqual(renderer.uploadQueue.length, 2)
    assert(!renderer.geometry.has('next'))
    busy.cancel()
    renderer.processUploads(Infinity)
    assert(renderer.geometry.has('next'), 'Freed capacity did not admit queued geometry')
    assert.strictEqual(renderer.resourceLedger.stats().owners['geometry-gpu'].resident, 60)
  } finally { busy.cancel(); renderer.destroy() }
  assert.strictEqual(renderer.resourceLedger.bytes, 0)
}

function testDirectMeasurementRefinement() {
  const fixtures=[{...require('./reference/measurement_fixture')(), passes:1, error:1.09375}, {
    // A hidden high-density face shares the visible face's UV domain. Even a
    // centred derivative box needs precise facing to remove this overestimate.
    positions:new Float32Array([-.4,-.4,0,-.3,-.4,0,-.4,-.3,0, -.4,-.4,0,.4,-.4,0,-.4,.4,0]),
    uv:new Float32Array([0,0,.25,0,0,.25, 0,0,.25,0,0,.25]),
    indices:new Uint16Array([0,2,1,1,3,3,3,4,5]), passes:2, error:.3125
  }]
  for (const fixture of fixtures) for (const interacting of [true,false]) {
    const canvas=new FakeCanvas(new FakeGl()); canvas.width=canvas.height=400
    const observed=[]
    const renderer=new Renderer(canvas,{fetchTextures:false,urlForTile:()=>'',
      planImagery(draws,measure) {
        const error=measure(draws[0]).pixelsPerUv/256
        observed.push(error)
        return {draws:draws.map(d=>Object.assign({},d,{imageryPixelError:error})),
          levels:new Map(),quality:{targetPixelError:1.25,meetsTarget:error<=1.25}}
      }})
    try {
      renderer.setInteractionActive(interacting)
      const source=Object.assign(draw(0),{origin:[0,0,0],vertexCount:fixture.positions.length/3,
        indexCount:fixture.indices.length})
      publishFrame(renderer,frame(),[source],fixture.positions,fixture.uv,fixture.indices)
      assert.strictEqual(observed.length,interacting ? fixture.passes : 2,
        'Direct rendering must normalize stationary demand while retaining fast passing motion bounds')
      if(fixture.passes===2) assert(observed[0]>1.25)
      assert(Math.abs(observed[observed.length - 1]-fixture.error)<0.00001)
      if(!interacting) assert.strictEqual(renderer.pendingQualityStats.refinableMeasurementCount,0)
    } finally {renderer.destroy()}
  }
}

function testProjectionEnvelope() {
  const source = Object.assign(draw(0), {texture: {level: 0, matrix: 0, row: 0, column: 0}})
  const measured = {visible: true, pixelsPerUv: 1024, centerDistance: 0,
    bounds: {minimumU: 0, minimumV: 0, maximumU: 1, maximumV: 1},
    hull: [[0,0], [1,0], [0,1]]}
  for (const plan of [imageryReference.refineImageryDraws, planImageryFrontier]) {
    const result = plan(frame(), [source], null, null, {width: 256, height: 256},
      {tile_size: 256, maximum_level: 4}, {measureDraw: () => measured,
        maximumTextures: 64, maximumDraws: 64, targetPixelError: 1.25})
    assert.strictEqual(result.draws.length, 10, 'Model-free UV hull admitted empty triangle corners')
    assert(result.draws.every(d => d.texture.level === 2), 'Projection metadata changed the SSE target')
  }
}

async function testUploadBudget() {
  testCompleteImageUploadGroup()
  const {UploadBudget, GlSubmission} = require('../../adapters/webgl/gl_allocation')
  for (const limits of [[0, 8], [128, 0], [Infinity, 8], [128, 1.5]]) {
    assert.throws(() => new UploadBudget(...limits), /positive integers/)
  }
  const budget = new UploadBudget(100, 2), gl = new FakeGl()
  const batch = new GlSubmission(gl, null, budget)
  let denied = 0
  assert(batch.stage('first', resources => resources.buffer(gl.ARRAY_BUFFER, new Float32Array(15)),
    () => {}, () => {}, {bytes: 60, objects: 1}))
  const allocations = gl.calls.filter(c => c.name === 'bufferData').length
  assert.strictEqual(batch.stage('second', () => assert.fail('Denied upload reached GL'),
    () => assert.fail('Denied upload published'), () => { ++denied }, {bytes: 60, objects: 1}), false)
  assert.strictEqual(denied, 1)
  assert.strictEqual(gl.calls.filter(c => c.name === 'bufferData').length, allocations)
  assert.strictEqual(budget.bytes, 60)
  assert(budget.take(1, 1))
  assert.strictEqual(budget.take(1, 1), false, 'Object limit was ignored')
  batch.cancel()
  const oversized = new UploadBudget(100, 2)
  assert(oversized.take(200, 3), 'A legal indivisible asset was permanently starved')
  assert.strictEqual(oversized.take(1, 1), false, 'Oversized assets must run alone')

  const renderer = new Renderer(new FakeCanvas(new FakeGl()), {
    mode: 'height', urlForTile: () => 'unused', uploadBudgetBytes: 70,
    uploadBudgetObjects: 3, partitionCacheBytes: 600, textureCacheBytes: 4 * 611668
  })
  renderer.textures.scheduler.pause() // This fixture supplies already decoded images.
  const positions = new Float32Array([0,0,0, 1,0,0, 0,1,0]), uv = new Float32Array([0,0,1,0,0,1])
  const indices = new Uint16Array([0,2,1]), resources = new Map()
  const draws = Array.from({length: 6}, (_, i) => {
    resources.set(i + 1, {positions, textureUv: uv})
    return Object.assign(draw(i), {resourceId: i + 1, textureResourceId: 4294967297+i})
  })
  const performance = global.performance
  global.performance = {now: () => 1000} // Cheap GL calls must still consume work credit.
  try {
    renderer.setMeshFrame(Object.assign(frame(), {sequence: 1}), draws, resources, indices, {modelRevision: 1})
    renderer.setOverlays({points: [{world: [1,2,3]}]})
    for (let i = 0; i < 10; ++i) {
      const before = renderer.gl.calls.length
      renderer.render()
      const uploads = renderer.gl.calls.slice(before).filter(c => c.name === 'bufferData')
      assert(uploads.reduce((n,c) => n + c.args[1].byteLength, 0) <= 70,
        'A frame submitted unbounded buffer bytes despite cheap GL calls')
      assert(uploads.length <= 3, 'A frame exceeded its GPU object allowance')
    }
    assert.strictEqual(renderer.geometry.values().length, 6, 'Finite upload credit starved geometry')
    assert(renderer.overlayBuffer && renderer.uploadedIndices === indices)

    const geometry = renderer.geometry.get(draws[0].geometryKey)
    const cells = Array.from({length: 8}, (_, i) => ({key: 'part-' + i,
      bounds: {minimumU:0,maximumU:1,minimumV:0,maximumV:1}}))
    renderer.options.createPartitionPlanTask = (id, wanted) => ({
      promise: Promise.resolve(wanted.map(cell => ({key:cell.key,bytes:66}))), cancel() {}})
    renderer.options.createPartitionTask = (id, wanted, source, maximumBytes) => {
      assert(renderer.resourceLedger.stats().owners['partition-gpu'].reserved >= maximumBytes,
        'Partition producer started without its GPU capacity')
      return {promise: Promise.resolve(wanted.map(cell => ({cell,positions,uv,indices}))), cancel() {}}
    }
    renderer.textures.frontierKeys = new Set(cells.map(cell => cell.key))
    cells.forEach(cell => renderer.partitionPublication.handoff.add(geometry.key + ':' + cell.key))
    renderer.requestPartitionSet(geometry, cells)
    await waitUntil('A completely admitted group did not progress through bounded batches', () => {
      // Normal imagery presentation reasserts demand when upload receipts
      // change capacity. Height mode needs that demand supplied by this fixture.
      renderer.requestPartitionSet(geometry, cells)
      renderer.render()
      assert(renderer.partitionBytes + renderer.partitionCpuBytes + renderer.partitionReservedBytes <= 600)
      return geometry.partitions.size === 8
    })
    assert.strictEqual(geometry.partitions.size, 8,
      'The admitted group failed to reuse its bounded CPU workspace')
    assert.strictEqual(renderer.partitionCpuBytes, 0)
    assert.strictEqual(renderer.partitionUploads.length, 0)
    assert.strictEqual(renderer.partitionReservedBytes, 0)

    const assets = []
    for (let i = 0; i < 2; ++i) {
      const tile = {level: 1, matrix: 1, row: 0, column: i}, key = '1/1/0/' + i
      const asset = {image: {}, width: 256, height: 256, texture: null}
      assets.push(asset)
      renderer.textures.currentRoots.set(key, tile)
      renderer.textures.cache.set(key, asset, 611668)
    }
    renderer.requestResources()
    for (let i = 0; i < 3; ++i) {
      const before = renderer.gl.calls.length
      renderer.render()
      const images = renderer.gl.calls.slice(before).filter(c => c.name === 'texImage2D')
      assert(images.length <= 1, 'Multiple oversized images shared an upload batch')
      if (images.length) assert.strictEqual(renderer.lastUploadBudget.bytes, 349524, 'Mip levels were not charged')
    }
    assert(assets.every(asset => asset.texture), 'Deferred decoded images failed to resume')
    assert.strictEqual(renderer.textures.cache.stats().retainedEntries, 0)
  } finally { global.performance = performance; renderer.destroy() }
  assert.strictEqual(renderer.resourceLedger.stats().bytes, 0)
}

function testCompleteImageUploadGroup() {
  const {UploadBudget,GlSubmission}=require('../../adapters/webgl/gl_allocation')
  const gl=new AsyncGl(),renderer=new RawRenderer(new FakeCanvas(gl),{
    mode:'height',urlForTile:()=> 'unused',textureCacheBytes:8*1024*1024,
    requestRender(){},requestResources(){}})
  renderer.textures.scheduler.pause()
  const tiles=[0,1].flatMap(row=>[0,1].map(column=>({level:1,matrix:1,row,column})))
  const ids=tiles.map(tile=>[tile.level,tile.matrix,tile.row,tile.column].join('/'))
  const assets=tiles.map(()=>({image:{},width:256,height:256,texture:null}))
  let batch
  try {
    for(let i=0;i<tiles.length;++i) {
      renderer.textures.currentRoots.set(ids[i],tiles[i])
      assert(renderer.textures.cache.set(ids[i],assets[i],611668))
    }
    batch=new GlSubmission(gl,null,new UploadBudget())
    renderer.uploadBatch=batch
    renderer.textures.processUploads(Infinity)
    renderer.submissions.submit(batch);renderer.uploadBatch=null
    assert.strictEqual(batch.items.length,4,'Default upload window split one ready 256px sibling group')
    assert.strictEqual(batch.budget.bytes,4*349524,'The complete mipmapped images were not priced')
    assert(batch.budget.bytes<=batch.budget.maximumBytes&&batch.budget.objects<=batch.budget.maximumObjects)
    assert(!renderer.submissions.poll(()=>{}))
    assert(assets.every(asset=>!asset.texture),'Unfinished uploads published images')
    gl.complete();assert(renderer.submissions.poll(()=>{}))
    assert(ids.every(id=>renderer.textures.gpuReady(id)))
  }finally{
    if(renderer.uploadBatch){batch.cancel();renderer.uploadBatch=null}
    renderer.destroy()
  }
  assert.strictEqual(renderer.resourceLedger.bytes,0)
  assert.strictEqual(gl.syncs.size,0)
}

function testBoundedGpuFrames() {
  const gl = new AsyncGl(), canvas = new FakeCanvas(gl)
  let wakes = 0
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    mode: 'height', urlForTile: () => 'unused', requestRender: () => { ++wakes }
  })
  try {
    publishFrame(renderer, frame(), [draw(0)], new Float32Array([0,0,0, 1,0,0, 0,1,0]),
      new Float32Array([0,0, 1,0, 0,1]), new Uint16Array([0,2,1]))
    renderer.render(); gl.complete(); renderer.render()
    const draws = () => gl.calls.filter(call => call.name === 'drawElements').length
    const before = draws(), checks = gl.checks
    assert(before > 0)
    for (let i = 1; i <= 25; ++i) {
      const camera = frame(); camera.projectionView[3] = i / 1000
      renderer.setCameraFrame(camera)
      renderer.render(false)
    }
    assert.strictEqual(draws(), before, 'Camera-only frames accumulated behind unfinished GPU work')
    assert.strictEqual(gl.syncs.size, 1)
    assert.strictEqual(gl.checks, checks, 'Camera pacing introduced synchronous GL validation')
    gl.complete()
    assert(renderer.render(false).submitted > 0)
    assert.strictEqual(draws(), before + 1, 'Queued camera revisions were replayed instead of coalesced')
    const matrix = gl.calls.filter(call => call.name === 'uniformMatrix4fv' &&
      call.args[0].name === 'u_projection_view').pop().args[2]
    assert(Math.abs(matrix[12] - 10.025) < 1e-5, 'The admitted frame did not use the latest camera')
    gl.complete()
    assert.strictEqual(renderer.render(false), null, 'A completion poll caused a redundant draw')
    const idleWakes = wakes
    for (let i = 0; i < 10; ++i) assert.strictEqual(renderer.render(false), null)
    assert.strictEqual(wakes, idleWakes, 'Completion polling kept waking a settled scene')
    assert.strictEqual(gl.syncs.size, 0)
    assert.strictEqual(gl.checks, checks)
    renderer.render()
    assert.strictEqual(gl.syncs.size, 1, 'An explicit redraw bypassed submission admission')
    renderer.setPaused(true); gl.complete()
    assert.strictEqual(renderer.render(false), null)
    assert.strictEqual(draws(), before + 2, 'Paused rendering issued GPU work')
    renderer.setPaused(false)
    assert(renderer.render(false).submitted > 0)
  } finally { renderer.destroy() }
  assert.strictEqual(gl.syncs.size, 0, 'Destroy retained a frame-only completion handle')
}

async function testGeometryUploadWithoutRedraw() {
  const {patch, surface} = require('./terrain_surface_fixture')
  const performance = global.performance
  let clock = 1000
  global.performance = {now: () => clock}
  try {
    for (const proof of [true, false]) {
      const lower = [[0,0], [1,0], [0,1]], upper = [[1,1], [0,1], [1,0]]
      const old = surface([patch(51, lower), patch(52, upper)])
      const next = surface([
        patch(61, [[0,0], [.5,0], [0,.5]]), patch(62, [[.5,0], [1,0], [.5,.5]]),
        patch(63, [[0,.5], [.5,.5], [0,1]]), patch(64, [[.5,0], [.5,.5], [0,.5]]),
        patch(65, [[1,1], [0,1], [.5,.5]]), patch(66, [[1,1], [.5,.5], [1,0]])])
      const gl = new AsyncGl(), receipts = [], submitted = []
      const renderer = new Renderer(new FakeCanvas(gl), {
        mode: 'height', urlForTile: () => 'unused', uploadBudgetObjects: 2,
        onPresented: sequence => receipts.push(sequence),
        onSurfaceSubmitted: value => submitted.push(value.draws.map(d => d.resourceId))
      })
      renderer.canvas.width = renderer.canvas.height = 64
      const publish = (sequence, value, replacementPlan) => renderer.setMeshFrame(
        Object.assign(frame(), {sequence, coverageComplete: true}), value.draws, value.meshResources,
        old.indices, {modelRevision: sequence, workerGeneration: 1, pendingPriorityUpdateCount: 1},
        null, [], {replacementPlan, selectionCurrent: true, camera: {}})
      const draws = () => gl.calls.filter(call => call.name === 'clear').length
      try {
        publish(1, old)
        for (let i = 0; i < 12; ++i) { clock += 20; gl.complete(); renderer.render(false) }
        assert.deepStrictEqual(receipts, [1])
        const oldCurrent=renderer.displaySurface.current
        publish(2, next, proof ? {groups: [
          {before: [51], after: [61,62,63,64]}, {before: [52], after: [65,66]}]} : null)
        renderer.render(false)
        // Each host turn delivers background preparation and display separately.
        // Their phase offset is not a count of completed geometry uploads.
        const camera=Object.assign(frame(), {cameraPosition:[11,21,31]})
        renderer.setCameraFrame(camera)
        let moved=false
        for(let turn=0;turn<24&&receipts.length<2;++turn) {
          clock+=20;gl.complete();renderer.render(false)
          moved=moved||renderer.presentedCameraVersion===renderer.cameraVersion
          assert(renderer.displaySurface,'A preparation turn discarded the displayed surface')
          if(!proof&&receipts.length<2)assert.strictEqual(renderer.displaySurface.current,oldCurrent,
            'A cut without a boundary proof published partial geometry')
        }
        assert(moved,'Preparation starved the latest camera')
        assert.deepStrictEqual(receipts, [1,2])
        assert.deepStrictEqual(submitted, proof ? [[51,52], [61,62,63,64,52], [61,62,63,64,65,66]]
          : [[51,52], [61,62,63,64,65,66]])
        gl.complete(); renderer.render(false)
        assert.strictEqual(renderer.pendingSubmission, null)
        assert.strictEqual(renderer.uploadQueue.length, 0)
      } finally { renderer.destroy() }
      await settle()
      assert.strictEqual(gl.syncs.size, 0)
      assert.strictEqual(renderer.resourceLedger.bytes, 0)
    }
  } finally {global.performance = performance}
}

async function testTextureUploadWithoutRedraw() {
  const performance = global.performance
  let clock = 1000
  global.performance = {now: () => clock}
  const keyOf = tile => [tile.level, tile.matrix, tile.row, tile.column].join('/')
  const gl = new AsyncGl(), canvas = new FakeCanvas(gl)
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    mode: 'height', urlForTile: () => 'unused', uploadBudgetBytes: 350000,
    textureCacheBytes: 32 * 611668, maximumTextureEntries: 32
  })
  try {
    publishFrame(renderer, frame(), [draw(0)], new Float32Array([0,0,0, 1,0,0, 0,1,0]),
      new Float32Array([0,0, 1,0, 0,1]), new Uint16Array([0,2,1]))
    renderer.render()
    for (let i = 0; i < 8; ++i) { gl.complete(); renderer.render(false) }
    assert.strictEqual(renderer.pendingSubmission, null)
    assert(renderer.stats(true).performance.drawSubmissionWait.count > 0,
      'A frame with geometry uploads was not classified as drawing')
    renderer.resetTimings()
    const store = renderer.textures
    const children = [0,1,2,3].map(i => ({level: 1, matrix: 2, row: i >> 1, column: i & 1}))
    store.cache.set('0/1/0/0', {image: {}, texture: {}, width: 256, height: 256}, 349524)
    store.buildRequirementTree(children.map(texture => ({texture})))
    store.recomputeAvailability()
    children.forEach(tile => store.cache.set(keyOf(tile),
      {image: {}, texture: null, width: 256, height: 256}, 349524))
    store.advance()
    const draws = () => gl.calls.filter(call => call.name === 'drawElements').length
    const before = draws()
    for (let i = 0; i < 4; ++i) {
      assert.strictEqual(renderer.render(false), null, 'An incomplete image group redrew unchanged terrain')
      assert.strictEqual(gl.syncs.size, 1)
      assert.strictEqual(renderer.pendingSubmission.items.length, 1, 'Upload allowance was bypassed')
      assert.strictEqual(renderer.stats().transition.gpuSubmission.kind, 'resource')
      const stats = renderer.stats(true).performance
      assert.strictEqual(stats.resourceSubmissionWait.count, i,
        'Polling or beginning a submission must not record completion')
      assert.strictEqual(stats.drawSubmissionWait.count, 0,
        'An upload-only submission was attributed to drawing')
      clock += 7
      for (let poll = 0; poll < 3; ++poll) renderer.render(false)
      assert.strictEqual(draws(), before, 'Polling an upload-only fence issued terrain commands')
      assert.strictEqual(gl.syncs.size, 1, 'Resource pumping exceeded the single submission bound')
      gl.complete()
      if (i < 3) {
        // Polling commits one image and starts the next bounded resource batch.
        assert.strictEqual(renderer.render(false), null)
        assert.strictEqual(store.availableKeys.has(keyOf(children[i])), false)
      }
    }
    assert(renderer.render(false).submitted > 0, 'The ready sibling group did not wake presentation')
    assert.strictEqual(draws(), before + 1)
    assert(children.every(tile => store.availableKeys.has(keyOf(tile))))
    assert.strictEqual(renderer.stats().transition.gpuSubmission.kind, 'draw')
    clock += 19
    gl.complete(); renderer.render(false)
    assert.strictEqual(gl.syncs.size, 0)
    assert.strictEqual(store.cache.stats().retainedEntries, 0)
    const completed = renderer.stats(true).performance
    assert.strictEqual(completed.resourceSubmissionWait.count, 4)
    assert.strictEqual(completed.resourceSubmissionWait.p95Ms, 7)
    assert.strictEqual(completed.drawSubmissionWait.count, 1)
    assert.strictEqual(completed.drawSubmissionWait.p95Ms, 19)
    assert.strictEqual(renderer.stats().transition.gpuSubmission.kind, null)
    renderer.resetTimings()
    renderer.render()
    renderer.setPaused(true)
    assert.strictEqual(renderer.stats(true).performance.drawSubmissionWait.count, 0,
      'Cancellation was recorded as a completed GPU submission')
  } finally { renderer.destroy(); global.performance = performance }
  assert.strictEqual(gl.syncs.size, 0)
  await settle()
  assert.strictEqual(renderer.resourceLedger.stats().bytes, 0)
}

async function testPartitionPreparationWithoutRedraw() {
  const gl = new AsyncGl(), plans = [], outputs = []
  const task = queue => {
    const value = {cancel() {}}
    value.promise = new Promise(resolve => { value.finish = resolve })
    queue.push(value)
    return value
  }
  // Drive the normal render/resource pump, without the legacy fixture's
  // automatic synchronous uploads in settle().
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const renderer = new Renderer(new FakeCanvas(gl), {
    mode: 'height', urlForTile: () => 'unused',
    requestResources() {},
    createPartitionPlanTask: () => task(plans),
    createPartitionTask: () => task(outputs)
  })
  try {
    publishFrame(renderer, frame(), [draw(0)], new Float32Array([0,0,0, 1,0,0, 0,1,0]),
      new Float32Array([0,0, 1,0, 0,1]), new Uint16Array([0,2,1]))
    renderer.render()
    for (let i = 0; i < 8; ++i) { gl.complete(); renderer.render(false) }
    const draws = () => gl.calls.filter(call => call.name === 'drawElements').length
    const geometry = renderer.geometry.values()[0]
    for (const empty of [false, true]) {
      const before = draws(), index = plans.length
      const cell = {key: empty ? 'empty' : 'visible', bounds: {
        minimumU: 0, maximumU: 0.5, minimumV: 0, maximumV: 0.5}}
      renderer.partitionPublication.handoff.add(geometry.key + ':' + cell.key)
      renderer.requestPartitionSet(geometry, [cell])
      renderer.render(false); await tick()
      assert.strictEqual(plans.length, index + 1, 'A resource wake failed to start partition planning')
      assert.strictEqual(draws(), before, 'Enqueuing partition work redrew unchanged terrain')
      assert.strictEqual(renderer.pendingSubmission, null)
      plans[index].finish([{key: cell.key, bytes: empty ? 0 : 6}]); await tick()
      assert.strictEqual(outputs.length, index, 'Pricing completion started production without a background turn')
      renderer.render(false); await tick()
      assert.strictEqual(outputs.length, index + 1)
      for (let i = 0; i < 4; ++i) renderer.render(false)
      assert.strictEqual(draws(), before, 'Waiting for CPU partition output redrew terrain')
      outputs[index].finish(empty ? [] : [{cell, indices: new Uint16Array([0,2,1]),
        positions: new Float32Array(0), uv: new Float32Array(0)}])
      await tick()
      renderer.render(false)
      if (!empty) {
        assert.strictEqual(draws(), before, 'CPU completion drew before its GPU resources were usable')
        assert.strictEqual(renderer.pendingSubmission.drawn, false)
        for (let i = 0; i < 4; ++i) renderer.render(false)
        assert.strictEqual(draws(), before, 'Pending partition upload redrew terrain')
        gl.complete(); renderer.render(false)
      }
      assert.strictEqual(draws(), before, 'Unused UV output redrew a height-only view')
      assert(geometry.partitions.has(cell.key))
      gl.complete(); renderer.render(false)
      assert.strictEqual(renderer.pendingSubmission, null)
      assert.strictEqual(renderer.partitionCpuBytes + renderer.partitionReservedBytes, 0)
    }
  } finally { renderer.destroy() }
  await tick()
  assert.strictEqual(gl.syncs.size, 0)
  assert.strictEqual(renderer.resourceLedger.stats().bytes, 0)
}

async function testPartitionPreparationDuringGpuWait() {
  const gl = new AsyncGl(), plans = [], outputs = []
  const task = queue => {
    const value = {cancel() { this.finish(null) }}
    value.promise = new Promise(resolve => { value.finish = resolve })
    queue.push(value)
    return value
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  const renderer = new Renderer(new FakeCanvas(gl), {
    mode: 'height', urlForTile: () => 'unused',
    createPartitionPlanTask: () => task(plans),
    createPartitionTask: () => task(outputs)
  })
  try {
    publishFrame(renderer, frame(), [draw(0)], new Float32Array([0,0,0, 1,0,0, 0,1,0]),
      new Float32Array([0,0, 1,0, 0,1]), new Uint16Array([0,2,1]))
    renderer.render()
    for (let i = 0; i < 8; ++i) { gl.complete(); renderer.render(false) }
    renderer.render()
    const submission = renderer.pendingSubmission
    assert(submission && submission.drawn)
    const uploads = () => gl.calls.filter(call => call.name === 'bufferData').length
    const before = uploads(), geometry = renderer.geometry.values()[0]
    const cells = Array.from({length: 9}, (_,i) => ({key: 'prepared-' + i, sourceUv: true, bounds: {
      minimumU: 0, maximumU: 0.5, minimumV: 0, maximumV: 0.5}}))
    cells.forEach(cell => renderer.partitionPublication.handoff.add(geometry.key + ':' + cell.key))
    renderer.requestPartitionSet(geometry, cells)
    for (let i = 0; i < 4; ++i) { renderer.render(false); await tick() }
    assert.strictEqual(plans.length, 1, 'CPU partition planning waited for an unrelated GPU receipt')
    plans[0].finish(cells.map(cell => ({key: cell.key, bytes: 6}))); await tick()
    renderer.render(false); await tick()
    const admitted = renderer.partitionActive.cells
    assert.strictEqual(admitted.length, 8)
    assert.strictEqual(outputs.length, 1)
    assert.strictEqual(renderer.partitionCpuBytes + renderer.partitionReservedBytes, 102,
      'Preparation bypassed the joint CPU/GPU output credit')
    outputs[0].finish(admitted.map(cell => ({cell, indices: new Uint16Array([0,2,1]),
      positions: new Float32Array(0), uv: new Float32Array(0)}))); await tick()
    for (let i = 0; i < 4; ++i) { renderer.render(false); await tick() }
    assert.strictEqual(renderer.pendingSubmission, submission)
    assert.strictEqual(uploads(), before + 8, 'A pending display blocked an admitted partition upload')
    assert.strictEqual(geometry.partitions.size, 0, 'Uncompleted uploads were published')
    assert.strictEqual(gl.syncs.size, 2, 'Display and resource lanes did not remain bounded')
    assert.strictEqual(plans.length, 1, 'A full CPU ready slot admitted another partition task')
    assert.strictEqual(renderer.partitionUploads.length, 0)
    // Completing the earlier draw is not proof that the later upload finished.
    submission.sync.ready = true
    renderer.render(false); await tick()
    assert.strictEqual(geometry.partitions.size, 0)
    assert.strictEqual(gl.syncs.size, 1)
    gl.complete(); renderer.render(false); await tick()
    assert.strictEqual(geometry.partitions.size, 8, 'The actual upload receipt did not publish its partitions')
  } finally { renderer.destroy() }
  await tick()
  assert.strictEqual(gl.syncs.size, 0)
  assert.strictEqual(renderer.resourceLedger.stats().bytes, 0)
}

async function testUnchangedCandidateYield() {
  const {patch, surface} = require('./terrain_surface_fixture')
  const {SubmittedTerrain} = require('../../sdk/js/terrain/submitted_terrain')
  const old = surface([patch(51, [[0,0], [1,0], [0,1]], undefined, 4),
    patch(52, [[1,1], [0,1], [1,0]], undefined, 4)])
  for (const generation of [1, 2]) {
    const gl = new AsyncGl(), receipts = [], progress = new SubmittedTerrain()
    const renderer = new rendererModule.TerraWebGlRenderer(new FakeCanvas(gl), {
      mode: 'height', managedResources: true, geometryCacheBytes: 900,
      urlForTile: () => 'unused', onPresented: sequence => receipts.push(sequence),
      onSurfaceSubmitted: (value, partial) => progress.submit(value, partial)})
    const publish = (sequence, workerGeneration) => renderer.setMeshFrame(
      Object.assign(frame(), {sequence, coverageComplete: true}), old.draws, old.meshResources, old.indices,
      {modelRevision: sequence, workerGeneration}, null, [], replacementPresentation(renderer, old))
    try {
      publish(1, 1)
      await waitUntil('Initial unchanged-candidate display did not submit', () => {
        gl.complete(); renderer.render(false); return receipts.includes(1)
      })
      const displayed = renderer.displaySurface, before = progress.snapshot()
      publish(2, generation)
      renderer.localReplacementSurface()
      assert.strictEqual(renderer.candidateCanYield(2), generation === 1,
        'An identical immutable cut blocked a newer model, or IDs from another generation were aliased')
      assert.deepStrictEqual(progress.snapshot(), before, 'Yield eligibility fabricated mesh progress')
      assert.strictEqual(renderer.candidateCanYield(99), false)
      if (generation === 1) {
        renderer.lastSubmittedSurface = null
        assert.strictEqual(renderer.candidateCanYield(2), false, 'Unacknowledged coverage allowed retirement')
        renderer.lastSubmittedSurface = displayed.current
        const held = renderer.holdCandidate(2)
        assert(held)
        renderer.discardCandidate(held); renderer.releaseCandidate(held)
        assert.deepStrictEqual(receipts, [1], 'Discard acknowledged an obsolete candidate')
        assert.strictEqual(renderer.displaySurface, displayed)
        assert(displayed.current.draws.every(draw => renderer.geometryPinnedKeys.has(draw.geometryKey)))
      }
    } finally { renderer.destroy() }
    await settle()
    assert.strictEqual(renderer.resourceLedger.bytes, 0)
    assert.strictEqual(gl.syncs.size, 0)
  }
}

async function testReplacementPreparation() {
  const {patch, surface} = require('./terrain_surface_fixture')
  const {SubmittedTerrain} = require('../../sdk/js/terrain/submitted_terrain')
  const lower = [[0,0], [1,0], [0,1]], upper = [[1,1], [0,1], [1,0]]
  for (const cancel of [null, 'supersede', 'refused', 'refused-loss', 'pause', 'reset', 'loss', 'destroy']) {
    const old = surface([patch(51, lower, undefined, 4), patch(52, upper, undefined, 4)])
    const next = surface([patch(53, lower, undefined, 4), patch(54, upper, undefined, 4)])
    const gl = new AsyncGl(), receipts = [], local = [], progress = new SubmittedTerrain()
    const renderer = new rendererModule.TerraWebGlRenderer(new FakeCanvas(gl), {
      mode: 'height', managedResources: true, geometryCacheBytes: 900,
      urlForTile: () => 'unused', onPresented: sequence => receipts.push(sequence),
      onSurfaceSubmitted: (value, partial) => {
        progress.submit(value, partial)
        if (partial) local.push(value)
      }
    })
    const publish = (sequence, value) => renderer.setMeshFrame(Object.assign(frame(), {
      sequence, coverageComplete: true}), value.draws, value.meshResources, old.indices,
      {modelRevision: sequence, workerGeneration: 1, pendingPriorityUpdateCount: 1},
      null, [], replacementPresentation(renderer, value))
    try {
      publish(1, old)
      await waitUntil('Initial cut did not submit', () => {
        gl.complete(); renderer.render(false)
        return receipts.includes(1)
      })
      const initialProgress = progress.snapshot()
      assert.strictEqual(initialProgress.meshRevision, 1)
      publish(2, next)
      assert.strictEqual(renderer.candidateCanYield(2), false,
        'An admitted candidate was replaceable before its first display change')
      // Explicitly prepare the proof whose cancellation this fixture checks;
      // same-camera upload progress need not first redraw the old surface.
      renderer.localReplacementSurface()
      gl.complete(); renderer.render(false)
      const plan = renderer.replacement, commands = gl.calls.length
      assert(plan && plan.groups && renderer.pendingSubmission)
      assert.strictEqual(renderer.candidateCanYield(2), false,
        'Queued GPU work was mistaken for a changed display')
      assert.deepStrictEqual(progress.snapshot(), initialProgress,
        'Queued uploads fabricated a display-cut receipt')
      const replace = ['supersede', 'refused', 'refused-loss'].includes(cancel)
      if (cancel && !replace) {
        // An admitted native proof must not outlive the owning candidate.
        if (cancel === 'pause') renderer.setPaused(true)
        else if (cancel === 'reset') renderer.resetWorker()
        else if (cancel === 'loss') renderer.contextWasLost()
        else renderer.destroy()
        assert(!renderer.replacement, 'Cancellation retained boundary ownership')
        await settle()
        assert.strictEqual(renderer.replacement, null, 'A cancelled result was adopted')
        if (cancel === 'loss') gl.syncs.clear() // Browser invalidates context handles.
      } else {
        assert.strictEqual(gl.calls.length, commands, 'Boundary preparation issued GL work')
        assert.strictEqual(plan.groups.length, 2)
        assert.deepStrictEqual(receipts, [1], 'Preparation falsely acknowledged display')
        assert.strictEqual(local.length, 0)
        gl.complete(); renderer.render(false)
        assert(local.some(value => value.meshResources.has(53) && value.meshResources.has(52)),
          'A prepared independent group did not publish after GPU admission')
        assert.deepStrictEqual(receipts, [1])
        assert.strictEqual(progress.snapshot().meshRevision, initialProgress.meshRevision + 1,
          'A submitted mixed cut was omitted from terrain progress')
        assert.strictEqual(progress.snapshot().partialSubmissions, initialProgress.partialSubmissions + 1)
        assert.strictEqual(renderer.candidateCanYield(2), true,
          'A submitted independent group did not permit latest-model replacement')
        if (replace) {
          const held = renderer.holdCandidate(2), submitted = renderer.displaySurface
          assert(held && held.draws.some(draw => draw.resourceId === 53))
          assert(held.draws.some(draw => draw.resourceId === 52))
          assert.strictEqual(renderer.holdCandidate(2), null, 'A second replacement transaction was admitted')
          gl.complete(); renderer.render()
          assert.strictEqual(renderer.displaySurface, submitted, 'Held candidate continued promoting geometry')
          assert.deepStrictEqual(receipts, [1], 'Frozen preparation acknowledged the obsolete candidate')
          if (cancel !== 'supersede') {
            if (cancel === 'refused-loss') {
              renderer.contextWasLost(); gl.syncs.clear()
              renderer.contextWasRestored()
            }
            renderer.discardCandidate(held)
            renderer.releaseCandidate(held)
            assert(!renderer.heldCandidate)
            await waitUntil('Refused publication did not restore its retained display', () => {
              gl.complete(); renderer.render()
              return renderer.drawStats.submitted > 0 &&
                !(renderer.pendingSubmission && renderer.pendingSubmission.items.length)
            })
            const ids = Array.from(renderer.current.meshResources.keys()).sort()
            assert.deepStrictEqual(ids, [52,53], 'An unretained candidate mesh survived refusal')
            assert.deepStrictEqual(receipts, [1], 'Refusal falsely presented the discarded candidate')
            assert(!renderer.geometryPinnedKeys.has('mesh:54'))
            renderer.setCameraFrame(Object.assign(frame(), {cameraPosition: [1,2,3]}))
            gl.complete(); renderer.render()
            assert.deepStrictEqual(Array.from(renderer.displaySurface.current.meshResources.keys()).sort(), ids)
          }
          const successor = surface([patch(53, lower, undefined, 4), patch(55, upper, undefined, 4)])
          publish(3, successor)
          renderer.releaseCandidate(held)
        }
        await waitUntil('Remaining group failed to use released capacity', () => {
          gl.complete(); renderer.render(false)
          return receipts.includes(replace ? 3 : 2)
        })
        assert.deepStrictEqual(receipts, replace ? [1,3] : [1,2])
      }
    } finally { renderer.destroy() }
    await settle()
    assert.strictEqual(gl.syncs.size, 0)
    assert.strictEqual(renderer.resourceLedger.stats().bytes, 0)
  }
}

async function testRetiredCandidateDestinations() {
  const {patch, surface} = require('./terrain_surface_fixture')
  const lower = [[0,0], [1,0], [0,1]], upper = [[1,1], [0,1], [1,0]]
  for (const inFlight of [false, true]) {
    const old = surface([patch(51, lower, undefined, 4), patch(52, upper, undefined, 4)])
    const next = surface([patch(53, lower, undefined, 4), patch(54, upper, undefined, 4)])
    const gl = new AsyncGl(), receipts = []
    const renderer = new rendererModule.TerraWebGlRenderer(new FakeCanvas(gl), {
      mode: 'height', managedResources: true, geometryCacheBytes: 4096,
      uploadBudgetObjects: 2, urlForTile: () => 'unused', onPresented: sequence => receipts.push(sequence)
    })
    const reserve = () => renderer.reserveMeshOutputs({draws: next.draws}, 0)
    const publish = (sequence, value, outputs) => {
      const presentation = replacementPresentation(renderer, value)
      presentation.outputs = outputs
      renderer.setMeshFrame(Object.assign(frame(), {sequence, coverageComplete: true}),
        value.draws, value.meshResources, old.indices,
        {modelRevision: sequence, workerGeneration: 1, pendingPriorityUpdateCount: 1},
        null, [], presentation)
      if (outputs) { outputs.release(); outputs.credit.release() }
    }
    try {
      publish(1, old)
      await waitUntil('Initial display did not submit', () => {
        gl.complete(); renderer.render(false); return receipts.includes(1)
      })
      const output = reserve()
      assert(output)
      publish(2, next, output)
      assert.strictEqual(renderer.uploadQueue.length, 4)
      const display = renderer.displaySurface
      let held = renderer.holdCandidate(2)
      assert(held)
      renderer.releaseCandidate(held) // Failed CPU retention must preserve the original producer.
      assert.strictEqual(renderer.uploadQueue.length, 4)
      assert.strictEqual(renderer.geometry.reservations.size, 4)
      if (inFlight) {
        gl.complete(); renderer.render(false)
        assert(renderer.pendingSubmission)
        assert.strictEqual(renderer.uploadQueue.length, 2)
      }
      held = renderer.holdCandidate(2)
      assert(held)
      const shared = reserve()
      assert(shared && shared.valid(), 'Successor could not borrow the existing destination')
      shared.release(); shared.credit.release()
      renderer.discardCandidate(held)
      renderer.discardCandidate(held)
      assert.strictEqual(renderer.uploadQueue.length, 0, 'Retired producer kept a paused upload queue')
      assert.strictEqual(renderer.geometry.reservations.size, inFlight ? 2 : 0,
        'Queued and submitted destinations did not keep separate lifetimes')
      assert.strictEqual(renderer.displaySurface, display)
      assert(!renderer.geometryPinnedKeys.has('mesh:54'))
      assert(renderer.heldCandidate, 'Retirement resumed promotion before successor admission')
      if (inFlight) {
        const waiting = reserve(), bytes = renderer.geometry.reservedBytes
        assert(waiting && waiting.valid())
        assert.strictEqual(waiting.take('mesh:53'), undefined, 'Shared in-flight upload acquired a second producer')
        const before = renderer.resourceLedger.availabilityRevision
        gl.complete(); renderer.render(false)
        assert(renderer.resourceLedger.availabilityRevision > before, 'GPU completion did not wake admission')
        assert(waiting.valid(), 'GPU completion invalidated a borrowed destination')
        assert(renderer.geometry.reservedBytes < bytes)
        waiting.release(); waiting.credit.release()
      }
      const successor = reserve()
      assert(successor && successor.valid(), 'Retired destinations blocked successor production')
      assert.deepStrictEqual(receipts, [1], 'Retirement falsely acknowledged a candidate')
      publish(3, next, successor)
      renderer.releaseCandidate(held)
      await waitUntil('Successor failed to publish', () => {
        gl.complete(); renderer.render(false); return receipts.includes(3)
      })
      assert.deepStrictEqual(receipts, [1, 3])
    } finally { renderer.destroy() }
    await settle()
    assert.strictEqual(gl.syncs.size, 0)
    assert.strictEqual(renderer.resourceLedger.stats().bytes, 0)
  }
}

function testAsynchronousUploads() {
  const gl = new AsyncGl(), canvas = new FakeCanvas(gl), receipts = []
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    mode: 'height', managedResources: true, geometryCacheBytes: 120, partitionCacheBytes: 198,
    urlForTile: () => 'unused', onPresented: sequence => receipts.push(sequence)
  })
  const indices = new Uint16Array([0,2,1])
  const publish = id => renderer.setMeshFrame(Object.assign(frame(), {sequence: id}),
    [Object.assign(draw(0), {resourceId: id, textureResourceId: 4294967296+id})], new Map([[id, {
      positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]), textureUv: new Float32Array([0,0, 1,0, 0,1])
    }]]), indices, {modelRevision: id})
  const nextFrame = () => { gl.complete(); return renderer.render() }
  try {
    publish(1)
    const checks = gl.checks
    renderer.render()
    assert(renderer.pendingSubmission && renderer.geometry.reservedBytes === 60)
    assert.strictEqual(renderer.geometry.bytes, 0, 'Unfinished geometry was marked resident')
    const allocated = gl.calls.filter(c => c.name === 'bufferData').length
    for (let i = 0; i < 5; ++i) assert.strictEqual(renderer.render(), null)
    assert.strictEqual(gl.checks, checks)
    assert.strictEqual(gl.calls.filter(c => c.name === 'bufferData').length, allocated,
      'Pending GPU work accumulated duplicate uploads')
    assert.deepStrictEqual(receipts, [])
    gl.complete(); renderer.render()
    assert.deepStrictEqual(receipts, [1])
    assert.strictEqual(renderer.geometry.reservedBytes, 0)
    assert(renderer.geometry.has('mesh:1'))
    const geometry = renderer.geometry.get('mesh:1'), cell = {key: 'retired-cell'}
    stagePartitionJob(renderer, geometry, [cell],
      [{cell, positions: new Float32Array(9), uv: new Float32Array(6), indices: new Uint16Array([0,2,1])}])
    gl.complete();renderer.advanceResources()
    assert.strictEqual(renderer.partitionReservedBytes, 66)
    assert.strictEqual(renderer.partitionBytes, 0)
    assert.strictEqual(renderer.resourceLedger.stats().owners['partition-gpu'].reserved, 66)
    assert.strictEqual(renderer.partitionCpuBytes, 66)
    renderer.releasePartitions(geometry)
    assert.strictEqual(renderer.partitionReservedBytes, 66, 'In-flight GPU objects lost their byte reservation')
    gl.complete(); renderer.render()
    assert.strictEqual(renderer.partitionReservedBytes, 0)
    assert.strictEqual(renderer.partitionCpuBytes, 0)
    assert.strictEqual(geometry.partitions.size, 0, 'A retired partition generation was resurrected')
    publish(2); nextFrame()
    const displayed = renderer.displaySurface, submitted = renderer.drawStats
    assert(renderer.pendingSubmission)
    assert.strictEqual(renderer.render(), null)
    assert.strictEqual(renderer.displaySurface, displayed)
    assert.strictEqual(renderer.drawStats, submitted, 'GPU backpressure erased the composed image state')
    gl.error = 0x0505; gl.complete(); renderer.render()
    assert(!renderer.geometry.has('mesh:2'), 'OOM batch published replacement geometry')
    assert.deepStrictEqual(receipts, [1])
    for(let turn=0;turn<4&&receipts.length<2;++turn){gl.complete();renderer.advanceResources();renderer.render(false)}
    assert.deepStrictEqual(receipts, [1, 2])

    // The async overlay keeps its coordinate origin while a newer camera is
    // rendered; its data must not be silently interpreted relative to that eye.
    renderer.setOverlays({points: [{world: [1,2,3]}]})
    nextFrame(); nextFrame()
    const origin = renderer.overlayData.camera.slice()
    renderer.current.frame = Object.assign({}, renderer.current.frame, {cameraPosition: [10, 20, 30]})
    nextFrame()
    const offset = gl.calls.filter(c => c.name === 'uniform3f' && c.args[0].name === 'u_origin').pop().args.slice(1)
    assert.deepStrictEqual(offset, origin.map((v, i) => v - [10,20,30][i]))
    renderer.setOverlays({})
    gl.complete(); renderer.render()
    assert.strictEqual(renderer.pendingSubmission.items.length, 0, 'Rejected stale overlay kept allocating')

    // A source removal must not let a delayed texture attach to an evicted asset.
    const store = renderer.textures, tile = {level: 1, matrix: 1, row: 0, column: 1}
    const key = require('../../sdk/js/core/terra_globe_common').textureKeyString(tile)
    let closed = 0
    const asset = {image: {close() { ++closed }}, width: 256, height: 256, texture: null}
    store.currentRoots.set(key, tile); store.cache.set(key, asset, 400000)
    renderer.requestResources()
    nextFrame()
    assert(renderer.pendingSubmission && !asset.texture)
    const charged = store.cache.bytes
    store.cache.delete(key)
    assert.strictEqual(store.cache.bytes, charged, 'Pending texture lost its memory charge')
    assert.strictEqual(closed, 0, 'An image was disposed before its upload completed')
    const deleted = gl.calls.filter(c => c.name === 'deleteTexture').length
    gl.complete(); renderer.render()
    assert.strictEqual(asset.texture, null)
    assert.strictEqual(closed, 1)
    assert.strictEqual(store.cache.stats().retainedEntries, 0)
    assert.strictEqual(store.cache.bytes, charged - 400000)
    assert(gl.calls.filter(c => c.name === 'deleteTexture').length > deleted, 'Retired source leaked an uploaded texture')

    publish(3); nextFrame()
    assert(renderer.pendingSubmission)
    const beforeLoss = gl.calls.filter(c => c.name === 'deleteBuffer' || c.name === 'deleteSync').length
    renderer.contextWasLost()
    assert.strictEqual(renderer.pendingSubmission, null)
    assert.strictEqual(renderer.geometry.reservedBytes, 0)
    assert.strictEqual(gl.calls.filter(c => c.name === 'deleteBuffer' || c.name === 'deleteSync').length, beforeLoss,
      'Lost-context handles were passed to GL during reclamation')
    gl.syncs.clear() // The browser invalidates these on context loss.
    renderer.contextWasRestored(); nextFrame(); nextFrame()
    assert(receipts.includes(3))
    publish(4); nextFrame()
    assert(renderer.pendingSubmission)
  } finally { renderer.destroy() }
  assert.strictEqual(gl.syncs.size, 0)
  assert.strictEqual(renderer.geometry.reservedBytes, 0)
  assert.strictEqual(renderer.pendingSubmission, null)

  // Missing/failed fences must cancel ownership, never publish unchecked data.
  const {GlSubmission} = require('../../adapters/webgl/gl_allocation')
  const observationGl = new AsyncGl(), observationBatch = new GlSubmission(observationGl), holds = []
  observationBatch.hold(completed => holds.push(completed))
  assert(observationBatch.defer(), 'An observation-only submission omitted its GPU receipt')
  assert.strictEqual(observationBatch.poll(), false)
  assert.deepStrictEqual(holds, [], 'An in-flight depth borrower released its ownership')
  observationGl.complete()
  assert(observationBatch.poll())
  observationBatch.commit(); observationBatch.cancel()
  assert.deepStrictEqual(holds, [true], 'Depth borrow did not complete exactly once')
  for (const failure of ['create', 'wait']) {
    const failing = new AsyncGl(), batch = new GlSubmission(failing)
    let cancelled = 0
    const completions = []
    batch.hold(completed => completions.push(completed))
    batch.stage('failed fence', resources => resources.buffer(failing.ARRAY_BUFFER, new Float32Array(3)),
      () => assert.fail('Failed fence published data'), () => { ++cancelled })
    if (failure === 'create') {
      failing.fenceSync = () => null
      assert.throws(() => batch.defer(), /fence allocation failed/)
    } else {
      batch.defer(); failing.clientWaitSync = () => 0x911d
      assert.throws(() => batch.poll(), /fence wait failed/)
    }
    batch.cancel(); batch.cancel()
    assert.strictEqual(cancelled, 1)
    assert.strictEqual(failing.syncs.size, 0)
    assert.strictEqual(failing.checks, 0)
    assert.strictEqual(failing.calls.filter(c => c.name === 'deleteBuffer').length, 1)
    assert.deepStrictEqual(completions, [false], 'Failed fence falsely completed a retained depth borrower')
  }
}

async function testMeshOwnership() {
  const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
  const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
  const ledger = new ResourceLedger(64 * 1024 * 1024), frames = new MeshFrames(ledger), gl = new FakeGl()
  const retained = new rendererModule.TerraWebGlRenderer(new FakeCanvas(gl), {
    mode: 'height', urlForTile: () => 'unused', resourceLedger: ledger})
  try {
    const indices = new Uint16Array([0,2,1]), descriptor = Object.assign(draw(0), {resourceId: 1, textureResourceId: 4294967297})
    adoptPacket(frames, {frame: Object.assign(frame(), {sequence: 1}), draws: [descriptor], indices,
      additions: [{resourceId: 1, positions: new Float32Array([0,0,0,1,0,0,0,1,0]), textureUv: new Float32Array([0,0,1,0,0,1])}]})
    const candidate = frames.candidate
    retained.setMeshFrame(candidate.frame, candidate.draws, candidate.resources, indices, {modelRevision: 1})
    retained.render(); retained.render()
    assert(retained.displaySurface, 'Ownership fixture must reach a submitted display')
    frames.clear()
    assert.strictEqual(ledger.stats().owners['mesh-host'].retired, 36,
      'Clearing Worker frame ownership forgot renderer-held input')
    retained.contextWasLost(); retained.contextWasRestored(); retained.render(); retained.render()
    assert.strictEqual(ledger.stats().owners['mesh-host'].retired, 36,
      'Context restoration lost its CPU payload owner')
    retained.resetWorker()
    assert.strictEqual(ledger.stats().owners['mesh-host'].retired, 36,
      'Worker recovery released the retained display')
  } finally { frames.clear(); retained.destroy() }
  await settle()
  assert.strictEqual(ledger.bytes, 0, 'Renderer destruction leaked retired mesh payload')
}

async function testQueuedMeshOwnership() {
  const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
  const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
  for (const upload of [true, false]) {
    const ledger = new ResourceLedger(64 * 1024 * 1024), frames = new MeshFrames(ledger)
    const renderer = new rendererModule.TerraWebGlRenderer(new FakeCanvas(new FakeGl()), {
      mode: 'height', urlForTile: () => 'unused', resourceLedger: ledger})
    try {
      const indices = new Uint16Array([0,2,1])
      for (const sequence of [1,2]) {
        adoptPacket(frames, {frame: Object.assign(frame(), {sequence}),
          draws: [Object.assign(draw(0), {resourceId: 1, textureResourceId: 4294967297})], indices,
          additions: [{resourceId: 1, positions: new Float32Array([0,0,0,1,0,0,0,1,0]),
            textureUv: new Float32Array([0,0,1,0,0,1])}]})
        const candidate = frames.candidate
        renderer.setMeshFrame(candidate.frame, candidate.draws, candidate.resources, indices,
          {modelRevision: sequence, workerGeneration: 1})
        frames.clear()
      }
      assert.strictEqual(renderer.uploadQueue.length, 2)
      assert.strictEqual(ledger.stats().owners['mesh-host'].retired, 72,
        'Same-ID reentry lost the queued old allocation while holding the new frame')
      if (upload) {
        renderer.processUploads()
        assert.strictEqual(renderer.geometry.stats().reservedEntries, 0)
        assert.strictEqual(renderer.geometry.stats().entries, 1)
      } else renderer.resetWorker()
    } finally { frames.clear(); renderer.destroy() }
    await settle()
    assert.strictEqual(ledger.bytes, 0, 'Queued mesh completion/cancellation leaked payload')
  }
}

async function testDependentMeshReclamation() {
  const {ResourceLedger} = require('../../sdk/js/resources/resource_ledger')
  const {MeshFrames} = require('../../sdk/js/terrain/terra_mesh_frames')
  const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
  const ledger = new ResourceLedger(64 * 1024 * 1024), frames = new MeshFrames(ledger)
  const renderer = new rendererModule.TerraWebGlRenderer(new FakeCanvas(new FakeGl()), {
    mode: 'height', urlForTile: () => 'unused', resourceLedger: ledger})
  let query, incoming
  try {
    const indices = new Uint16Array([0,2,1])
    adoptPacket(frames, {frame: Object.assign(frame(), {sequence: 1}),
      draws: [Object.assign(draw(0), {resourceId: 1, textureResourceId: 4294967297})], indices,
      additions: [{resourceId: 1, positions: new Float32Array([0,0,0,1,0,0,0,1,0]),
        textureUv: new Float32Array([0,0,1,0,0,1])}]})
    const candidate = frames.candidate
    query = holdMeshes(candidate.resources.values())
    renderer.setMeshFrame(candidate.frame, candidate.draws, candidate.resources, indices, {modelRevision: 1})
    renderer.processUploads(Infinity)
    const geometry = renderer.geometry.get(candidate.draws[0].geometryKey), key = 'partial-cell'
    renderer.partitionPublication.handoff.add(geometry.key + ':' + key)
    renderer.requestPartitionSet(geometry, [{key, bounds: {minimumU: 0, maximumU: 0.5, minimumV: 0, maximumV: 0.5}}])
    await waitUntil('Owned partition did not complete', () => {
      renderer.pumpPartitionRequests(); renderer.processPartitionUploads(Infinity)
      return geometry.partitions.has(key)
    })
    const partBytes = geometry.partitions.get(key).byteSize
    assert(partBytes > 0)
    frames.clear(); renderer.resetWorker()
    // The image may still be a frontier goal elsewhere; it must not pin an
    // otherwise idle geometry's obsolete partition forever.
    renderer.textures.frontierKeys.add(key)
    ledger.setLimit(ledger.bytes)
    const directlyReclaimable = Array.from(ledger.leases).filter(lease => lease.reclaimable && lease.reclaimable())
      .reduce((n, lease) => n + lease.bytes, 0)
    const bytes = directlyReclaimable + geometry.uv.byteLength + partBytes + 1
    assert.strictEqual(ledger.reserve('next-model', bytes), null)
    assert(renderer.geometry.has(geometry.key), 'A live query was reclaimed with the idle GPU asset')
    query()
    incoming = ledger.reserve('next-model', bytes)
    assert(incoming, 'Real renderer ownership did not fund the next model')
    assert(!renderer.geometry.has(geometry.key))
    assert.strictEqual(renderer.partitionBytes, 0)
    assert(ledger.stats().dependentReclaimedBytes >= 60 + partBytes)
    assert.strictEqual(ledger.stats().overBudgetBytes, 0)
  } finally {
    if (query) query()
    if (incoming) incoming.release()
    frames.clear(); renderer.destroy()
  }
  await settle()
  assert.strictEqual(ledger.bytes, 0)
}

async function main() {
  await require('./partial_mesh_retention_contract')()
  await require('./world_display_contract')(RawRenderer)
  await require('./world_source_continuity_contract')(RawRenderer)
  await require('./world_work_budget_contract')(undefined,RawRenderer)
  await require('./world_demand_receipt_contract')(RawRenderer)
  await require('./world_goal_residency_contract')(RawRenderer)
  await require('./world_display_alias_contract')(RawRenderer)
  await require('./world_group_demand_contract')(RawRenderer)
  await require('./terrain_publication_clock_contract')(RawRenderer)
  await require('./camera_surface_witness_contract')(RawRenderer)
  await require('./world_group_progress_contract')(RawRenderer)
  await require('./world_goal_continuity_contract')(RawRenderer)
  await require('./imagery_candidate_work_contract')()
  require('./persistent_footprint_contract')()
  require('./imagery_ancestor_lookup_contract')()
  testGeometryUnpinAvailability()
  require('./terrain_index_budget_contract')({Renderer: RawRenderer, AsyncGl, FakeCanvas, draw})
  await require('./shared_geometry_upload_contract')({Renderer: RawRenderer, AsyncGl, FakeCanvas, frame, draw})
  testResourceLimitOwnership()
  await testUnchangedCandidateYield()
  require('./submitted_terrain_test').testSubmittedTerrain()
  require('./partition_publication_contract')()
  await require('./partition_demand_contract')({Renderer, FakeGl, FakeCanvas, stagePartitionJob, settle})
  await require('./partition_pipeline_contract')({Renderer, FakeGl, FakeCanvas})
  await require('./surface_publication_contract')({Renderer:RawRenderer, AsyncGl, FakeCanvas, frame, draw, publishFrame})
  require('./surface_commands_contract')()
  await require('./terrain_publication_cadence_contract')({Renderer:RawRenderer,AsyncGl,FakeCanvas,frame,settle})
  require('./visibility_submission_contract')({Renderer: rendererModule.TerraWebGlRenderer,
    AsyncGl, FakeCanvas, publishFrame, frame, draw})
  await testMeshOwnership()
  await testQueuedMeshOwnership()
  await testDependentMeshReclamation()
  testBoundedGpuFrames()
  await require('./gpu_resource_presentation_contract')({Renderer: rendererModule.TerraWebGlRenderer,
    AsyncGl, FakeCanvas, publishFrame, frame, draw, settle})
  await testGeometryUploadWithoutRedraw()
  await testTextureUploadWithoutRedraw()
  await require('./partition_group_publication_contract')({Renderer: RawRenderer, AsyncGl, FakeCanvas, frame, draw})
  await require('./partition_group_publication_contract')({Renderer: RawRenderer, AsyncGl, FakeCanvas, frame, draw, sourceUv:true})
  await require('./imagery_output_contract')({Renderer: RawRenderer, AsyncGl, FakeCanvas, frame, draw})
  await require('./imagery_output_contract')({Renderer: RawRenderer, AsyncGl, FakeCanvas, frame, draw, imageSource:true})
  await testPartitionPreparationWithoutRedraw()
  await testPartitionPreparationDuringGpuWait()
  await require('./background_resource_contract')({Renderer: RawRenderer, AsyncGl, FakeCanvas, publishFrame, frame, draw, settle})
  await require('./camera_submission_contract')({Renderer: RawRenderer, AsyncGl, FakeCanvas, publishFrame, frame, draw, settle})
  await require('./display_receipt_contract')({Renderer: RawRenderer, AsyncGl, FakeCanvas, publishFrame, frame, draw, settle})
  await require('./partition_upload_publication_contract')({Renderer: RawRenderer,
    AsyncGl, FakeCanvas, frame, draw, publishFrame, stagePartitionJob, settle})
  require('./retired_geometry_cleanup_contract')(RawRenderer)
  require('./resident_imagery_coverage_contract')(RawRenderer)
  require('./coverage_images_contract')(RawRenderer)
  require('./coverage_cell_bounds_contract')()
  await testReplacementPreparation()
  await require('./mixed_measurement_ownership_contract')({Renderer,FakeGl,FakeCanvas,frame,replacementPresentation,settle})
  await testRetiredCandidateDestinations()
  await testIndependentImageryRoots(true)
  await testIndependentImageryRoots(false)
  await require('./imagery_priority_contract')({Renderer: RawRenderer, FakeCanvas, FakeGl, settle})
  testSubmittedSurfaceClipping()
  testProjectionEnvelope()
  testDirectMeasurementRefinement()
  testStandaloneGeometryAdmission()
  await testUploadBudget()
  testAsynchronousUploads()
  testGlAllocationAndSubmission()
  testGeometryOutputAdmission()
  await testPartitionPriorityAndCancellation()
  await testPartitionOutputAdmission()
  await require('./mesh_output_plan_contract')(Renderer, new FakeCanvas(new FakeGl()), settle)
  await testWorkerFinePresentationContinuity()
  await testWorkerFinePresentationContinuity(true)
  await testWorkerFinePresentationContinuity(true, true)
  await testCoarseGeometryAdmission()
  await testCoarseGeometryAdmission(true)
  await testLocalGeometryReplacement()
  await testLocalGeometryReplacement(true)
  await testLocalGeometryReplacement(false, true)
  await testLocalGeometryReplacement(false, false, true)
  await testLocalGeometryReplacement(true, false, true)
  await testSameCameraDemandContinuity()
  await testMovingCameraDemandOwnership()
  await testPanPartitionCoverage()
  assert.strictEqual(isPowerOfTwo(256), true)
  assert.strictEqual(isPowerOfTwo(255), false)
  assert.strictEqual(rendererModule.geometryKey(draw(2)),
    'geometry:0/1/2/3:0')
  assert.deepStrictEqual(Array.from(invertMatrix4([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ])), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  assert.deepStrictEqual(textureTiles.ancestorTextureTiles({
    level: 3, matrix: 4, row: 5, column: 11
  }), [
    { level: 2, matrix: 3, row: 2, column: 5 },
    { level: 1, matrix: 2, row: 1, column: 2 },
    { level: 0, matrix: 1, row: 0, column: 1 }
  ])
  assert.deepStrictEqual(textureTiles.ancestorUvTransform(
    { level: 3, matrix: 3, row: 7, column: 11 },
    { level: 2, matrix: 2, row: 3, column: 5 }), {
    scale: 0.5,
    offsetX: 0.5,
    offsetY: 0.5
  })
  const coverage = textureTiles.globalCoverageTextureTiles({
    kind: 'global-geodetic',
    matrix_level_offset: 1,
    maximum_level: 17, minimum_level: 0, bounds: [[-180,-90],[180,90]],
    level_zero_columns: 2,
    level_zero_rows: 1
  })
  assert.strictEqual(coverage.length, 2)
  assert.deepStrictEqual(coverage[0],
    { level: 0, matrix: 1, row: 0, column: 0 })
  assert.deepStrictEqual(coverage[coverage.length - 1],
    { level: 0, matrix: 1, row: 0, column: 1 })
  for (let row = 0; row < 8; ++row) {
    for (let column = 0; column < 16; ++column) {
      const descendant = {level: 3, matrix: 4, row, column}
      assert.strictEqual(coverage.filter(root =>
        textureTiles.textureTileContains(root, descendant)).length, 1,
      'Minimum source coverage lost or duplicated a descendant region')
    }
  }
  assert.deepStrictEqual(textureTiles.globalCoverageTextureTiles({
    kind: 'planar-tms'
  }), [])

  const qualityDraw = draw(4)
  qualityDraw.origin = [0, 0, 0]
  qualityDraw.vertexCount = 4
  const qualityPositions = new Float32Array([
    -1, -1, 0,
    1, -1, 0,
    -1, 1, 0,
    1, 1, 0
  ])
  const qualityUv = new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    1, 1
  ])
  const refined = imageryReference.refineImageryDraws(frame(), [qualityDraw],
    qualityPositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, { targetPixelError: 1, maximumDraws: 64 })
  assert.strictEqual(refined.draws.length, 16)
  assert.deepStrictEqual(refined.draws[15].texture,
    { level: 4, matrix: 4, row: 15, column: 19 })
  assert.strictEqual(refined.quality.measuredMaxPixelError, 1)
  assert.strictEqual(refined.quality.limitedByBudget, false)
  assert.strictEqual(refined.coverageDraws.length, 1)
  assert.deepStrictEqual(refined.coverageDraws[0].texture,
    { level: 0, matrix: 0, row: 0, column: 1 })
  assert.strictEqual(refined.coverageDraws[0].imageryClipCell, false)
  assert.strictEqual(refined.coverageDraws[0].imageryCoverageDraw, true)
  assert(refined.draws.every((item) => item.imageryClipCell &&
    !item.imageryCoverageDraw))
  assert.strictEqual(refined.quality.sourceDrawCount, 1)
  assert.strictEqual(refined.quality.coverageDrawCount, 1)
  assert.strictEqual(refined.quality.clippedDrawCount, 16)
  assert.strictEqual(refined.quality.coverageGuaranteed, true)
  const edgePositions = new Float32Array([
    0.75, -1, 0,
    2.75, -1, 0,
    0.75, 1, 0,
    2.75, 1, 0
  ])
  const edgeRefined = imageryReference.refineImageryDraws(frame(), [qualityDraw],
    edgePositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, { targetPixelError: 1, maximumDraws: 64 })
  assert.strictEqual(edgeRefined.draws.length, refined.draws.length)
  assert.strictEqual(edgeRefined.quality.selectedLevelMinimum,
    refined.quality.selectedLevelMinimum)
  assert.strictEqual(edgeRefined.quality.selectedLevelMaximum,
    refined.quality.selectedLevelMaximum)
  assert.strictEqual(edgeRefined.quality.measuredMaxPixelError,
    refined.quality.measuredMaxPixelError)
  const terrainBound = imageryReference.refineImageryDraws(frame(),
    [qualityDraw], qualityPositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, {
      targetPixelError: 1,
      maximumSubdivisionLevels: 0,
      maximumDraws: 64
    })
  assert.strictEqual(terrainBound.draws.length, 1)
  assert.deepStrictEqual(terrainBound.draws[0].texture, qualityDraw.texture)
  assert.strictEqual(terrainBound.coverageDraws.length, 0)
  assert.strictEqual(terrainBound.quality.limitedByLevel, true)
  assert(terrainBound.quality.measuredMaxPixelError > 1)
  const terrainRefinedDraw = Object.assign({}, qualityDraw, {
    key: Object.assign({}, qualityDraw.key, { level: 8 })
  })
  assert.strictEqual(imageryReference.maximumTerrainTextureLevel(
    terrainRefinedDraw, [terrainRefinedDraw]), 4)
  const terrainCoarseDraw = Object.assign({}, qualityDraw, {
    key: Object.assign({}, qualityDraw.key, { level: 0 }),
    texture: { level: 0, matrix: 0, row: 0, column: 1 }
  })
  const terrainDescendantDraw = Object.assign({}, qualityDraw, {
    key: Object.assign({}, qualityDraw.key, { level: 8 }),
    texture: { level: 4, matrix: 4, row: 3, column: 19 }
  })
  assert.strictEqual(imageryReference.maximumTerrainTextureLevel(
    terrainCoarseDraw, [terrainCoarseDraw, terrainDescendantDraw]), 4)
  const terrainRefined = imageryReference.refineImageryDraws(frame(),
    [terrainRefinedDraw], qualityPositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, {
      targetPixelError: 1,
      maximumDraws: 64,
      terrainBound: true
    })
  assert.strictEqual(terrainRefined.draws.length, 16)
  assert.strictEqual(terrainRefined.quality.meetsTarget, true)
  const budgetLimited = imageryReference.refineImageryDraws(frame(),
    [qualityDraw], qualityPositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, { targetPixelError: 1, maximumDraws: 4 })
  assert.strictEqual(budgetLimited.draws.length, 4)
  assert.strictEqual(budgetLimited.quality.limitedByBudget, true)
  assert.strictEqual(budgetLimited.coverageDraws.length, 1)
  assert.strictEqual(budgetLimited.quality.coverageGuaranteed, true)
  const capacityDraws = Array.from({ length: 8 }, (value, index) => {
    const item = Object.assign({}, qualityDraw)
    item.texture = { level: 3, matrix: 4, row: 0, column: index * 2 }
    return item
  })
  const capacityLimited = imageryReference.refineImageryDraws(frame(),
    capacityDraws, qualityPositions, qualityUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, {
      targetPixelError: 1,
      maximumDraws: 0,
      maximumTextures: 2
    })
  const selectedCapacityKeys = new Set(capacityLimited.draws.map((item) =>
    `${item.texture.level}/${item.texture.matrix}/` +
    `${item.texture.row}/${item.texture.column}`))
  assert(selectedCapacityKeys.size <= 2)
  assert.strictEqual(capacityLimited.quality.selectedTextureCount,
    selectedCapacityKeys.size)
  assert.strictEqual(capacityLimited.quality.maximumTextureCount, 2)
  assert(capacityLimited.quality.coarsenedDrawCount > 0)
  assert.strictEqual(capacityLimited.quality.limitedByTextureBudget, true)
  assert.strictEqual(capacityLimited.draws.length, capacityDraws.length)
  assert(capacityLimited.draws.every((item) =>
    item.imageryCellScale > 0 && item.imageryCellScale <= 1))
  const partialUv = new Float32Array([
    0.25, 0.25,
    0.5, 0.25,
    0.25, 0.5,
    0.5, 0.5
  ])
  const partial = imageryReference.refineImageryDraws(frame(), [qualityDraw],
    qualityPositions, partialUv,
    { width: 1024, height: 1024, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, { targetPixelError: 1, maximumDraws: 64 })
  assert.strictEqual(partial.draws.length, 16)
  assert(partial.draws.every((item) => item.texture.level === 6))
  assert.strictEqual(partial.quality.meetsTarget, true)
  assert.strictEqual(partial.coverageDraws.length, 1)
  assert.strictEqual(partial.quality.coverageGuaranteed, true)
  const distant = imageryReference.refineImageryDraws(frame(), [qualityDraw],
    qualityPositions, qualityUv,
    { width: 64, height: 64, devicePixelRatio: 1 }, {
      tile_size: 256,
      maximum_level: 8
    }, { targetPixelError: 1, maximumDraws: 64 })
  assert.strictEqual(distant.draws.length, 1)
  assert.deepStrictEqual(distant.draws[0].texture,
    { level: 0, matrix: 0, row: 0, column: 1 })
  assert.strictEqual(distant.draws[0].imageryCellScale, 0.25)
  assert.strictEqual(distant.quality.coarsenedDrawCount, 1)
  assert.strictEqual(distant.quality.measuredMaxPixelError, 1)
  assert.strictEqual(distant.quality.meetsTarget, true)
  assert.strictEqual(distant.coverageDraws.length, 0)
  assert.strictEqual(distant.draws[0].imageryClipCell, false)
  assert.strictEqual(distant.quality.coverageGuaranteed, true)

  const gl = new FakeGl()
  const canvas = new FakeCanvas(gl)
  const contextEvents = []
  const diagnostics = []
  const renderRequests = []
  const renderer = new rendererModule.TerraWebGlRenderer(canvas, {
    directTextureTargets: false,
      urlForTile: (tile) =>
      `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
    onContextChange: (event) => contextEvents.push(event),
    onDiagnostic: (kind, detail) => diagnostics.push({ kind, detail }),
    requestRender: () => renderRequests.push('requested'),
    uploadBudgetMs: 20,
    maximumTextureRetries: 0,
    textureRetryDelayMs: 0,
    prefetchTextureAncestors: false
  })
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ])
  const textureUv = new Float32Array([
    0, 0,
    1, 0,
    0, 1
  ])
  const indices = new Uint16Array([0,2,1])

  const directGl = new FakeGl(), directCanvas = new FakeCanvas(directGl)
  const directRenderer = new rendererModule.TerraWebGlRenderer(directCanvas, {
    urlForTile: tile => `https://tiles.example/${tile.level}/${tile.column}/${tile.row}.jpg`,
    maximumTextureRequests: 8, maximumTextureRetries: 0, terrainBoundImagery: false,
    textureDescriptor: { tile_size: 256, maximum_level: 12 }
  })
  directRenderer.textures.sync([{ texture: { level: 6, matrix: 6, row: 10, column: 20 } }])
  await loadAllImages(directCanvas)
  assert.strictEqual(directCanvas.images.length, 2,
    'Direct scheduling must request only root and terminal target, not six intermediate levels')
  assert.strictEqual(directRenderer.stats().textures.targetMissing, 0)
  const siblingTiles = [0,1,2,3].map(index => ({level: 6, matrix: 6,
    row: 12 + Math.floor(index / 2), column: 24 + index % 2}))
  directRenderer.textures.sync(siblingTiles.map(texture => ({texture})))
  await settle()
  const siblingImages = directCanvas.images.slice(2)
  assert.strictEqual(siblingImages.length, 4,
    'A skipped-level sibling group downloaded intermediate images')
  for(const image of siblingImages.slice(0,3)) image.onload()
  await settle()
  assert(siblingTiles.every(tile => directRenderer.textures.presentationTileFor(tile).level === 0),
    'Partially uploaded siblings exposed inconsistent imagery detail')
  siblingImages[3].onload()
  await settle()
  assert(siblingTiles.every(tile => directRenderer.textures.presentationTileFor(tile).level === 6),
    'A complete sibling group waited for unnecessary intermediate images')
  const directStart = directCanvas.images.length
  const directTargets = Array.from({ length: 40 }, (_, column) => ({
    texture: { level: 6, matrix: 6, row: 10, column } }))
  directRenderer.textures.sync(directTargets)
  await loadAllImages(directCanvas, directStart)
  assert.strictEqual(directRenderer.stats().textures.targetMissing, 0,
    'Targets sharing a root must progress when their count exceeds the transition reserve')
  const directLoaded = directCanvas.images.length

  const visibleDraw = Object.assign(draw(0), { origin: [0, 0, 0],
    texture: { level: 0, matrix: 0, row: 0, column: 0 } })
  const rootDraw = Object.assign({}, visibleDraw, { flags: 1,
    key: { level: 0, i: 9, j: 9, k: 9 } })
  publishFrame(directRenderer, frame(), [visibleDraw, rootDraw], positions, textureUv, indices)
  directRenderer.render()
  await loadAllImages(directCanvas, directLoaded)
  directRenderer.render()
  const preview = frame()
  preview.projectionView[3] = 0.25
  directRenderer.setCameraFrame(preview)
  directRenderer.render()
  assert.strictEqual(directRenderer.stats().quality.quiescent, false,
    'A dirty camera cannot be reported as converged')
  assert(directGl.calls.some(call => call.name === 'stencilFunc' && call.args[0] === directGl.EQUAL && call.args[1] === 0),
    'Camera preview coverage must be restricted to pixels not drawn by retained geometry')
  directRenderer.destroy()
  await settle()

  const prefetchGl = new FakeGl()
  const prefetchCanvas = new FakeCanvas(prefetchGl)
  const pressureGl = new FakeGl()
  const pressureCanvas = new FakeCanvas(pressureGl)
  const pressureRenderer = new rendererModule.TerraWebGlRenderer(
    pressureCanvas, {
      directTextureTargets: false,
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureEntries: 4,
      textureCacheBytes: 4 * 256 * 256 * 4,
      maximumTextureRequests: 1,
      maximumTextureRetries: 0
    })
  const pressureDraws = [
    { texture: { level: 3, matrix: 4, row: 4, column: 8 } },
    { texture: { level: 3, matrix: 4, row: 6, column: 12 } }
  ]
  pressureRenderer.textures.sync(pressureDraws)
  const pressureStats = pressureRenderer.stats().textures
  assert.strictEqual(pressureStats.capacity, 3)
  assert.strictEqual(pressureStats.targetDesired, 2)
  assert.strictEqual(pressureStats.supportDesired, 5)
  assert.strictEqual(pressureStats.desired, 7)
  assert.strictEqual(pressureStats.rootDesired, 1)
  assert.strictEqual(pressureStats.coverageReady, false)
  assert.strictEqual(pressureStats.state, 'bootstrapping')
  assert.strictEqual(pressureStats.frontierTiles, 1)
  assert.strictEqual(pressureStats.limitedByCapacity, true)
  pressureRenderer.textures.sync([{
    texture: { level: 3, matrix: 4, row: 4, column: 8 },
    imageryCoverageDraw: true
  }])
  const coverageSupportStats = pressureRenderer.stats().textures
  assert.strictEqual(coverageSupportStats.targetDesired, 0)
  assert.strictEqual(coverageSupportStats.supportDesired, 4)
  pressureRenderer.destroy()
  await settle()

  const coverageGl = new FakeGl()
  const coverageCanvas = new FakeCanvas(coverageGl)
  const coverageRenderer = new rendererModule.TerraWebGlRenderer(
    coverageCanvas, {
      directTextureTargets: false,
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      textureDescriptor: {
        kind: 'global-geodetic',
        matrix_level_offset: 1,
        maximum_level: 17,
        level_zero_columns: 2,
        level_zero_rows: 1,
        tile_size: 256
      },
      maximumTextureRequests: 1,
      maximumTextureRetries: 0
    })
  const coverageDraw = draw(13)
  coverageDraw.texture = { level: 3, matrix: 4, row: 5, column: 13 }
  publishFrame(coverageRenderer, frame(), [coverageDraw], positions, textureUv,
    indices)
  assert.strictEqual(coverageCanvas.images[0].src,
    'https://tiles.example/1/0/0.jpg')
  assert.strictEqual(coverageRenderer.stats().textures.coverageDesired, 2)
  assert.strictEqual(coverageRenderer.stats().textures.rootDesired, 2)
  assert.strictEqual(coverageRenderer.stats().textures.cachedCoverage, 0)
  assert.strictEqual(coverageRenderer.stats().textures.coverageReady, false)
  assert.strictEqual(coverageCanvas.images.length, 1)
  coverageCanvas.images[0].onload()
  await settle()
  assert.strictEqual(coverageCanvas.images.length, 2)
  assert.strictEqual(coverageCanvas.images[1].src,
    'https://tiles.example/1/1/0.jpg')
  assert.strictEqual(coverageRenderer.stats().textures.coverageReady, false)
  coverageCanvas.images[1].onload()
  await settle()
  assert.strictEqual(coverageRenderer.stats().textures.coverageReady, true)
  assert.strictEqual(coverageRenderer.stats().textures.cachedRoots, 2)
  assert.strictEqual(coverageRenderer.stats().textures.coarseCoverageReady, true)
  assert.strictEqual(coverageCanvas.images.length, 2,
    'Global fallback eagerly downloaded an unneeded refinement level')
  coverageRenderer.textures.sync([{texture: coverageDraw.texture}])
  assert.strictEqual(coverageCanvas.images[2].src,
    'https://tiles.example/2/3/1.jpg')
  coverageRenderer.destroy()

  const capacityGl = new FakeGl()
  const capacityCanvas = new FakeCanvas(capacityGl)
  capacityCanvas.width = 1024
  capacityCanvas.height = 1024
  const capacityRenderer = new rendererModule.TerraWebGlRenderer(
    capacityCanvas, {
      directTextureTargets: false,
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      textureDescriptor: {
        kind: 'global-geodetic',
        matrix_level_offset: 1,
        maximum_level: 17,
        level_zero_columns: 2,
        level_zero_rows: 1,
        tile_size: 256
      },
      maximumTextureEntries: 16,
      textureCacheBytes: 16 * 349524,
      maximumTextureRequests: 16,
      maximumTextureRetries: 0
    })
  publishFrame(capacityRenderer, frame(), [qualityDraw], qualityPositions,
    qualityUv, indices)
  capacityRenderer.render()
  const capacityStats = capacityRenderer.stats()
  assert.strictEqual(capacityStats.textures.capacity, 16)
  assert.strictEqual(capacityStats.textures.targetCapacity, 10)
  assert(capacityStats.textures.targetDesired <=
    capacityStats.textures.targetCapacity)
  assert.strictEqual(capacityStats.textures.limitedByCapacity, false)
  assert.strictEqual(capacityStats.quality.terrainBound, true)
  assert.strictEqual(capacityStats.quality.limitedByTextureBudget, false)
  assert.strictEqual(capacityStats.quality.limitedByLevel, true)
  await loadAllImages(capacityCanvas)
  capacityRenderer.render()
  const loadedCapacityStats = capacityRenderer.stats()
  assert.strictEqual(loadedCapacityStats.textures.targetMissing, 0)
  assert(loadedCapacityStats.textures.entries <=
    loadedCapacityStats.textures.capacity)
  assert.strictEqual(loadedCapacityStats.quality.targetCoverage, 1)
  assert.strictEqual(loadedCapacityStats.quality.ready, false)
  assert.strictEqual(loadedCapacityStats.quality.settled, false)
  assert.strictEqual(loadedCapacityStats.quality.quiescent, true)
  assert.strictEqual(loadedCapacityStats.quality.targetMet, false)
  assert.strictEqual(loadedCapacityStats.quality.state, 'limited')
  assert.strictEqual(loadedCapacityStats.quality.limitedByTextureBudget, false)
  assert.strictEqual(loadedCapacityStats.quality.limitedByLevel, true)
  capacityRenderer.destroy()
  await settle()

  const presentationGl = new FakeGl()
  const presentationCanvas = new FakeCanvas(presentationGl)
  presentationCanvas.width = 1024
  presentationCanvas.height = 1024
  const presentationRenderer = new rendererModule.TerraWebGlRenderer(
    presentationCanvas, {
      directTextureTargets: false,
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      textureDescriptor: {
        kind: 'global-geodetic',
        matrix_level_offset: 1,
        maximum_level: 8,
        level_zero_columns: 2,
        level_zero_rows: 1,
        tile_size: 256
      },
      terrainBoundImagery: false,
      maximumTextureEntries: 64,
      textureCacheBytes: 64 * 349524,
      maximumTextureRequests: 64,
      maximumTextureRetries: 0,
      prefetchTextureAncestors: false
    })
  const presentationDraw = Object.assign({}, qualityDraw, { indexCount: 4 })
  const presentationIndices = new Uint16Array([0,2,1,3])
  publishFrame(presentationRenderer, frame(), [presentationDraw], qualityPositions,
    qualityUv, presentationIndices)
  const loadingPresentation = presentationRenderer.render()
  assert(loadingPresentation.submitted > 0)
  assert(presentationRenderer.stats().quality.coverageSubmitted>0,
    'An unprepared world footprint was reported as a completed target display')
  assert(presentationRenderer.stats().quality.missingCount > 0)
  assert.strictEqual(presentationRenderer.stats().quality.ready, false)
  await loadAllImages(presentationCanvas)
  await waitUntil('Presentation partitions did not reach the GPU', () => {
    presentationRenderer.render()
    return presentationRenderer.stats().quality.ready
  })
  const settledPresentation = presentationRenderer.stats()
  assert.strictEqual(settledPresentation.textures.targetMissing, 0)
  assert.strictEqual(settledPresentation.quality.coverageSubmitted, 0)
  assert.strictEqual(settledPresentation.quality.ready, true, JSON.stringify({
    quality: settledPresentation.quality, textures: settledPresentation.textures,
    queuedPartitions: presentationRenderer.partitionQueue.length,
    stagedPartitions: presentationRenderer.partitionUploads.length,
    activePartition: !!presentationRenderer.partitionActive
  }))
  assert.strictEqual(settledPresentation.quality.settled, true)
  const refinable = presentationRenderer.qualityStats.refinableMeasurementCount
  presentationRenderer.qualityStats.refinableMeasurementCount = 1
  const measuring = presentationRenderer.stats().quality
  assert(measuring.targetMet && measuring.measurementPending)
  assert(!measuring.ready && !measuring.settled && !measuring.resourceStable,
    'Passing coarse measurements were reported as normalized stationary demand')
  presentationRenderer.qualityStats.refinableMeasurementCount = refinable
  publishFrame(presentationRenderer, Object.assign(frame(), { decisionsComplete: false, requestCount: 1 }),
    [presentationDraw], qualityPositions, qualityUv, presentationIndices)
  presentationRenderer.render()
  assert.strictEqual(presentationRenderer.stats().quality.ready, false)
  assert.strictEqual(presentationRenderer.stats().quality.state, 'refining')
  publishFrame(presentationRenderer, frame(), [presentationDraw], qualityPositions, qualityUv, presentationIndices)
  presentationRenderer.render()
  const uploaded = settledPresentation.performance.textureUploads
  const partitions = settledPresentation.performance.partitionBuilds
  const requests = presentationCanvas.images.length
  const rotatedFrame = frame()
  const c = Math.SQRT1_2
  rotatedFrame.projectionView = new Float64Array([
    c,-c,0,0,c,c,0,0,0,0,1,0,0,0,0,1])
  presentationRenderer.setInteractionActive(true)
  presentationRenderer.setCameraFrame(rotatedFrame)
  presentationRenderer.render()
  assert.strictEqual(presentationRenderer.stats().quality.state, 'interacting')
  assert.strictEqual(presentationRenderer.stats().quality.ready, false)
  assert.strictEqual(presentationRenderer.stats().performance.textureUploads, uploaded)
  assert.strictEqual(presentationRenderer.stats().performance.partitionBuilds, partitions)
  presentationRenderer.setInteractionActive(false)
  assert.notStrictEqual(presentationRenderer.stats().quality.state, 'ready')
  publishFrame(presentationRenderer, rotatedFrame, [presentationDraw], qualityPositions, qualityUv, presentationIndices)
  presentationRenderer.render()
  assert.strictEqual(presentationRenderer.stats().quality.ready, true,JSON.stringify({
    quality:presentationRenderer.stats().quality,handoff:presentationRenderer.handoff.snapshot(),
    world:presentationRenderer.worldDisplay.snapshot(),compatible:presentationRenderer.worldDisplay.compatible(presentationRenderer.renderDraws)}))
  assert.strictEqual(presentationCanvas.images.length, requests)
  assert.strictEqual(presentationRenderer.stats().performance.textureUploads, uploaded)
  assert.strictEqual(presentationRenderer.stats().performance.partitionBuilds, partitions)
  // A new, uncached coarser target must not erase the already presented detail.
  const oldLevel = presentationRenderer.stats().quality.resolvedLevelMinimum
  presentationRenderer.options.imageryPixelError = 3
  publishFrame(presentationRenderer, rotatedFrame, [presentationDraw], qualityPositions, qualityUv, presentationIndices)
  presentationRenderer.render()
  assert.strictEqual(presentationRenderer.stats().quality.resolvedLevelMinimum, oldLevel)
  assert.strictEqual(presentationRenderer.stats().performance.textureUploads, uploaded)
  assert.strictEqual(presentationRenderer.stats().performance.partitionBuilds, partitions)
  await loadAllImages(presentationCanvas, requests)
  presentationRenderer.render()
  assert.strictEqual(presentationRenderer.stats().quality.ready, true)
  {
  // The coarse parent is now resident. A capacity-derived coarse plan still
  // cannot erase valid fine leaves whose measured error exceeds the goal.
  const detailedImageStart = presentationCanvas.images.length
  presentationRenderer.options.imageryPixelError = 1.25
  publishFrame(presentationRenderer, rotatedFrame, [presentationDraw], qualityPositions, qualityUv, presentationIndices)
  await loadAllImages(presentationCanvas, detailedImageStart)
  await waitUntil('Fine detail was not restored', () => {
    presentationRenderer.render()
    return presentationRenderer.stats().quality.ready
  })
  const detailed = presentationRenderer.renderDraws.slice()
  const tileModule = require('../../sdk/js/imagery/terra_texture_tiles')
  const coarse = new Map()
  detailed.forEach(item => {
    const tile = tileModule.parentTextureTile(item.texture), key = require('../../sdk/js/core/terra_globe_common').textureKeyString(tile)
    const t = tileModule.textureCellTransform(item.sourceTexture, tile)
    assert(presentationRenderer.textures.cache.has(key), 'Cached-parent regression requires resident parent imagery')
    coarse.set(key, Object.assign({}, item, { texture: tile, imageryCellScale: t.scale,
      imageryCellOffsetX: t.offsetX, imageryCellOffsetY: t.offsetY,
      imageryClipCell: tile.level > item.sourceTexture.level, imageryPixelError: item.imageryPixelError*2 }))
  })
  const constrained = { draws: Array.from(coarse.values()), levels: new Set(),
    quality: Object.assign({}, presentationRenderer.pendingQualityStats, { limitedByBudget: true }) }
  presentationRenderer.current.imageryPlan = constrained
  presentationRenderer.rebuildImageryDraws()
  presentationRenderer.render()
  assert.strictEqual(presentationRenderer.stats().quality.resolvedLevelMinimum, oldLevel,
    'A resident coarse parent erased still-required, GPU-resident fine detail')
  const oldSurface = presentationRenderer.displaySurface
  const replacement = Object.assign({}, presentationDraw, { key: Object.assign({}, presentationDraw.key, { k: 999 }) })
  publishFrame(presentationRenderer, rotatedFrame, [replacement], qualityPositions, qualityUv, presentationIndices)
  presentationRenderer.current.imageryPlan = { draws: constrained.draws.map(item =>
    Object.assign({}, item, {geometryKey:replacement.geometryKey, resourceId:replacement.resourceId,
      textureResourceId:replacement.textureResourceId, key:replacement.key})),
  levels: new Set(), quality: constrained.quality }
  presentationRenderer.rebuildImageryDraws()
  presentationRenderer.processUploads(Infinity)
  assert.strictEqual(presentationRenderer.promoteCurrentSurfaceIfReady(), false,
    'New terrain was promoted before its fine imagery partitions were prepared')
  assert.strictEqual(presentationRenderer.displaySurface, oldSurface)
  await waitUntil('Compatible fine partitions did not unblock new terrain', () => {
    presentationRenderer.render()
    return presentationRenderer.displaySurface.current === presentationRenderer.current
  })
  assert.strictEqual(presentationRenderer.stats().quality.resolvedLevelMinimum, oldLevel)
  const displayedTiles = Array.from(presentationRenderer.presentedTextures.keys()).sort()
  const imageCountBeforeRestore = presentationCanvas.images.length
  presentationCanvas.emit('webglcontextlost', { preventDefault() {} })
  presentationCanvas.emit('webglcontextrestored')
  assert.deepStrictEqual(Array.from(presentationRenderer.presentedTextures.keys()).sort(), displayedTiles,
    'Context recovery discarded the content ledger of the displayed fine cut')
  const advanceWorld = presentationRenderer.worldDisplay.advance
  presentationRenderer.worldDisplay.advance = () => {}
  try {
    await waitUntil('Context recovery did not upload the owned images and geometry', () => {
      presentationRenderer.render()
      return displayedTiles.every(id => presentationRenderer.textures.gpuReady(id)) &&
        presentationRenderer.queuedGeometryCount === 0
    })
    assert(presentationRenderer.restoringPresentation,
      'GPU image readiness retired fine presentation before its world footprint was prepared')
    assert(displayedTiles.every(id => presentationRenderer.presentedTextures.has(id)),
      'Coverage rendering discarded the pending restoration footprint')
  } finally { presentationRenderer.worldDisplay.advance = advanceWorld }
  await waitUntil('Context recovery did not restore fine presentation', () => {
    presentationRenderer.render()
    return !presentationRenderer.restoringPresentation &&
      presentationRenderer.stats().textures.fallbackRatio === 0
  })
  assert.strictEqual(presentationRenderer.stats().quality.resolvedLevelMinimum, oldLevel)
  assert.deepStrictEqual(Array.from(presentationRenderer.presentedTextures.keys()).sort(), displayedTiles)
  assert.strictEqual(presentationCanvas.images.length, imageCountBeforeRestore,
    'Restoring pinned imagery unnecessarily fetched its content again')
  presentationRenderer.current.updateState = { limitedByCapacity: true }
  assert.strictEqual(presentationRenderer.stats().quality.geometryTargetComplete, false)
  assert.strictEqual(presentationRenderer.stats().quality.resourceStable, true,
    'A stable capacity-limited cut must not be reported as endless work')
  assert.strictEqual(presentationRenderer.stats().quality.ready, false)
  const savedVisibility = presentationRenderer.visibility
  presentationRenderer.visibility = {proofs:{pending:new Map([['proof',{}]])}}
  assert.strictEqual(presentationRenderer.stats().quality.visibilityProofsPending, 1)
  assert.strictEqual(presentationRenderer.stats().quality.resourceStable, false,
    'Unfinished visibility work was reported as an idle resource set')
  assert.strictEqual(presentationRenderer.stats().quality.quiescent, false)
  presentationRenderer.visibility = savedVisibility
  }
  presentationRenderer.destroy()
  assert.strictEqual(presentationRenderer.partitionBytes, 0)
  await settle()

  const prefetchRenderer = new rendererModule.TerraWebGlRenderer(
    prefetchCanvas, {
      directTextureTargets: false,
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureRequests: 3,
      maximumTextureRetries: 0
    })
  const prefetchDraw = draw(11)
  prefetchDraw.texture = { level: 3, matrix: 4, row: 5, column: 11 }
  prefetchRenderer.textures.sync([{ texture: prefetchDraw.texture }])
  assert.deepStrictEqual(prefetchCanvas.images.map((image) => image.src), [
    'https://tiles.example/1/1/0.jpg'
  ])
  let prefetchStats = prefetchRenderer.stats().textures
  assert.strictEqual(prefetchStats.desired, 4)
  assert.strictEqual(prefetchStats.targetDesired, 1)
  assert.strictEqual(prefetchStats.targetMissing, 1)
  assert.strictEqual(prefetchStats.supportDesired, 3)
  assert.strictEqual(prefetchStats.rootDesired, 1)
  assert.strictEqual(prefetchStats.active, 1)
  assert.strictEqual(prefetchStats.queued, 0)
  assert.strictEqual(prefetchStats.state, 'bootstrapping')
  prefetchCanvas.images[0].onload()
  await waitForImageCount(prefetchCanvas, 2)
  assert.strictEqual(prefetchCanvas.images[1].src,
    'https://tiles.example/2/2/1.jpg')
  prefetchCanvas.images[1].onload()
  await waitForImageCount(prefetchCanvas, 3)
  assert.strictEqual(prefetchCanvas.images[2].src,
    'https://tiles.example/3/5/2.jpg')
  prefetchCanvas.images[2].onload()
  await waitForImageCount(prefetchCanvas, 4)
  assert.strictEqual(prefetchCanvas.images[3].src,
    'https://tiles.example/4/11/5.jpg')
  prefetchCanvas.images[3].onload()
  await waitUntil('Leaf texture did not commit', () =>
    prefetchRenderer.stats().textures.state === 'settled')
  prefetchStats = prefetchRenderer.stats().textures
  assert.strictEqual(prefetchStats.cachedTarget, 1)
  assert.strictEqual(prefetchStats.targetMissing, 0)
  assert.strictEqual(prefetchStats.state, 'settled')
  prefetchRenderer.destroy()
  await settle()

  const atomicGl = new FakeGl()
  const atomicCanvas = new FakeCanvas(atomicGl)
  const atomicRenderer = new rendererModule.TerraWebGlRenderer(atomicCanvas, {
    directTextureTargets: false,
      urlForTile: (tile) =>
      `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
    maximumTextureRequests: 4,
    maximumTextureRetries: 0
  })
  const atomicDraws = [
    { texture: { level: 2, matrix: 3, row: 0, column: 0 } },
    { texture: { level: 2, matrix: 3, row: 0, column: 1 } }
  ]
  atomicRenderer.textures.sync(atomicDraws)
  assert.strictEqual(atomicCanvas.images.length, 1)
  atomicCanvas.images[0].onload()
  await waitForImageCount(atomicCanvas, 2)
  assert.strictEqual(atomicCanvas.images.length, 2)
  atomicCanvas.images[1].onload()
  await waitForImageCount(atomicCanvas, 4)
  assert.strictEqual(atomicCanvas.images.length, 4)
  atomicCanvas.images[2].onload()
  await settle()
  await settle()
  let atomicStats = atomicRenderer.stats().textures
  assert.strictEqual(atomicStats.residentTarget, 1)
  assert.strictEqual(atomicStats.cachedTarget, 0,
    'One decoded sibling must not replace the parent before the visible group is ready')
  assert.strictEqual(atomicStats.stagedTiles, 1)
  assert.strictEqual(atomicStats.state, 'refining')
  atomicCanvas.images[3].onload()
  await Promise.resolve()
  await Promise.resolve()
  assert.strictEqual(atomicRenderer.stats().textures.residentTarget, 2)
  assert.strictEqual(atomicRenderer.stats().textures.cachedTarget, 0,
    'Decoded images must not commit before the last sibling reaches the GPU')
  await waitUntil('Sibling group did not finish refining', () =>
    atomicRenderer.stats().textures.state === 'settled')
  atomicStats = atomicRenderer.stats().textures
  assert.strictEqual(atomicStats.cachedTarget, 2)
  assert.strictEqual(atomicStats.stagedTiles, 0)
  assert.strictEqual(atomicStats.state, 'settled')
  atomicRenderer.textures.sync([{
    texture: { level: 1, matrix: 2, row: 0, column: 0 }
  }])
  atomicStats = atomicRenderer.stats().textures
  assert.strictEqual(atomicStats.targetDesired, 1)
  assert.strictEqual(atomicStats.cachedTarget, 1)
  assert.strictEqual(atomicStats.presentationTiles, 1)
  assert.strictEqual(atomicRenderer.textures.availableKeys.has('2/3/0/0'),
    false)
  assert.strictEqual(atomicRenderer.textures.availableKeys.has('2/3/0/1'),
    false)
  atomicRenderer.destroy()
  await settle()

  const stagedGl = new FakeGl()
  const stagedCanvas = new FakeCanvas(stagedGl)
  const stagedRenderer = new rendererModule.TerraWebGlRenderer(
    stagedCanvas, {
      directTextureTargets: false,
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureEntries: 128,
      textureCacheBytes: 128 * 349524,
      maximumTextureRequests: 1,
      maximumTextureRetries: 0
    })
  const stagedDraws = []
  for (let index = 0; index < 17; ++index) {
    const parent = {
      level: 3,
      matrix: 4,
      row: Math.floor(index / 16),
      column: index % 16
    }
    const resident = {
      level: 4,
      matrix: 5,
      row: parent.row * 2,
      column: parent.column * 2
    }
    const missing = Object.assign({}, resident, {
      column: resident.column + 1
    })
    textureTiles.ancestorTextureTiles(resident).reverse()
      .concat([resident]).forEach((tile) => {
        const key = `${tile.level}/${tile.matrix}/${tile.row}/${tile.column}`
        if (!stagedRenderer.textures.cache.has(key)) {
          stagedRenderer.textures.cache.set(key, {
            image: null,
            texture: {},
            width: 1,
            height: 1,
            url: key
          }, 4)
        }
        stagedRenderer.textures.availableKeys.add(key)
      })
    stagedDraws.push({ texture: resident }, { texture: missing })
  }
  stagedRenderer.textures.sync(stagedDraws)
  const stagedStats = stagedRenderer.stats().textures
  assert.strictEqual(stagedStats.transitionCapacity, 4)
  assert.strictEqual(stagedStats.transitionGroups, 2)
  assert.strictEqual(stagedStats.transitionReserved, 4)
  assert.strictEqual(stagedStats.stagedTiles, 0,
    'Previously available siblings must remain usable while their missing neighbours load')
  assert.strictEqual(stagedStats.frontierTiles, 17)
  assert.strictEqual(stagedStats.blockedGroupCount, 15)
  assert.strictEqual(stagedStats.blockedTileCount, 15)
  assert.strictEqual(stagedStats.blockedByCapacity, true)
  assert.strictEqual(stagedStats.state, 'refining')
  assert.strictEqual(stagedStats.active, 1)
  assert.strictEqual(stagedStats.queued, 1)
  stagedRenderer.destroy()
  await settle()

  const logicalParentGl = new FakeGl()
  const logicalParentCanvas = new FakeCanvas(logicalParentGl)
  const logicalParentRenderer = new rendererModule.TerraWebGlRenderer(
    logicalParentCanvas, {
      directTextureTargets: false,
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureRequests: 1,
      maximumTextureRetries: 0
    })
  const logicalTarget = { level: 3, matrix: 4, row: 0, column: 0 }
  const logicalPath = textureTiles.ancestorTextureTiles(logicalTarget)
    .reverse()
  logicalPath.forEach((tile, index) => {
    const key = `${tile.level}/${tile.matrix}/${tile.row}/${tile.column}`
    logicalParentRenderer.textures.availableKeys.add(key)
    if (index < 2) {
      logicalParentRenderer.textures.cache.set(key, {
        image: null,
        texture: {},
        width: 1,
        height: 1,
        url: key
      }, 4)
    }
  })
  logicalParentRenderer.textures.sync([{ texture: logicalTarget }])
  const logicalParentStats = logicalParentRenderer.stats().textures
  assert.strictEqual(logicalParentStats.frontierTiles, 1)
  assert.strictEqual(logicalParentStats.active, 1)
  assert.strictEqual(logicalParentCanvas.images[0].src,
    'https://tiles.example/4/0/0.jpg')
  logicalParentRenderer.destroy()
  await settle()

  const failureGl = new FakeGl()
  const failureCanvas = new FakeCanvas(failureGl)
  const failureRenderer = new rendererModule.TerraWebGlRenderer(
    failureCanvas, {
      directTextureTargets: false,
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureRequests: 4,
      maximumTextureRetries: 0
    })
  failureRenderer.textures.sync(atomicDraws)
  failureCanvas.images[0].onload()
  await waitForImageCount(failureCanvas, 2)
  failureCanvas.images[1].onload()
  await waitForImageCount(failureCanvas, 4)
  failureCanvas.images[2].onload()
  failureCanvas.images[3].onerror(new Error('upstream failed'))
  await waitUntil('Failed sibling blocked its available neighbour', () => {
    const stats = failureRenderer.stats().textures
    return stats.state === 'degraded' && stats.cachedTarget === 1
  })
  let failureStats = failureRenderer.stats().textures
  assert.strictEqual(failureStats.state, 'degraded')
  assert.strictEqual(failureStats.blockedByFailure, true)
  assert.strictEqual(failureStats.cachedTarget, 1)
  failureRenderer.textures.beginFrame()
  atomicDraws.forEach((item) =>
    failureRenderer.textures.get(item.texture))
  failureStats = failureRenderer.stats().textures
  assert.strictEqual(failureStats.fallbackRatio, 0.5)
  assert.strictEqual(failureStats.missingRatio, 0)
  assert.strictEqual(failureRenderer.retryTextures(), true)
  await waitForImageCount(failureCanvas, 5)
  assert.strictEqual(failureCanvas.images.length, 5)
  failureCanvas.images[4].onload()
  await waitUntil('Retried sibling group did not commit', () =>
    failureRenderer.stats().textures.state === 'settled')
  failureStats = failureRenderer.stats().textures
  assert.strictEqual(failureStats.cachedTarget, 2)
  assert.strictEqual(failureStats.state, 'settled')
  failureRenderer.destroy()
  await settle()
  const transitionGl = new FakeGl()
  const transitionCanvas = new FakeCanvas(transitionGl)
  const transitionRenderer = new rendererModule.TerraWebGlRenderer(
    transitionCanvas, {
      directTextureTargets: false,
      urlForTile: (tile) =>
        `https://tiles.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`,
      maximumTextureRequests: 1,
      maximumTextureRetries: 0,
      prefetchTextureAncestors: false,
      maximumGeometryEntries: 1,
      uploadBudgetMs: 20
    })
  const firstTransitionDraw = draw(20)
  publishFrame(transitionRenderer, frame(), [firstTransitionDraw], positions,
    textureUv, indices)
  transitionRenderer.render()
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, false)
  const drawCallsBeforeEmptyFrame = transitionGl.calls.filter((call) =>
    call.name === 'drawElements').length
  publishFrame(transitionRenderer, frame(), [], new Float32Array(0),
    new Float32Array(0), indices)
  const emptyFrameStats = transitionRenderer.render()
  assert.strictEqual(emptyFrameStats.submitted, 1)
  assert.strictEqual(transitionGl.calls.filter((call) =>
    call.name === 'drawElements').length, drawCallsBeforeEmptyFrame + 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, true)
  const originalProcessUploads = transitionRenderer.processUploads.bind(
    transitionRenderer)
  transitionRenderer.processUploads = () => {}
  const secondTransitionDraw = Object.assign(draw(21), {
    key: { level: 0, i: 1, j: 2, k: 4 }
  })
  const secondTransitionPositions = new Float32Array([
    0, 0, 0,
    2, 0, 0,
    0, 2, 0
  ])
  publishFrame(transitionRenderer, frame(), [secondTransitionDraw],
    secondTransitionPositions, textureUv, indices)
  const drawCallsBeforePendingRender = transitionGl.calls.filter((call) =>
    call.name === 'drawElements').length
  const pendingStats = transitionRenderer.render()
  assert.strictEqual(pendingStats.submitted, 1)
  assert.strictEqual(transitionGl.calls.filter((call) =>
    call.name === 'drawElements').length, drawCallsBeforePendingRender + 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, true)
  assert.strictEqual(transitionRenderer.stats().transition.pendingGeometry, 1)
  transitionRenderer.uploadQueue = []
  transitionRenderer.processUploads = originalProcessUploads
  transitionRenderer.ensureCurrentGeometryQueued()
  assert.strictEqual(transitionRenderer.stats().transition.queuedGeometry, 1)
  transitionRenderer.requestResources()
  transitionRenderer.render()
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, false)
  assert.strictEqual(transitionRenderer.stats().transition.pendingGeometry, 0)
  assert.strictEqual(transitionRenderer.stats().transition.queuedGeometry, 0)
  assert.strictEqual(transitionRenderer.stats().geometry.entries, 1)
  assert.strictEqual(transitionRenderer.stats().transition.pinnedGeometry, 1)
  const incompleteGeometryFrame = frame()
  incompleteGeometryFrame.expectedDrawCount = 2
  incompleteGeometryFrame.omittedDrawCount = 1
  publishFrame(transitionRenderer, incompleteGeometryFrame,
    [secondTransitionDraw], secondTransitionPositions, textureUv, indices)
  transitionRenderer.render()
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, true)
  assert.strictEqual(
    transitionRenderer.stats().transition.expectedGeometry, 2)
  assert.strictEqual(
    transitionRenderer.stats().transition.omittedGeometry, 1)
  assert.strictEqual(transitionRenderer.stats().quality.covered, false)

  const coveredGeometryFrame = frame()
  coveredGeometryFrame.expectedDrawCount = 2
  coveredGeometryFrame.omittedDrawCount = 1
  coveredGeometryFrame.coverageDrawCount = 1
  coveredGeometryFrame.coverageComplete = true
  const rootCoverageDraw = Object.assign({}, secondTransitionDraw, {
    flags: 1
  })
  const pendingDetailDraw = Object.assign({}, draw(22), {
    key: { level: 1, i: 4, j: 5, k: 6 },
    firstVertex: 3
  })
  const coveredPositions = new Float32Array([
    ...secondTransitionPositions,
    0, 0, 1,
    2, 0, 1,
    0, 2, 1
  ])
  const coveredUv = new Float32Array([
    ...textureUv,
    0, 0,
    1, 0,
    0, 1
  ])
  publishFrame(transitionRenderer, coveredGeometryFrame,
    [rootCoverageDraw, pendingDetailDraw], coveredPositions,
    coveredUv, indices)
  transitionRenderer.processUploads = () => {}
  transitionRenderer.render()
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, true)
  assert.strictEqual(
    transitionRenderer.stats().transition.coverageGeometry, 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.pendingCoverageGeometry, 0)
  assert.strictEqual(
    transitionRenderer.stats().transition.pendingGeometry, 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.queuedGeometry, 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.coverageComplete, true)
  assert.strictEqual(
    transitionRenderer.stats().quality.geometryCoverageReady, true)
  assert.strictEqual(
    transitionRenderer.stats().quality.geometryTargetComplete, false)
  assert.strictEqual(
    transitionRenderer.stats().quality.sourceDrawCount, 1)
  const drawCallsBeforeCoveredRender = transitionGl.calls.filter((call) =>
    call.name === 'drawElements').length
  transitionRenderer.setInteractionActive(true)
  transitionRenderer.setCameraFrame({
    cameraPosition: [1000, 2000, 3000],
    projectionView: frame().projectionView
  })
  const previousRenderStats = transitionRenderer.render()
  assert.strictEqual(previousRenderStats.submitted, 1)
  assert.strictEqual(transitionGl.calls.filter((call) =>
    call.name === 'drawElements').length, drawCallsBeforeCoveredRender + 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, true)
  transitionRenderer.processUploads = originalProcessUploads
  transitionRenderer.requestResources()
  const incompleteRenderStats = transitionRenderer.render()
  assert.strictEqual(incompleteRenderStats.submitted, 1)
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, true)
  assert.strictEqual(
    transitionRenderer.stats().transition.pendingGeometry, 0)
  const completeGeometryFrame = Object.assign({}, coveredGeometryFrame, {
    expectedDrawCount: 1,
    omittedDrawCount: 0
  })
  publishFrame(transitionRenderer, completeGeometryFrame,
    [rootCoverageDraw, pendingDetailDraw], coveredPositions,
    coveredUv, indices)
  let promotedRenderStats
  for(let turn=0;turn<3&&transitionRenderer.displaySurface.current!==transitionRenderer.current;++turn)
    promotedRenderStats=transitionRenderer.render()
  assert.strictEqual(promotedRenderStats.submitted, 1)
  assert.strictEqual(
    transitionRenderer.stats().quality.geometryCoverageSubmitted, 0)
  assert.strictEqual(
    transitionRenderer.stats().transition.displayingPreviousFrame, false)
  assert.strictEqual(transitionGl.calls.some((call) =>
    call.name === 'clear' &&
    call.args[0] === transitionGl.DEPTH_BUFFER_BIT), false)
  transitionRenderer.destroy()
  await settle()

  renderer.textures.sync([{ texture: draw(4).texture }])
  assert.strictEqual(canvas.images.length, 1)
  renderer.textures.sync([{ texture: draw(5).texture }])
  assert.deepStrictEqual(canvas.images[0].sources,
    ['https://tiles.example/2/4/3.jpg'])
  await settle()
  await settle()
  assert.strictEqual(canvas.images.length, 2)
  canvas.images[1].onload()
  await waitUntil('Parent texture did not commit', () =>
    renderer.stats().textures.state === 'settled')

  const descendant = draw(11)
  descendant.texture = { level: 3, matrix: 3, row: 7, column: 11 }
  renderer.options.imageryPixelError = 0.0001
  publishFrame(renderer, frame(), [descendant], positions, textureUv, indices)
  let interactionRebuilds = 0
  const rebuildImageryDraws = renderer.rebuildImageryDraws
  renderer.rebuildImageryDraws = () => { interactionRebuilds += 1 }
  renderer.setInteractionActive(true)
  renderer.setInteractionActive(false)
  assert.strictEqual(interactionRebuilds, 0)
  renderer.rebuildImageryDraws = rebuildImageryDraws
  await settle()
  assert.strictEqual(renderer.stats().quality.terrainBound, true)
  assert.strictEqual(canvas.images.length, 3)
  renderer.render()
  renderer.textures.availableKeys.add('2/2/3/5')
  renderer.textures.beginFrame()
  const fallbackBinding = renderer.textures.get(descendant.texture)
  assert.strictEqual(fallbackBinding.kind, 'fallback')
  assert.strictEqual(fallbackBinding.scale, 0.5)
  assert.strictEqual(fallbackBinding.offsetX, 0.5)
  assert.strictEqual(fallbackBinding.offsetY, 0.5)
  assert.strictEqual(renderer.stats().textures.fallbackRatio, 1)
  assert.strictEqual(renderer.stats().textures.missingRatio, 0)
  assert.strictEqual(renderer.stats().quality.ready, false)
  canvas.images[2].onload()
  await waitUntil('Descendant texture did not commit', () =>
    renderer.stats().textures.state === 'settled')
  await settle()
  await settle()
  renderer.render()
  assert.strictEqual(renderer.stats().textures.fallbackRatio, 0)
  assert.strictEqual(renderer.stats().quality.targetMet, true)
  assert.strictEqual(renderer.stats().quality.state, 'ready')
  assert.strictEqual(renderer.stats().quality.ready, true)
  assert.strictEqual(renderer.stats().quality.settled, true)
  assert.strictEqual(renderer.stats().quality.coverageSubmitted, 0)
  renderer.setOverlays({
    points: [{ id: 'beijing', world: [1, 2, 3], priority: 1 }],
    route: {
      worlds: [[0, 0, 0], [1, 1, 1]],
      color: '#2f7de1',
      opacity: 0.75,
      widthPixels: 3
    }
  })
  renderer.render()
  assert.strictEqual(renderer.stats().overlays.points, 1)
  assert.strictEqual(renderer.stats().overlays.routeVertices, 2)
  assert(gl.calls.some((call) => call.name === 'drawArrays' &&
    call.args[0] === gl.POINTS))
  assert(gl.calls.some((call) => call.name === 'drawArrays' &&
    call.args[0] === gl.LINE_STRIP))
  assert(gl.calls.some((call) => call.name === 'blendFunc' &&
    call.args[0] === gl.SRC_ALPHA &&
    call.args[1] === gl.ONE_MINUS_SRC_ALPHA))

  const stats = renderer.render()
  assert.deepStrictEqual(stats, { submitted: 3, queued: 0 })
  assert(gl.calls.filter((call) => call.name === 'drawElements').length >= 3)
  assert(gl.calls.some((call) => call.name === 'pixelStorei' &&
    call.args[1] === false))
  assert(gl.calls.some((call) => call.name === 'generateMipmap'))
  assert(renderRequests.length > 0)
  renderer.setMode('height')
  renderer.render()
  assert.strictEqual(renderer.stats().mode, 'height')
  assert(gl.calls.some((call) => call.name === 'uniform1f' &&
    call.args[1] === 1))
  assert(gl.calls.some((call) => call.name === 'uniform1f' &&
    call.args[0].name === 'u_height_origin' && call.args[1] === 300))

  renderer.textures.sync([{ texture: draw(6).texture }])
  await settle()
  assert.strictEqual(canvas.images.length, 4)
  canvas.images[3].onerror(new Error('https://tiles.example/?tk=secret-token'))
  await settle()
  assert.strictEqual(renderer.stats().textures.failed, 1)
  assert.strictEqual(diagnostics[diagnostics.length - 1].kind,
    'texture_load_failed')
  assert.strictEqual(diagnostics[diagnostics.length - 1].detail.message,
    'Texture image failed')
  assert.strictEqual(renderer.retryTextures(), true)
  await settle()
  await settle()
  assert.strictEqual(canvas.images.length, 5)
  canvas.images[4].onload()
  await settle()
  assert.strictEqual(renderer.stats().textures.failed, 0)

  const sourceSwitchDraw = draw(7)
  renderer.textures.sync([{ texture: sourceSwitchDraw.texture }])
  await settle()
  assert.strictEqual(canvas.images.length, 6)
  canvas.images[5].onload()
  renderer.textures.clear()
  renderer.textures.sync([{ texture: sourceSwitchDraw.texture }])
  await waitUntil('Cancelled source reservation did not unblock replacement', () => canvas.images.length === 7)
  assert.strictEqual(canvas.images.length, 7)
  assert.strictEqual(renderer.textures.cache.has('2/2/3/7'), false)
  canvas.images[6].onload()
  await settle()
  assert.strictEqual(renderer.textures.cache.has('2/2/3/7'), true)

  renderer.textures.prefetchAncestors = true
  const sourceGeneration = renderer.textures.generation
  let invalidSourceTiles = 0
  renderer.current.draws.forEach(draw => { draw.textureNode = {level: draw.texture.level - 1,
    root: Math.floor(draw.texture.row / 2**(draw.texture.level-1))*4 +
      Math.floor(draw.texture.column / 2**(draw.texture.level-1)), row: draw.texture.row, column: draw.texture.column} })
  renderer.setImagerySource({
    kind: 'global-geodetic',
    matrix_level_offset: 1,
    maximum_level: 17, minimum_level: 0, bounds: [[-180,-90],[180,90]],
    level_zero_columns: 2,
    level_zero_rows: 1,
    tile_size: 256
  }, (tile) => {
    if (tile.matrix !== tile.level + 1) {
      invalidSourceTiles += 1
      throw new Error('New imagery source received an invalid matrix')
    }
    return `https://new.example/${tile.matrix}/${tile.column}/${tile.row}.jpg`
  })
  assert.strictEqual(renderer.textures.generation, sourceGeneration + 1)
  assert.strictEqual(renderer.textures.cache.has('2/2/3/7'), false)
  assert.deepStrictEqual(Array.from(renderer.textures.currentRoots.values()), [
    { level: 0, matrix: 1, row: 0, column: 0 },
    { level: 0, matrix: 1, row: 0, column: 1 }
  ])
  await settle()
  assert.strictEqual(invalidSourceTiles, 0)
  assert.strictEqual(renderer.stats().textures.rootDesired, 2)
  assert.strictEqual(renderer.stats().textures.failed, 0)
  assert(canvas.images.slice(7).some((image) =>
    image.src === 'https://new.example/1/0/0.jpg'))

  renderer.current.draws.forEach(draw => { draw.textureNode = {level: draw.texture.level - 1,
    root: Math.floor(draw.texture.row / 2**(draw.texture.level-1))*4 +
      Math.floor(draw.texture.column / 2**(draw.texture.level-1)), row: draw.texture.row, column: draw.texture.column} })
  renderer.setImagerySource({
    kind: 'global-geodetic',
    matrix_level_offset: 0,
    maximum_level: 7, minimum_level: 0, bounds: [[-180,-90],[180,90]],
    level_zero_columns: 2,
    level_zero_rows: 1,
    tile_size: 256
  }, (tile) => {
    assert.strictEqual(tile.matrix, tile.level)
    return `https://original.example/${tile.matrix}/` +
      `${tile.column}/${tile.row}.jpg`
  })
  await settle()
  assert.strictEqual(renderer.stats().textures.rootDesired, 2)
  assert.strictEqual(renderer.stats().textures.failed, 0)
  assert(canvas.images.some((image) =>
    image.src === 'https://original.example/0/0/0.jpg'))

  let prevented = false
  canvas.emit('webglcontextlost', {
    preventDefault() {
      prevented = true
    }
  })
  assert.strictEqual(prevented, true)
  assert.strictEqual(renderer.contextLost, true)
  canvas.emit('webglcontextrestored')
  assert.strictEqual(renderer.contextLost, false)
  renderer.render()
  assert.deepStrictEqual(contextEvents, [{ lost: true }, { lost: false }])

  const atmosphereGl = new FakeGl()
  const atmosphereCanvas = new FakeCanvas(atmosphereGl)
  const atmosphereRenderer = new rendererModule.TerraWebGlRenderer(
    atmosphereCanvas, {
      directTextureTargets: false,
      urlForTile: () => 'https://tiles.example/0/0/0.jpg',
      atmosphereCapable: true,
      atmosphereEnabled: true,
      planetRadius: 30,
      maximumTextureRetries: 0
    })
  atmosphereRenderer.setAtmosphere({
    width: 4,
    height: 2,
    sunVisible: true,
    fogEnabled: false,
    fogDensityMultiplier: 1,
    sunDirection: [0, 0, 1],
    ambientColor: [0.2, 0.3, 0.4],
    diffuseColor: [1, 0.9, 0.7],
    fogColor: [0.5, 0.6, 0.7],
    seaLevelFogDensity: 0.00002,
    rgba: new Uint8Array(4 * 2 * 4).fill(128)
  })
  publishFrame(atmosphereRenderer, frame(), [draw(0)], positions,
    textureUv, indices)
  const geometryEntries = atmosphereRenderer.stats().geometry.entries
  const geometryPreparations = atmosphereRenderer.stats().performance.geometryPrepare.count
  publishFrame(atmosphereRenderer, frame(), [draw(0)], positions,
    textureUv, indices)
  assert.strictEqual(atmosphereRenderer.stats().performance.geometryPrepare.count, geometryPreparations,
    'Repeated immutable geometry reran full frame preparation')
  assert.strictEqual(atmosphereRenderer.stats().performance.imageryRebuild.count, 1,
    'Repeated immutable geometry rebuilt imagery')
  assert.strictEqual(atmosphereRenderer.uploadQueue.length, 2)
  assert.strictEqual(atmosphereRenderer.stats().geometry.entries,
    geometryEntries)
  atmosphereRenderer.render()
  assert(atmosphereGl.calls.some((call) => call.name === 'drawArrays' &&
    call.args[0] === atmosphereGl.TRIANGLES))
  assert(atmosphereGl.calls.some((call) => call.name === 'depthMask' &&
    call.args[0] === false))
  const noFogCall = atmosphereGl.calls.filter((call) =>
    call.name === 'uniform1f' &&
    call.args[0].name === 'u_fog_density').pop()
  assert.strictEqual(noFogCall.args[1], 0)
  atmosphereRenderer.setAtmosphere(Object.assign({},
    atmosphereRenderer.atmosphere, {
      fogEnabled: true,
      fogDensityMultiplier: 2
    }))
  atmosphereRenderer.render()
  const fogCall = atmosphereGl.calls.filter((call) =>
    call.name === 'uniform1f' &&
    call.args[0].name === 'u_fog_density').pop()
  assert(fogCall.args[1] > 0)
  const previousDraws = atmosphereRenderer.current.draws
  const previousDesired = atmosphereRenderer.stats().textures.targetDesired
  atmosphereRenderer.setCameraFrame({
    cameraPosition: [11, 22, 33],
    projectionView: frame().projectionView
  })
  assert.strictEqual(atmosphereRenderer.current.draws, previousDraws)
  assert.strictEqual(atmosphereRenderer.stats().textures.targetDesired,
    previousDesired)
  assert.deepStrictEqual(atmosphereRenderer.stats().atmosphere, {
    capable: true,
    enabled: true,
    sunVisible: true,
    fogEnabled: true,
    source: 'terra-core'
  })
  assert(atmosphereRenderer.stats().performance.render.count >= 2)
  assert.strictEqual(atmosphereRenderer.stats().performance.geometryPrepare.count, 1)
  assert.strictEqual(atmosphereRenderer.stats().performance.imageryRebuild.count, 1)
  atmosphereRenderer.destroy()

  const meshGl = new FakeGl()
  const meshCanvas = new FakeCanvas(meshGl)
  const receipts = []
  const meshRenderer = new rendererModule.TerraWebGlRenderer(meshCanvas, {
    urlForTile: () => 'https://tiles.example/0.jpg', mode: 'height',
    onPresented: sequence => receipts.push(sequence)
  })
  const meshDraw = Object.assign(draw(0), { resourceId: 51, textureResourceId: 4294967347, firstVertex: 999 })
  const mesh = { resourceId: 51, positions, textureUv }
  const resources = new Map([[51, mesh]])
  const meshState = { modelRevision: 1 }
  meshRenderer.setMeshFrame(Object.assign(frame(), { sequence: 1 }), [meshDraw],
    resources, indices, meshState)
  assert.deepStrictEqual(receipts, [], 'GPU upload must precede the frame receipt')
  meshRenderer.render()
  assert.deepStrictEqual(receipts, [1])
  assert.strictEqual(meshRenderer.stats().transition.handoff.phase, 'presented')
  assert.strictEqual(meshRenderer.geometry.get('mesh:51').positions, positions,
    'Resource arrays must be reused without copying concatenated vertex offsets')
  const geometryUploads = meshGl.calls.filter(call => call.name === 'bufferData').length
  const rebuilds = meshRenderer.performanceStats.imageryRebuild.count
  meshRenderer.setMeshFrame(Object.assign(frame(), { sequence: 2 }), [meshDraw],
    resources, indices, meshState)
  meshRenderer.render()
  assert.deepStrictEqual(receipts, [1, 2])
  assert.strictEqual(meshGl.calls.filter(call => call.name === 'bufferData').length, geometryUploads)
  assert.strictEqual(meshRenderer.performanceStats.imageryRebuild.count, rebuilds)
  meshRenderer.setCameraFrame({ cameraPosition: [11, 21, 31], projectionView: frame().projectionView })
  meshRenderer.render()
  assert.strictEqual(meshGl.calls.filter(call => call.name === 'bufferData').length, geometryUploads)
  meshRenderer.setMeshFrame(Object.assign(frame(), { sequence: 3, cameraPosition: [11, 21, 31] }),
    [meshDraw], resources, indices, meshState)
  meshRenderer.render()
  assert.strictEqual(meshRenderer.plannedCameraVersion, meshRenderer.cameraVersion,
    'A formal frame matching the preview must still replace the previous camera imagery plan')
  assert.strictEqual(meshRenderer.performanceStats.imageryRebuild.count, rebuilds + 1)
  assert.strictEqual(meshGl.calls.filter(call => call.name === 'bufferData').length, geometryUploads)
  const selected = Object.assign(frame(), {sequence: 30})
  const liveCamera = {cameraPosition: [12, 22, 32], projectionView: frame().projectionView}
  meshRenderer.setMeshFrame(selected, [meshDraw], resources, indices, meshState,
    null, null, {camera: liveCamera, selectionCurrent: false})
  meshRenderer.render()
  assert.strictEqual(meshRenderer.current.selectionFrame, selected)
  assert.deepStrictEqual(meshRenderer.current.frame.cameraPosition, liveCamera.cameraPosition,
    'A late mesh publication rewound the live camera')
  assert.strictEqual(meshRenderer.currentSelectionReady(), false)
  assert.strictEqual(meshRenderer.currentTargetGeometryReady(), true,
    'Camera freshness prevented immutable geometry from being admitted')
  assert(receipts.includes(30), 'Camera movement starved a GPU submission receipt')
  const rootMeshDraw = Object.assign({}, meshDraw, {flags: 1})
  meshRenderer.setMeshFrame(Object.assign(frame(), {sequence: 31, coverageComplete: true}),
    [meshDraw, rootMeshDraw], resources, indices, {modelRevision: 31, pendingPriorityUpdateCount: 6})
  const originalMeasure = meshRenderer.measureDraw
  meshRenderer.measureDraw = d => ({visible: Boolean(d.flags & 1), pixelError: 0})
  const waitingRender = meshRenderer.render()
  assert(waitingRender.submitted > 0, 'a moved camera with an old cut must still render root coverage')
  assert(meshRenderer.stats().quality.coverageSubmitted > 0,
    'planning imagery with the new camera must not disable coverage while terrain selection is pending')
  assert.strictEqual(meshRenderer.stats().quality.terrainSelectionCurrent, false)
  assert.strictEqual(meshRenderer.stats().quality.geometryTargetComplete, false)
  assert(receipts.includes(31), 'A safe display receipt must not wait for unfinished terrain priorities')
  meshRenderer.current.updateState.pendingPriorityUpdateCount = 0
  meshRenderer.current.updateState.pendingMeshGroups = 1
  assert.strictEqual(meshRenderer.stats().quality.terrainSelectionCurrent, false,
    'Pending production groups claimed current target geometry')
  meshRenderer.current.updateState.pendingMeshGroups = 0

  meshRenderer.measureDraw = originalMeasure
  meshRenderer.setMeshFrame(Object.assign(frame(), {sequence: 3, cameraPosition: [11, 21, 31]}),
    [meshDraw], resources, indices, meshState)
  meshRenderer.render()
  const replacement = Object.assign({}, meshDraw, { resourceId: 52 })
  meshRenderer.setMeshFrame(Object.assign(frame(), { sequence: 4 }), [replacement],
    new Map([[52, mesh]]), indices, { modelRevision: 2 })
  assert.strictEqual(meshRenderer.displaySurface.current.frame.sequence, 3,
    'Keep the displayed mesh while the replacement awaits GPU admission')
  for(let turn=0;turn<3&&!receipts.includes(4);++turn)meshRenderer.render()
  assert.deepStrictEqual(receipts, [1, 2, 3, 30, 31, 3, 4])
  assert.strictEqual(meshRenderer.displaySurface.current.frame.sequence, 4)
  const sameCut = meshRenderer.current
  const sameCutUploads = meshGl.calls.filter(call => call.name === 'bufferData').length
  const pendingPlan = {revision: 101, draws: sameCut.draws, levels: new Set(),
    quality: Object.assign({}, meshRenderer.qualityStats, {planningComplete: false})}
  meshRenderer.setMeshFrame(Object.assign({}, sameCut.frame, {sequence: 81}), sameCut.draws,
    sameCut.meshResources, indices, sameCut.updateState, pendingPlan)
  meshRenderer.render()
  const completedPlan = Object.assign({}, pendingPlan, {revision: 102,
    quality: Object.assign({}, pendingPlan.quality, {planningComplete: true})})
  meshRenderer.setMeshFrame(Object.assign({}, sameCut.frame, {sequence: 82}), sameCut.draws,
    sameCut.meshResources, indices, sameCut.updateState, completedPlan)
  meshRenderer.render()
  assert.strictEqual(meshRenderer.stats().quality.planningComplete, true,
    'The unchanged-mesh path lost the completed background imagery plan')
  assert.strictEqual(meshGl.calls.filter(call => call.name === 'bufferData').length, sameCutUploads,
    'Independent imagery progress reuploaded immutable terrain')
  meshRenderer.destroy()

  const previousBitmapDecoder = global.createImageBitmap
  const previousAbortController = global.AbortController
  const fetchedCanvas = new FakeCanvas(new FakeGl())
  fetchedCanvas.ownerDocument = {}
  let closedImages = 0, fetchedUrl = null, fetchedSignal = null
  let fetchedRenderer
  try {
    if (!global.AbortController) global.AbortController = class {
      constructor() { this.signal = { aborted: false, addEventListener() {} } }
      abort() { this.signal.aborted = true }
    }
    global.createImageBitmap = async () => ({ width: 256, height: 256,
      close() { closedImages += 1 } })
    fetchedRenderer = new rendererModule.TerraWebGlRenderer(fetchedCanvas, {
      urlForTile: () => 'http://127.0.0.1/terra/v1/imagery/test/0/0/0.jpg',
      fetchTextures: async (url, options) => {
        fetchedUrl = url
        fetchedSignal = options.signal
        return { ok: true, blob: async () => ({}) }
      }
    })
    fetchedRenderer.textures.sync([{ texture: { level: 0, matrix: 0, row: 0, column: 0 } }])
    await waitUntil('The host texture fetch adapter did not load', () =>
      fetchedRenderer.textures.cache.entries.size === 1)
    assert.strictEqual(fetchedUrl, 'http://127.0.0.1/terra/v1/imagery/test/0/0/0.jpg')
    assert(fetchedSignal && typeof fetchedSignal.addEventListener === 'function')
    assert.strictEqual(fetchedCanvas.images.length, 0, 'Fetch must use the supplied host adapter')
  } finally {
    if (fetchedRenderer) fetchedRenderer.destroy()
    if (previousBitmapDecoder === undefined) delete global.createImageBitmap
    else global.createImageBitmap = previousBitmapDecoder
    if (previousAbortController === undefined) delete global.AbortController
    else global.AbortController = previousAbortController
  }
  assert.strictEqual(closedImages, 1, 'Destroy must release the decoded bitmap')

  renderer.setBudget({
    geometryCacheBytes: 1,
    textureCacheBytes: 1,
    maximumTextureEntries: 2,
    uploadBudgetMs: 3,
    maximumTextureRequests: 1
  })
  assert.strictEqual(renderer.geometry.maximumBytes, 1)
  assert.strictEqual(renderer.textures.cache.maximumBytes, 1)
  assert.strictEqual(renderer.textures.cache.maximumEntries, 2)
  assert.strictEqual(renderer.textures.scheduler.maximumConcurrent, 1)
  renderer.destroy()
  assert(gl.calls.some((call) => call.name === 'deleteProgram'))
  console.log('Mini Program WebGL renderer tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
}).finally(() => { Array.from(textureUploadRenderers).forEach(renderer => renderer.destroy()) })
