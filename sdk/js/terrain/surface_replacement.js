// A boundary proof authorizes mixing only its exact immutable old/new cut.
// Coverage roots are separate fallback owners and are never replacement members.
function surfaceIds(draws) {
  return Array.from(new Set(draws.filter(draw => !(draw.flags & 1))
    .map(draw => draw.resourceId))).sort((a, b) => a - b)
}

// Within one native context, identical immutable IDs cannot change geometry.
// Only a completely unchanged cut bypasses the native boundary comparison;
// shared IDs inside a changed cut still participate in all its dependencies.
function identityReplacementPlan(before, after) {
  const oldIds = surfaceIds(before), newIds = surfaceIds(after)
  return oldIds.length && oldIds.length === newIds.length &&
    oldIds.every((id, i) => id === newIds[i])
    ? {groups: oldIds.map(id => ({before: [id], after: [id]}))} : null
}

// Replacing both complete cuts atomically cannot introduce an old/new seam.
// This proof needs only immutable membership, not edge samples. It authorizes
// no proper subset: capacity-limited publication must first refine it natively.
function atomicReplacementPlan(before, after) {
  const oldIds = surfaceIds(before), newIds = surfaceIds(after)
  return oldIds.length || newIds.length
    ? {atomic: true, groups: [{before: oldIds, after: newIds}]} : null
}

function selectReplacementGroups(proof, selected) {
  const groups = new Set(selected)
  return {groups: proof.groups.flatMap((group, i) => groups.has(i) ? [group] :
    group.before.map(id => ({before: [id], after: [id]})))}
}

function changedReplacementGroups(proof, beforeDraws, afterDraws) {
  const before = new Map(beforeDraws.map(draw => [draw.resourceId, draw]))
  const after = new Map(afterDraws.map(draw => [draw.resourceId, draw]))
  const vertices = (ids, map) => ids.reduce((sum, id) => sum + map.get(id).vertexCount, 0)
  return proof.groups.map((group, index) => ({group, index,
    cost:vertices(group.after, after), oldCost:vertices(group.before, before)}))
    .filter(({group}) => group.before.length !== group.after.length ||
      group.after.some(id => !group.before.includes(id)))
    .sort((a,b) => Number(b.cost < b.oldCost) - Number(a.cost < a.oldCost) || a.cost - b.cost || a.index - b.index)
}

function bindReplacementPlan(proof, before, after) {
  if (!proof || !Array.isArray(proof.groups)) return null
  const maps = [before, after].map(surface => new Map(surface.draws
    .filter(draw => !(draw.flags & 1)).map(draw => [draw.resourceId, draw])))
  const seen = [new Set(), new Set()], result = []
  for (const group of proof.groups) {
    const bound = {before: [], after: []}
    for (const [side, name] of ['before', 'after'].entries()) {
      if (!Array.isArray(group[name])) return null
      for (const id of group[name]) {
        if (!Number.isInteger(id) || !maps[side].has(id) || seen[side].has(id)) return null
        seen[side].add(id); bound[name].push(maps[side].get(id))
      }
    }
    if (!bound.before.length && !bound.after.length) return null
    result.push(bound)
  }
  return maps.every((map, i) => map.size === seen[i].size) ? result : null
}

module.exports = {surfaceIds, identityReplacementPlan, atomicReplacementPlan, selectReplacementGroups, changedReplacementGroups, bindReplacementPlan}
