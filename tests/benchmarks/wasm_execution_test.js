'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path')
const {execFileSync}=require('child_process')
const {run}=require('./headless_scheduling/execution')
const {Records}=require('./headless_scheduling/records')
const {route}=require('./headless_scheduling/case')
const config=require('../../testdata/benchmarks/taian-scheduling-v1.json')
const root=path.resolve(__dirname,'../..'),mount=path.join(root,'viewer_verify_output')

async function main() {
  execFileSync('mountpoint',['-q',mount])
  const output=fs.mkdtempSync(path.join(mount,'wasm-execution-contract-'))
  const records=new Records(root,output,config)
  // The checked-in encoded fixture has exactly these declared dimensions.
  // Global driver validation needs no sampled local ground or online metadata.
  records.manifest={schema:'terra.dataset-manifest',schema_version:1,format_version:1,
    dataset_id:config.datasetId,patch_dim:config.patchDimension,height_scale:config.heightScale,
    transform:{kind:'cylindrical',radius:config.radiusMeters,bounds:[[-180,-90],[180,90]]},
    endpoints:{root:'/unused-root',detail:'/unused-detail'}}
  const wasm=fs.readFileSync(path.join(root,'workspace_old/build/wasm/terra_sdk.wasm'))
  const lifetime=new AbortController(),timer=setTimeout(()=>lifetime.abort(),30000),results=[]
  try {
    const poses=route(config,'global-coarsening-contract',0)
    poses.push({...poses[0],id:'global-tilted',tiltDegrees:45})
    for(const meshBytes of [16,32].map(mib=>mib*1024*1024))for(const worker of [false,true]) {
      const result=await run({wasm,worker,config,poses,records,signal:lifetime.signal,capacity:'production',
        resourceOptions:{maximumTerrainMeshBytes:meshBytes}})
      results.push(result)
      assert.strictEqual(result.maximumManagedBytes,config.maximumManagedBytes,
        'Execution ignored the explicit historical case capacity')
      assert.strictEqual(result.terrainBudget.meshBudgetBytes,meshBytes)
      assert.deepStrictEqual(result.resourcePolicy.terrainCapacity,
        {meshBytes,recordBytes:meshBytes,heightBytes:2*meshBytes,publicationBytes:4*meshBytes})
      assert(result.complete&&result.cleanup.ownerDestroyed&&result.cleanup.ledgerBytes===0)
      if(worker)assert(result.cleanup.workerTerminated)
      for(const stage of result.stages) {
        assert(stage.cameraCheck.positionErrorMeters<=1e-6&&stage.cameraCheck.projectionViewRelativeError<=1e-10)
        assert.strictEqual(stage.status,'ready',stage.errorStack)
        assert(stage.terrainKeys.length>8&&stage.imageryKeys.length>8)
        assert(stage.publishedCutMeshBytes>0&&stage.publishedCutMeshBytes<=meshBytes)
        assert.strictEqual(stage.terrain.maximumMeshBytes,4*meshBytes)
        assert(stage.imageryQuality.coverageGuaranteed&&stage.imageryQuality.meetsTarget)
        assert(stage.resources.highWaterBytes<=config.maximumManagedBytes)
        assert(stage.maximumTopologyChanges<=config.maximumTopologyChanges)
        const count=stage.planning.work.nativeMeasurements
        assert(count.modelsBuilt>0&&count.layoutReuses>0&&count.measurements>0)
        for(const name of ['modelsBuilt','measurements','refinements','bounds'])
          assert.strictEqual(stage.repeatPlanning.work.nativeMeasurements[name],count[name])
      }
      assert.deepStrictEqual(result.stages[0].imageryKeys,result.stages[2].imageryKeys)
    }
    for(let pair=0;pair<4;pair+=2)for(let i=0;i<poses.length;++i) {
      assert.deepStrictEqual(results[pair].stages[i].terrainKeys,results[pair+1].stages[i].terrainKeys)
      assert.deepStrictEqual(results[pair].stages[i].imageryKeys,results[pair+1].stages[i].imageryKeys)
      assert.strictEqual(results[pair].stages[i].planning.work.nativeMeasurements.modelsBuilt,
        results[pair+1].stages[i].planning.work.nativeMeasurements.modelsBuilt,
        'Direct publication rebuilt models retained by the Worker')
      assert.deepStrictEqual(results[pair].stages[i].terrainKeys,results[0].stages[i].terrainKeys,
        'Capacity changed a fully converged target that fits both profiles')
    }
    // A missing encoded record is a failed run, never a zero-height success.
    records.records.clear()
    const missing=await run({wasm,worker:true,config,poses:poses.slice(0,1),records,
      signal:lifetime.signal,capacity:'production'})
    assert(!missing.complete&&missing.stages[0].status==='failed')
    assert.match(missing.stages[0].error,/Uncaptured terrain record/)
    assert(missing.cleanup.workerTerminated&&missing.cleanup.ledgerBytes===0)
    results.push(missing)
  } finally {
    clearTimeout(timer);await records.close()
    assert.strictEqual(records.network.requests,0)
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(results,null,2))
  }
  console.log('Real Wasm Direct/Worker: logical cuts, completed-cache reuse, error cleanup and offline parity passed; '+output)
}
main().catch(error=>{console.error(error.stack);process.exitCode=1})
