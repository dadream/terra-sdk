const assert=require('assert')
const {patch,surface}=require('./terrain_surface_fixture')
const {REGION_BYTES,adoptMeasurementRows,ownMeasurements,releaseMeasurements,writeMeasurementRow,
  measurementLease}=require('../../sdk/js/terrain/measurement_rows')

module.exports=async function({Renderer,FakeGl,FakeCanvas,frame,replacementPresentation,settle}) {
  const lower=[[0,0],[1,0],[0,1]],upper=[[1,1],[0,1],[1,0]]
  for(const outcome of ['submit','supersede','pause','reset','loss','destroy']) {
    const old=surface([patch(51,lower,undefined,4),patch(52,upper,undefined,4)]),
      next=surface([patch(53,lower,undefined,4),patch(54,upper,undefined,4)])
    const gl=new FakeGl(),renderer=new Renderer(new FakeCanvas(gl),{
      mode:'height',managedResources:true,geometryCacheBytes:900,urlForTile:()=> 'unused'
    })
    const loans=[]
    const measurements=density=>{
      const owned=next.draws.map(draw=>{
        const data=new Uint8Array(REGION_BYTES)
        writeMeasurementRow({uv:{minimumU:0,minimumV:0,maximumU:1,maximumV:1},pixelsPerUv:density},data,0)
        const entry=adoptMeasurementRows(data,renderer.resourceLedger.reserve('fixture-mixed-measurement',REGION_BYTES))
        return {entry,value:{resourceId:draw.resourceId,visible:true,pixelsPerUv:density,regions:entry.rows}}
      })
      const values=ownMeasurements(owned.map(v=>v.value));loans.push(values)
      for(const v of owned)v.entry.release()
      return values
    }
    const publish=(sequence,value,values=[])=>renderer.setMeshFrame(Object.assign(frame(),{sequence,coverageComplete:true}),
      value.draws,value.meshResources,old.indices,
      {modelRevision:sequence,workerGeneration:1,pendingPriorityUpdateCount:1},null,values,replacementPresentation(renderer,value))
    try {
      publish(1,old);renderer.render()
      assert(renderer.displaySurface&&renderer.displaySurface.current===renderer.current)
      const first=measurements(128);publish(2,next,first);releaseMeasurements(first)
      // Upload and prepare one complete local group without submitting it.
      for(let i=0;i<12&&!(renderer.replacement&&renderer.replacement.mixed);++i)renderer.advanceResources()
      const pending=renderer.replacement&&renderer.replacement.mixed
      assert(pending&&pending!==renderer.displaySurface.current,'Fixture did not prepare an unsubmitted mixed cut')
      const originalRows=first[0].regions
      const second=measurements(256)
      renderer.setImageryPlan(2,{draws:next.draws,levels:new Map(),
        quality:{targetPixelError:1.25,planningComplete:true,cameraCurrent:true}},second)
      releaseMeasurements(second)
      if(outcome==='submit') {
        assert.doesNotThrow(()=>renderer.render(),'A pending mixed cut resurrected retired measurement evidence')
        assert.strictEqual(renderer.displaySurface.current,pending)
        assert.strictEqual(originalRows.number(0,4),128,'Submitted mixed metadata lost its numeric loan')
        assert(!measurementLease(originalRows).reclaimable(),'Pressure could reclaim displayed measurement evidence')
      } else {
        if(outcome==='supersede')publish(3,old)
        else if(outcome==='pause')renderer.setPaused(true)
        else if(outcome==='reset')renderer.resetWorker()
        else if(outcome==='loss')renderer.contextWasLost()
        else renderer.destroy()
        assert.throws(()=>originalRows.number(0,4),/retired/,'Discarded mixed metadata kept its old loan')
      }
    }finally {
      renderer.destroy()
      for(const values of loans)releaseMeasurements(values)
    }
    await settle()
    assert.strictEqual(renderer.resourceLedger.bytes,0,'Mixed publication leaked numeric or mesh ownership')
  }
  console.log('Mixed measurement ownership: pending publication, plan replacement, submission, cancellation and zero teardown passed')
}
