const {invariant} = require('../../sdk/js/core/terra_globe_common')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')
const {createUvPartitionPlanTask, createPartitionPlanTask} = require('../../sdk/js/terrain/terra_surface_plan')
const {PartitionPlanBatch} = require('../../sdk/js/terrain/partition_plan_batch')
const {holdIndices} = require('../../sdk/js/resources/mesh_indices')

const {SAMPLE_VERTICES} = require('./prepared_surface')

function preparedPartitionBytes(draw, needsIndices = false) {
  invariant(draw && Number.isInteger(draw.vertexCount) && draw.vertexCount > 0 &&
    draw.vertexCount <= 33153 && Number.isInteger(draw.indexCount) && draw.indexCount >= 0 &&
    draw.indexCount <= 393216, 'Invalid prepared partition dimensions')
  // One native slice, full JS UVs, expanded strip faces and their spatial block bounds.
  // Normally the shared index buffer is borrowed. Recovery also credits its
  // bounded native/JS copy; no temporary array may enter a persistent cache.
  const faces = Math.max(0, draw.indexCount - 2)
  return SAMPLE_VERTICES * 8 + draw.vertexCount * 8 + faces * 6 + Math.ceil(faces / 64) * 32 +
    (needsIndices ? draw.indexCount * 4 + 4 : 0)
}

function createPreparedPartitionTask(abi, planId, draw, cells, indices, maximumBytes) {
  invariant(Number.isSafeInteger(maximumBytes) && maximumBytes >= preparedPartitionBytes(draw, !indices),
    'Prepared partition scratch is not credited')
  invariant(Number.isInteger(draw.firstIndex) && draw.firstIndex >= 0 && (indices ?
    indices instanceof Uint16Array && draw.firstIndex + draw.indexCount <= indices.length : draw.firstIndex === 0),
  'Prepared partition indices are unavailable')
  // Keep the shared 4ms slice check. UV blocks are much smaller than full
  // surface jobs; yielding after eight blocks mostly pays the browser's timer
  // clamp instead of doing work. The operation ceiling still bounds a slice.
  return new CooperativeTask(steps(abi, planId, draw, cells, indices), 64)
}

function* steps(abi, planId, draw, cells, indices) {
  let pointer = 0, task
  const sample = (first, count) => {
    const status = abi.module.call('terra_get_prepared_mesh_uv', abi.context,
      planId, draw.resourceId, first, count, pointer)
    if (status) throw Object.assign(new Error('Prepared UV plan is unavailable'), {status})
  }
  try {
    // Validate plan membership before allocating even the bounded scratch.
    sample(0, 0)
    // Worker recovery retains the old display before the new owner has copied
    // its first index template. Bootstrap only within caller-owned credit.
    if (!indices) indices = abi.getIndices(draw.indexCount)
    pointer = abi.alloc(SAMPLE_VERTICES * 8)
    const uv = new Float32Array(draw.vertexCount * 2)
    for (let first = 0; first < draw.vertexCount; first += SAMPLE_VERTICES) {
      const count = Math.min(SAMPLE_VERTICES, draw.vertexCount - first)
      sample(first, count)
      uv.set(new Float32Array(abi.module.refreshMemory().bytes.buffer, pointer, count * 2), first * 2)
      yield
    }
    const faces = new Uint16Array(Math.max(0, draw.indexCount - 2) * 3)
    let length = 0
    for (let i = 2; i < draw.indexCount; ++i) {
      const a = indices[draw.firstIndex + i - 2], b = indices[draw.firstIndex + i - 1], c = indices[draw.firstIndex + i]
      if (a < draw.vertexCount && b < draw.vertexCount && c < draw.vertexCount && a !== b && b !== c && a !== c) {
        faces[length++] = i % 2 ? b : a; faces[length++] = i % 2 ? a : b; faces[length++] = c
      }
      if (i % 512 === 511) yield
    }
    task = createUvPartitionPlanTask(uv, faces.subarray(0, length), cells)
    task.maximumSteps = 1
    for (;;) {
      // Model/height invalidation or group reselection cannot price stale IDs.
      sample(0, 0)
      const result = task.step()
      if (result.done) return result.value
      yield
    }
  } finally {
    if (task) task.cancel()
    if (pointer) abi.free(pointer)
  }
}

function createPreparedPartitionBatch(abi, planId, rows, indices, maximumBytes, resident) {
  invariant(Number.isSafeInteger(maximumBytes) && maximumBytes >= 0 &&
    rows.every(row => maximumBytes >= preparedPartitionBytes(row.draw, !indices)),
    'Prepared batch scratch is not credited')
  const releaseIndices = holdIndices(indices)
  return new PartitionPlanBatch(rows, row => {
    const status = abi.module.call('terra_get_prepared_mesh_uv', abi.context,
      planId, row.draw.resourceId, 0, 0, 0)
    if (status) throw Object.assign(new Error('Prepared UV plan is unavailable'), {status})
    const input = resident(row)
    if (!input) return {task: abi.createPreparedPartitionTask(planId, row.draw, row.cells, indices, maximumBytes),
      source: 'sampled', release() {}}
    try { return {task: createPartitionPlanTask(input.model, row.cells), source: 'resident', release: input.release} }
    catch (error) { input.release(); throw error }
  }, releaseIndices)
}

module.exports = {preparedPartitionBytes, createPreparedPartitionTask, createPreparedPartitionBatch}
