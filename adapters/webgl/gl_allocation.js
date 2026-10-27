const { monotonicNow } = require('../../sdk/js/diagnostics/timing')

// Submission work, separate from resident-memory admission. A single larger
// asset may run alone so a legal source tile/mesh cannot be starved forever.
class UploadBudget {
  // Four ready 256px mipmapped siblings occupy about 1.34MiB. The default
  // admits that group without four GPU fences; object/time bounds and actual
  // resource credit remain independent limits on the work issued this turn.
  constructor(maximumBytes = 2 * 1024 * 1024, maximumObjects = 8) {
    if (![maximumBytes, maximumObjects].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('GPU upload limits must be positive integers')
    }
    this.maximumBytes = maximumBytes
    this.maximumObjects = maximumObjects
    this.bytes = this.objects = this.largestBytes = this.largestObjects = this.deferred = 0
  }

  fits(bytes, objects, single = true) {
    return this.bytes + bytes <= this.maximumBytes && this.objects + objects <= this.maximumObjects ||
      single && this.bytes === 0 && this.objects === 0
  }

  take(bytes, objects) {
    if (![bytes, objects].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('GPU upload cost is invalid')
    }
    if (!this.fits(bytes, objects)) { ++this.deferred; return false }
    this.bytes += bytes; this.objects += objects
    this.largestBytes = Math.max(this.largestBytes, bytes)
    this.largestObjects = Math.max(this.largestObjects, objects)
    return true
  }
}

// WebGL allocation failures do not throw. Validate new objects before publishing
// them to a cache; a failed batch owns and deletes every object it created.
// WebGL2 batches can wait for a fence across display callbacks before validation.
function prepareGl(gl, label, build) {
  const releases = []
  let bytes = 0
  const object = (create, destroy) => {
    const value = create()
    if (!value) throw new Error('WebGL ' + label + ' object allocation failed')
    releases.push(() => destroy(value))
    return value
  }
  try {
    const value = build({
      buffer(target, data) {
        bytes += data.byteLength
        const buffer = object(() => gl.createBuffer(), value => gl.deleteBuffer(value))
        gl.bindBuffer(target, buffer)
        gl.bufferData(target, data, gl.STATIC_DRAW)
        return buffer
      },
      texture(upload, byteSize = 0) {
        bytes += byteSize
        const texture = object(() => gl.createTexture(), value => gl.deleteTexture(value))
        gl.bindTexture(gl.TEXTURE_2D, texture)
        upload()
        return texture
      },
      framebuffer() {
        return object(() => gl.createFramebuffer(), value => gl.deleteFramebuffer(value))
      },
      renderbuffer(format, width, height, samples, byteSize) {
        bytes += byteSize
        const buffer = object(() => gl.createRenderbuffer(), value => gl.deleteRenderbuffer(value))
        gl.bindRenderbuffer(gl.RENDERBUFFER, buffer)
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, width, height)
        return buffer
      }
    })
    return {value, bytes, release: () => releases.reverse().forEach(release => release())}
  } catch (error) {
    releases.reverse().forEach(release => release())
    throw error
  }
}

// One ordered command group owns a completion boundary. The renderer queues
// display-only and allocation batches separately; display receipts never make
// an allocation error-query round trip.
class GlSubmission {
  constructor(gl, onValidation, budget) {
    this.gl = gl
    this.onValidation = onValidation
    this.items = []
    this.holds = []
    this.budget = budget
  }

  defer(drawn = false) {
    if (!drawn && !this.items.length && !this.holds.length) return false
    this.drawn = drawn
    this.sync = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    if (!this.sync) throw new Error('WebGL submission fence allocation failed')
    this.startedAt = monotonicNow()
    this.gl.flush()
    return true
  }

  poll() {
    if (!this.sync) return true
    const gl = this.gl, status = gl.clientWaitSync(this.sync, 0, 0)
    if (status === gl.TIMEOUT_EXPIRED) return false
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) {
      throw new Error('WebGL submission fence wait failed')
    }
    gl.deleteSync(this.sync); this.sync = null
    this.completed = true
    return true
  }

  hold(receipt) { this.holds.push(receipt) }

  releaseHolds(completed) {
    const holds = this.holds.splice(0)
    holds.forEach(receipt => receipt(completed))
  }

  stage(label, build, publish, cancel, cost) {
    if (this.budget && !this.budget.take(cost.bytes, cost.objects)) { cancel(); return false }
    let prepared
    try { prepared = prepareGl(this.gl, label, build) }
    catch (error) { cancel(); throw error }
    this.items.push({label, prepared, publish, cancel})
    return true
  }

  commit() {
    this.releaseHolds(true)
    if (!this.items.length) return
    const started = monotonicNow(), error = this.gl.getError()
    if (this.onValidation) this.onValidation(monotonicNow() - started)
    if (error !== this.gl.NO_ERROR) {
      const failure = new Error('WebGL ' + this.items[0].label + ' allocation failed (' + error + ')')
      failure.glError = error
      throw failure
    }
    // A stale owner may reject publication. Earlier committed items are no
    // longer batch-owned, even if a later callback fails.
    while (this.items.length) {
      const item = this.items.shift()
      try { if (item.publish(item.prepared.value) === false) item.prepared.release() }
      catch (error) { item.prepared.release(); item.cancel(); throw error }
    }
  }

  cancel(lost = false) {
    if (this.sync && !lost) this.gl.deleteSync(this.sync)
    this.sync = null
    this.items.reverse().forEach(item => { if (!lost) item.prepared.release(); item.cancel() })
    this.items = []
    this.releaseHolds(lost || this.completed === true)
  }
}

function allocateGl(gl, label, build, onValidation) {
  const batch = new GlSubmission(gl, onValidation)
  let value
  try {
    batch.stage(label, build, result => { value = result }, () => {})
    batch.commit()
    return value
  } catch (error) { batch.cancel(); throw error }
}

module.exports = { allocateGl, GlSubmission, UploadBudget }
