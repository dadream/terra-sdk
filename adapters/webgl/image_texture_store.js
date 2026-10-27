const { ProducedTextureStore } = require('./produced_texture_store')
const { TextureStore, imageTask } = require('./texture_store')

// Canvas image APIs combine download and decode. Fund pixels before setting
// src, retain them through upload completion, then keep only GPU residency.
class ImageTextureStore extends ProducedTextureStore {
  configureDimensions() {
    const descriptor = this.renderer.options.textureDescriptor
    this.tileSize = Number(descriptor && descriptor.tile_size) || 256
    this.decodeBytes = this.tileSize * this.tileSize * 4
    this.inputEnvelopeBytes = this.decodeBytes
    this.decodeOverlapBytes = 0
    this.maximumInputBytes = this.maximumPipelineBytes = 2 * this.decodeBytes
    this.estimatedTileBytes = this.resourceBytes(this.tileSize, this.tileSize)
  }

  requestAsset(url, reservation) {
    const size = this.tileSize
    const task = imageTask(this.canvas, url, 15000, false)
    return {abort: task.abort, promise: task.promise.then(image => {
      if (image.width !== size || image.height !== size) {
        this.releasePixels({image})
        throw new Error('Texture dimensions differ from the imagery descriptor')
      }
      const input = reservation.input
      input.resize(size * size * 4)
      input.transferred = true
      return {input, image, texture: null, width: size, height: size, url}
    })}
  }

  prepareAsset(key, entry) { return Boolean(entry.value.image) }
}

// Fixed-size geodetic sources can reload after context loss. Their decoded
// pixels belong only to the bounded producer, never the resident tile cache.
// Arbitrary planar images keep their dimension and recovery contract.
function createCanvasTextureStore(renderer, options) {
  const descriptor = renderer.options.textureDescriptor
  return descriptor && descriptor.kind === 'global-geodetic'
    ? new ImageTextureStore(renderer, options) : new TextureStore(renderer, options)
}

module.exports = { ImageTextureStore, createCanvasTextureStore }
