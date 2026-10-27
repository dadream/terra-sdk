const {surfaceIds} = require('./surface_replacement')

// Observe successful display-cut receipts, including mixed local replacements.
// Store immutable IDs only; camera/imagery changes cannot fabricate mesh progress.
class SubmittedTerrain {
  constructor() {
    this.ids = []
    this.generation = null
    this.submissions = this.partialSubmissions = this.meshRevision = 0
  }

  submit(surface, partial) {
    const ids = surfaceIds(surface.draws)
    if (!ids.length) return
    // Local replacement groups never span native generations. Read the
    // submitted draw's origin, since a restarted Worker may own future work
    // while a retained surface from its predecessor is still being drawn.
    const generation = surface.draws.find(draw => !(draw.flags & 1)).workerGeneration || 0
    ++this.submissions
    if (partial) ++this.partialSubmissions
    if (generation !== this.generation || ids.length !== this.ids.length ||
        ids.some((id, index) => id !== this.ids[index])) ++this.meshRevision
    this.ids = ids
    this.generation = generation
  }

  snapshot() {
    return {submissions: this.submissions, partialSubmissions: this.partialSubmissions,
      meshRevision: this.meshRevision, meshes: this.ids.length}
  }
}

module.exports = {SubmittedTerrain}
