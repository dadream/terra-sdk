const {visibilityBounds} = require('../../sdk/js/terrain/visibility_bounds')
const {visibilityMembers} = require('../../sdk/js/terrain/visibility_evidence')
const {visibilityCoverage} = require('../../sdk/js/terrain/visibility_coverage')
const {offscreenCoverage} = require('./visibility_dependencies')
const {VisibilityProofs} = require('./visibility_proofs')
const {DisplayTarget} = require('./display_target')

// Browser entry injects this observer. It shares the renderer's completion
// boundary; no private RAF, timer, terrain copy or GPU fence.
class TerrainVisibility {
  constructor(renderer) {
    this.renderer = renderer
    this.gl = renderer.gl
    this.pending = []
    this.proofs = new VisibilityProofs(renderer)
    // Renderer ownership survives a context/observer replacement. A prior
    // plan receipt must never acknowledge a new observer's first snapshot.
    this.revision = renderer.visibilityRevision || 0
    const gl = this.gl, shaders = []
    try {
      this.program = gl.createProgram()
      for (const [type, source] of [[gl.VERTEX_SHADER, `#version 300 es
        precision highp float;
        uniform vec4 rectangle; uniform float depth;
        void main() {
          vec2 uv=vec2(gl_VertexID & 1, (gl_VertexID >> 1) & 1);
          gl_Position=vec4(mix(rectangle.xy,rectangle.zw,uv),depth,1.0);
        }`], [gl.FRAGMENT_SHADER, `#version 300 es
        precision highp float; out vec4 color;
        void main() { color=vec4(0.0); }`]]) {
        const shader = gl.createShader(type)
        shaders.push(shader)
        gl.shaderSource(shader, source); gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
        gl.attachShader(this.program, shader)
      }
      gl.linkProgram(this.program)
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program))
      this.rectangle = gl.getUniformLocation(this.program, 'rectangle')
      this.depth = gl.getUniformLocation(this.program, 'depth')
    } catch (error) { this.destroy(); throw error }
    finally { shaders.forEach(shader => gl.deleteShader(shader)) }
  }

  valid() {
    const r = this.renderer
    return !r.contextLost && this.owner === r.current && this.version === r.cameraVersion &&
      this.width === r.canvas.width && this.height === r.canvas.height
  }

  snapshot() {
    if (!this.valid()) { this.reset(this.renderer.contextLost); return null }
    return this.evidence && this.evidence.hidden.length ? this.evidence : null
  }
  hidden(id) { return Boolean(this.snapshot() && this.publishedIds.has(id)) }

  publicationGuard() {
    const r = this.renderer
    if (!this.valid() || this.failed || !this.scope || r.interactionActive || r.heldCandidate ||
        !r.displaySurface || r.displaySurface.current !== r.current) return null
    // Share the fast projection allowance across this entire preparation pass.
    const fast = offscreenCoverage(r)
    return (key, draws) => {
      const geometry = r.geometry.get(key)
      if (!geometry || !geometry.partitionDraws || this.hiddenKeys.has(key) || !this.scope.has(key)) return true
      const previous = geometry.partitionDraws
      if (previous.length === draws.length && previous.every((old, i) => {
        const next = draws[i]
        return (old.flags & 1) === (next.flags & 1) && Boolean(old.imageryClipCell) === Boolean(next.imageryClipCell) &&
          (!old.imageryClipCell || (old.imageryCellScale || 1) === (next.imageryCellScale || 1) &&
            (old.imageryCellOffsetX || 0) === (next.imageryCellOffsetX || 0) &&
            (old.imageryCellOffsetY || 0) === (next.imageryCellOffsetY || 0))
      })) return true
      const coverage = visibilityCoverage(draws.map(draw => [draw, Boolean(draw.imageryClipCell)]),
        r.geometry, this.hiddenIds)
      // Keep actual old coverage while CPU proof advances. A completed unknown
      // result allows the change; only the post-submission observer may decide
      // whether its old visibility evidence still applies.
      return this.proofs.checkCoverage(key, this.scope.get(key), coverage.get(key), fast) !== null
    }
  }

  targetSatisfied() {
    const r = this.renderer, display = r.qualityStats
    const plan = r.current && r.current.imageryPlan && r.current.imageryPlan.quality
    return Boolean(display && plan && plan.planningComplete === true && plan.cameraCurrent !== false &&
      r.lastSubmittedSurface === r.current && r.presentedCameraVersion === r.cameraVersion &&
      r.plannedCameraVersion === r.cameraVersion && !r.presentation.active && !display.coverageSubmitted &&
      Number.isFinite(plan.targetPixelError) && plan.targetPixelError > 0 &&
      Number.isFinite(display.resolvedMaxPixelError) && display.resolvedMaxPixelError <= plan.targetPixelError * 1.001)
  }

  needsObservation() {
    return !this.failed && (this.pending.length > 0 || !this.targetSatisfied() &&
      (!this.done || this.hiddenIds.size !== this.publishedIds.size))
  }

  needsDepth() {
    const r = this.renderer
    if (!r.current || r.interactionActive || r.heldCandidate ||
        r.displaySurface && r.displaySurface.current !== r.current) return false
    // A plan becoming affordable alone is insufficient: its imagery must reach
    // the current display. Then optional observation parks, keeping progress and
    // evidence but releasing depth after any issued query receipts are consumed.
    if (this.valid()) return this.needsObservation()
    return r.plannedCameraVersion === r.cameraVersion && Boolean(r.current.imageryPlan &&
      r.current.imageryPlan.quality.limitedByTextureBudget)
  }

  wake() {
    if (this.target && this.target.valid()) this.renderer.requestResources()
    else this.renderer.requestRender()
  }

  reset(lost = false) {
    if (!lost) this.pending.forEach(item => this.gl.deleteQuery(item.query))
    this.pending = []
    this.owner = this.evidence = null
    this.draws = null
    this.hiddenIds = new Set()
    this.hiddenKeys = new Set()
    this.publishedIds = new Set()
    this.scope = null
    this.done = false
  }

  publish() {
    if (this.hiddenIds.size === this.publishedIds.size) return
    const r = this.renderer, quality = r.current.imageryPlan && r.current.imageryPlan.quality
    if (!quality) return
    // One published snapshot at a time. Continue gathering query results while
    // the Worker finishes its immutable plan; do not rebase it every GPU batch.
    if (this.evidence && (quality.visibilityRevision !== this.evidence.revision ||
        quality.planningComplete === false || quality.cameraCurrent === false)) return
    this.publishedIds = new Set(this.hiddenIds)
    this.evidence = {schema: 'terra.terrain-visibility.v2', revision: ++this.revision,
      projectionView: Array.from(r.current.frame.projectionView),
      cameraPosition: Array.from(r.current.frame.cameraPosition),
      members: visibilityMembers(this.draws), viewport: [this.width, this.height],
      hidden: Array.from(this.publishedIds).sort((a, b) => a - b)}
    r.visibilityRevision = this.revision
    r.measurements.clear()
    if (r.options.onImageryPlanningChange) r.options.onImageryPlanningChange()
    r.requestRender()
  }

  observe(surface, stencilEnabled, submitted, masked = false) {
    const r = this.renderer, gl = this.gl
    this.invalidated = false
    if (r.interactionActive || surface.current !== r.current || r.heldCandidate) return
    // Affordable cuts need no extra GPU work. A sweep starts only from a
    // camera-current, capacity-limited plan; it never competes with pointer
    // previews or makes a settled all-visible view replan an identical cut.
    if (!this.valid() && (r.plannedCameraVersion !== r.cameraVersion ||
        !r.current.imageryPlan || !r.current.imageryPlan.quality.limitedByTextureBudget)) return
    if (this.valid() && this.failed) return
    // Adding coverage cannot expose a hidden surface. Losing an occluder can;
    // discard both published and pending proof before consuming query results.
    // Proven hidden members contribute no nearest surface and are not dependencies.
    const scope = hidden => visibilityCoverage(submitted, r.geometry, hidden)
    // An observation-only batch cannot change the retained framebuffer. Its
    // established dependency footprint remains exact without rebuilding draws.
    let coverage = submitted ? scope(this.valid() ? this.hiddenIds : new Set()) : this.scope
    const fast = offscreenCoverage(r)
    const changed = submitted && this.valid() && Array.from(this.scope).some(([key, before]) =>
      !this.hiddenKeys.has(key) && this.proofs.checkCoverage(key, before, coverage.get(key), fast) !== true)
    if (changed && this.snapshot()) {
      this.reset()
      this.invalidated = true
      if (r.options.onImageryPlanningChange) r.options.onImageryPlanningChange()
    }
    if (!this.valid() || changed) {
      this.reset()
      this.owner = r.current; this.version = r.cameraVersion
      this.width = r.canvas.width; this.height = r.canvas.height
      this.draws = r.current.draws.filter(draw => !(draw.flags & 1))
      this.index = 0
      // Demand uses resource IDs. Multiple instances at different origins
      // would need per-instance evidence; keep them unknown for this backend.
      this.failed = new Set(this.draws.map(draw => draw.resourceId)).size !== this.draws.length
      coverage = this.scope = scope(new Set())
    }
    if (this.failed) return
    // Adopt the verified footprint even after the sweep is complete. Otherwise
    // a later cache eviction would make an already-proved old loss uncertain
    // again, despite no further change to the submitted surface.
    this.scope = coverage
    // Resource-clock observations can run after the terrain pass has disabled
    // culling. Restore the caller's state, including early query/ready exits;
    // enabling it unconditionally clips the next counter-clockwise sky draw.
    const cullingEnabled = gl.isEnabled(gl.CULL_FACE)
    try {
      // observe() runs only after the preceding shared GPU submission completed.
      // Query availability is still explicit; a delayed/failed query is unknown.
      if (this.pending.some(item => !gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE))) {
        if (Date.now() - this.started > 1000) throw new Error('Terrain visibility receipt timed out')
        this.wake(); return
      }
      for (const item of this.pending) {
        if (!gl.getQueryParameter(item.query, gl.QUERY_RESULT)) {
          this.hiddenIds.add(item.id); this.hiddenKeys.add(item.key)
        }
        gl.deleteQuery(item.query)
      }
      this.pending = []
      if (this.targetSatisfied()) {
        // Completed hidden results remain valid under the existing coverage
        // guard. Publish/continue only if precision demand returns; unqueried
        // members remain unknown and the sweep is not marked complete.
        if (this.target && this.target.valid()) r.requestResources()
        return
      }
      this.publish()
      if (this.index === this.draws.length) {
        this.done = true
        this.wake()
        return
      }
      // New queries may rely on the newly added coverage as well. A single
      // conservative dependency union avoids storing a footprint per query.
      gl.useProgram(this.program)
      gl.colorMask(false, false, false, false); gl.depthMask(false)
      gl.disable(gl.CULL_FACE)
      if (masked) { gl.enable(gl.STENCIL_TEST); gl.stencilMask(0); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP) }
      else gl.disable(gl.STENCIL_TEST)
      // At most eight queries / 128 conservative blocks per submission. A
      // retained block has two draws to include unknown stencil samples.
      const end = Math.min(this.draws.length, this.index + 8)
      for (; this.index < end; ++this.index) {
        const draw = this.draws[this.index], geometry = r.geometry.get(draw.geometryKey)
        const rectangles = geometry && visibilityBounds(geometry.model, draw, r.current.frame,
          {width: this.width, height: this.height}, r.depthState)
        if (!rectangles) continue
        if (!rectangles.length) {
          this.hiddenIds.add(draw.resourceId); this.hiddenKeys.add(draw.geometryKey); continue
        }
        const query = gl.createQuery()
        if (!query) throw new Error('Terrain visibility query allocation failed')
        this.pending.push({query, id: draw.resourceId, key: draw.geometryKey})
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, query)
        try {
          // Retained color may contain coarse coverage or overlays. A sample
          // without fine-terrain stencil is unknown, regardless of its depth.
          // Count unknown samples and depth-visible fine samples in ONE query.
          for (let pass = 0; pass < (masked ? 2 : 1); ++pass) {
            if (masked) {
              gl.stencilFunc(gl.EQUAL, pass, 255)
              if (pass) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST)
            }
            for (const rectangle of rectangles) {
              gl.uniform4f(this.rectangle, ...rectangle.slice(0, 4))
              gl.uniform1f(this.depth, rectangle[4])
              gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
            }
          }
        } finally { gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE) }
      }
      this.started = Date.now()
      this.wake()
    } catch (error) {
      const published = Boolean(this.evidence)
      this.reset()
      this.owner = r.current; this.version = r.cameraVersion
      this.failed = true
      if (published) {
        this.invalidated = true
        if (r.options.onImageryPlanningChange) r.options.onImageryPlanningChange()
      }
      r.onDiagnostic('terrain_visibility_unavailable', {message: error.message})
    } finally {
      gl.colorMask(true, true, true, true); gl.depthMask(true)
      if (masked) { gl.enable(gl.DEPTH_TEST); gl.stencilMask(255) }
      if (cullingEnabled) gl.enable(gl.CULL_FACE)
      else gl.disable(gl.CULL_FACE)
      if (stencilEnabled) gl.enable(gl.STENCIL_TEST)
      else gl.disable(gl.STENCIL_TEST)
      gl.useProgram(r.program)
    }
  }

  needsDraw(surface) {
    const r = this.renderer
    if (this.invalidated) return true
    if (r.interactionActive || surface.current !== r.current || r.heldCandidate) return false
    if (this.target && this.target.reusable(surface)) return false
    if (this.valid()) return this.needsObservation()
    return r.plannedCameraVersion === r.cameraVersion && r.current.imageryPlan &&
      r.current.imageryPlan.quality.limitedByTextureBudget
  }

  resume(surface, submitted) {
    const r = this.renderer
    if (!this.target || !this.target.reusable(surface) || r.interactionActive ||
        surface.current !== r.current || r.heldCandidate || this.valid() && !this.needsObservation()) return
    this.target.observe(() => this.observe(surface, false, submitted.filter(([draw]) => !(draw.flags & 1)), true))
  }

  advance() {
    const r = this.renderer, surface = {current: r.current}
    if (!this.target || !this.target.reusable(surface) || this.target.current.busy ||
        !this.valid() || r.interactionActive || r.heldCandidate || !this.needsObservation()) return
    this.target.observe(() => this.observe(surface, false, null, true))
  }

  destroy(lost = false) {
    this.reset(lost)
    this.proofs.clear()
    if (this.target) this.target.destroy(lost)
    if (this.program && !lost) this.gl.deleteProgram(this.program)
    this.program = null
  }
}

function createTerrainVisibility(renderer) {
  if (!renderer.options.scheduledImagery || !renderer.asyncGpu ||
      typeof renderer.gl.createQuery !== 'function') return null
  try {
    const observer = new TerrainVisibility(renderer)
    try { observer.target = new DisplayTarget(renderer) }
    catch (error) { renderer.onDiagnostic('display_target_unavailable', {message: error.message}) }
    return observer
  }
  catch (error) {
    renderer.onDiagnostic('terrain_visibility_unavailable', {message: error.message})
    return null
  }
}

module.exports = {TerrainVisibility, createTerrainVisibility}
