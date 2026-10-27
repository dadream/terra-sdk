(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TerraJointVisibility = factory()
})(typeof self === 'undefined' ? this : self, function () {
  'use strict'

  function viewerOptions(policy) {
    if (policy === 'renderer') return {}
    if (policy === 'all-visible') return {createTerrainVisibility:null}
    throw new Error('Unknown benchmark visibility policy')
  }

  // Capture only after the timed observation. Do not request a new frame or
  // call snapshot(), which can reset stale observer state. The comparator uses
  // the SDK's own evidence validator against this exact scene.
  function read(runtime) {
    const r = runtime.renderer, current = r.current, observer = r.visibility
    if (!current) return null // Preserve collection after an initial-frame timeout.
    const evidence = observer && observer.valid() ? observer.evidence : null
    return {observerEnabled:Boolean(observer),
      evidence:evidence ? JSON.parse(JSON.stringify(evidence)) : null,
      scene:{frame:{projectionView:Array.from(current.frame.projectionView),
        cameraPosition:Array.from(current.frame.cameraPosition)},
      viewport:{width:r.canvas.width, height:r.canvas.height},
      draws:current.draws.map(draw => ({geometryKey:draw.geometryKey, resourceId:draw.resourceId,
        firstIndex:draw.firstIndex, indexCount:draw.indexCount, flags:draw.flags || 0,
        origin:Array.from(draw.origin)}))}}
  }

  return {viewerOptions, read}
})
