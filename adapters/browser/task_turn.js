const {CooperativeTurn} = require('../../sdk/js/runtime/cooperative_turn')

function clearTask(task) {
  if (!task) return
  task.callback = null
  if (task.channel) {
    task.channel.port1.onmessage = null
    task.channel.port1.close()
    task.channel.port2.close()
    task.channel = null
  }
  if (task.timer !== null) {clearTimeout(task.timer); task.timer = null}
}

// Ready continuations use a host task, while actual deadlines retain timers.
// Every pending task owns its dispatch handles; delivery/cancellation releases
// them before running user work. A detached callback cannot revive cancelled work.
function setTask(callback, delay = 0) {
  const task = {callback, channel:null, timer:null}
  const resume = () => {
    const callback = task.callback
    clearTask(task)
    if (callback) callback()
  }
  if (delay > 0 || typeof MessageChannel !== 'function') task.timer = setTimeout(resume, delay)
  else {
    try {
      task.channel = new MessageChannel()
      task.channel.port1.onmessage = resume
      task.channel.port2.postMessage(0)
    } catch (error) {clearTask(task); throw error}
  }
  return task
}

function createTaskTurn(options = {}) {
  if (typeof MessageChannel !== 'function') return new CooperativeTurn(options)
  return new CooperativeTurn(Object.assign({}, options, {
    schedule:setTask,
    cancel:clearTask
  }))
}

module.exports = {createTaskTurn, setTask, clearTask}
