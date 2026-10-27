// Real GPU sample preservation, retained-query progress and physical ownership.
// No network access and no production timing/precision thresholds are changed.
window.verifyDisplayTarget = async function (sdk) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
  const gl = canvas.getContext('webgl2', {alpha: false, antialias: true, stencil: true, preserveDrawingBuffer: true})
  const check = (value, message) => { if (!value) throw Error(message) }
  check(gl, 'Retained display fixture requires WebGL2')
  const {DisplayTarget} = sdk.testDisplayTarget, {GlSubmission} = sdk.testGlAllocation
  const ledger = new sdk.testLedger.ResourceLedger(1024 * 1024)
  const shaders = [], program = gl.createProgram(), results = []
  let target, observer, batch, batches = 0, terrainDraws = 0
  const r = {gl, canvas, program, resourceLedger: ledger, cameraVersion: 1, plannedCameraVersion: 1,
    surfaceCommands: {clear() {}}, measurements: new Map(), options: {},
    requestRender() {}, requestResources() {}, onDiagnostic(kind, data) {throw Error(kind + ': ' + data.message)},
    stageResources(label, cost, build, publish, cancel) {
      check(!batch, 'Allocation bypassed the one-submission lane')
      batch = new GlSubmission(gl)
      return batch.stage(label, build, publish, cancel, cost)
    }}
  const complete = async () => {
    if (!batch) batch = new GlSubmission(gl)
    target.submit(batch); check(batch.defer(true), 'Missing GPU receipt'); ++batches
    const started = performance.now()
    while (!batch.poll()) {
      check(performance.now() - started < 5000, 'Retained display GPU deadline')
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    batch.commit(); batch = null
  }
  const pixels = () => {const p = new Uint8Array(64 * 64 * 4); gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, p); return p}
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, `#version 300 es
      uniform vec2 span; uniform bool striped; uniform float depth;
      void main() {vec2 uv=vec2(gl_VertexID&1,(gl_VertexID>>1)&1);
        float x=striped?(float(gl_InstanceID)+mix(span.x,span.y,uv.x))/64.0:uv.x;
        gl_Position=vec4(x*2.0-1.0,uv.y*2.0-1.0,depth,1.0);}`],
    [gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;out vec4 color;uniform vec4 paint;void main(){color=paint;}']]) {
      const shader = gl.createShader(type); shaders.push(shader)
      gl.shaderSource(shader, source); gl.compileShader(shader)
      check(gl.getShaderParameter(shader, gl.COMPILE_STATUS), gl.getShaderInfoLog(shader)); gl.attachShader(program, shader)
    }
    gl.linkProgram(program); check(gl.getProgramParameter(program, gl.LINK_STATUS), gl.getProgramInfoLog(program))
    const span = gl.getUniformLocation(program, 'span'), striped = gl.getUniformLocation(program, 'striped')
    const depth = gl.getUniformLocation(program, 'depth'), paint = gl.getUniformLocation(program, 'paint')
    const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
    const draws = Array.from({length: 25}, (_, i) => ({resourceId: i+1, geometryKey: 'mesh:'+(i+1),
      origin: [0,0,0], firstIndex: 0, indexCount: 4, flags: 0}))
    r.current = {frame: {projectionView: identity, cameraPosition: [0,0,0]}, draws,
      imageryPlan: {quality: {limitedByTextureBudget: true, planningComplete: true}}}
    r.geometry = new Map(draws.map((draw, i) => [draw.geometryKey, {model: {
      hull: [[0,0],[1,0],[1,1],[0,1]], faces: new Uint16Array([0,1,2]), blocks: [{faces: [0],
        minimum: [-.5,-.5,i ? .2 : -.2], maximum: [.5,.5,i ? .2 : -.2]}]}}]))
    const surface = {current: r.current}, submitted = draws.map(draw => [draw, false])
    target = new DisplayTarget(r); check(target.supported && target.samples > 0, 'Missing requested MSAA target capability')
    observer = new sdk.testVisibility.TerrainVisibility(r); observer.target = target
    const charged = 64 * 64 * 4 * (2 * target.samples + 1)
    ledger.setLimit(charged + 32)
    const cached = ledger.reserve('imagery-cache', 64)
    cached.mark('resident'); cached.reclaimable = () => true; cached.reclaim = () => cached.release()
    target.prepare(true)
    check(!batch && cached.active && ledger.bytes === 64,
      'Optional depth storage evicted image data to admit itself')
    cached.release(); ledger.setLimit(1024 * 1024)
    r.current.imageryPlan.quality.limitedByTextureBudget = false
    target.prepare(observer.needsDepth())
    check(!batch && !target.valid() && ledger.bytes === 0, 'Affordable view allocated unused display attachments')
    r.current.imageryPlan.quality.limitedByTextureBudget = true
    target.prepare(observer.needsDepth()); check(!target.valid() && ledger.bytes > 0, 'Allocation published without GPU completion')
    await complete(); check(target.valid(), 'Completed target did not publish')
    check(ledger.bytes === charged, 'Display attachments were not fully priced')
    for (const gap of [-1,0,1,2,3,'overlay']) {
      observer.reset(); target.begin()
      check(gl.getParameter(gl.SAMPLES) === target.samples, 'Observation changed sample count')
      gl.viewport(0, 0, 64, 64); gl.useProgram(program); gl.disable(gl.CULL_FACE)
      gl.colorMask(true,true,true,true); gl.depthMask(true); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL)
      gl.enable(gl.STENCIL_TEST); gl.stencilMask(255); gl.stencilFunc(gl.ALWAYS,1,255); gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE)
      gl.clearColor(0,0,0,1); gl.clearDepth(1); gl.clearStencil(0)
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT)
      gl.uniform1i(striped,1); gl.uniform1f(depth,-.2); gl.uniform4f(paint,.25,.5,.75,1)
      const ranges = gap === -1 || gap === 'overlay' ? [[0,1]] : [[0,gap/4],[(gap+1)/4,1]]
      for (const [a,b] of ranges) if (b > a) {
        gl.uniform2f(span,a,b); gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,64); ++terrainDraws
      }
      // Deliberately start ALL queries after presentation, including coarse
      // fill or an overlay that would falsely occlude if its stencil were lost.
      gl.stencilFunc(gap === 'overlay' ? gl.ALWAYS : gl.EQUAL,0,255)
      gl.stencilOp(gl.KEEP,gl.KEEP,gap === 'overlay' ? gl.REPLACE : gl.KEEP)
      gl.uniform1i(striped,0); gl.uniform1f(depth,-.4); gl.uniform4f(paint,.75,.25,.5,1)
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4)
      target.present(surface)
      const displayed = pixels()
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,target.current.resolve)
      const resolved = pixels()
      gl.bindFramebuffer(gl.FRAMEBUFFER,null)
      check(displayed.every((v,i) => v === resolved[i]), 'Presentation changed resolved color')
      await complete()
      // Simulate discard of every default framebuffer attachment. Queries must
      // still use retained samples and never repaint terrain to regain depth.
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT)
      const before = terrainDraws
      for (let i = 0; i < 8 && !observer.done; ++i) {
        check(!observer.needsDraw(surface), 'Retained observation requested a terrain redraw')
        if (i === 0) observer.resume(surface, submitted); else observer.advance()
        if (i === 0) {
          r.current.imageryPlan.quality.limitedByTextureBudget = false
          check(observer.needsDepth(), 'Affordable feedback revoked an unfinished sweep')
          target.prepare(observer.needsDepth())
          check(target.valid() && ledger.bytes === charged, 'Query samples lost their ownership')
        }
        await complete()
        r.current.imageryPlan.quality.visibilityRevision = observer.revision
      }
      check(observer.done && terrainDraws === before, 'Retained query sweep did not progress independently')
      check(gap === -1 ? observer.hiddenIds.size === 24 : observer.hiddenIds.size === 0,
        'Retained samples misclassified gap ' + gap + ': ' + Array.from(observer.hiddenIds))
      results.push({gap, hidden: observer.hiddenIds.size})
      check(gl.getError() === gl.NO_ERROR, 'Retained observation generated a GL error')
      check(!observer.needsDepth(), 'Completed proof kept unused depth storage')
      const proof = observer.snapshot()
      if (gap === -1) {
        ledger.setLimit(charged + 64)
        const required = ledger.reserve('imagery-input', 128)
        check(required && !target.current && observer.snapshot() === proof && proof.hidden.length === 24,
          'Reclaiming depth discarded verified occlusion evidence')
        required.release(); ledger.setLimit(1024 * 1024)
      }
      target.prepare(observer.needsDepth())
      check(!target.current && ledger.bytes === 0 && observer.snapshot() === proof,
        'Releasing completed depth discarded proof or retained its attachments')
      r.current.imageryPlan.quality.limitedByTextureBudget = true
      observer.reset(); target.prepare(observer.needsDepth()); await complete()
    }
    ledger.setLimit(charged + 64)
    const idle = target.current
    const image = ledger.reserve('imagery-input', 128)
    check(image && idle.released && !target.current && ledger.bytes === 128,
      'Idle optional depth prevented image admission')
    target.prepare(true)
    check(!batch && image.active, 'Optional depth displaced its waiting producer')
    image.release(); target.prepare(true); await complete()
    // A submitted target must yield too, but its physical bytes cannot be
    // promised to an image until the ordinary shared GPU receipt arrives.
    target.begin()
    const busy = target.current
    check(!ledger.reserve('imagery-input', 128), 'Busy target was refunded synchronously')
    const reclaim = ledger.reclamation.pending
    check(reclaim, 'Busy optional depth has no pressure continuation')
    await Promise.resolve(); await Promise.resolve()
    check(!target.current && !busy.released && ledger.bytes === charged,
      'Pressure did not retire busy depth while preserving its charge')
    target.prepare(true)
    check(!batch, 'Pressure retirement immediately recreated the same target')
    await complete(); await reclaim
    check(busy.released && ledger.bytes === 0, 'GPU receipt did not finish depth reclamation')
    const resumed = ledger.reserve('imagery-input', 128)
    check(resumed, 'Image admission did not recover after the target receipt')
    resumed.release()
    // Pending allocation is owned by its resource batch, including when a
    // later prepare still asks for depth. Pressure cancels publication only.
    target.prepare(true)
    check(batch && !target.current && ledger.bytes === charged, 'Missing pending target')
    check(!ledger.reserve('imagery-input', 128), 'Pending target was refunded before upload completion')
    const allocationReclaim = ledger.reclamation.pending
    check(allocationReclaim, 'Pending target has no reclamation continuation')
    await Promise.resolve(); await Promise.resolve()
    target.prepare(true)
    check(ledger.bytes === charged, 'Pending allocation lost its physical ownership')
    await complete(); await allocationReclaim
    check(!target.current && ledger.bytes === 0, 'Pressured allocation published or retained storage')
    ledger.setLimit(1024 * 1024)
    target.prepare(true); await complete()
    // Camera motion revokes demand even when the target is still borrowed by
    // a submitted pass. The same receipt, not elapsed time, releases storage.
    target.begin()
    const moving = target.current
    ++r.cameraVersion
    target.prepare(observer.needsDepth())
    check(!target.current && !moving.released && ledger.bytes === charged,
      'Camera motion refunded depth before its GPU receipt')
    await complete()
    check(moving.released && ledger.bytes === 0, 'Camera receipt retained obsolete depth')
    r.plannedCameraVersion = r.cameraVersion
    target.prepare(observer.needsDepth())
    check(batch && ledger.bytes === charged, 'New limited view failed to request samples')
    r.interactionActive = true
    target.prepare(observer.needsDepth())
    check(ledger.bytes === charged, 'Demand cancellation refunded an in-flight allocation')
    await complete()
    check(!target.current && ledger.bytes === 0, 'Cancelled allocation became a display target')
    r.interactionActive = false
    target.prepare(observer.needsDepth()); await complete()
    const old = target.current
    target.begin(); canvas.width = 80
    const nextBytes = 80 * 64 * 4 * (2 * target.samples + 1)
    ledger.setLimit(charged + nextBytes - 1)
    target.prepare(true)
    check(!target.current && old.busy && ledger.bytes === charged && !old.released && !batch,
      'Resize refunded in-flight storage or overcommitted replacement')
    await complete()
    check(old.released && ledger.bytes === 0, 'Receipt did not retire old attachments')
    target.prepare(true); await complete()
    check(target.valid() && ledger.bytes === nextBytes, 'Resize did not recover after physical admission')
    // Failure to create a fence must retain both an old depth borrower and a
    // just-allocated replacement, even though GL has deleted the latter handles.
    target.begin(); canvas.width = 96; ledger.setLimit(1024 * 1024)
    target.prepare(true); target.submit(batch)
    const fence = gl.fenceSync.bind(gl)
    let failed = false
    try {
      gl.fenceSync = () => null
      try { batch.defer(true) } catch (_) { failed = true }
    } finally { gl.fenceSync = fence }
    batch.cancel(); batch = null
    check(failed && target.retired.size === 2 && ledger.bytes ===
      nextBytes + 96 * 64 * 4 * (2 * target.samples + 1), 'Failed fence refunded queued attachment storage')
    ledger.setLimit(ledger.bytes + 64)
    check(!ledger.reserve('imagery-input', 128), 'Failed fence storage was counted as free capacity')
    const failedReclaim = ledger.reclamation.pending
    check(failedReclaim, 'Failed fence retirement has no pressure continuation')
    await Promise.resolve(); await Promise.resolve()
    await complete(); await failedReclaim
    check(ledger.bytes === 0 && target.retired.size === 0, 'Recovery receipt did not release failed allocations')
    canvas.width = 80; target.prepare(true); await complete()
    ++r.cameraVersion
    check(!target.reusable(surface) && !observer.snapshot(), 'Camera change reused depth proof')
    target.begin(); ledger.setLimit(ledger.bytes + 64)
    check(!ledger.reserve('imagery-input', 128), 'Teardown fixture lost busy ownership')
    const teardownReclaim = ledger.reclamation.pending
    await Promise.resolve(); await Promise.resolve()
    observer.destroy(); observer = null
    await teardownReclaim
    check(ledger.bytes === 0, 'Explicit teardown retained attachment ownership')
    check(ledger.reclamation.owners.size === 0, 'Teardown retained its reclamation provider')
    check(gl.getError() === gl.NO_ERROR, 'Target teardown generated a GL error')
    return {samples: target.samples, charged, results, batches, independentQueries: true,
      colorUnchanged: true, resizeAdmission: true, receiptRetirement: true, failedFenceRetained: true, teardownReleased: true,
      optionalAdmission: true, idleReclaim: true, pressureReceiptRetirement: true, pendingAllocationReclaim: true,
      demandDriven: true, proofPreserved: true, cancelledAllocationReleased: true}
  } finally {
    if (batch) batch.cancel(gl.isContextLost())
    if (observer) observer.destroy(gl.isContextLost()); else if (target) target.destroy(gl.isContextLost())
    shaders.forEach(shader => gl.deleteShader(shader)); gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context').loseContext(); canvas.remove()
  }
}
