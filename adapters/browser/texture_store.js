const { createCanvasTextureStore } = require('../webgl/image_texture_store')
const { EncodedTextureStore } = require('./encoded_texture_store')

function createTextureStore(renderer, options) {
  const descriptor = renderer.options.textureDescriptor
  const encoded = descriptor && descriptor.kind === 'global-geodetic' &&
    renderer.options.fetchTextures !== false && renderer.canvas.ownerDocument &&
    typeof createImageBitmap === 'function' && typeof Blob === 'function' && typeof fetch === 'function'
  return encoded ? new EncodedTextureStore(renderer, options) : createCanvasTextureStore(renderer, options)
}

module.exports = { createTextureStore }
