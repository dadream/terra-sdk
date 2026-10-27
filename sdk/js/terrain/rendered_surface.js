const same = (a, b) => a === b || a && b && a.length === b.length && a.every((v, i) => v === b[i])
const fields = ['resourceId', 'firstIndex', 'indexCount', 'flags']

// Own only CPU resources referenced by successful draw commands. This snapshot
// is independent of the complete cut retained for future uploads and retirement.
function renderedSurface(previous, owner, submitted, stencil) {
  if (!owner.meshResources) return null
  const groups = new Map(), resources = new Map()
  for (const [draw, clipped] of submitted) {
    const key = draw.geometryKey + ':' + (draw.flags & 1)
    let item = groups.get(key)
    if (!item) {
      item = {origin: draw.origin.slice(), cells: []}
      fields.forEach(field => { item[field] = draw[field] })
      groups.set(key, item)
      resources.set(draw.resourceId, owner.meshResources.get(draw.resourceId))
    }
    if (!clipped) item.cells = null
    else if (item.cells) item.cells.push(draw.imageryCellScale || 1,
      draw.imageryCellOffsetX || 0, draw.imageryCellOffsetY || 0)
  }
  const draws = Array.from(groups.values())
  if (previous && previous.stencil === stencil && previous.indices === owner.indices && previous.draws.length === draws.length &&
      draws.every((draw, i) => fields.every(field => draw[field] === previous.draws[i][field]) &&
        same(draw.origin, previous.draws[i].origin) && same(draw.cells, previous.draws[i].cells) &&
        resources.get(draw.resourceId) === previous.resources.get(draw.resourceId))) return previous
  return {draws, resources, indices: owner.indices, stencil}
}

module.exports = { renderedSurface }
