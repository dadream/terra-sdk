'use strict'
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path')
const {compareExecution,compareStage,resourceReader}=require('./headless_scheduling/execution_comparison')
const {digest}=require('./headless_scheduling/records')
const camera=require('../../testdata/benchmarks/taian-oblique-camera-v1.json')
const config=require('../../testdata/benchmarks/taian-scheduling-v1.json')
const parent='27/-134217728/108085248/-53477376/0',root='0/1/2/3/0'
const children=['28/-134217728/108077056/-53469184/1','28/-134217728/108093440/-53469184/0']
const key=parent.split('/').slice(0,4).map(Number)
const progressiveInput={availableRoots:[[0,1,2,3]],heightRanges:[[...key,735.0625,952.609375]]}
const fixedInput={...progressiveInput,heightRanges:[[...key,645.328125,952.609375]]}
const expected={...camera.row,threshold:.001,achievedError:.0009,nodes:12,visibleKeys:[parent],resourceInput:{sha256:'progressive'}}
const fixed={...expected,nodes:18,visibleKeys:children,resourceInput:{sha256:'fixed'}}
const reference={schema:'terra.headless-scheduling.v1',status:'complete',inputsUnchanged:true,sdkResourceMode:'fixed',
  configuration:{...config,benchmarkImagery:true,benchmarkMeshBytes:0},poses:[camera.pose],
  cores:{sdk:{complete:true,rows:[fixed],discoveryRows:[expected]}}}
const stage={id:camera.pose.id,terrainTargetMet:true,terrainKeys:[parent,root],
  cameraCheck:{positionErrorMeters:0,projectionViewRelativeError:0},
  terrain:{topologyNodeCount:12,achievedLodError:.0009,requestedLodThreshold:.001}}
const execution={schema:'terra.wasm-scheduling.v1',configuration:config,poses:[camera.pose],
  backends:[{backend:'direct',complete:true,stages:[stage]}]}
const inputs=receipt=>receipt.sha256==='progressive'?progressiveInput:fixedInput
const result=compareExecution(reference,execution,inputs)
assert(result.allProgressiveTargetsMatched&&!result.allFixedTargetsMatched)
assert.strictEqual(result.rows[0].classification,'matches-progressive-input')
assert.deepStrictEqual(result.rows[0].progressive.retainedRootCoverage,[root])
assert.deepStrictEqual(result.rows[0].fixed.extra,[parent])
assert.deepStrictEqual(result.rows[0].fixed.missing,children)
assert.strictEqual(result.rows[0].inputEvidence.changedRangesAtDifferentFragments.length,1)
assert(!compareStage({...stage,terrainKeys:[parent,'0/9/9/9/0']},expected,progressiveInput).sameSets,
  'Unrecorded roots were removed to conceal a difference')
assert(!compareStage({...stage,terrainKeys:[root]},expected,progressiveInput).sameSets,
  'Missing target fragment was treated as coverage')
assert.throws(()=>compareStage({...stage,terrainKeys:[parent,parent]},expected,progressiveInput),/Duplicate/)
const unexplained=compareExecution(reference,{...execution,backends:[{...execution.backends[0],
  stages:[{...stage,terrainKeys:[...stage.terrainKeys,'30/9/9/9/0']}]}]},inputs)
assert.strictEqual(unexplained.rows[0].classification,'unexplained')
assert.throws(()=>compareExecution(reference,{...execution,configuration:{...config,terrainPixelError:2}},inputs),/configuration differs/)
assert.throws(()=>compareExecution(reference,{...execution,poses:[{...camera.pose,tiltDegrees:0}]},inputs),/poses differ/)
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'terra-input-comparison-'))
try {
  const bytes=Buffer.from(JSON.stringify(progressiveInput)),file=path.join(directory,'input.json')
  fs.writeFileSync(file,bytes)
  const receipt={file:'input.json',sha256:digest(bytes)},read=resourceReader(directory)
  assert.deepStrictEqual(read(receipt),progressiveInput)
  fs.writeFileSync(file,JSON.stringify(fixedInput))
  assert.throws(()=>read(receipt),/snapshot changed/,'Cached receipts accepted a changed snapshot')
}finally {fs.rmSync(directory,{recursive:true,force:true})}
console.log('Execution references: progressive/frozen profiles, exact root coverage and changed-input rejection passed')
