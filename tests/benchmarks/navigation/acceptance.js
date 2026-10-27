(function(root,factory) {
  if(typeof module==='object'&&module.exports)module.exports=factory()
  else root.TerraNavigationAcceptance=factory()
})(typeof self==='undefined'?this:self,function() {
  'use strict'
  function legs(config) {
    let previous=config.view
    return (config.motions||[config.motion]).map((motion,index)=>{
      if(!motion||!['direct-flight','log-zoom'].includes(motion.kind)||
          !Number.isFinite(motion.durationMs)||motion.durationMs<=0||motion.durationMs>8000)
        throw Error('Invalid fixed navigation motion')
      if(motion.kind==='log-zoom'&&(!Number.isInteger(motion.samples)||motion.samples<2||motion.samples>256))
        throw Error('Invalid fixed zoom samples')
      const view={...previous,...motion.view,target:{...previous.target,...(motion.view||{}).target}}
      if(motion.headingDegrees!==undefined)view.headingDegrees=motion.headingDegrees
      if(!(view.rangeMeters>0))throw Error('Invalid navigation range')
      const result={index,motion,from:previous,view};previous=view;return result
    })
  }
  function endpoint(config) {
    return legs(config).slice(-1)[0].view
  }
  function zoomView(from,to,progress) {
    const t=Math.max(0,Math.min(1,progress))
    return {...to,target:{...to.target},rangeMeters:t===1?to.rangeMeters:
      from.rangeMeters*Math.pow(to.rangeMeters/from.rangeMeters,t)}
  }
  function groundReady(state) {
    const camera=state.cameraGround||{},demand=camera.demand
    return !demand||!demand.active||!demand.pending&&camera.appliedDemandRevision===demand.revision&&
      ['eye','front'].every(role=>!demand[role]||demand[role].status!=='pending')
  }
  function sourceReady(state,quality,limit) {
    const q=(state.renderer||{}).quality||{}
    return Boolean(limit&&quality.terminal==='data-limited'&&quality.current&&quality.covered&&quality.terrainMet&&
      quality.busy.length===0&&quality.reasons.length===1&&quality.reasons[0]==='source-level'&&
      q.resolvedLevelMinimum===limit.sourceLevel&&q.resolvedLevelMaximum===limit.sourceLevel&&
      q.resolvedMaxPixelError<=limit.maximumPixelError*1.001&&q.refinableMeasurementCount===0)
  }
  class SettledWindow {
    constructor(config,view,sameView,sourceLimit=null) {
      this.config=config;this.view=view;this.sameView=sameView;this.stableAt=null;this.lastMs=-Infinity
      this.sourceLimit=sourceLimit
    }
    observe(elapsed,state,quality) {
      if(!Number.isFinite(elapsed)||elapsed<this.lastMs)throw Error('Non-monotonic conditioning clock')
      this.lastMs=elapsed
      if(!this.sameView(state.view,this.view))throw Error('Conditioned camera differs from the declared endpoint')
      const selection=state.terrainSelection||{}
      const identity=JSON.stringify([selection.presentedSequence,selection.presentedModelRevision,
        selection.desiredViewRevision,selection.preparedViewRevision,selection.presentedViewRevision])
      const limited=sourceReady(state,quality,this.sourceLimit)
      const ready=(quality.terminal==='ready'||limited)&&groundReady(state)
      if(!ready||identity!==this.identity)this.stableAt=null
      this.identity=identity
      if(ready&&this.stableAt===null)this.stableAt=elapsed
      if(elapsed<=this.config.acceptanceMs&&this.stableAt!==null&&elapsed-this.stableAt>=this.config.stableMs)
        return limited?'source-limited':'ready'
      return elapsed>=this.config.acceptanceMs?'timeout':'waiting'
    }
  }
  return {endpoint,legs,zoomView,groundReady,sourceReady,SettledWindow}
})
