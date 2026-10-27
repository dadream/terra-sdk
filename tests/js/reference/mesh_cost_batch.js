// Deterministic producer for admission fixtures: one completed mesh per receipt.
module.exports = function meshCostBatch(rows, onRows, price) {
  let cancelled = false
  const promise = (async () => {
    await Promise.resolve()
    for (const row of rows) {
      if (cancelled) return null
      if (onRows([{resourceId: row.draw.resourceId, source: 'sampled',
        prices: price(row)}]) === false) return null
      await Promise.resolve()
    }
    return true
  })()
  return {promise, cancel() {cancelled = true}}
}
