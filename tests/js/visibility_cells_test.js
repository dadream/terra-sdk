const assert = require('assert')
const {visibilityCellBounds} = require('../../sdk/js/terrain/visibility_cells')
const {prepareSurface, createPartitionTask} = require('../../sdk/js/terrain/terra_surface_plan')
const {relativeProjectionView, rowMajorToWebGlMatrix} = require('../../sdk/js/core/terra_globe_common')
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
const frame = {projectionView:identity,cameraPosition:[0,0,0]}, draw={origin:[0,0,0]}
const viewport={width:128,height:128},cell={scale:4,x:1,y:1}
const drain = work => { let next; do {next=work.next()} while(!next.done); return next.value }

async function main() {
  const model=prepareSurface(new Float32Array([-.8,-.7,.1,.9,-.6,.23,-.3,.9,.13]),
    new Float32Array([0,0,1,0,0,1]),new Uint16Array([0,1,2]),0,3)
  const before=JSON.stringify(model)
  // This triangle's centroid is outside several cells it crosses.
  for(const selected of [cell,{scale:4,x:2,y:0},{scale:16,x:0,y:14}]) {
    const bounds={minimumU:selected.x/selected.scale,maximumU:(selected.x+1)/selected.scale,
      minimumV:selected.y/selected.scale,maximumV:(selected.y+1)/selected.scale}
    const parts=await createPartitionTask(model,[{key:'cell',bounds}]).run()
    assert(parts.length)
    for(const world of [0,6378000,-6378000]) for(const distance of [2,100,1e6]) {
      const camera=[world,world,world],origin=[world+.1,world-.1,world-distance]
      const view={cameraPosition:camera,projectionView:[1,0,0,-world,0,1,0,-world,0,0,-1,world-1,0,0,-1,world]}
      const rectangles=drain(visibilityCellBounds(model,{origin},view,viewport,selected))
      assert(rectangles && rectangles.length)
      const f=Math.fround,m=rowMajorToWebGlMatrix(relativeProjectionView(view.projectionView,camera))
      for(const part of parts) for(let i=0;i<part.positions.length;i+=3) {
        const p=[0,1,2].map(axis=>f(part.positions[i+axis]+f(origin[axis]-camera[axis])))
        const clip=[0,1,2,3].map(row=>f(f(f(f(m[row]*p[0])+f(m[4+row]*p[1]))+f(m[8+row]*p[2]))+m[12+row]))
        const [x,y,z]=clip.slice(0,3).map(v=>v/clip[3])
        assert(rectangles.some(r=>x>=r[0]&&x<=r[2]&&y>=r[1]&&y<=r[3]&&z>=r[4]),
          'UV-local bounds lost a generated Float32 partition vertex')
      }
    }
  }
  assert.strictEqual(JSON.stringify(model),before,'Visibility changed immutable geometry')
  assert.deepStrictEqual(drain(visibilityCellBounds(model,{origin:[10,0,0]},frame,viewport,cell)),[])
  assert.strictEqual(drain(visibilityCellBounds(model,{origin:[0,0,-2]},frame,viewport,cell)),null)
  for(const invalid of [{...cell,scale:3},{...cell,x:-1},{...cell,x:4}])
    assert.strictEqual(drain(visibilityCellBounds(model,draw,frame,viewport,invalid)),null)
  assert.strictEqual(drain(visibilityCellBounds({...model,blocks:[]},draw,frame,viewport,cell)),null)
  assert.strictEqual(drain(visibilityCellBounds({...model,positions:new Float32Array([NaN])},draw,frame,viewport,cell)),null)
  // Schedule/cancellation contract: bounded work even when every triangle
  // contributes, without storing a second mesh or a full face list.
  let visited=0
  const many={...model,faces:new Uint16Array(Array.from({length:771},(_,i)=>i%3)),
    blocks:[{faces:{length:257,*[Symbol.iterator](){for(let i=0;i<257;++i){++visited;yield i*3}}}}]}
  const work=visibilityCellBounds(many,draw,frame,viewport,cell)
  assert.strictEqual(work.next().done,false)
  assert.strictEqual(visited,64)
  work.return()
  assert.strictEqual(work.next().done,true)
  assert.strictEqual(visited,64,'Cancelled query geometry kept consuming triangles')
  console.log('Conservative UV bounds preserve rounded partitions, reject unknowns and bound work')
}
main().catch(error=>{console.error(error);process.exitCode=1})
