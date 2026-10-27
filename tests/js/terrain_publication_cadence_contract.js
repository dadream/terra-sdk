const assert = require('assert')
const {patch, surface} = require('./terrain_surface_fixture')

// CPU model revisions and resource receipts are not camera motion. Within one
// display interval, admitted independent groups can share their next draw.
module.exports = async function ({Renderer, AsyncGl, FakeCanvas, frame, settle}) {
  const performance = global.performance
  let clock = 1000
  global.performance = {now: () => clock}
  try {
    for (const interrupt of [null, 'camera', 'deadline', 'no-upload']) {
      const before = surface([patch(51, [[0,0],[1,0],[0,1]]), patch(52, [[1,1],[0,1],[1,0]])])
      const next = surface([
        patch(61, [[0,0],[.5,0],[0,.5]]), patch(62, [[.5,0],[1,0],[.5,.5]]),
        patch(63, [[0,.5],[.5,.5],[0,1]]), patch(64, [[.5,0],[.5,.5],[0,.5]]),
        patch(65, [[1,1],[0,1],[.5,.5]]), patch(66, [[1,1],[.5,.5],[1,0]])])
      const gl = new AsyncGl(), canvas = new FakeCanvas(gl), receipts = []
      canvas.width = canvas.height = 64
      const r = new Renderer(canvas, {mode:'height',urlForTile:()=>'',uploadBudgetObjects:2,
        onPresented:sequence=>receipts.push(sequence)})
      const publish = (sequence, value, replacementPlan) => r.setMeshFrame(
        Object.assign(frame(), {sequence, coverageComplete:true}),value.draws,value.meshResources,before.indices,
        {modelRevision:sequence,workerGeneration:1,pendingPriorityUpdateCount:1},null,[],
        {replacementPlan,selectionCurrent:true,camera:{}})
      const draws = () => gl.calls.filter(call=>call.name==='clear').length
      const step = (ms=1) => {clock+=ms;gl.complete();r.advanceResources();return r.render(false)}
      let processUploads
      try {
        publish(1,before)
        for(let i=0;i<12;++i)step(40)
        const start=draws(),camera=r.cameraVersion
        assert.deepStrictEqual(receipts,[1])
        publish(2,next,{groups:[{before:[51],after:[61,62,63,64]},{before:[52],after:[65,66]}]})
        assert.strictEqual(r.cameraVersion,camera,'Same-view model publication changed the camera epoch')
        r.advanceResources()
        r.render(false)
        assert.strictEqual(draws(),start,'Unready model publication repainted identical display inputs')
        for(let i=0;i<3;++i)step()
        assert.strictEqual(draws(),start)
        // The fourth upload makes the first group usable. There is still
        // admitted work for a second independent group, using the same camera.
        if(interrupt==='no-upload') {
          processUploads=r.processUploads
          r.processUploads=()=>{} // Independent producer/backpressure boundary.
        }
        step()
        if(interrupt==='no-upload') {
          assert.strictEqual(draws(),start+1,'A blocked upload lane delayed a usable local group')
          assert.deepStrictEqual(r.displaySurface.current.draws.map(d=>d.resourceId),[61,62,63,64,52])
          r.processUploads=processUploads;processUploads=null;r.requestResources()
        } else {
          assert.strictEqual(draws(),start,'A local geometry group bypassed the existing resource merge interval')
          assert(r.pendingSubmission&&!r.pendingSubmission.drawn,'Preparation created an early draw fence')
          if(interrupt==='camera') {
            const moved=frame();moved.projectionView[3]=.25
            r.setCameraFrame(moved);r.render(false);step()
            assert.strictEqual(draws(),start+1,'Coalescing delayed a real camera change')
            const matrix=gl.calls.filter(call=>call.name==='uniformMatrix4fv'&&call.args[0].name==='u_projection_view').pop().args[2]
            assert(Math.abs(matrix[12]-10.25)<1e-5)
          } else if(interrupt==='deadline') {
            step(20)
            assert.strictEqual(draws(),start+1,'Continuing uploads starved ready geometry past the merge interval')
            assert.deepStrictEqual(r.displaySurface.current.draws.map(d=>d.resourceId),[61,62,63,64,52])
          }
        }
        assert.deepStrictEqual(receipts,[1],'Partial presentation acknowledged the whole candidate')
        for(let i=0;i<8;++i)step()
        assert.deepStrictEqual(receipts,[1,2])
        assert.strictEqual(draws(),start+(interrupt?2:1),'Ready groups were not published as the expected complete draws')
        assert.strictEqual(r.pendingSubmission,null)
        assert.strictEqual(r.uploadQueue.length,0)
      } finally {
        if(processUploads)r.processUploads=processUploads
        r.destroy();await settle()
      }
      assert.strictEqual(gl.syncs.size,0)
      assert.strictEqual(r.resourceLedger.bytes,0)
    }
  } finally {global.performance=performance}
}
