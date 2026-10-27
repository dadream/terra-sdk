const assert=require('assert')
const {coverageCellBounds,coverageScissor}=require('../../adapters/webgl/coverage_cell_bounds')
function drain(work){let r;do{r=work.next()}while(!r.done);return r.value}
module.exports=function() {
  const model={positions:[0,0,0,1,0,0,0,1,0,1,1,0],uv:[0,0,1,0,0,1,1,1],faces:[0,1,2,2,1,3]}
  const bounds=drain(coverageCellBounds(model,{bounds:{minimumU:.25,maximumU:.5,minimumV:.25,maximumV:.5}}))
  assert(bounds.minimum[0]<.25&&bounds.minimum[0]>.249)
  assert(bounds.maximum[1]>.5&&bounds.maximum[1]<.501)
  const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
  const rect=coverageScissor(bounds,[0,0,0],identity,1000,1000)
  assert(rect[2]<140&&rect[3]<140,'Tiny image cell rasterized its whole source mesh')
  assert(rect[0]<=625&&rect[0]+rect[2]>=750,'Scissor omitted a cell boundary')
  const behind=identity.slice();behind[15]=-1
  assert.deepStrictEqual(coverageScissor(bounds,[0,0,0],behind,1000,1000),[0,0,0,0])
  const outside=coverageScissor(bounds,[3,0,0],identity,1000,1000)
  assert.strictEqual(outside[2],0)
  const empty=drain(coverageCellBounds(model,{bounds:{minimumU:2,maximumU:3,minimumV:2,maximumV:3}}))
  assert.deepStrictEqual(coverageScissor(empty,[0,0,0],identity,1000,1000),[0,0,0,0])
}
if(require.main===module)module.exports()
