const common = require('../core/terra_globe_common')
const {parentTextureTile} = require('./terra_texture_tiles')

// Stable tile nodes survive camera revisions. Required edges describe the
// visible cut for this revision; decoded/GPU state belongs to the resource owner.
class ImageryPyramid {
  constructor(options) {
    this.maximumNodes = options && options.maximumNodes || 4096
    this.nodes = new Map()
    this.revision = 0
    this.desired = new Map()
    this.children = new Map()
    this.priorities = new Map()
    this.roots = new Map()
    this.coverageParents = new Map()
    this.coverageLevelStep = options && options.coverageLevelStep || Infinity
  }

  begin() {
    this.revision += 1
    this.desired.clear(); this.children.clear(); this.priorities.clear(); this.roots.clear()
    this.coverageParents.clear()
  }

  addPath(tile, priority, ancestors, direct, resident, pixelError) {
    let path = [tile]
    if (ancestors) {
      let ancestor = parentTextureTile(tile)
      while (ancestor) { path.unshift(ancestor); ancestor = parentTextureTile(ancestor) }
    }
    if (direct && path.length > 2) {
      const ready = path.slice(1,Number.isFinite(this.coverageLevelStep)?path.length:-1)
        .reverse().find(node => resident(common.textureKeyString(node)))
      const selected=[path[0]]
      if(ready)selected.push(ready)
      // Sparse coverage bounds the resolution jump during a cold request.
      // Resident detail skips missing ancestors; final demand stays the leaf.
      let level=(ready||path[0]).level
      let next=(Math.floor(level/this.coverageLevelStep)+1)*this.coverageLevelStep
      while(next<tile.level) {
        level=next
        selected.push(path[level-path[0].level])
        next+=this.coverageLevelStep
      }
      if(!ready||ready.level!==tile.level)selected.push(tile)
      path=selected
    }
    path.forEach((node, index) => {
      const key = common.textureKeyString(node)
      let entry = this.nodes.get(key)
      if (!entry) { entry = { tile: node, revision: this.revision }; this.nodes.set(key, entry) }
      entry.revision = this.revision
      this.desired.set(key, entry.tile)
      const urgency = pixelError === undefined ? priority :
        pixelError * Math.pow(2, tile.level - node.level)
      this.priorities.set(key, Math.max(this.priorities.get(key) || -Infinity, urgency))
      if (!index) this.roots.set(key, entry.tile)
      else {
        const parentKey = common.textureKeyString(path[index - 1])
        if(direct&&Number.isFinite(this.coverageLevelStep))this.coverageParents.set(key,parentKey)
        if (!this.children.has(parentKey)) this.children.set(parentKey, new Map())
        this.children.get(parentKey).set(key, entry.tile)
      }
    })
  }

  finish() {
    if (this.nodes.size <= this.maximumNodes) return
    const idle = Array.from(this.nodes.entries()).filter(([key]) => !this.desired.has(key))
      .sort((a, b) => a[1].revision - b[1].revision)
    for (const [key] of idle) {
      if (this.nodes.size <= this.maximumNodes) break
      this.nodes.delete(key)
    }
  }

  refinementPriority(tile, predecessorLevel) {
    // Final target errors are nearly uniform. Rank the missing detail relative
    // to usable coverage instead; each quadtree level doubles linear density.
    // The resource owner supplies readiness, not the platform-independent tree.
    return (this.priorities.get(common.textureKeyString(tile)) || 0) *
      Math.pow(2, Math.max(0, tile.level - predecessorLevel))
  }

  clear() { this.nodes.clear(); this.begin() }
}

module.exports = { ImageryPyramid }
