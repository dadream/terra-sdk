const {invariant} = require('../../sdk/js/core/terra_globe_common')
const {CooperativeTask} = require('../../sdk/js/runtime/cooperative_task')

const SAMPLE_VERTICES = 1024

function preparedSurfaceBytes(draw) {
  invariant(draw && Number.isInteger(draw.vertexCount) && draw.vertexCount > 0 &&
    draw.vertexCount <= 33153, 'Invalid prepared surface dimensions')
  // One shared native XYZ/UV slice and one JS position/UV pair. The caller
  // retains output credit until it releases the result, even after completion.
  // Topology/measurement metadata and index storage are separate owners.
  return SAMPLE_VERTICES * 12 + draw.vertexCount * 20
}

function createPreparedSurfaceTask(abi, planId, draw, maximumBytes) {
  invariant(Number.isSafeInteger(maximumBytes) && maximumBytes >= preparedSurfaceBytes(draw),
    'Prepared surface scratch/output is not credited')
  return new CooperativeTask(steps(abi, planId, draw.resourceId, draw.vertexCount))
}

function* steps(abi, planId, resourceId, vertexCount) {
  let pointer = 0
  const sample = (kind, first, count) => {
    const status = abi.module.call('terra_get_prepared_mesh_' + kind, abi.context,
      planId, resourceId, first, count, pointer)
    if (status) throw Object.assign(new Error('Prepared surface plan is unavailable'), {status})
  }
  try {
    sample('positions', 0, 0)
    pointer = abi.alloc(SAMPLE_VERTICES * 12)
    const positions = new Float32Array(vertexCount * 3), textureUv = new Float32Array(vertexCount * 2)
    for (let first = 0; first < vertexCount; first += SAMPLE_VERTICES) {
      const count = Math.min(SAMPLE_VERTICES, vertexCount - first)
      sample('positions', first, count)
      positions.set(new Float32Array(abi.module.refreshMemory().bytes.buffer, pointer, count * 3), first * 3)
      sample('uv', first, count)
      textureUv.set(new Float32Array(abi.module.refreshMemory().bytes.buffer, pointer, count * 2), first * 2)
      yield
    }
    // A last-slice yield may have replaced/discarded the plan. Never return a
    // partial or stale result; cancellation releases native scratch in finally.
    sample('positions', 0, 0)
    return {positions, textureUv}
  } finally { if (pointer) abi.free(pointer) }
}

module.exports = {SAMPLE_VERTICES, preparedSurfaceBytes, createPreparedSurfaceTask}
