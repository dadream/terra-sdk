// A retained display target, not a copy of resolved default-framebuffer depth.
// Color resolves for presentation; depth and stencil keep their original samples.
class DisplayTarget {
  constructor(renderer) {
    this.renderer = renderer
    this.gl = renderer.gl
    this.retired = new Set()
    this.refunds = new Map()
    const gl = this.gl
    this.samples = gl.getParameter(gl.SAMPLES)
    this.supported = gl.getParameter(gl.DEPTH_BITS) === 24 && gl.getParameter(gl.STENCIL_BITS) === 8 &&
      (!this.samples || [gl.RGBA8, gl.DEPTH24_STENCIL8].every(format =>
        Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, format, gl.SAMPLES)).includes(this.samples)))
    if (!this.supported) return
    const shaders = []
    try {
      this.program = gl.createProgram()
      for (const [type, source] of [[gl.VERTEX_SHADER, `#version 300 es
        out vec2 uv;
        void main() {
          uv=vec2(float((gl_VertexID << 1) & 2),float(gl_VertexID & 2));
          gl_Position=vec4(uv*2.0-1.0,0.0,1.0);
        }`], [gl.FRAGMENT_SHADER, `#version 300 es
        precision highp float;
        in vec2 uv; uniform sampler2D image; out vec4 color;
        void main() { color=texture(image,uv); }`]]) {
        const shader = gl.createShader(type)
        shaders.push(shader)
        gl.shaderSource(shader, source); gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
        gl.attachShader(this.program, shader)
      }
      gl.linkProgram(this.program)
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program))
      this.image = gl.getUniformLocation(this.program, 'image')
    } catch (error) { this.destroy(); throw error }
    finally { shaders.forEach(shader => gl.deleteShader(shader)) }
    this.unregister = renderer.resourceLedger.reclamation.register({
      owner: 'display-target',
      revision: () => this.pending || this.current || this.retired.values().next().value || null,
      reclaim: () => this.reclaim()
    })
  }

  valid(value = this.current) {
    const r = this.renderer
    return value && !r.contextLost && value.width === r.canvas.width && value.height === r.canvas.height
  }

  release(value, lost = false) {
    if (!value || value.released) return
    if (value.busy && !lost) {
      value.lease.mark('retired'); this.retired.add(value); return
    }
    value.released = true
    this.retired.delete(value)
    if (!lost && !value.abandoned) {
      const gl = this.gl
      gl.deleteFramebuffer(value.framebuffer); gl.deleteFramebuffer(value.resolve)
      gl.deleteRenderbuffer(value.color); gl.deleteRenderbuffer(value.depth)
      gl.deleteTexture(value.texture)
    }
    this.refund(value.lease)
  }

  refund(lease) {
    const bytes = lease.bytes
    lease.release()
    const receipt = this.refunds.get(lease)
    if (receipt) { this.refunds.delete(lease); receipt.resolve(bytes) }
  }

  retire() {
    if (this.current) { const value = this.current; this.current = null; this.release(value) }
    // Retained samples accelerate queries, but are not their visibility proof.
    // The observer can continue from a normal draw using the default target.
    this.renderer.surfaceCommands.clear()
    this.renderer.requestRender()
  }

  reclaim() {
    const values = Array.from(this.retired)
    if (this.current) values.push(this.current)
    if (this.pending) { this.pending.cancelled = true; values.push(this.pending) }
    if (!values.length) return 0
    const receipts = values.map(value => {
      const lease = value.lease
      if (!this.refunds.has(lease)) {
        let resolve
        const promise = new Promise(done => { resolve = done })
        this.refunds.set(lease, {promise, resolve})
      }
      return this.refunds.get(lease).promise
    })
    this.retire()
    // Existing submission receipts own both allocation cancellation and busy
    // samples. Never refund queued storage, or introduce a private GPU fence.
    this.renderer.requestResources()
    return Promise.all(receipts).then(bytes => bytes.reduce((sum, value) => sum + value, 0))
  }

  prepare(needed) {
    this.needed = Boolean(needed)
    // The default framebuffer already owns presentation. Retain a second
    // color/depth surface only while a visibility sweep needs its samples.
    // Submitted work keeps physical ownership until the existing GPU receipt.
    if (!this.needed) {
      if (this.current) { this.release(this.current); this.current = null }
      return
    }
    if (!this.supported || this.destroyed || this.pending || this.valid()) return
    const r = this.renderer, gl = this.gl, width = r.canvas.width, height = r.canvas.height
    const key = width + ':' + height
    if (this.current) { this.release(this.current); this.current = null }
    if (this.failed === key || !width || !height) return
    if (this.blocked === r.resourceLedger.availabilityRevision) return
    // Two multisample renderbuffers and one complete single-sample RGBA8 resolve.
    // The browser-owned default framebuffer is not counted as refundable credit.
    const planeBytes = width * height * 4, sampledBytes = planeBytes * Math.max(1, this.samples)
    const bytes = sampledBytes * 2 + planeBytes
    // This optional cache must not evict required terrain/images or compete
    // with a producer waiting for actual reclamation receipts.
    if (r.resourceLedger.reclamation.pending) return
    if (r.resourceLedger.maximumBytes && r.resourceLedger.bytes + bytes > r.resourceLedger.maximumBytes) {
      this.blocked = r.resourceLedger.availabilityRevision; return
    }
    if (r.uploadBatch && !r.uploadBatch.budget.fits(bytes, 5)) { r.requestResources(); return }
    const lease = r.resourceLedger.reserve('display-target', bytes)
    if (!lease) { this.blocked = r.resourceLedger.availabilityRevision; return }
    this.blocked = undefined
    const pending = this.pending = {width, height, lease}
    const submission = r.uploadBatch
    const cancel = () => {
      this.pending = null
      if (!pending.allocated || r.contextLost || this.drained || submission && submission.completed) this.refund(lease)
      else {
        // A failed fence is not a completion receipt. GL has deleted the batch's
        // handles, but its queued storage stays charged until the next receipt.
        pending.busy = pending.abandoned = true
        this.release(pending)
        r.requestResources()
      }
      if (pending.allocated) this.failed = key
    }
    try {
      r.stageResources('display target', {bytes, objects: 5}, resources => {
        pending.allocated = true
        try {
          const framebuffer = resources.framebuffer(), resolve = resources.framebuffer()
          const color = resources.renderbuffer(gl.RGBA8, width, height, this.samples, sampledBytes)
          const depth = resources.renderbuffer(gl.DEPTH24_STENCIL8, width, height, this.samples, sampledBytes)
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color)
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth)
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Display framebuffer is incomplete')
          const texture = resources.texture(() => {
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
          }, planeBytes)
          gl.bindFramebuffer(gl.FRAMEBUFFER, resolve)
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Display resolve is incomplete')
          return {framebuffer, resolve, color, depth, texture, lease, width, height}
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.bindRenderbuffer(gl.RENDERBUFFER, null)
        }
      }, value => {
        this.pending = false
        if (this.destroyed || pending.cancelled || !this.needed || !this.valid(value)) { this.refund(lease); return false }
        lease.mark('resident')
        this.current = value
        lease.reclaimable = () => this.current === value && !value.busy
        lease.reclaim = () => this.retire()
        r.surfaceCommands.clear()
      }, cancel)
    } catch (error) {
      this.failed = key
      r.onDiagnostic('display_target_unavailable', {message: error.message})
    }
  }

  begin() {
    if (!this.valid()) return false
    this.current.busy = true
    this.current.owner = null
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.current.framebuffer)
    return true
  }

  present(surface) {
    const r = this.renderer, gl = this.gl, value = this.current
    const {width, height} = value
    gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, value.framebuffer)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, value.resolve)
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    // A default MSAA draw buffer cannot be a blit destination. Present resolved
    // color with a full-screen triangle, leaving retained depth/stencil intact.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, value.texture)
    gl.uniform1i(this.image, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.depthMask(true); gl.enable(gl.DEPTH_TEST); gl.useProgram(r.program)
    value.owner = surface.current; value.camera = r.cameraVersion
  }

  reusable(surface) {
    const value = this.current
    return this.valid(value) && value.owner === surface.current && value.camera === this.renderer.cameraVersion
  }

  observe(callback) {
    const value = this.current, gl = this.gl
    value.busy = true
    this.observationPasses = (this.observationPasses || 0) + 1
    gl.bindFramebuffer(gl.FRAMEBUFFER, value.framebuffer)
    try { callback() }
    finally { gl.bindFramebuffer(gl.FRAMEBUFFER, null) }
  }

  submit(batch) {
    const values = Array.from(this.retired)
    if (this.current) values.push(this.current)
    for (const value of values) {
      if (!value.busy || value.released) continue
      batch.hold(completed => {
        if (!completed) { if (!this.destroyed) this.renderer.requestResources(); return }
        value.busy = false
        if (this.retired.has(value)) this.release(value)
      })
    }
  }

  stats() {
    const values = Array.from(this.retired)
    if (this.current) values.push(this.current)
    if (this.pending) values.push(this.pending)
    return {samples: this.samples, needed: Boolean(this.needed), ready: Boolean(this.valid()), preparing: Boolean(this.pending),
      retired: this.retired.size, observationPasses: this.observationPasses || 0,
      bytes: values.reduce((sum, value) => sum + value.width * value.height * 4 * (2 * Math.max(1, this.samples) + 1), 0)}
  }

  destroy(lost = false) {
    this.destroyed = true
    if (this.unregister) { this.unregister(); this.unregister = null }
    // Explicit synchronous teardown is the only blocking drain. Normal redraw,
    // resize and queries use the renderer's existing asynchronous receipt lane.
    const values = Array.from(this.retired)
    if (this.current) values.push(this.current)
    if (!lost && (this.pending || values.some(value => value.busy))) this.gl.finish()
    this.drained = true
    values.forEach(value => { value.busy = false; this.release(value, lost) })
    this.current = null
    if (this.program && !lost) this.gl.deleteProgram(this.program)
    this.program = null
  }
}

module.exports = {DisplayTarget}
