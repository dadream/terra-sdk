function statusError(operation, status, detail) {
  const suffix = detail ? `: ${detail}` : ''
  return Object.assign(new Error(
    `${operation} failed with Terra status ${status}${suffix}`), {status})
}

function requireStatus(status, operation, allowed) {
  const accepted = allowed || [0]
  if (accepted.indexOf(status) < 0) {
    throw statusError(operation, status)
  }
  return status
}

module.exports = {statusError, requireStatus}
