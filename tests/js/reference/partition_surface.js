const {createPartitionTask} = require('../../../sdk/js/terrain/terra_surface_plan')

// Synchronous oracle consumer; production uses cancellable cooperative tasks.
module.exports = (surface, cells) => {
  const task = createPartitionTask(surface, cells)
  while (!task.step().done) {}
  return task.value
}
