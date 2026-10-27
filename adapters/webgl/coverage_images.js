const {textureKeyString:key}=require('../../sdk/js/core/terra_globe_common')
const {textureTileContains,textureCellTransform}=require('../../sdk/js/imagery/terra_texture_tiles')
const {CooperativeTask}=require('../../sdk/js/runtime/cooperative_task')
const {monotonicNow}=require('../../sdk/js/diagnostics/timing')
const {holdMeshes}=require('../../sdk/js/resources/mesh_ownership')
const {coverageCellBounds,coverageScissor}=require('./coverage_cell_bounds')

const identity=d=>[d.geometryKey,key(d.sourceTexture||d.texture),d.firstIndex,d.indexCount].join(':')

// Geometry coverage must not imply root-image coverage. Reuse resident images
// on the existing coarse meshes until CBDAM publishes the new terrain cut.
// These optional descriptors request no images or UV buffers. Fine-to-coarse
// stencil submission fills each uncovered pixel once, preserving real terrain.
class CoverageImages {
  constructor(renderer){this.renderer=renderer;this.rows=new Map();this.sources=new Map();this.loans=new Map();this.projections=new WeakMap()}
  scissor(draw,frame) {
    const bounds=draw.coverageBounds
    if(!bounds)return null
    const r=this.renderer,width=r.canvas.width,height=r.canvas.height,origin=draw.origin
    const previous=this.projections.get(bounds)
    if(previous&&previous.version===r.cameraVersion&&previous.width===width&&previous.height===height&&
        origin.every((v,i)=>v===previous.origin[i]))return previous.rect
    const rect=coverageScissor(bounds,origin,frame.projectionView,width,height)
    this.projections.set(bounds,{version:r.cameraVersion,width,height,origin:origin.slice(),rect})
    return rect
  }
  endFrame(){for(const release of this.loans.values())release();this.loans.clear()}
  use(tile) {
    const id=key(tile)
    if(this.loans.has(id))return
    const release=this.renderer.textures.cache.retain(id)
    if(release)this.loans.set(id,release)
  }
  submit(batch){for(const release of this.loans.values())batch.hold(release);this.loans.clear()}
  clear() {
    this.endFrame()
    if(this.job){this.job.task.cancel();this.job.releaseMeshes();this.job.credit.release();this.job=null}
    if(this.credit)this.credit.release()
    this.credit=null;this.rows.clear();this.stamp=null
    this.sources.clear();this.sourceStamp=null
    this.projections=new WeakMap()
  }
  advance(deadline) {
    const r=this.renderer
    if(r.mode!=='texture'||!r.sourceUvPartitions||typeof r.gl.stencilFunc!=='function') {
      if(this.credit||this.job)this.clear()
      return
    }
    if(this.generation!==r.textures.generation){this.clear();this.generation=r.textures.generation}
    // Only the submitted surface can ask for optional geometry fallback.
    // Building every retained/private surface after its fallback is no longer
    // drawn steals time and handoff capacity from mandatory image production.
    const sources=this.sources
    if(!sources.size)return
    const stamp=r.textures.cache.contentRevision+':'+r.sourceUvScale()+':'+Array.from(sources.keys()).join('|')
    if(!this.job&&stamp!==this.stamp) {
      const size=1024+sources.size*256+r.textures.cache.entries.size*(96+sources.size*4096)
      // Optional visual coverage never evicts a producer to fund its metadata.
      const ledger=r.resourceLedger
      if(ledger.maximumBytes&&ledger.bytes+size>ledger.maximumBytes)return
      const credit=ledger.reserve('coverage-image-descriptors',size)
      if(!credit)return
      const tiles=[]
      for(const id of r.textures.cache.entries.keys())if(r.textures.gpuReady(id)) {
        const [level,matrix,row,column]=id.split('/').map(Number)
        tiles.push({level,matrix,row,column})
      }
      const models=new Map(),resources=[]
      for(const [id,draw]of sources) {
        const geometry=r.geometry.get(draw.geometryKey)
        if(geometry){models.set(id,geometry.model);if(geometry.resource)resources.push(geometry.resource)}
      }
      const job=this.job={stamp,credit,releaseMeshes:holdMeshes(resources)}
      job.task=new CooperativeTask(this.build(sources,tiles,r.sourceUvScale(),models),Infinity,monotonicNow)
    }
    if(!this.job)return
    const job=this.job,result=job.task.step(deadline)
    if(result.done) {
      job.releaseMeshes()
      if(this.credit)this.credit.release()
      this.rows=result.value;this.credit=job.credit;this.credit.mark('resident')
      this.stamp=job.stamp;this.job=null;r.requestRender()
    }
    if(this.job||this.stamp!==stamp)r.requestResources()
  }
  *build(sources,tiles,maximumScale,models) {
    tiles.sort((a,b)=>b.level-a.level)
    const result=new Map()
    for(const [id,draw]of sources) {
      const source=draw.sourceTexture||draw.texture,rows=[]
      const previous=new Map((this.rows.get(id)||[]).map(row=>[key(row.texture),row.coverageBounds]))
      for(const tile of tiles) {
        yield
        if(tile.level<=source.level||!textureTileContains(source,tile))continue
        const t=textureCellTransform(source,tile)
        if(t.scale>maximumScale)continue
        const row=Object.assign({},draw,{sourceTexture:source,texture:tile,imageryTarget:tile,
          imageryCellScale:t.scale,imageryCellOffsetX:t.offsetX,imageryCellOffsetY:t.offsetY,
          imageryClipCell:true,imageryDirectClip:true,imageryIndexCell:undefined,
          imageryHandover:true,imageryResidentCoverage:true})
        row.coverageBounds=previous.get(key(tile))||
          (yield* coverageCellBounds(models.get(id),this.renderer.partitionCell(row)))
        rows.push(row)
      }
      result.set(id,rows)
    }
    return result
  }
  read(draws) {
    if(this.generation!==this.renderer.textures.generation){this.clear();this.generation=this.renderer.textures.generation}
    if(!draws.length) {
      if(this.sources.size||this.job||this.credit)this.clear()
      return draws
    }
    this.sources=new Map(draws.map(draw=>[identity(draw),draw]))
    const stamp=Array.from(this.sources.keys()).join('|')
    if(stamp!==this.sourceStamp){this.sourceStamp=stamp;this.renderer.requestResources()}
    const result=[]
    for(const draw of draws) {
      for(const row of this.rows.get(identity(draw))||[])
        if(this.renderer.textures.gpuReady(key(row.texture)))result.push(row)
      result.push(draw)
    }
    return result
  }
}
module.exports={CoverageImages}
