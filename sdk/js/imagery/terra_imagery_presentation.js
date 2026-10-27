const { textureKeyString: key } = require('../core/terra_globe_common')
const { parentTextureTile, descendantTextureTile } = require('./terra_texture_tiles')

const same = (a, b) => key(a) === key(b)

// World tile cells, independent of mesh IDs and camera/plan publication. Only
// submitted cells survive endFrame; downloaded candidates never own display.
class ImageryPresentation {
  constructor(duration = 200) {
    this.duration = Math.max(0, duration)
    this.clear()
  }

  clear() {
    this.cells = new Map()
    this.active = 0
    this.cutRevision=(this.cutRevision||0)+1
    this.coarseningRevision=(this.coarseningRevision||0)+1
    this.settledCoarseningRevision=this.coarseningRevision
    this.setGoals([])
  }

  setGoals(tiles) {
    for (const step of this.setGoalsWork(tiles)) { /* synchronous caller */ }
  }

  *setGoalsWork(tiles, reserve = () => {}) {
    this.goals = new Map()
    for (const tile of tiles) {
      yield
      if (!tile) continue
      const id = key(tile)
      if (!this.goals.has(id)) reserve(64 + id.length * 2)
      this.goals.set(id, tile)
    }
    this.goalBranches = new Set()
    for (const tile of this.goals.values()) {
      for (let parent = parentTextureTile(tile); parent; parent = parentTextureTile(parent)) {
        yield
        const id = key(parent)
        if (this.goalBranches.has(id)) break // The entire ancestor path is already present.
        reserve(64 + id.length * 2)
        this.goalBranches.add(id)
      }
    }
  }

  beginFrame(now) {
    for (const step of this.beginFrameWork(now)) { /* synchronous caller */ }
  }

  beginSubmission(now) {
    this.now=now
    this.next=new Map()
  }

  *beginFrameWork(now, reserve = () => {}) {
    this.now = now
    this.next = new Map()
    this.branches = new Map()
    for (const state of this.cells.values()) {
      yield
      // A branch splits unless ALL of its descendants' two endpoints equal
      // the destination. Keep that exact predicate once per world branch,
      // rather than retaining/scanning its complete descendant list per mesh.
      const a = key(state.a), b = key(state.b), endpoint = a === b ? a : null
      let parent = parentTextureTile(state.cell)
      while (parent) {
        yield
        const id = key(parent)
        const previous = this.branches.get(id)
        if (previous === undefined) reserve(64 + id.length * 2)
        this.branches.set(id, previous === undefined || previous === endpoint ? endpoint : null)
        parent = parentTextureTile(parent)
      }
    }
  }

  // A coarse destination must keep the old child footprints while fading: an
  // individual child image cannot be stretched over the whole parent region.
  cover(cell, target, visit, intersects) {
    for (const step of this.coverWork(cell, target, visit, intersects)) { /* synchronous caller */ }
  }

  *coverWork(cell, target, visit, intersects) {
    const stack = [[cell, target]]
    while (stack.length) {
      let [cell, target] = stack.pop()
      yield
      // A mesh borrows this world cut only on its immutable footprint. Prune
      // before descent; filtering leaves repeats unrelated fine trees per mesh.
      if (intersects && !intersects(cell)) continue
      // Shared finer goals override a mesh's coarse target. Ancestors at or
      // below that target cannot improve it. Keep the original traversal order.
      for (let tile = cell; tile && tile.level > target.level; tile = parentTextureTile(tile)) {
        const goal = this.goals.get(key(tile))
        if (goal && goal.level > target.level) target = goal
      }
      const id = key(cell), endpoint = this.branches.get(id)
      if (this.goalBranches.has(id) || endpoint !== undefined && endpoint !== key(target)) {
        for (let row = 1; row >= 0; --row) for (let column = 1; column >= 0; --column)
          stack.push([descendantTextureTile(cell, 1, row, column), target])
      } else visit(cell, target)
    }
  }

  previous(cell) {
    for (let tile = cell; tile; tile = parentTextureTile(tile)) {
      const state = this.cells.get(key(tile))
      if (state) return state
    }
    return null
  }

  group(cell, target) {
    const prior = this.previous(cell)
    return key(prior && target.level < Math.max(prior.a.level, prior.b.level)
      ? target : parentTextureTile(target) || target)
  }

  resolve(cell, target, resident, ready = true) {
    const id = key(cell)
    if (this.next.has(id)) return this.next.get(id)
    let state = this.previous(cell)
    if (!state || !resident(state.a) || !resident(state.b)) {
      state = { cell, a: target, b: target, alpha: 1, goal: 1, at: this.now }
    } else {
      state = Object.assign({}, state, {cell})
      // The prior frame's blend is the starting value, including when the next
      // target is a third tile. No unbounded chain of textures is retained.
      if (!same(state.a, state.b)) {
        const delta = this.duration ? Math.max(0, this.now - state.at) / this.duration : 1
        state.alpha = state.goal ? Math.min(1, state.alpha + delta) : Math.max(0, state.alpha - delta)
        if (state.alpha === state.goal) {
          state.a = state.b = state.goal ? state.b : state.a
          state.alpha = 1
        }
      }
      if (ready) {
        if (same(state.a, state.b)) {
          if (!same(state.b, target)) {
            state.a = state.b; state.b = target; state.alpha = this.duration ? 0 : 1
            state.goal = 1
          }
        } else if (same(target, state.a)) state.goal = 0
        else if (same(target, state.b)) state.goal = 1
        // A third target remains only in the current candidate cut. Finish this
        // pair, then start the latest candidate on the next submitted frame.
      }
      state.at = this.now
      if (!this.duration) { state.a = state.b; state.alpha = 1 }
    }
    this.next.set(id, state)
    return state
  }

  endFrame() {
    const previous=this.cells
    let changed=previous.size!==this.next.size,coarsened=false
    this.cells = this.next
    this.active = 0
    this.cells.forEach((state,id) => {
      if (!same(state.a, state.b)) ++this.active
      const old=previous.get(id)
      if(!old||!same(old.a,state.a)||!same(old.b,state.b))changed=true
      if(old&&same(state.a,state.b)&&state.b.level<state.cell.level&&
          (!same(old.a,state.a)||!same(old.b,state.b)))coarsened=true
    })
    if(changed)++this.cutRevision
    if(coarsened)++this.coarseningRevision
    // Intermediate submitted fades still need their child footprints. Queue
    // optional layout compaction once this batch has no remaining endpoints;
    // image goals and capacity handoffs have independent invalidation paths.
    if(!this.active)this.settledCoarseningRevision=this.coarseningRevision
    return this.active
  }
}

module.exports = { ImageryPresentation }
