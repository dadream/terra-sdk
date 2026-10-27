const {textureKeyString: key} = require('../core/terra_globe_common')
const {parentTextureTile} = require('./terra_texture_tiles')

// One synchronous read of a fixed availability state. Shared ancestor paths
// are resolved once, including absence. Never retain this across uploads,
// eviction, context changes or a yield; the next traversal creates a new view.
// Only tile identities are held, never images, cache entries or GPU handles.
// Bound temporary metadata even for a large cut. Uncached queries remain exact;
// ancestors take precedence because they are shared by the most descendants.
class ImageryResolution {
  constructor(ready) { this.ready = ready; this.paths = new Map() }

  lookup(tile) {
    const path = []
    let result
    for (let current = tile; current; current = parentTextureTile(current)) {
      const id = key(current)
      if (this.paths.has(id)) { result = this.paths.get(id); break }
      path.push(id)
      if (this.ready(id)) { result = {resolved:current, fallback:current}; break }
      // An absent root is still the coverage cell, but is not a ready image.
      if (current.level <= 0 || current.matrix <= 0) {
        result = {resolved:null, fallback:current}; break
      }
    }
    for (let i=path.length-1;i>=0 && this.paths.size<4096;--i) this.paths.set(path[i],result)
    return result
  }

  resolve(tile) { return this.lookup(tile).resolved }
  fallback(tile) { return this.lookup(tile).fallback }
}

module.exports = {ImageryResolution}
