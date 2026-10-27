const {splitSurfaceBlock} = require('./surface_blocks')

// Provenance belongs to a numeric region, not its terrain resource. Keep only
// a mesh-specific root token and at most two child indices; never retain a model,
// vertex view, face list or transient subdivision tree in projection history.
// Together with a scalar region this fits the cache's existing 168-byte quote.
const domains = new WeakMap()
const roots = new WeakMap()

function measurementRoot(block) {
  let token = roots.get(block)
  if (!token) {token = {}; roots.set(block, token)}
  return token
}

function rememberDomain(region, root, path) {
  domains.set(region, {root, path})
  return region
}

function* measurementBlocks(model, regions) {
  const roots = new Map(model.blocks.map(block => [measurementRoot(block), block]))
  const requests = []
  for (const region of regions) {
    const domain = domains.get(region)
    if (!domain || !roots.has(domain.root)) return null
    requests.push({region, domain})
  }
  // Reconstruct only requested paths. Siblings reuse one bounded subdivision;
  // all generated metadata is discarded when this cooperative task ends.
  const children = new Map(), selected = []
  for (const {region, domain} of requests) {
    let block = roots.get(domain.root)
    for (const index of domain.path) {
      if (!children.has(block)) children.set(block, yield* splitSurfaceBlock(model, block))
      const split = children.get(block)
      if (!split || !split[index]) return null
      block = split[index]
    }
    if (['minimumU', 'minimumV', 'maximumU', 'maximumV'].some(key => block.uv[key] !== region.uv[key])) return null
    // Preserve published numeric metadata identity, without mutating roots.
    if (domain.path.length) block.uv = region.uv
    selected.push(block)
  }
  return selected
}

module.exports = {measurementRoot, rememberDomain, measurementBlocks}
