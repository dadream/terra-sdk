const {responseLimit, responseSizeError} = require('../../sdk/js/transport/response_limits')

// Keep the deadline active through body consumption. AbortError alone cannot
// distinguish a deadline from cancellation by the request owner.
function browserRequest(options) {
  const maximumBytes = responseLimit(options.maximumResponseBytes)
  const controller = new AbortController()
  let reason = null, settled = false
  const abort = name => {
    if (settled || reason) return
    reason = name
    controller.abort()
  }
  const timer = setTimeout(() => abort('TimeoutError'), options.timeout || 15000)
  const promise = Promise.resolve().then(() => fetch(options.url, {
    method: options.method || 'GET', signal: controller.signal, cache: 'no-store'
  })).then(async response => {
    // Never delegate bounded SDK input to an unbounded arrayBuffer()/text().
    // Fetch owns each incoming chunk; copy only accepted bytes into one bounded
    // buffer so a small subview cannot retain a large transport-owned backing.
    const declared = response.headers.get('content-length')
    let bytes = new Uint8Array(0)
    if (reason) {
      if (response.body) await response.body.cancel().catch(() => {})
      throw new Error('Request interrupted')
    }
    if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
      if (response.body) await response.body.cancel().catch(() => {})
      throw responseSizeError()
    }
    if (response.body) {
      if (typeof response.body.getReader !== 'function') throw new Error('Response requires a readable body')
      const reader = response.body.getReader(), buffer = new Uint8Array(maximumBytes)
      let size = 0, complete = false
      try {
        for (;;) {
          if (reason) throw new Error('Request interrupted')
          const next = await reader.read()
          if (reason) throw new Error('Request interrupted')
          if (next.done) { complete = true; break }
          if (!(next.value instanceof Uint8Array)) throw new Error('Response contains a nonbinary chunk')
          if (next.value.byteLength > maximumBytes - size) throw responseSizeError()
          buffer.set(next.value, size); size += next.value.byteLength
        }
        bytes = buffer.slice(0, size)
      } finally {
        if (!complete) await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    let data = bytes.buffer
    if (options.responseType !== 'arraybuffer') {
      const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes)
      data = text ? JSON.parse(text) : null
    }
    if (reason) throw new Error('Request interrupted')
    const header = {}
    response.headers.forEach((value, name) => { header[name] = value })
    return {statusCode: response.status, data, header}
  }).catch(error => {
    if (reason) throw Object.assign(new Error(reason === 'TimeoutError'
      ? 'Browser request timed out' : 'Browser request was cancelled'), {name: reason})
    throw error
  }).finally(() => { settled = true; clearTimeout(timer) })
  return {promise, abort: () => abort('AbortError')}
}

module.exports = {browserRequest}
