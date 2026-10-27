// Replay the native imagery planner with an offline, fixed-view UV oracle.
// No network, image fetch, production visibility feedback or budget changes.
const fs = require('fs')
const crypto = require('crypto')
const assert = require('assert')
const {TerraAbi} = require('../adapters/wasm/terra_abi')
const {instantiateTerraWasmBytes} = require('../adapters/wasm/terra_wasm')
const {regionError} = require('../sdk/js/terrain/terra_surface_plan')
const {textureKeyString:key} = require('../sdk/js/core/terra_globe_common')
const {globalCoverageTextureTiles,parentTextureTile,textureTileContains} = require('../sdk/js/imagery/terra_texture_tiles')
const {textureByteSize} = require('../adapters/webgl/texture_store')

function intersect(a,b) {
  const uv={minimumU:Math.max(a.minimumU,b.minimumU),minimumV:Math.max(a.minimumV,b.minimumV),
    maximumU:Math.min(a.maximumU,b.maximumU),maximumV:Math.min(a.maximumV,b.maximumV)}
  return uv.minimumU<uv.maximumU && uv.minimumV<uv.maximumV ? uv : null
}

function clipTriangle(triangle,uv) {
  let polygon=triangle
  for (const [axis,bound,sign] of [[0,uv.minimumU,1],[0,uv.maximumU,-1],[1,uv.minimumV,1],[1,uv.maximumV,-1]]) {
    const next=[]
    for(let i=0;i<polygon.length;++i) {
      const a=polygon[i],b=polygon[(i+1)%polygon.length],da=sign*(a[axis]-bound),db=sign*(b[axis]-bound)
      if(da>=0)next.push(a)
      if((da<0)!==(db<0)) {const t=da/(da-db);next.push(a.map((v,j)=>v+t*(b[j]-v)))}
    }
    polygon=next
  }
  const triangles=[]
  for(let i=2;i<polygon.length;++i) {
    const [a,b,c]=[polygon[0],polygon[i-1],polygon[i]]
    if((b[0]-a[0])*(c[1]-a[1])!==(b[1]-a[1])*(c[0]-a[0]))triangles.push([a,b,c])
  }
  return triangles
}

function clipMeasurement(measurement,cells) {
  const regions=[]
  for(const cell of cells) {
    const bounds={minimumU:cell.x/cell.scale,minimumV:cell.y/cell.scale,
      maximumU:(cell.x+1)/cell.scale,maximumV:(cell.y+1)/cell.scale}
    for(const region of measurement.regions) {
      const uv=intersect(region.uv,bounds)
      if(!uv)continue
      // A projective triangle's UV bounds alone do not clip its density
      // coefficients in the ABI. Preserve the actual clipped polygon as a fan.
      const triangles=region.projection && !(region.numeratorBound>=0)
        ? clipTriangle(region.triangle,uv) : [null]
      for(const triangle of triangles) {
        const clipped=Object.assign({},region,{uv},triangle?{triangle}:{})
        clipped.pixelsPerUv=Math.min(region.pixelsPerUv,regionError(clipped,uv))
        if(clipped.pixelsPerUv>0)regions.push(clipped)
      }
    }
  }
  return Object.assign({},measurement,{regions,visible:measurement.visible&&regions.length>0,
    pixelsPerUv:regions.reduce((maximum,r)=>Math.max(maximum,r.pixelsPerUv),0)})
}

