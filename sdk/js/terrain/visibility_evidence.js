const same = (a, b, n) => a && b && a.length === n && b.length === n &&
  Array.from(a).every((v, i) => Number.isFinite(v) && v === b[i])

function visibilityMembers(draws) {
  return draws.filter(draw => !(draw.flags & 1)).map(draw => [draw.geometryKey,
    draw.resourceId, draw.firstIndex, draw.indexCount, ...draw.origin].join(':')).sort()
}

// Occlusion depends on all occluders, not only on the hidden mesh's immutable
// ID. Reject a changed scene/view instead of contaminating reusable SSE data.
function hiddenResources(evidence, frame, draws, viewport) {
  if (!evidence || evidence.schema !== 'terra.terrain-visibility.v2' ||
      !Number.isSafeInteger(evidence.revision) || evidence.revision <= 0 ||
      !same(evidence.projectionView, frame.projectionView, 16) ||
      !same(evidence.cameraPosition, frame.cameraPosition, 3) ||
      !same(evidence.viewport, [viewport.width, viewport.height], 2) ||
      JSON.stringify(evidence.members) !== JSON.stringify(visibilityMembers(draws))) return new Set()
  const members = draws.filter(draw => !(draw.flags & 1))
  const ids = new Set(members.map(draw => draw.resourceId))
  if (ids.size !== members.length) return new Set()
  if (!Array.isArray(evidence.hidden) || evidence.hidden.some(id => !ids.has(id))) return new Set()
  return new Set(evidence.hidden)
}

module.exports = {visibilityMembers, hiddenResources}
