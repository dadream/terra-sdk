// A selection scan owns a fixed camera until its bounded native continuations
// have finished. Pointer notifications replace desired input, never the work
// already completed in that scan. The next epoch takes the newest desired view.
class TerrainEpoch {
  constructor() { this.clear() }

  begin(request, latestView) {
    if (!this.active) {
      const view = latestView && latestView.camera && latestView.viewport &&
        latestView.viewport.width === request.viewport.width &&
        latestView.viewport.height === request.viewport.height &&
        latestView.viewport.fovRadians === request.viewport.fovRadians &&
        latestView.revision >= request.viewRevision ? latestView : request
      this.active = { camera: Object.assign({}, view.camera), viewport: Object.assign({}, view.viewport),
        viewRevision: view.revision === undefined ? view.viewRevision : view.revision,
        threshold: request.threshold }
    }
    return Object.assign({}, request, this.active)
  }

  finish(updateState) {
    if (!(updateState.pendingPriorityUpdateCount > 0)) this.clear()
  }

  clear() { this.active = null }
}

module.exports = { TerrainEpoch }