// A constructive image-only handoff witness, not a production scheduler or an
// optimality proof. A predecessor remains until every overlapping target has
// a usable replacement; both ends of an existing blend are predecessors.
function transitionWitness(presentation,targets,coverage,tileBytes) {
  const desired=new Map(targets.map(tile=>[key(tile),tile])),resident=new Set(coverage.map(key))
  const predecessors=new Map(),groups=new Map()
  for(const state of presentation) for(const tile of [state.a,state.b]) {
    const id=key(tile);resident.add(id)
    if(!predecessors.has(id))predecessors.set(id,new Set())
    for(const [target,value] of desired)
      if(textureTileContains(value,state.cell)||textureTileContains(state.cell,value))predecessors.get(id).add(target)
  }
  const requiredCoverage=new Set(coverage.map(key))
  const retire=()=>{
    for(const [id,dependencies] of predecessors)
      if(!desired.has(id)&&!requiredCoverage.has(id)&&Array.from(dependencies).every(k=>resident.has(k)))resident.delete(id)
  }
  let peak=resident.size*tileBytes
  retire()
  for(const [id,tile] of desired) {
    const parent=key(parentTextureTile(tile)||tile)
    if(!groups.has(parent))groups.set(parent,new Set())
    groups.get(parent).add(id)
  }
  const steps=[]
  while(groups.size) {
    // Small additions first; ties prefer retiring more predecessor payload.
    const candidates=Array.from(groups,([id,members])=>{
      const missing=Array.from(members).filter(k=>!resident.has(k))
      const released=Array.from(predecessors).filter(([k,needs])=>resident.has(k)&&!desired.has(k)&&
        !requiredCoverage.has(k)&&Array.from(needs).every(t=>resident.has(t)||members.has(t))).length
      return {id,members,missing,released}
    }).sort((a,b)=>a.missing.length-b.missing.length||b.released-a.released||a.id.localeCompare(b.id))
    const next=candidates[0],before=resident.size
    next.missing.forEach(id=>resident.add(id))
    const submitted=resident.size
    peak=Math.max(peak,submitted*tileBytes)
    retire();groups.delete(next.id)
    if(next.missing.length)steps.push({group:next.id,added:next.missing.length,retired:submitted-resident.size,
      beforeEntries:before,submissionEntries:submitted,afterEntries:resident.size})
  }
  return {peakGpuBytes:peak,finalGpuBytes:resident.size*tileBytes,steps}
}

