const {PartitionPlanBatch} = require('../../sdk/js/terrain/partition_plan_batch')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {holdMeshes} = require('../../sdk/js/resources/mesh_ownership')
const {invariant} = require('../../sdk/js/core/terra_globe_common')
const surface = require('../../sdk/js/terrain/terra_surface_plan')

// Snapshot every immutable input before yielding. Terrain publication can retire
// a later row while the first one is being priced. Missing rows are explicit;
// the renderer can still own their host copy after Worker recovery/retirement.
function residentPartitionPlan(rows, resources) {
  invariant(Array.isArray(rows), 'Invalid resident partition batch')
  const seen = new Set()
  const inputs = rows.map(row => {
    invariant(Number.isSafeInteger(row.resourceId) && !seen.has(row.resourceId) &&
      Array.isArray(row.cells), 'Invalid resident partition member')
    seen.add(row.resourceId)
    const resource = resources.get(row.resourceId)
    return {draw: row, cells: row.cells, resource: resource && resource.model ? resource : null}
  })
  const release = holdMeshes(inputs.map(row => row.resource).filter(Boolean))
  const batch = new PartitionPlanBatch(inputs, row => ({
    task: row.resource ? surface.createPartitionPlanTask(row.resource.model, row.cells) :
      new CooperativeTask((function* () { return null })()),
    source: row.resource ? 'resident' : 'missing', release() {}
  }))
  batch.releaseMeshes = release
  return batch
}

// One RPC for the group's current-generation rows. Older host-owned models use
// one cooperative local batch after the receipt, never one RPC per mesh.
function partitionGroupPlan(rows, worker, eligible) {
  let task, cancelled = false
  const costs = new Map()
  const promise = (async () => {
    const remote = worker ? rows.filter(row => eligible(row.geometry)) : []
    if (remote.length) {
      const ids = new Map(remote.map(row => [row.geometry.resourceId, row.geometry.key]))
      task = worker.createPartitionGroupPlanTask(remote.map(row => ({
        resourceId: row.geometry.resourceId, cells: row.cells
      })), completed => {
        for (const row of completed) {
          invariant(ids.has(row.resourceId), 'Unexpected resident partition result')
          if (row.prices !== null) costs.set(ids.get(row.resourceId), row.prices)
        }
      })
      const result = await task.promise
      if (cancelled || result === null) return null
    }
    const missing = rows.filter(row => !costs.has(row.geometry.key))
    if (missing.length) {
      task = new PartitionPlanBatch(missing.map(row => ({...row, draw: {resourceId: row.geometry.key}})), row => ({
        task: surface.createPartitionPlanTask(row.geometry.model, row.cells), source: 'host', release() {}
      }))
      await task.run(completed => completed.forEach(row => costs.set(row.resourceId, row.prices)))
    }
    return cancelled ? null : costs
  })()
  return {promise, cancel() { cancelled = true; if (task) task.cancel() }}
}

module.exports = {residentPartitionPlan, partitionGroupPlan}
