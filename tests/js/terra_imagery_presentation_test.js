const assert = require('assert')
const { ImageryPresentation } = require('../../sdk/js/imagery/terra_imagery_presentation')
const { descendantTextureTile, ancestorUvTransform, textureTileContains } = require('../../sdk/js/imagery/terra_texture_tiles')
const { textureKeyString: key } = require('../../sdk/js/core/terra_globe_common')
const { imageryDraws } = require('../../adapters/webgl/imagery_draws')
const { imageryCandidate } = require('../../adapters/webgl/imagery_candidate')

function main() {
  require('./presentation_branch_contract')()
  const root = {level: 0, matrix: 1, row: 0, column: 0}
  const children = [0, 1, 2, 3].map(i => descendantTextureTile(root, 1, i >> 1, i % 2))
  const p = new ImageryPresentation(200), resident = () => true
  const submit = (time, cells, targets, ready = true) => {
    p.beginFrame(time)
    const states = cells.map((tile, i) => p.resolve(tile, targets[i], resident, ready))
    p.endFrame()
    return states
  }
  submit(0, [root], [root])
  assert(submit(10, children, children, false).every(s => key(s.b) === key(root)),
    'Incomplete sibling/partition readiness must keep the visible ancestor')
  assert(submit(20, children, children).every(s => s.alpha === 0))
  assert(submit(120, children, children).every(s => s.alpha === 0.5),
    'Visible siblings must share one progression, independent of draw order')
  const reverse = submit(120, children, children.map(() => root))
  assert(reverse.every(s => s.alpha === 0.5 && s.goal === 0), 'Reversal reset alpha')
  assert(submit(170, children, children.map(() => root)).every(s => s.alpha === 0.25))
  assert(submit(220, children, children.map(() => root)).every(s => key(s.a) === key(root)))
  assert.strictEqual(p.active, 0)
  submit(230, children, children)
  submit(430, children, children)
  p.beginFrame(440)
  const common = []
  p.cover(root, root, cell => common.push(cell))
  assert.deepStrictEqual(common.map(key), children.map(key), 'Coarsening stretched a fine tile over its parent')
  common.forEach(cell => {
    const state = p.resolve(cell, root, resident)
    const uv = ancestorUvTransform(cell, state.b)
    assert.strictEqual(uv.scale, 0.5)
    assert.strictEqual(uv.offsetX, cell.column / 2)
    assert.strictEqual(uv.offsetY, cell.row / 2)
  })
  p.endFrame()
  // A third destination does not add a sampler or restart the existing blend.
  const grandchild = descendantTextureTile(children[0], 1, 0, 0)
  let state = submit(490, [grandchild], [grandchild])[0]
  assert.strictEqual(state.alpha, 0.25)
  assert.strictEqual(key(state.b), key(root))
  state = submit(640, [grandchild], [grandchild])[0]
  assert.strictEqual(key(state.a), key(root))
  assert.strictEqual(key(state.b), key(grandchild))
  assert.strictEqual(state.alpha, 0)
  submit(840, [grandchild], [grandchild])
  assert.strictEqual(p.cells.size, 1, 'Offscreen cells retained transition ownership')
  assert.strictEqual(p.active, 0)
  p.clear()
  assert.strictEqual(p.cells.size, 0, 'Source replacement retained the old display cut')
  p.beginFrame(900)
  const cover = cell => {
    const cut = []
    p.cover(cell, root, (tile, target) => cut.push([key(tile),key(target)]))
    return cut
  }
  p.setGoals([root,grandchild])
  const cut = cover(root)
  assert.strictEqual(cut.length, 7, 'Ready fine demand did not split the coarse fragment footprint')
  assert(cut.some(([cell,target]) => cell === key(grandchild) && target === cell))
  p.setGoals([grandchild,root])
  assert.deepStrictEqual(cover(root), cut, 'Ready goal order changed the shared world-cell cut')
  const neighbor = descendantTextureTile(grandchild, 1, 0, 1)
  assert.deepStrictEqual(cover(neighbor), [[key(neighbor),key(grandchild)]],
    'A coarse fragment overrode the finer goal on a shared footprint')
  p.clear()
  p.beginFrame(901)
  assert.deepStrictEqual(cover(root), [[key(root),key(root)]], 'Cleared source retained goal subdivision')

  // A deep ready target cannot be improved by any of its coarser ancestors.
  // A large zoom must not multiply these irrelevant lookups per mesh/group.
  const deep = descendantTextureTile(root, 16, 12345, 23456)
  p.setGoals([root, deep])
  let lookups = 0
  const getGoal = p.goals.get.bind(p.goals)
  p.goals.get = id => { ++lookups; return getGoal(id) }
  const direct = []
  p.cover(deep, deep, (cell, target) => direct.push([key(cell), key(target)]))
  assert.deepStrictEqual(direct, [[key(deep), key(deep)]])
  assert(lookups <= 1, 'Ready deep target scanned irrelevant coarse ancestors')

  // Coarse coverage can overlap a tiny mesh while fine old/ready cells live
  // elsewhere. Filtering the final leaves still traverses the unrelated tree.
  p.clear()
  const dense = []
  for (let row = 0; row < 32; ++row) for (let column = 0; column < 32; ++column)
    dense.push(descendantTextureTile(children[0], 5, row, column))
  submit(1000, dense, dense)
  p.beginFrame(1100)
  p.setGoals([root, ...dense])
  const footprint = children[3]
  const intersects = cell => textureTileContains(cell, footprint) || textureTileContains(footprint, cell)
  const expected = []
  p.cover(root, root, (cell, target) => {
    if (intersects(cell)) expected.push([key(cell), key(target)])
  })
  const actual = []
  let visits = 0
  p.cover(root, root, (cell, target) => actual.push([key(cell), key(target)]), cell => {
    ++visits; return intersects(cell)
  })
  assert.deepStrictEqual(actual, expected, 'Footprint pruning changed the shared transition cut')
  assert(visits <= 5, 'Local mesh traversed another region\'s detailed transition tree')

  // A prospective local image group needs only its participating meshes, but
  // the cut must still include finer goals contributed by other meshes.
  const draws = [{geometryKey: 'coarse', texture: root},
    {geometryKey: 'fine', texture: grandchild}, {geometryKey: 'neighbor', texture: children[3]}]
  const goals = new Map(draws.map(draw => [key(draw.texture), draw.texture]))
  const textures = {targetDesired: goals, admissionBlocked: new Set(), availableKeys: new Set(goals.keys()),
    cache: {has: () => true}, gpuReady: () => true, presentationTileFor: tile => tile,
    get: tile => ({resolvedTile: tile})}
  const touched = []
  const renderer = {plannedCameraVersion: 1, cameraVersion: 1, current: {imageryPlan: {quality: {planningComplete:true}}},
    terrainBoundImagery: true, options: {imageryPixelError: 1.25}, presentedTextures: new Map(),
    presentationBridges: [], measureDraw: () => ({visible:true}), measureTextureDraw: () => 0,
    geometry: {get(id) { touched.push(id); return {model: {hull:[[0,0],[1,0],[1,1],[0,1]]}} }}}
  const world = new ImageryPresentation(), local = new ImageryPresentation()
  world.beginFrame(0); local.beginFrame(0)
  const full = imageryDraws(renderer, draws, textures, world, new Map())
  touched.length = 0
  const selected = imageryDraws(renderer, draws, textures, local, new Map(), true, new Set(['coarse']))
  assert.deepStrictEqual(selected, full.filter(draw => draw.geometryKey === 'coarse'),
    'Local candidate changed the globally shared imagery cut')
  assert.deepStrictEqual([...local.goals], [...world.goals], 'Local production discarded another mesh\'s finer goal')
  assert.deepStrictEqual(touched, ['coarse'], 'Local image production prepared unrelated mesh transitions')
  Object.assign(textures, {currentRoots: new Map([[key(root), root]]), failed: new Set(),
    resourceGroups: () => [[key(root), new Map([[key(grandchild), grandchild], [key(children[3]), children[3]]])]],
    requiresResident: () => true, directTargets: true})
  Object.assign(renderer, {textures, renderDraws: draws, presentation: new ImageryPresentation()})
  touched.length = 0
  const candidate = imageryCandidate(renderer, new Map([[key(grandchild), grandchild]]))
  assert.deepStrictEqual(candidate, full.filter(draw => draw.geometryKey !== 'neighbor'))
  assert.deepStrictEqual(touched, ['coarse', 'fine', 'neighbor', 'coarse', 'fine'],
    'World pricing must read immutable peer hulls but prepare only participating mesh transitions')

  // Two disjoint requested cells can resolve to overlapping ready footprints:
  // the missing child's ancestor covers its already resident sibling too.
  // Expand that union once, retaining the finer goal and any unfinished fade.
  for (const bridge of [false, true]) for (const retained of [false, true]) {
    const available = new Map([root, children[1]].map(tile => [key(tile), tile]))
    const store = {
      targetDesired: new Map(children.slice(0, 2).map(tile => [key(tile), tile])),
      admissionBlocked: new Set(), availableKeys: new Set(available.keys()),
      cache: {has: id => available.has(id)}, gpuReady: id => available.has(id),
      presentationTileFor: tile => available.get(key(tile)) || root,
      get: tile => ({resolvedTile: available.get(key(tile)) || root})
    }
    const inputs = children.slice(0, 2).map(texture => ({geometryKey: 'shared', sourceTexture: root, texture}))
    const r = Object.assign({}, renderer, {presentationBridges: bridge ? [root] : []})
    const selections = []
    for (const reverse of [false, true]) {
      const display = new ImageryPresentation()
      if (retained) {
        display.beginFrame(0)
        display.resolve(children[1], children[1], () => true)
        display.endFrame()
      }
      display.beginFrame(1)
      const output = imageryDraws(r, reverse ? inputs.slice().reverse() : inputs, store, display, new Map())
      for (let i = 0; i < output.length; ++i) for (let j = i + 1; j < output.length; ++j) {
        assert(!textureTileContains(output[i].texture, output[j].texture) &&
          !textureTileContains(output[j].texture, output[i].texture),
        'Ready ancestor and child submitted overlapping cells on the same mesh')
      }
      const expected = bridge && !retained ? [root] : children
      assert.deepStrictEqual(output.map(draw => key(draw.texture)).sort(), expected.map(key).sort(),
        'Footprint normalization discarded coverage or an unfinished fine transition')
      assert(output.every(draw => key(draw.imageryTarget) === key(
        !bridge && key(draw.texture) === key(children[1]) ? children[1] : root)),
      'Ancestor footprint replaced a resident fine goal')
      selections.push(output.map(draw => [key(draw.texture), key(draw.imageryTarget)]).sort())
    }
    assert.deepStrictEqual(selections[0], selections[1], 'Request order changed the displayed footprint')
  }
  // A small triangular mesh borrowing a coarse image must not inherit cells
  // from another mesh's distant fine goal during a large zoom-out.
  const small = descendantTextureTile(root, 4, 4, 5)
  const distant = descendantTextureTile(root, 10, 900, 900)
  const readyImages = new Map([root, distant].map(tile => [key(tile), tile]))
  const coarseStore = {
    targetDesired: readyImages, admissionBlocked: new Set(), availableKeys: new Set(readyImages.keys()),
    cache: {has: id => readyImages.has(id)}, gpuReady: id => readyImages.has(id),
    presentationTileFor: tile => readyImages.get(key(tile)) || root,
    get: tile => ({resolvedTile: readyImages.get(key(tile)) || root})
  }
  const triangularRenderer = Object.assign({}, renderer, {geometry: {
    get: () => ({model: {hull: [[0,0],[1,1],[0,1]]}})
  }})
  const coarseDisplay = new ImageryPresentation(); coarseDisplay.beginFrame(0)
  const coarseCells = imageryDraws(triangularRenderer, [
    {geometryKey: 'small', texture: small, sourceTexture: small},
    {geometryKey: 'distant', texture: distant, sourceTexture: distant}
  ], coarseStore, coarseDisplay, new Map()).filter(draw => draw.geometryKey === 'small')
  assert.strictEqual(coarseCells.length, 1, 'Distant world cells repeatedly drew the whole small mesh')
  assert(textureTileContains(coarseCells[0].texture, small), 'The retained cell does not cover this mesh')

  // Many requested leaves on one mesh can all borrow the same ready ancestor.
  // Accepted cells are already unique; do not repeat their expensive footprint
  // tests before checking that fact, or price errors unused by a leaf decision.
  const requests = dense.map(texture => ({geometryKey: 'shared', sourceTexture: root, texture}))
  let hullChecks = 0, errorChecks = 0
  const measured = {visible: true, get hull() { ++hullChecks; return [[0,0],[1,0],[1,1],[0,1]] }}
  const duplicateRenderer = Object.assign({}, renderer, {
    measureDraw: () => measured,
    measureTextureDraw() { ++errorChecks; return Infinity }
  })
  const rootOnly = Object.assign({}, coarseStore, {
    availableKeys: new Set([key(root)]), cache: {has: id => id === key(root)},
    gpuReady: id => id === key(root), presentationTileFor: () => root,
    get: () => ({resolvedTile: root})
  })
  const duplicateDisplay = new ImageryPresentation(); duplicateDisplay.beginFrame(0)
  const duplicates = imageryDraws(duplicateRenderer, requests, rootOnly, duplicateDisplay, new Map())
  assert.strictEqual(duplicates.length, 1, 'Duplicate ready fallback changed the canonical coverage')
  assert.strictEqual(key(duplicates[0].texture), key(root))
  assert(hullChecks <= 2, 'Already accepted fallback repeated footprint intersection per requested leaf')
  assert.strictEqual(errorChecks, 0, 'A cell without a preserved branch priced unused texture errors')

  // The optimization must still price old descendants when they exist. A new
  // invocation uses the new camera error; no prior refinement decision sticks.
  const retainedRenderer = Object.assign({}, duplicateRenderer, {
    presentedTextures: new Map(children.map(tile => [key(tile), tile]))
  })
  const retainedStore = Object.assign({}, rootOnly, {cache: {has: () => true}})
  for (const error of [Infinity, 0, Infinity]) {
    errorChecks = 0
    retainedRenderer.measureTextureDraw = () => { ++errorChecks; return error }
    const display = new ImageryPresentation(); display.beginFrame(0)
    const output = imageryDraws(retainedRenderer, requests, retainedStore, display, new Map())
    assert.deepStrictEqual(output.map(draw => key(draw.texture)), (error ? children : [root]).map(key),
      'An old descendant branch ignored the current camera error')
    assert(errorChecks > 0 && errorChecks <= 2, 'Old branch decision was omitted or repeated per requested leaf')
  }

  // Rejected intersections must NOT mark a cell visited: another draw can
  // still contribute it. Deduplication is local to each prospective cut, so
  // changing readiness or the camera never reuses an earlier rejection.
  const rejected = {geometryKey: 'shared', sourceTexture: children[3], texture: children[0], rejected: true}
  const accepted = {geometryKey: 'shared', sourceTexture: children[0], texture: children[0]}
  const selectedStore = Object.assign({}, textures, {presentationTileFor: () => children[0]})
  for (const reverse of [false, true]) {
    const display = new ImageryPresentation(); display.beginFrame(0)
    const inputs = reverse ? [accepted, rejected] : [rejected, accepted]
    const output = imageryDraws(renderer, inputs, selectedStore, display, new Map())
    assert(output.length && output.every(draw => !draw.rejected), 'Rejected source suppressed a valid shared cell')
  }
  console.log('Imagery display cut, sibling progression, reversal, UV and ownership contracts passed.')
}

main()
