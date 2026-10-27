const {textureKeyString:tileKey}=require('../../sdk/js/core/terra_globe_common')

// Reuse a submitted allocation witness across camera/metadata publications.
// It borrows no GPU handles and never transfers display ownership.
function submittedSurfaceWitness(r,previous,draws,meshResources,indices,sameWorker) {
  const frame=r.current.frame,DRAW_FLAG_COVERAGE=1
  const displayed=r.displaySurface
  if(sameWorker&&displayed&&displayed.current===previous&&!displayed.useGeometryCoverage&&
      previous.indices===indices&&frame.coverageComplete!==false&&r.omittedCurrentGeometryCount()===0&&
      draws.some(draw=>!(draw.flags&DRAW_FLAG_COVERAGE))) {
    const submitted=new Map()
    for(const draw of previous.draws) {
      if(!submitted.has(draw.resourceId))submitted.set(draw.resourceId,[])
      submitted.get(draw.resourceId).push(draw)
    }
    const reusable=draws.every(draw=>previous.meshResources.get(draw.resourceId)===meshResources.get(draw.resourceId)&&
      (submitted.get(draw.resourceId)||[]).some(old=>old.textureResourceId===draw.textureResourceId&&
        old.firstIndex===draw.firstIndex&&old.indexCount===draw.indexCount&&old.vertexCount===draw.vertexCount&&
        tileKey(old.texture)===tileKey(draw.texture)&&old.origin.every((v,k)=>v===draw.origin[k])))
    if(reusable&&(r.mode!=='texture'||r.worldDisplay.compatible(r.renderDraws))) {
      return {current:r.current,renderDraws:r.renderDraws,coverageDraws:r.coverageDraws,
        geometryCoverageDraws:r.geometryCoverageDraws,useGeometryCoverage:false,quality:r.pendingQualityStats}
    }
  }
  return null
}

module.exports={submittedSurfaceWitness}
