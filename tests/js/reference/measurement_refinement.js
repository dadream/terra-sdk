// JS comparison oracle only. The SDK default producer tightens domains in C++.
const surface = require('../../../sdk/js/terrain/terra_surface_plan')
const {measurementBlocks} = require('../../../sdk/js/terrain/measurement_domains')

// The caller supplies an earlier measurement of this immutable mesh and view.
// Clipped projective regions are already exact; only whole-block derivative
// bounds need tightening. Reuse their output objects, not another triangle cache.
function* refineMeasurements(model, origin, context, previous) {
  // A mesh-wide summary without regions carries no domain-completeness proof.
  if (!previous.regions.length) return yield* surface.surfaceMeasurements(model, origin, context, false, true)
  const projected = [], loose = []
  for (const region of previous.regions) {
    if (region.projection) projected.push(region)
    else loose.push(region)
  }
  if (!loose.length) return Object.assign({}, previous, {refinable: false})
  const blocks = yield* measurementBlocks(model, loose)
  // Identity ties each summary to its immutable block. Foreign summaries must
  // take the complete measurement path rather than silently omit a block.
  if (!blocks) return yield* surface.surfaceMeasurements(model, origin, context, false, true)
  // Preserve the model's native-view getters across cooperative yields.
  const selected = Object.assign(Object.create(model), {blocks})
  const tightened = yield* surface.surfaceMeasurements(selected, origin, context, false, true)
  const regions = tightened.regions.concat(projected)
  return Object.assign({}, previous, {
    regions, refinable: false,
    // Conservative facing bounds can disappear entirely after exact clipping.
    // Do not make the consumer wait for cells of a mesh the planner rejected.
    visible: projected.length > 0 || tightened.visible,
    uv: projected.length ? previous.uv : tightened.uv,
    pixelsPerUv: regions.reduce((error, region) => Math.max(error, region.pixelsPerUv), 0),
    // This remains a conservative ordering hint; SSE uses the exact regions.
    centerDistance: Math.min(previous.centerDistance, tightened.centerDistance)
  })
}

module.exports = {refineMeasurements}
