const api = require('../../sdk/js/api/terra_viewer')
const { TerraGlobeRuntime, TerraPlanarRuntime } = require('../wasm/terra_globe_runtime')
const {requestWithWx} = require('./wx_request')
const {createCanvasTextureStore} = require('../webgl/image_texture_store')

// Mini Program owns direct WXWebAssembly creation. Browser Worker creation is
// supplied by the browser entry and is absent from this dependency graph.
class TerraViewer extends api.TerraViewer {
  static create(options) {
    return super.create(Object.assign({
      createTextureStore: createCanvasTextureStore,
      createRuntime(value) {
        const Runtime = value.mode === 'globe' ? TerraGlobeRuntime : TerraPlanarRuntime
        return Runtime.create(value)
      }
    }, options, {request: options && options.request || requestWithWx}))
  }
}

module.exports = Object.assign({}, api, { TerraViewer })
