const assert=require('assert')

module.exports=async function({Renderer,AsyncGl,FakeCanvas,publishFrame,frame,draw,settle}) {
  const performance=global.performance
  let now=1000
  global.performance={now:()=>now}
  try {
    for(const outcome of ['observation','display','withheld','same-camera','pause','loss']) {
      const gl=new AsyncGl(),delays=[],errors=[],renderer=new Renderer(new FakeCanvas(gl),{
        mode:'height',urlForTile:()=> 'unused',directTextureTargets:true,
        maximumTextureEntries:32,textureCacheBytes:32*349524,uploadBudgetBytes:350000,
        requestResources:delay=>delays.push(delay),
        onDiagnostic(kind,detail){if(kind==='webgl_allocation_failed')errors.push(detail)}
      })
      try {
        publishFrame(renderer,frame(),[draw(0)],new Float32Array([0,0,0,1,0,0,0,1,0]),
          new Float32Array([0,0,1,0,0,1]),new Uint16Array([0,1,2]))
        renderer.render()
        for(let i=0;i<8;++i){gl.complete();renderer.advanceResources();renderer.render(false)}
        assert.strictEqual(renderer.pendingSubmission,null)
        const draws=()=>gl.calls.filter(v=>v.name==='drawElements').length,before=draws()
        const store=renderer.textures,key=t=>[t.level,t.matrix,t.row,t.column].join('/')
        if(outcome==='observation') {
          const previous=renderer.visibility
          let observations=0,busy=false
          const observer={hidden:()=>false,needsDepth:()=>false,advance(){++observations;busy=true},
            target:{prepare(){},submit(batch){if(busy)batch.hold(()=>{busy=false})}}}
          try {
            renderer.visibility=observer
            for(const column of [0,1])store.cache.set(`0/1/0/${column}`,
              {image:{},texture:{},width:256,height:256},349524)
            renderer.requestRender();renderer.resourcesRequested=true
            renderer.resourcePresentationDeadline=0;renderer.resourceDisplayOfferUntil=now-1
            renderer.advanceResources()
            assert.strictEqual(observations,0,
              'Optional observation fenced a ready resource-only display after its offer expired')
            assert.strictEqual(renderer.pendingSubmission,null)
            const tile={level:1,matrix:2,row:0,column:0}
            store.buildRequirementTree([{texture:tile}]);store.recomputeAvailability()
            store.cache.set(key(tile),{image:{},texture:null,width:256,height:256},349524)
            store.advance();renderer.resourcesRequested=true;renderer.advanceResources()
            assert(renderer.submissions.uploading&&renderer.pendingSubmission.items.length>0,
              'Observation deferral stopped necessary uploads without a display clock: '+JSON.stringify({
                resources:renderer.resourcesRequested,pending:!!renderer.pendingSubmission,
                budget:renderer.lastUploadBudget,desired:Array.from(store.desired.keys()),
                keys:Array.from(store.uploadKeys()),preparing:store.stats().preparingImages||0,
                asset:store.cache.entries.get(key(tile))&&store.cache.entries.get(key(tile)).value,
                group:!!renderer.partitionGroups.current,priority:renderer.cameraSubmissionPriority}))
            assert.strictEqual(observations,0)
            gl.complete();renderer.advanceResources()
            assert(store.gpuReady(key(tile)))
            renderer.visibility=previous
            assert(renderer.render(false),'The ready resource display could not submit')
            gl.complete();renderer.advanceResources()
            renderer.visibility=observer;renderer.resourcesRequested=true;renderer.advanceResources()
            assert.strictEqual(observations,1,'Optional observation did not resume after display acknowledgement')
            assert.deepStrictEqual(errors,[])
            assert(gl.syncs.size<=2)
          }finally {renderer.visibility=previous}
          continue
        }
        const tiles=[0,2,4,6].map(column=>({level:2,matrix:3,row:0,column}))
        for(const column of [0,1])store.cache.set(`0/1/0/${column}`,
          {image:{},texture:{},width:256,height:256},349524)
        store.buildRequirementTree(tiles.map(texture=>({texture})));store.recomputeAvailability()
        for(const tile of tiles)store.cache.set(key(tile),{image:{},texture:null,width:256,height:256},349524)
        store.advance();renderer.advanceResources();renderer.render(false)
        assert(renderer.submissions.uploading,'Fixture did not issue the first resource batch')
        if(outcome!=='same-camera') {
          const camera=frame();camera.projectionView[3]=0.25;renderer.setCameraFrame(camera)
          assert.strictEqual(renderer.render(false),null,'Fixture did not block the camera on an unfinished upload')
        }
        ++now;gl.complete();renderer.advanceResources()
        if(outcome==='same-camera') {
          assert(renderer.submissions.uploading,'A stationary display blocked independent resource progress')
        } else {
          assert(!renderer.submissions.uploading,'Background uploads replaced the waiting camera display opportunity')
          assert.strictEqual(draws(),before,'Background readiness drew outside the display callback')
          assert(tiles.some(t=>store.gpuReady(key(t)))&&tiles.some(t=>!store.gpuReady(key(t))))
          if(outcome==='display') {
            const latest=frame();latest.projectionView[3]=0.5;renderer.setCameraFrame(latest)
            const result=renderer.render(false)
            assert(result&&result.submitted>0,'A ready camera waited behind another upload')
            assert.strictEqual(renderer.presentedCameraVersion,renderer.cameraVersion)
            assert.strictEqual(draws(),before+1)
            const matrix=gl.calls.filter(v=>v.name==='uniformMatrix4fv'&&v.args[0].name==='u_projection_view').pop().args[2]
            assert(Math.abs(matrix[12]-10.5)<1e-5,'Display priority replayed an older camera')
            assert(gl.syncs.size<=2,'Display priority exceeded the GPU submission bound')
          } else if(outcome==='withheld') {
            // New pointer updates do not restart an already offered window.
            for(let i=0;i<4;++i){now+=8;const camera=frame();camera.projectionView[3]=0.3+i/100;renderer.setCameraFrame(camera)}
            ++now;renderer.advanceResources()
            assert(renderer.submissions.uploading,'Withheld display callbacks stopped background uploads')
            const ready=tiles.filter(t=>store.gpuReady(key(t))).length
            ++now;gl.complete();renderer.advanceResources()
            assert(tiles.filter(t=>store.gpuReady(key(t))).length>ready,'Expired priority silently rearmed without a display attempt')
            assert.strictEqual(draws(),before)
          } else if(outcome==='pause') {
            renderer.setPaused(true);renderer.setPaused(false);renderer.advanceResources()
            assert(renderer.submissions.uploading,'Pause retained a stale camera priority window')
          } else {
            renderer.contextWasLost();gl.syncs.clear();renderer.advanceResources()
            assert.strictEqual(renderer.pendingSubmission,null)
          }
        }
      } finally {renderer.destroy()}
      await settle()
      assert.strictEqual(gl.syncs.size,0);assert.strictEqual(renderer.resourceLedger.bytes,0)
    }
  } finally {global.performance=performance}
  console.log('Camera submission: drained upload handoff, latest display, bounded withholding, stationary progress and teardown passed')
}
