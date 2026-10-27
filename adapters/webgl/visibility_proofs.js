const {offscreenCells} = require('../../sdk/js/terrain/visibility_footprint')
const {coversVisibility} = require('../../sdk/js/terrain/visibility_coverage')
const {ownMeshWork} = require('../../sdk/js/resources/mesh_ownership')
const {monotonicNow} = require('../../sdk/js/diagnostics/timing')

// Optional CPU proof for losses the fast block test cannot classify. Results
// carry no mesh references; active generators borrow the existing mesh charge.
// Coverage changes preserve this work, but camera/model/source changes do not.
class VisibilityProofs {
  constructor(renderer) {
    this.renderer = renderer
    this.pending = new Map()
    this.clear()
  }

  clear() {
    this.pending.forEach(item => item.work.return())
    this.pending.clear()
    this.results = new Map()
    this.models = new WeakMap()
    this.nextModel = 0
    this.owner = null
  }

  synchronize() {
    const r = this.renderer
    if (r.paused || r.destroyed || r.contextLost || !r.current) { this.clear(); return false }
    if (this.owner !== r.current || this.version !== r.cameraVersion || this.generation !== r.partitionGeneration ||
        this.width !== r.canvas.width || this.height !== r.canvas.height) {
      this.clear()
      this.owner = r.current; this.version = r.cameraVersion; this.generation = r.partitionGeneration
      this.width = r.canvas.width; this.height = r.canvas.height
    }
    return true
  }

  // true: coverage preserved, false: unknown/visible loss, null: proof pending.
  // Pending includes a full queue; a completion wakes publication to retry it.
  checkCoverage(key, before, after, fast) {
    if (before === undefined || before === 0) return true
    if (!this.synchronize()) return false
    const cells = []
    if (!coversVisibility(new Map([[key, before]]), new Map([[key, after]]), new Set(),
      (id, x, y, scale) => {
        if (!fast || !fast(id, x, y, scale)) cells.push({x, y, scale})
        return true
      })) return false
    if (!cells.length) return true
    const r = this.renderer, geometry = r.geometry.get(key), model = geometry && geometry.model
    if (!model || !model.positions || !model.uv || !model.faces) return false
    const draw = r.current.draws.find(draw => draw.geometryKey === key && !(draw.flags & 1))
    if (!draw) return false
    if (!this.models.has(model)) this.models.set(model, ++this.nextModel)
    const id = `${this.models.get(model)}:${draw.origin.join(',')}:${JSON.stringify([before, after || 0])}`
    if (this.results.has(id)) return this.results.get(id)
    // A whole footprint owns one bounded job and one boolean result. Its input
    // trees belong to this call; neither the result nor its key retains a mesh.
    if (!this.pending.has(id) && this.pending.size < 8) {
      const work = ownMeshWork(offscreenCells(model, draw, r.current.frame,
        {width: this.width, height: this.height}, cells), [geometry.resource])
      this.pending.set(id, {key, model, work})
      r.requestResources()
    }
    return null
  }

  advance() {
    if (!this.synchronize() || !this.pending.size) return
    const r = this.renderer, deadline = monotonicNow() + 2
    // At most eight 64-triangle steps. The existing host queue supplies the
    // next turn; no timer, GL query, mesh copy or display receipt is needed.
    for (let steps = 0; steps < 8 && this.pending.size; ++steps) {
      const [id, item] = this.pending.entries().next().value
      const geometry = r.geometry.get(item.key)
      if (!geometry || geometry.model !== item.model) {
        item.work.return(); this.pending.delete(id)
      } else {
        let result
        try { result = item.work.next() }
        catch (error) {
          item.work.return(); result = {done: true, value: false}
          r.onDiagnostic('terrain_visibility_proof_failed', {message: error.message})
        }
        if (result.done) {
          this.pending.delete(id)
          if (this.results.size >= 512) this.results.delete(this.results.keys().next().value)
          this.results.set(id, result.value === true)
          // Both outcomes unblock publication. A visible/unknown loss may be
          // adopted, but observe() must then revoke the old depth evidence.
          r.requestRender()
        }
      }
      if (monotonicNow() >= deadline) break
    }
    if (this.pending.size) r.requestResources()
  }
}

module.exports = {VisibilityProofs}