async function main() {
  const [snapshotFile,planFile,reportFile,output,wasmFile='workspace_old/build/wasm/terra_sdk.wasm']=process.argv.slice(2)
  if(!output)throw Error('Usage: node scripts/analyze_visible_uv.js SNAPSHOT PLAN UV_REPORT OUTPUT [WASM]')
  const bytes=fs.readFileSync(snapshotFile),snapshot=JSON.parse(bytes),input=JSON.parse(fs.readFileSync(planFile))
  const report=JSON.parse(fs.readFileSync(reportFile)),wasm=fs.readFileSync(wasmFile)
  const hash=value=>crypto.createHash('sha256').update(value).digest('hex')
  assert(report.passed && report.visibleUv && report.visibleUv.schema==='terra.offline-visible-uv.v1')
  assert.strictEqual(report.snapshotSha256,hash(bytes),'Visibility and geometry snapshots differ')
  assert.strictEqual(report.wasmSha256,hash(wasm),'Visibility and planner Wasm differ')
  assert.deepStrictEqual(input.state.view,snapshot.view,'Planner and geometry views differ')
  assert.strictEqual(input.state.frame.sequence,snapshot.frame.sequence,'Planner and geometry cuts differ')
  const descriptor=input.options.descriptor,measurements=new Map(input.measurements)
  const sources=new Map(snapshot.draws.map(draw=>[draw.resourceId,draw]))
  for(const draw of input.draws) {
    const source=sources.get(draw.resourceId)
    for(const field of ['origin','texture','firstIndex','indexCount','textureNode'])
      assert.deepStrictEqual(draw[field],source&&source[field],'Planner draw differs: '+field)
  }
  const ids=new Set(input.draws.map(draw=>draw.resourceId))
  assert.strictEqual(ids.size,input.draws.length)
  assert(report.visibleUv.levels.length>0 && report.visibleUv.levels.length<=5)
  report.visibleUv.levels.forEach((level,index)=>assert.strictEqual(level.depth,index,'Incomplete UV levels'))
  const coverage=globalCoverageTextureTiles(descriptor),coverageKeys=coverage.map(key)
  assert.strictEqual(coverage.length,input.state.renderer.textures.coverageDesired,'Unsupported coverage policy')
  const old=new Set((input.presentation||[]).flatMap(state=>[key(state.a),key(state.b)]).concat(coverageKeys))
  const tileBytes=textureByteSize(descriptor.tile_size,descriptor.tile_size),results=[]
  const abi=new TerraAbi(await instantiateTerraWasmBytes(wasm))
  try {
    abi.loadManifest({formatVersion:1,patchDimension:64,transform:'cylindrical',heightScale:1/512,
      minimumU:-180,minimumV:-90,maximumU:180,maximumV:90,radius:6378000,texture:descriptor})
    let previous
    for(const level of [{depth:-1,visible:null},...report.visibleUv.levels]) {
      const byId=new Map(),seen=new Set()
      for(const cell of level.visible||[]) {
        assert(ids.has(cell.id)&&cell.scale===Math.pow(2,level.depth)&&
          Number.isInteger(cell.x)&&Number.isInteger(cell.y)&&cell.x>=0&&cell.y>=0&&
          cell.x<cell.scale&&cell.y<cell.scale,'Invalid UV cell')
        const name=[cell.id,cell.x,cell.y].join(':')
        assert(!seen.has(name),'Duplicate UV cell');seen.add(name)
        if(previous)assert(previous.has([cell.id,Math.floor(cell.x/2),Math.floor(cell.y/2)].join(':')),
          'UV child outside its visible parent')
        if(!byId.has(cell.id))byId.set(cell.id,[])
        byId.get(cell.id).push(cell)
      }
      if(level.depth>=0)previous=seen
      const clipped=level.depth<0?measurements:new Map(input.measurements.map(([id,m])=>
        [id,clipMeasurement(m,byId.get(id)||[])]))
      const capacities=[]
      for(const maximumTextures of [214,256,1024]) {
        const plan=abi.planImagery(input.draws,draw=>clipped.get(draw.resourceId),{
          ...input.options,maximumTextures,detached:true,maximumDraws:8192,resetHistory:true})
        const targets=new Set(plan.draws.map(draw=>key(draw.texture)))
        const steady=new Set([...targets,...coverageKeys]),union=new Set([...old,...steady])
        const witness=maximumTextures===1024 ? transitionWitness(input.presentation||[],
          plan.draws.map(draw=>draw.texture),coverage,tileBytes) : null
        // Proposed transient envelope, not the current retained-Blob policy:
        // one bounded streamed body plus assembly and two decode/upload slots.
        const stagingBytes=Math.max(65536,descriptor.tile_size**2*8)*2+descriptor.tile_size**2*8
        capacities.push({maximumTextures,meetsTarget:plan.quality.meetsTarget,
          error:plan.quality.measuredMaxPixelError,textures:targets.size,draws:plan.draws.length,
          gpuOnly:{targetBytes:targets.size*tileBytes,withCoverageBytes:steady.size*tileBytes,
            withCoverageEntries:steady.size,oldAndNewBytes:union.size*tileBytes,oldAndNewEntries:union.size},
          steadyGpuFits:steady.size<=input.state.budget.maximumTextureEntries&&
            steady.size*tileBytes<=input.state.budget.textureCacheBytes,
          imageOnlyWitness:witness&&Object.assign(witness,{stagingBytes,
            peakWithTransientBytes:witness.peakGpuBytes+stagingBytes,
            fitsByteLimitWithoutRetainedBlobs:witness.peakGpuBytes+stagingBytes<=input.state.budget.textureCacheBytes})})
      }
      results.push({depth:level.depth,visibleMeshes:Array.from(clipped.values()).filter(m=>m.visible).length,
        visibleCells:level.visible&&level.visible.length,regions:Array.from(clipped.values()).reduce((n,m)=>n+m.regions.length,0),capacities})
    }
    const result={schema:'terra.visible-uv-capacity.v1',snapshotSha256:hash(bytes),wasmSha256:hash(wasm),
      visibilityMode:report.visibleUv.conservativeTriangles?'expanded-triangle-experiment':
        report.visibleUv.conservativeBounds?'triangle-envelope':'original-triangle-oracle',
      visibilitySha256:hash(fs.readFileSync(reportFile)),tileBytes,oldEntries:old.size,coverageEntries:coverage.length,
      scope:'Fixed raster UV oracle and native planner. GPU-only steady/union costs exclude all transient owners. The constructive image-only witness adds one bounded body/assembly plus two decoded images, assumes encoded bytes are dropped after upload and completed blends retire before the next group, and ignores the current entry cap. It excludes UV/geometry costs and does not prove shared-ledger or runtime feasibility. Whole-union cost is not an incremental handoff lower bound.',results}
    fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result))
  } finally {abi.destroy()}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1})
module.exports={clipMeasurement,transitionWitness}
