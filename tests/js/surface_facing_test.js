const assert=require('assert')
const plan=require('../../sdk/js/terrain/terra_surface_plan')
const facing=require('../../sdk/js/terrain/surface_facing')
const {invertMatrix4}=require('../../sdk/js/math/matrix')
const reference=require('./reference/surface_facing_contract')
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
const context=m=>plan.projectionContext({projectionView:m},{width:400,height:400},invertMatrix4(m))
const uv=new Float32Array([0,0,1,0,0,1])
const prepare=(positions,clockwise)=>plan.prepareSurface(new Float32Array(positions),uv,
  new Uint16Array(clockwise?[0,2,1]:[0,1,2]),0,3)
const drain=work=>{let r;do{r=work.next()}while(!r.done);return r.value}

const front=prepare([-.5,-.5,0,.5,-.5,0,-.5,.5,0],true)
const back=prepare([-.5,-.5,0,.5,-.5,0,-.5,.5,0],false)
for(const model of [front,back]) {
  for(const mirror of [1,-1]) {
    const m=identity.slice();m[0]=mirror
    const visible=(model===front)===(mirror===1),c=context(m)
    assert.strictEqual(plan.previewSurface(model,[0,0,0],c).visible,visible)
    for(const bound of [false,true]) for(const tight of [false,true]) {
      const r=drain(plan.surfaceMeasurements(model,[0,0,0],c,bound,tight))
      assert.strictEqual(r.visible,visible)
      assert.strictEqual(r.regions.length>0,visible)
    }
  }
}
const metadata={...back,get positions(){throw Error('Preview read positions')},
  get uv(){throw Error('Preview read UV')}}
assert.strictEqual(plan.previewSurface(metadata,[0,0,0],context(identity)).visible,false)
assert.strictEqual(facing.blockFacing({...front.blocks[0],winding:0},[0,0,0],context(identity)),0)
assert(!facing.backFacing([[0,0,0,1],[1,0,0,1],[2,0,0,1]]))

// Opposite windings share a block. Tightening excludes the hidden, higher
// density triangle but keeps one conservative shallow region, not a face soup.
const mixed=plan.prepareSurface(new Float32Array([
  -.4,-.4,0,-.3,-.4,0,-.4,-.3,0, -.4,-.4,0,.4,-.4,0,-.4,.4,0]),
  new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),
  new Uint16Array([0,2,1,1,3,3,3,4,5]),0,9)
assert.strictEqual(mixed.blocks.length,1)
assert.strictEqual(mixed.blocks[0].winding,0)
const tightened=drain(plan.surfaceMeasurements(mixed,[0,0,0],context(identity),false,true))
assert(tightened.visible && Math.abs(tightened.pixelsPerUv-20)<1e-4)
assert.strictEqual(tightened.regions.length,1)

// Deterministic varied relief, perspective, offsets and near-plane crossings.
let seed=93841,fronts=0,backs=0,proofs=0
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
for(let trial=0;trial<100;++trial) {
  const p=[],tex=[],indices=[],origin=[1e6*random(),-1e6*random(),1e6*random()]
  const slope=trial%2 ? 0 : 2
  for(let i=0;i<12;++i) {
    const first=p.length/3,x=random()-.5,y=random()-.5
    for(const [u,v] of [[0,0],[1,0],[0,1]]) {
      p.push(x+u*.15,y+v*.15,random()*slope+.1);tex.push(u,v)
    }
    if(indices.length)indices.push(indices[indices.length-1],first)
    if(indices.length%2)indices.push(first)
    indices.push(first,first+(trial%3===0 && i%3===0?1:2),first+(trial%3===0 && i%3===0?2:1))
  }
  const model=plan.prepareSurface(new Float32Array(p),new Float32Array(tex),new Uint16Array(indices),0,indices.length)
  const m=identity.slice();m[0]=trial%2?1:-1;m[2]=random()-.5;m[6]=random()-.5
  m[12]=random()-.5;m[14]=trial%4?1:0;m[15]=trial%4?.15:1
  for(let row=0;row<4;++row)for(let axis=0;axis<3;++axis)m[row*4+3]-=m[row*4+axis]*origin[axis]
  const result=reference.verify(model,origin,context(m),facing)
  fronts+=result.front;backs+=result.back;proofs+=result.proven
}
assert(fronts>100 && backs>100 && proofs>10)
assert(reference.verify(front,[0,0,0],context(identity),facing).proven>0)
console.log(`Surface facing contract passed: ${fronts} front, ${backs} back faces`)
