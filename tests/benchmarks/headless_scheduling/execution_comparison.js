'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path')
const {difference}=require('./compare')
const {digest}=require('./records')
const {verifyReferenceCamera}=require('./camera')

function resourceReader(directory) {
  const base=path.resolve(directory),cache=new Map()
  return receipt=>{
    assert(receipt&&receipt.file&&receipt.sha256,'Missing Native resource-input receipt')
    const file=path.resolve(base,receipt.file)
    assert(file.startsWith(base+path.sep)&&fs.realpathSync(file).startsWith(fs.realpathSync(base)+path.sep),
      'Resource snapshot leaves the reference directory')
    const bytes=fs.readFileSync(file)
    assert.strictEqual(digest(bytes),receipt.sha256,'Native resource snapshot changed')
    if(!cache.has(receipt.sha256))cache.set(receipt.sha256,JSON.parse(bytes))
    return cache.get(receipt.sha256)
  }
}

function compareStage(actual,expected,inputs) {
  const roots=new Set(inputs.availableRoots.flatMap(key=>[0,1].map(fragment=>key.concat(fragment).join('/'))))
  const sets=difference(actual.terrainKeys,expected.visibleKeys)
  const retainedRootCoverage=sets.onlyFirst.filter(key=>roots.has(key))
  // Only the recorded persistent roots are coverage additions. Never remove an
  // arbitrary non-root parent, child or missing reference fragment to get parity.
  const extra=sets.onlyFirst.filter(key=>!roots.has(key)),missing=sets.onlySecond
  const nodeCountEqual=actual.terrain.topologyNodeCount===expected.nodes
  const errorDelta=actual.terrain.achievedLodError-expected.achievedError
  assert(Number.isFinite(errorDelta),'Missing measured terrain error')
  const errorEqual=Math.abs(errorDelta)<=1e-10
  return {sameSets:!extra.length&&!missing.length,nodeCountEqual,errorEqual,errorDelta,
    executionNodes:actual.terrain.topologyNodeCount,referenceNodes:expected.nodes,
    retainedRootCoverage,extra,missing,
    equivalent:!extra.length&&!missing.length&&nodeCountEqual&&errorEqual}
}

function compareExecution(reference,execution,readInputs) {
  assert.strictEqual(reference.schema,'terra.headless-scheduling.v1')
  assert.strictEqual(execution.schema,'terra.wasm-scheduling.v1')
  assert.strictEqual(reference.status,'complete')
  assert(reference.inputsUnchanged&&reference.cores.sdk.complete,'Incomplete Native reference')
  assert.strictEqual(reference.sdkResourceMode,'fixed','A frozen target reference is required')
  // Native runner controls are separate from the scene/error contract. Capacity
  // is intentionally compared against an unconstrained frozen target.
  const {benchmarkImagery,benchmarkMeshBytes,...referenceCase}=reference.configuration
  assert.deepStrictEqual(execution.configuration,referenceCase,'Execution case configuration differs')
  assert.deepStrictEqual(execution.poses,reference.poses,'Execution and reference poses differ')
  const core=reference.cores.sdk,results=[]
  for(const name of ['rows','discoveryRows']) {
    assert.strictEqual(core[name].length,reference.poses.length,'Incomplete Native '+name)
    assert.strictEqual(new Set(core[name].map(row=>row.id)).size,core[name].length,'Duplicate reference stage')
  }
  const frozenReceipts=new Set(core.rows.map(row=>row.resourceInput.sha256))
  assert.strictEqual(frozenReceipts.size,1,'Frozen Native input changed along the route')
  for(const backend of execution.backends) {
    assert(backend.complete,'Incomplete execution backend')
    assert.strictEqual(backend.stages.length,execution.poses.length,'Incomplete execution route')
    for(let i=0;i<execution.poses.length;++i) {
      const actual=backend.stages[i],pose=execution.poses[i]
      assert.strictEqual(actual.id,pose.id,'Execution stage order differs')
      assert(actual.cameraCheck&&actual.cameraCheck.positionErrorMeters<=1e-6&&
        actual.cameraCheck.projectionViewRelativeError<=1e-10,'Unverified execution camera')
      const progressive=core.discoveryRows.find(row=>row.id===pose.id),fixed=core.rows.find(row=>row.id===pose.id)
      assert(progressive&&fixed,'Missing reference pose')
      verifyReferenceCamera(reference.configuration,pose,progressive)
      verifyReferenceCamera(reference.configuration,pose,fixed)
      assert.strictEqual(actual.terrain.requestedLodThreshold,fixed.threshold,'Terrain thresholds differ')
      assert.strictEqual(progressive.threshold,fixed.threshold,'Native profile thresholds differ')
      const a=readInputs(progressive.resourceInput),b=readInputs(fixed.resourceInput)
      const first=compareStage(actual,progressive,a),second=compareStage(actual,fixed,b)
      const relevant=new Set([...second.extra,...second.missing].map(key=>key.split('/').slice(0,4).join('/')))
      const ranges=new Map(b.heightRanges.map(row=>[row.slice(0,4).join('/'),row.slice(4)]))
      const changedRanges=a.heightRanges.filter(row=>relevant.has(row.slice(0,4).join('/'))&&
        ranges.has(row.slice(0,4).join('/'))&&JSON.stringify(row.slice(4))!==JSON.stringify(ranges.get(row.slice(0,4).join('/'))))
        .map(row=>({key:row.slice(0,4),progressive:row.slice(4),fixed:ranges.get(row.slice(0,4).join('/'))}))
      const inputsDiffer=progressive.resourceInput.sha256!==fixed.resourceInput.sha256
      const classification=!actual.terrainTargetMet?'unmet-terrain-target':
        first.equivalent&&second.equivalent?'matched-both-profiles':
        first.equivalent&&inputsDiffer&&changedRanges.length?'matches-progressive-input':'unexplained'
      results.push({backend:backend.backend,id:pose.id,classification,terrainTargetMet:actual.terrainTargetMet,
        progressive:first,fixed:second,inputEvidence:{inputsDiffer,progressive:progressive.resourceInput,
          fixed:fixed.resourceInput,changedRangesAtDifferentFragments:changedRanges}})
    }
  }
  return {schema:'terra.execution-reference-comparison.v1',
    scope:'Terrain sets/nodes/errors only. Native discovery is progressive; measurement is frozen. Equal outputs do not prove identical retained height caches. Imagery, GPU capacity and runtime latency are separate.',
    rows:results,counts:results.reduce((out,row)=>{out[row.classification]=(out[row.classification]||0)+1;return out},{}),
    allProgressiveTargetsMatched:results.length>0&&results.every(row=>row.terrainTargetMet&&row.progressive.equivalent),
    allFixedTargetsMatched:results.length>0&&results.every(row=>row.terrainTargetMet&&row.fixed.equivalent),
    productAccepted:false}
}

module.exports={compareExecution,compareStage,resourceReader}
