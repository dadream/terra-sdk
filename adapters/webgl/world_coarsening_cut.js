const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {parentTextureTile,textureTileContains}=require('../../sdk/js/imagery/terra_texture_tiles')

// Retarget existing, already submitted UV cells before introducing any new
// fine-cell index dependency. No geometry, image or UV allocation is required.
function* coarseningCutRows(current,proposed,sourceKey,groupFor,reserve) {
  const goals=new Map(),rows=[],coarsening=[]
  for(const draw of proposed) {
    yield;reserve(512)
    goals.set(sourceKey(draw)+':'+key(draw.texture),draw)
  }
  for(const draw of current) {
    yield;reserve(896)
    let goal
    const source=sourceKey(draw)
    for(let tile=draw.texture;tile&&!goal;tile=parentTextureTile(tile)) {
      yield;reserve(96)
      goal=goals.get(source+':'+key(tile))
    }
    const row=Object.assign({},draw)
    delete row.imageryPublicationState
    const target=goal&&(goal.imageryTarget||goal.texture),old=draw.imageryTarget||draw.texture
    if(target&&target.level<old.level&&textureTileContains(target,draw.texture)) {
      row.imageryTarget={level:target.level,matrix:target.matrix,row:target.row,column:target.column}
      row.imageryHandover=goal.imageryHandover
      row.imageryCapacityCoarsened=goal.imageryCapacityCoarsened
      coarsening.push(row)
    }
    row.imageryGroup=groupFor(row.texture,row.imageryTarget||row.texture)
    rows.push(row)
  }
  return coarsening.length?{rows,coarsening}:null
}

module.exports={coarseningCutRows}
