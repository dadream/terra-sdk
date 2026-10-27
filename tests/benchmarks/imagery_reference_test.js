'use strict'
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path')
const {spawnSync} = require('child_process')
const root=path.resolve(__dirname,'../..'), temporary=fs.mkdtempSync(path.join(os.tmpdir(),'terra-imagery-reference-'))
const run=(script,args)=>spawnSync(process.execPath,[path.join(root,'scripts',script),...args],
  {cwd:root,encoding:'utf8',timeout:150000})
try {
  const fov=0.5233333333333334,radius=6378000,sample={id:'global',level:null,rangeMeters:4*radius}
  const input={schema:'terra.vertical-scale-benchmark.v1',configuration:{datasetId:'globe',radiusMeters:radius,
    fovRadians:fov,viewport:{physicalWidth:960,physicalHeight:519,devicePixelRatio:1},
    terrainPixelError:1.25,imageryPixelError:0.2,initialBudgets:{maximumTerrainMeshBytes:8*1048576,textureCacheBytes:48*1048576},
    source:{kind:'global-geodetic',matrix_level_offset:1,maximum_level:17,minimum_level:0,
      tile_size:256,level_zero_columns:2,level_zero_rows:1,bounds:[[-180,-90],[180,90]]}},
    target:{longitudeDegrees:116.5623,latitudeDegrees:40.74863,heightMeters:508.131826},samples:[sample],
    steps:[{...sample,direction:'down',status:'ready',final:{metrics:{
      terrainThreshold:Math.fround(1.25/519*2*Math.tan(fov/2)),workingMeshBytes:8388608}}}]}
  const filename=path.join(temporary,'input.json'), terrainDirectory=path.join(temporary,'terrain')
  fs.writeFileSync(filename,JSON.stringify(input))
  let result=run('benchmark_terrain_reference.js',['--report',filename,'--output',terrainDirectory,'--surfaces'])
  assert.strictEqual(result.status,0,result.stderr+result.stdout)
  const terrainFile=path.join(terrainDirectory,'report.json'), terrain=JSON.parse(fs.readFileSync(terrainFile)), runs=[]
  for(let i=0;i<2;++i) {
    // These quotas are comparison inputs only; no image storage is allocated.
    // The 0.2px fixture intentionally demands more than the Web's 48MiB default.
    terrain.configuration.initialBudgets.textureCacheBytes=i===0?Number.MAX_SAFE_INTEGER:1
    fs.writeFileSync(terrainFile,JSON.stringify(terrain))
    const output=path.join(temporary,'imagery-'+i)
    result=run('benchmark_imagery_reference.js',['--report',terrainFile,'--output',output])
    const report=JSON.parse(fs.readFileSync(path.join(output,'report.json'))), row=report.samples[0]
    assert.strictEqual(result.status,0,result.stderr+result.stdout+JSON.stringify({
      error:report.error,target:report.allImageryTargetsMet,preference:row?.initialTextureShare}))
    assert(report.allImageryTargetsMet && report.cleanup.childProcessesClosed && report.networkRequests===0)
    assert.strictEqual(report.allReferenceImagesFitInitialPreference,i===0)
    assert.strictEqual(row.initialTextureShare.fitsReference,i===0)
    assert.strictEqual(row.initialTextureShare.shortfallBytes,i===0?0:row.imageBytesWithRoots-1)
    assert(row.targetMet && row.cameraVerified && row.cleanup.nativeContextDestroyed && row.sourceImages.length>0)
    assert(row.quality.measuredMaxPixelError<=0.2*1.001)
    assert(row.partitionPayloadBytes.sourceUv>0 && row.partitionPayloadBytes.clippedUv>=row.partitionPayloadBytes.sourceUv,
      'Finer imagery must price actual UV partitions through both rendering paths')
    assert(row.visibleSurfaceCount>0 && row.visibleSurfaceCount<=terrain.samples[0].visibleMeshes)
    // A 256x256 RGBA pyramid contains 65536+16384+...+1 texels.
    assert.strictEqual(row.imageBytes,349524)
    assert.strictEqual(row.imageBytesWithRoots,row.imagesWithRoots.length*349524)
    runs.push(row)
  }
  for(const key of ['sourceImages','internalNodes','partitionPayloadBytes']) assert.deepStrictEqual(runs[0][key],runs[1][key])
  delete terrain.configuration.initialBudgets.textureCacheBytes
  fs.writeFileSync(terrainFile,JSON.stringify(terrain))
  const unknown=path.join(temporary,'unknown-capacity')
  result=run('benchmark_imagery_reference.js',['--report',terrainFile,'--output',unknown])
  assert.strictEqual(result.status,0,result.stderr+result.stdout)
  const unknownReport=JSON.parse(fs.readFileSync(path.join(unknown,'report.json')))
  assert.strictEqual(unknownReport.allReferenceImagesFitInitialPreference,null)
  assert.strictEqual(unknownReport.samples[0].initialTextureShare.fitsReference,null)
  assert.deepStrictEqual(unknownReport.samples[0].sourceImages,runs[0].sourceImages)
  // Check the public orientation contract with both angles nonzero. Comparing
  // two native runs would preserve a shared sign error in their camera setup.
  // Coarse geometry keeps this orientation test within the checked-in roots;
  // terrain precision is exercised separately by the demand reference tests.
  const tilted={schema:'terra.demand-poses.v1',configuration:{...input.configuration,imageryPixelError:1.25},
    poses:[{id:'tilted',terrainThreshold:0.1,
      view:{schema:'terra.view-state.v2',mode:'globe',target:input.target,
        rangeMeters:sample.rangeMeters,headingDegrees:37,tiltDegrees:20}}]}
  fs.writeFileSync(filename,JSON.stringify(tilted))
  const tiltedTerrain=path.join(temporary,'tilted-terrain'), tiltedImages=path.join(temporary,'tilted-images')
  result=run('benchmark_terrain_reference.js',['--report',filename,'--output',tiltedTerrain,'--surfaces'])
  assert.strictEqual(result.status,0,result.stderr+result.stdout+
    (fs.existsSync(path.join(tiltedTerrain,'report.json')) ? fs.readFileSync(path.join(tiltedTerrain,'report.json'),'utf8') : ''))
  const tiltedFile=path.join(tiltedTerrain,'report.json')
  result=run('benchmark_imagery_reference.js',['--report',tiltedFile,'--output',tiltedImages])
  assert.strictEqual(result.status,0,result.stderr+result.stdout)
  const tiltedReport=JSON.parse(fs.readFileSync(path.join(tiltedImages,'report.json')))
  assert(tiltedReport.samples[0].cameraVerified && tiltedReport.allImageryTargetsMet)
  assert.deepStrictEqual(tiltedReport.samples[0].view,tilted.poses[0].view)
  const wrongCamera=JSON.parse(fs.readFileSync(tiltedFile))
  wrongCamera.samples[0].view.tiltDegrees=0
  fs.writeFileSync(tiltedFile,JSON.stringify(wrongCamera))
  const mismatch=path.join(temporary,'camera-mismatch')
  result=run('benchmark_imagery_reference.js',['--report',tiltedFile,'--output',mismatch])
  assert.strictEqual(result.status,1,result.stderr+result.stdout)
  const mismatchReport=JSON.parse(fs.readFileSync(path.join(mismatch,'report.json')))
  assert(mismatchReport.status==='failed' && /differs from the SDK public view/.test(mismatchReport.error) &&
    mismatchReport.cleanup.childProcessesClosed)
  terrain.configuration.source.maximum_level=0
  terrain.configuration.imageryPixelError=0.01
  fs.writeFileSync(terrainFile,JSON.stringify(terrain))
  const limited=path.join(temporary,'limited')
  result=run('benchmark_imagery_reference.js',['--report',terrainFile,'--output',limited])
  assert.strictEqual(result.status,2,result.stderr+result.stdout)
  const limitedReport=JSON.parse(fs.readFileSync(path.join(limited,'report.json')))
  assert(limitedReport.status==='complete' && !limitedReport.allImageryTargetsMet &&
    limitedReport.samples[0].quality.limitedByLevel && limitedReport.cleanup.childProcessesClosed)
  terrain.samples[0].surfaceSnapshot.sha256='invalid'
  fs.writeFileSync(terrainFile,JSON.stringify(terrain))
  const invalid=path.join(temporary,'invalid')
  result=run('benchmark_imagery_reference.js',['--report',terrainFile,'--output',invalid])
  assert.strictEqual(result.status,1,result.stderr+result.stdout)
  const failed=JSON.parse(fs.readFileSync(path.join(invalid,'report.json')))
  assert(failed.status==='failed' && /identity mismatch/.test(failed.error) && failed.cleanup.childProcessesClosed)
  console.log('Imagery reference: exact terrain, public camera, repeatable targets, UV/mip bytes, limits, identity failure and cleanup passed')
} finally {fs.rmSync(temporary,{recursive:true,force:true})}
