const assert=require('assert')
const {mergeImageryDemand}=require('../../sdk/js/imagery/imagery_demand')

module.exports=function(merge=mergeImageryDemand) {
  const tile=level=>({level,matrix:level+1,row:0,column:0}),root=tile(0)
  const targets=[1,2].map(resourceId=>({resourceId,geometryKey:'mesh:'+resourceId,texture:root}))
  const row=(i,level,fitted=false)=>({...targets[i],texture:tile(level),sourceTexture:root,
    ...(fitted?{imageryPixelError:1.2}:{})})
  const measurements=new Map(targets.map(draw=>[draw.resourceId,{resourceId:draw.resourceId,visible:true,pixelsPerUv:Infinity}]))
  const options={sameView:true,viewRevision:1,measurementsCurrent:true,scheduledImagery:true,tileSize:256,
    hidden:()=>false,rootDraw:draw=>draw}
  const fitted=draws=>({draws,quality:{planningComplete:false,spatialCut:true,coverageGuaranteed:true,
    demandReady:true,targetPixelError:1.25,cameraCurrent:true}})
  const preview=draws=>({draws,quality:{planningComplete:false,measurementPending:true,cameraCurrent:true,targetPixelError:1.25}})
  const step=(previous,plan,configuration=options)=>merge(targets,previous,plan,measurements,
    Array.from(measurements.values()),configuration).plan
  const initial=step(null,fitted([row(0,1,true),row(1,1,true)]))
  let current=initial
  for(let n=0;n<12;++n) {
    current=step(current,preview([row(n%2,2)]))
    assert(current.draws.every(draw=>draw.texture.level===1),
      'Measurement preview replaced current fitted demand')
    assert.deepStrictEqual(current.draws.map(draw=>draw.geometryKey),['mesh:1','mesh:2'],
      'Partial measurements reordered unchanged terrain goals')
    assert.strictEqual(current.quality.planningComplete,false)
  }
  const next=step(current,fitted([row(1,3,true),row(0,2,true)]))
  assert.deepStrictEqual(next.draws.map(draw=>draw.texture.level),[2,3],
    'A newer fitted core cut could not replace the retained goals')
  // Fitted does not mean final: tighter measurements can prove that an old
  // oversampled cut is no longer needed before the whole new plan completes.
  const coarse=preview([row(0,0)])
  const update=pixelsPerUv=>[{resourceId:1,visible:true,pixelsPerUv}]
  const tightened=merge(targets,initial,coarse,measurements,update(100),options)
  assert.deepStrictEqual(tightened.plan.draws.map(draw=>draw.texture.level),[0,1],
    'A current-view precision proof could not retire provisional fine demand')
  assert(tightened.plan.draws[0].imageryCoverageBound)
  assert.strictEqual(tightened.plan.quality.planningComplete,false)
  assert.strictEqual(tightened.plan.quality.demandReady,false)
  assert.strictEqual(tightened.measurements.get(1).pixelsPerUv,100,
    'Retaining another mesh discarded a completed local measurement')
  for(const bound of [Infinity,350]) {
    const unsafe=merge(targets,initial,coarse,measurements,update(bound),options)
    assert.strictEqual(unsafe.plan.draws[0].texture.level,1,'Unproven coarse demand replaced fitted detail')
  }
  const stale=merge(targets,initial,{...coarse,quality:{...coarse.quality,cameraCurrent:false}},
    measurements,update(100),options)
  assert.strictEqual(stale.plan.draws[0].texture.level,1,'An old view supplied a coarse precision proof')
  let descending=step(null,fitted([row(0,3,true),row(1,3,true)]))
  for(const [level,bound] of [[2,800],[1,400],[0,100]]) {
    descending=merge(targets,descending,preview([row(0,level)]),measurements,update(bound),options).plan
    assert.strictEqual(descending.draws[0].texture.level,level,'Successive tighter proofs stopped after the first coarse cut')
    descending=merge(targets,descending,preview([row(0,level+1)]),measurements,update(bound),options).plan
    assert.strictEqual(descending.draws[0].texture.level,level,'A speculative finer preview replaced proven coarse demand')
  }
  const nextView=merge(targets,descending,preview([row(0,2)]),measurements,update(Infinity),
    {...options,viewRevision:2,sameView:false}).plan
  assert.strictEqual(nextView.draws[0].texture.level,2,'A prior-view coverage proof blocked new-view demand')
  // The first preview of another camera may retain useful old detail. A later
  // preview in that camera must not mistake those old rows for its own proof.
  const changed={...options,sameView:false,viewRevision:2}
  const oldDetail=step(initial,preview([row(0,0),row(1,0)]),changed)
  assert(oldDetail.draws.every(draw=>draw.texture.level===1))
  const newPreview=step(oldDetail,preview([row(0,2),row(1,2)]),{...changed,sameView:true})
  assert(newPreview.draws.every(draw=>draw.texture.level===2),'Old-camera fitted rows blocked current coverage preview')
  const seeded=step(null,preview([row(0,1)]))
  const growing=step(seeded,preview([row(1,2)]))
  assert.strictEqual(growing.draws.find(draw=>draw.resourceId===1).texture.level,1,
    'A later partial measurement withdrew useful in-flight coverage from an unchanged mesh')
  assert.strictEqual(growing.quality.planningComplete,false)
  assert.strictEqual(growing.quality.demandReady,false)
  assert.strictEqual(growing.draws.find(draw=>draw.resourceId===2).texture.level,2,
    'Stable fitted demand prevented a previously unmeasured mesh from progressing')
  console.log('Imagery demand stability: current fitted goals survive repeated previews, new fitted cuts replace them, stale-camera detail and initial coverage keep progressing')
}
if(require.main===module)module.exports()
