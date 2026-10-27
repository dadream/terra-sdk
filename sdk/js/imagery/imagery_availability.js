// Resource readiness is independent of terrain publication and UV partitioning.
// Visible siblings become available together after upload; only the renderer's
// submitted presentation cut may decide that their predecessor can be released.
function availableImageryCut(roots, groups, previous, state) {
  const work = availableImageryCutWork(roots, groups, previous, state)
  let result
  do { result = work.next() } while (!result.done)
  return result.value
}

function* availableImageryCutWork(roots, groups, previous, state, reserve = () => {}) {
  const available = new Set()
  const resident = key => state.ready(key) && !state.failed(key)
  const add = key => { if (!available.has(key)) { reserve(64 + key.length * 2); available.add(key) } }
  for (const [key] of roots) { yield; if (resident(key)) add(key) }
  reserve(64 + groups.length * 8)
  const ordered = groups.slice().sort((a, b) => a[1].values().next().value.level - b[1].values().next().value.level)
  for (const [parent, children] of ordered) {
      yield
      // Retrying a failed neighbour must not withdraw an uploaded, previously
      // admitted tile. New siblings still enter together when their work ends.
      for (const [key] of children) { yield; if (previous.has(key) && resident(key)) add(key) }
      if (!state.direct && !available.has(parent) && !state.failed(parent)) continue
      const logical = key => previous.has(key) && !state.required(key)
      let complete = true
      for (const [key] of children) {
        yield
        if (!resident(key) && !logical(key) && !state.failed(key)) { complete = false; break }
      }
      if (!complete) continue
      for (const [key] of children) { yield; if (resident(key) || logical(key)) add(key) }
  }
  return available
}

module.exports = { availableImageryCut, availableImageryCutWork }
