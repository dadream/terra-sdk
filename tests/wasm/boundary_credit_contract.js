const assert = require('assert')
const fs = require('fs'), path = require('path')
const {TerraAbi} = require('../../adapters/wasm/terra_abi')
const {surfaceIds} = require('../../sdk/js/terrain/surface_replacement')

module.exports = async function verifyBoundaryCredit(module) {
  const abi = new TerraAbi(module)
  const record = fs.readFileSync(path.join(__dirname, '../../testdata/miniprogram/golden/globe_root_0_record.bin'))
  const budget = {maximumChangeCount:0, maximumPriorityUpdateCount:4096, maximumElapsedMs:0}
  try {
    abi.loadManifest({formatVersion:1, patchDimension:64, transform:'cylindrical', heightScale:1/64,
      minimumU:-180, minimumV:-90, maximumU:180, maximumV:90, radius:6378000,
      texture:{kind:'global-geodetic', matrix_level_offset:0, maximum_level:17, minimum_level:0,
        tile_size:256, level_zero_columns:2, level_zero_rows:1, bounds:[[-180,-90],[180,90]]}})
    abi.setViewport(640,360,Math.PI/6); abi.setGlobeTarget(116.5623,40.74863)
    abi.setCamera({distance:9567,tiltRadians:0,yawRadians:0})
    abi.updateStep(0.002,budget)
    abi.getRequests().filter(r=>r.kind===1).forEach(r=>abi.submitRecord(r.kind,r.key,record))
    const first=abi.prepareMeshFrame(0.002,budget)
    abi.materializeMeshFrame(first); abi.commitMeshFrame(first); abi.presentFrame(first.frame.sequence)
    const before=surfaceIds(first.draws), next=abi.prepareMeshFrame(0.002,budget)
    assert(before.length>0)
    assert.deepStrictEqual(surfaceIds(next.draws),before,'Fixture needs identical immutable boundaries')
    const oneSide=abi.replacementWorkBytes(next.nativePlan,[])
    const shared=abi.replacementWorkBytes(next.nativePlan,before)
    // Two output memberships need one edge stream. Extra metadata is small;
    // doubling the expensive edge workspace rejects affordable local work.
    assert(shared<oneSide*1.1,'Retained boundaries are charged twice before production')
    assert.throws(()=>abi.replacementWorkBytes(next.nativePlan,[0]),/Boundary capacity unavailable/)
    await assert.rejects(abi.createReplacementTask(next.nativePlan,[0],shared).run(),error=>error.status===1,
      'Invalid boundary owners were mistaken for a retryable capacity shortage')
    await assert.rejects(abi.createReplacementTask(next.nativePlan,before,shared-1).run(),error=>error.status===9)
    const proof=await abi.createReplacementTask(next.nativePlan,before,shared).run()
    assert.deepStrictEqual(proof.groups.flatMap(g=>g.before).sort((a,b)=>a-b),before)
    assert.deepStrictEqual(proof.groups.flatMap(g=>g.after).sort((a,b)=>a-b),before)
    assert(proof.groups.every(g=>g.before.length===1 && g.after.length===1 && g.before[0]===g.after[0]))
    abi.discardMeshPlan(next.nativePlan)
    console.log('Wasm boundary credit counts shared immutable edges once',JSON.stringify({surfaces:before.length,oneSide,shared}))
  } finally {abi.destroy()}
}

if (require.main===module) require('../../adapters/wasm/terra_wasm').instantiateTerraWasmBytes(
  fs.readFileSync(process.argv[2])).then(module.exports).catch(error=>{console.error(error);process.exitCode=1})
