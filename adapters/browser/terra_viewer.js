const api = require('../../sdk/js/api/terra_viewer')
const { TerraGlobeRuntime, TerraPlanarRuntime } = require('../wasm/terra_globe_runtime')
const { TerrainWorkerClient } = require('../wasm/terra_worker_client')
const { browserRequest } = require('./browser_request')
const { createTextureStore } = require('./texture_store')
const {createTerrainVisibility} = require('../webgl/terrain_visibility')
const {createTaskTurn, setTask, clearTask} = require('./task_turn')

// Platform creation belongs to the entry. The shared runtime owns scheduling
// and passes the same lifecycle callbacks when restarting a failed Worker.
class TerraViewer extends api.TerraViewer {
  static create(options) {
    return super.create(Object.assign({
      request: browserRequest,
      createWorker: TerrainWorkerClient.create,
      createTextureStore,
      createTerrainVisibility,
      createTaskTurn,
      setTask,
      clearTask,
      createRuntime(value) {
        const Runtime = value.mode === 'globe' ? TerraGlobeRuntime : TerraPlanarRuntime
        return Runtime.create(value)
      }
    }, options))
  }
}

module.exports = Object.assign({}, api, { TerraViewer })
