const assert = require('assert')
const {TextureStore} = require('../../adapters/webgl/texture_store')
const {textureKeyString: key} = require('../../sdk/js/core/terra_globe_common')
const {ancestorTextureTiles, descendantTextureTile} = require('../../sdk/js/imagery/terra_texture_tiles')

module.exports = function verifyImageryAncestorLookup() {
  const root = {level:0, matrix:1, row:0, column:0}
  const leaf = descendantTextureTile(root, 17, 12345, 23456)
  const path = [leaf, ...ancestorTextureTiles(leaf)]
  const assets = new Map(), available = new Set(), presented = new Map(), touched = []
  const store = Object.assign(Object.create(TextureStore.prototype), {
    availableKeys:available,
    renderer:{presentedTextures:presented, fallbackTexture:{fallback:true}, contextLost:false},
    cache:{entries:assets, has:id=>assets.has(id), get(id) {
      touched.push(id)
      const entry = assets.get(id)
      return entry ? entry.value : null
    }}
  })
  const ready = tile => assets.set(key(tile), {value:{texture:{id:key(tile)}}})
  const uploaded = tile => {
    const entry = assets.get(key(tile))
    return entry && entry.value.texture
  }
  const verify = () => {
    const protection = path.find(tile => available.has(key(tile)) && assets.has(key(tile)))
    assert.strictEqual(store.presentationKeyFor(leaf), protection ? key(protection) : null)
    const selected = path.find(tile => uploaded(tile) &&
      (available.has(key(tile)) || presented.has(key(tile))))
    assert.deepStrictEqual(store.presentationTileFor(leaf), selected || root,
      'The display lookup changed the closest ready ancestor or missing root')
    const expectedTouches = []
    for (const tile of path) {
      if (!available.has(key(tile)) && !presented.has(key(tile))) continue
      expectedTouches.push(key(tile))
      if (uploaded(tile)) break
    }
    touched.length = 0
    store.beginFrame()
    const binding = store.get(leaf)
    assert.deepStrictEqual(touched, expectedTouches, 'Lazy lookup changed cache access/recency order')
    assert.deepStrictEqual(binding.resolvedTile, selected)
    assert.strictEqual(binding.resolvedLevel, selected ? selected.level : -1)
    assert.strictEqual(binding.texture, selected ? assets.get(key(selected)).value.texture : store.renderer.fallbackTexture)
    assert.deepStrictEqual(store.frameUsage, {
      exact:Number(selected === leaf), fallback:Number(!!selected && selected !== leaf), missing:Number(!selected)
    })
    if (selected) {
      const scale = 2 ** (selected.level - leaf.level)
      assert.strictEqual(binding.scale, scale)
      assert.strictEqual(binding.offsetX, leaf.column * scale - selected.column)
      assert.strictEqual(binding.offsetY, leaf.row * scale - selected.row)
    }
    store.get(leaf, false)
    assert.strictEqual(Object.values(store.frameUsage).reduce((a,b)=>a+b,0), 1,
      'An unrecorded display probe changed usage counters')
  }
  verify()
  ready(root); available.add(key(root)); verify()
  const middle = path[8]
  ready(middle); verify() // Cached alone does not authorize presentation.
  presented.set(key(middle), middle); verify()
  assets.set(key(leaf), {value:{texture:null}}); available.add(key(leaf)); verify()
  ready(leaf); verify()
  assets.delete(key(leaf)); presented.delete(key(middle)); verify()
  available.add(key(middle)); verify()
  assets.clear(); available.clear(); presented.clear(); verify()

  // The answer is known at the requested tile. Work must not grow with the
  // unused depth above it, including when the source has a matrix offset.
  for (const depth of [1, 8, 17, 24]) {
    const tile = descendantTextureTile(root, depth, 1, 1)
    let reads = 0
    const tracked = new Proxy(tile, {get(value, field) {
      if (field === 'level' || field === 'matrix') ++reads
      return value[field]
    }})
    assets.clear(); available.clear(); ready(tile); available.add(key(tile))
    for (const method of ['presentationKeyFor', 'presentationTileFor', 'get']) {
      reads = 0
      store[method](tracked)
      assert(reads <= 6, `Ready ${method} traversed unused ancestors at depth ${depth}: ${reads}`)
    }
  }
}
