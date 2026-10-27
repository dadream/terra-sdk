const {UploadBudget} = require('./gl_allocation')

// One next upload batch may be prepared while the submitted batch owns its GPU
// receipt. This bounds lookahead work, independently of already-admitted memory.
// A legal oversized cell may run alone, just like an oversized upload asset.
function partitionStagingBudget(jobs, options) {
  const budget = new UploadBudget(options.uploadBudgetBytes, options.uploadBudgetObjects)
  for (const job of jobs) for (const part of job.parts) {
    budget.bytes += part.positions.byteLength + part.uv.byteLength + part.indices.byteLength
    budget.objects += +(part.indices.length > 0) + (part.positions.length ? 2 : 0)
  }
  return budget
}

module.exports = {partitionStagingBudget}
