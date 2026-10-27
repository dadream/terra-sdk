const assert = require('assert')
const {ImageryPresentation} = require('../../sdk/js/imagery/terra_imagery_presentation')
const {textureKeyString:key} = require('../../sdk/js/core/terra_globe_common')
const {parentTextureTile, descendantTextureTile} = require('../../sdk/js/imagery/terra_texture_tiles')

// Test-only reference: retain the former per-ancestor descendant lists. It is
// deliberately independent of the new branch summaries used by production.
class DescendantPresentation extends ImageryPresentation {
  beginFrame(now) {
    this.now=now; this.next=new Map(); this.branches=new Map()
    this.cells.forEach(state => {
      for (let tile=parentTextureTile(state.cell);tile;tile=parentTextureTile(tile)) {
        const id=key(tile)
        if (!this.branches.has(id)) this.branches.set(id,[])
        this.branches.get(id).push(state)
      }
    })
  }
  cover(cell,target,visit,intersects) {
    if (intersects && !intersects(cell)) return
    for (let tile=cell;tile && tile.level>target.level;tile=parentTextureTile(tile)) {
      const goal=this.goals.get(key(tile))
      if (goal && goal.level>target.level) target=goal
    }
    const descendants=this.branches.get(key(cell)) || []
    if (this.goalBranches.has(key(cell)) || descendants.some(s=>key(s.a)!==key(target) || key(s.b)!==key(target))) {
      for (let row=0;row<2;++row) for (let column=0;column<2;++column)
        this.cover(descendantTextureTile(cell,1,row,column),target,visit,intersects)
    } else visit(cell,target)
  }
}

module.exports = function verifyPresentationBranches() {
  const root={level:0,matrix:1,row:0,column:0}
  const leaves=[]
  for (let row=0;row<8;++row) for (let column=0;column<8;++column)
    leaves.push(descendantTextureTile(root,3,row,column))
  const actual=new ImageryPresentation(200), reference=new DescendantPresentation(200)
  const collect=(p,cell,target) => {
    const result=[]
    p.cover(cell,target,(c,t)=>result.push([key(c),key(t)]))
    return result
  }
  // Refinement, reversal, coarsening and a third target share exactly the same
  // world cut, including partial blends and ancestor/descendant goals.
  for (let round=0;round<12;++round) {
    const targets=leaves.map((tile,i)=>round<2 || round>=7 && i%3===0 ? root : round<6 ? tile : parentTextureTile(tile))
    const goals=round%2 ? targets.slice().reverse() : targets
    actual.setGoals(goals);reference.setGoals(goals)
    actual.beginFrame(round*70);reference.beginFrame(round*70)
    for (const cell of [root,...leaves.slice(0,5)]) for (const target of [root,parentTextureTile(leaves[0]),leaves[0]])
      assert.deepStrictEqual(collect(actual,cell,target),collect(reference,cell,target),
        `Branch summary changed coverage at round ${round}, cell ${key(cell)}, target ${key(target)}`)
    leaves.forEach((tile,i)=>{
      const resident=t=>round!==8 || t.level===0
      assert.deepStrictEqual(actual.resolve(tile,targets[i],resident,round!==4),
        reference.resolve(tile,targets[i],resident,round!==4))
    })
    assert.strictEqual(actual.endFrame(),reference.endFrame())
  }
  actual.clear();reference.clear()
  actual.beginFrame(1000);reference.beginFrame(1000)
  assert.deepStrictEqual(collect(actual,root,root),collect(reference,root,root))

  // After fine-to-coarse blending has finished, many old cell footprints can
  // share one coarse image. A new mesh must not rescan every old endpoint.
  const dense=new ImageryPresentation()
  let reads=0
  for (let row=0;row<32;++row) for (let column=0;column<32;++column) {
    const cell=descendantTextureTile(root,5,row,column)
    dense.cells.set(key(cell),{cell,get a(){++reads;return root},get b(){++reads;return root}})
  }
  dense.beginFrame(1100)
  reads=0
  for (let mesh=0;mesh<256;++mesh)
    assert.deepStrictEqual(collect(dense,root,root),[[key(root),key(root)]])
  assert(reads<=512,`Each coarse mesh rescanned the old fine cut: ${reads} endpoint reads`)
}
