const {textureKeyString: key} = require('../core/terra_globe_common')
const {textureCellTransform} = require('../imagery/terra_texture_tiles')
const {regionError} = require('./terra_surface_plan')
const {MeasurementRows} = require('./measurement_rows')

// Region vectors are immutable projection snapshots. Transport and renderer
// metadata copies share that vector; a new projection owns a new vector. This
// weak memo owns neither meshes nor view wrappers. Keep the existing bound of
// 256 numeric entries per projection vector,
// shared by cell densities and complete-region densities, rather than adding
// another per-region cache. Eviction affects work only, never the quality cut.
const densities = new WeakMap()
const maximumEntries = 256

function remember(memo, id, density, cell = false) {
  const entries = cell ? memo.cells : memo.regions
  if (!entries.has(id) && memo.cells.size + memo.regions.size >= maximumEntries) {
    // A cell already summarizes all its contributing regions. Auxiliary
    // region reuse cannot displace that more expensive result; otherwise a
    // large mesh turns alternating coarse cells into repeated full scans.
    const victim = memo.regions.size ? memo.regions : cell ? memo.cells : null
    if (!victim) return density
    victim.delete(victim.keys().next().value)
  }
  entries.set(id, density)
  return density
}

function regionDensity(memo, region, cell) {
  if (!region.projection) return region.pixelsPerUv
  const b = region.uv
  if (cell.minimumU > b.minimumU || cell.maximumU < b.maximumU ||
      cell.minimumV > b.minimumV || cell.maximumV < b.maximumV) return regionError(region, cell)
  // Match Native's normalized region bound: a containing ancestor cannot
  // change this domain. The input pixelsPerUv may still be a loose triangle
  // bound, so compute the actual complete-region result before reusing it.
  if (memo.regions.has(region)) return memo.regions.get(region)
  return remember(memo, region, regionError(region, b))
}

function textureFootprintDensity(measured, source, tile, kernel) {
  const regions = measured.regions
  if (!regions) return measured.pixelsPerUv
  let memo = densities.get(regions)
  if (!memo) { memo = {cells:new Map(), regions:new Map()}; densities.set(regions, memo) }
  const id = `${key(source)}:${key(tile)}`
  if (memo.cells.has(id)) return memo.cells.get(id)
  const t = textureCellTransform(source, tile)
  const cell = {minimumU:-t.offsetX/t.scale, maximumU:(1-t.offsetX)/t.scale,
    minimumV:-t.offsetY/t.scale, maximumV:(1-t.offsetY)/t.scale}
  let density = 0
  if(regions instanceof MeasurementRows) {
    regions.visitIntersections(cell,(index,u0,v0,u1,v1)=>{
      let value
      if(!(regions.flags(index)&1))value=regions.number(index,4)
      else if(cell.minimumU>u0||cell.maximumU<u1||cell.minimumV>v0||cell.maximumV<v1)value=kernel.error(regions,index,cell)
      else if(memo.regions.has(index))value=memo.regions.get(index)
      else value=remember(memo,index,kernel.error(regions,index))
      density=Math.max(density,value)
    })
    return remember(memo,id,density,true)
  }
  for (const region of regions) {
    const b = region.uv
    if (b.maximumU > cell.minimumU && b.minimumU < cell.maximumU &&
        b.maximumV > cell.minimumV && b.minimumV < cell.maximumV) {
      density = Math.max(density, regionDensity(memo, region, cell))
    }
  }
  return remember(memo, id, density, true)
}

module.exports = {textureFootprintDensity}
