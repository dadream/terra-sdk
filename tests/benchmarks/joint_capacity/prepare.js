'use strict'

const fs = require('fs'), path = require('path'), assert = require('assert')
const {execFileSync} = require('child_process')
const {Records, digest, datasetIdentity} = require('../headless_scheduling/records')
const {validate, route} = require('../headless_scheduling/case')
const {cameraForPose, verifyReferenceCamera} = require('../headless_scheduling/camera')
const {cameraSnapshot} = require('../../../sdk/js/camera/terra_camera_snapshot')
const {TIANDITU_TEXTURE} = require('../../../sdk/js/imagery/terra_imagery_profiles')
const {browserBundle, workerBundle} = require('../../../scripts/sdk_modules')
const {viewerOptions} = require('./visibility')
const root = path.resolve(__dirname, '../../..')

function prepare(options) {
  viewerOptions(options.visibility)
  const config = validate(require('../../../testdata/benchmarks/taian-scheduling-v1.json'))
  const descriptor = require('../../../testdata/benchmarks/taian-terrain-v4.json')
  const output = path.resolve(options.output), mount = path.join(root, 'viewer_verify_output')
  execFileSync('mountpoint', ['-q', mount])
  assert(output.startsWith(mount + path.sep), 'Use the test-data mount')
  assert(!fs.existsSync(output), 'Preserve existing evidence; output must be new')
  const parent = fs.realpathSync(path.dirname(output)), realMount = fs.realpathSync(mount)
  assert(parent === realMount || parent.startsWith(realMount + path.sep), 'Output leaves data mount')
  for (const name of ['managedBytes','terrainMeshBytes'])
    assert(Number.isSafeInteger(options[name]) && options[name] > 0, 'Invalid ' + name)
  assert(Number.isInteger(options.observationSeconds) && options.observationSeconds >= 30 &&
    options.observationSeconds <= 120, 'Observation must be bounded at 30..120 seconds')
  const referenceBytes = fs.readFileSync(options.reference), reference = JSON.parse(referenceBytes)
  for (const key of Object.keys(config))
    assert.deepStrictEqual(reference.configuration[key], config[key], 'Different reference configuration: ' + key)
  assert(['taian-oblique-fixed-v1','taian-nadir-roundtrip-v1'].includes(reference.case) &&
    reference.sdkResourceMode === 'fixed' && reference.cores.sdk.complete,
    'Require a complete canonical fixed-resource oblique or nadir reference')
  assert.deepStrictEqual(reference.poses, route(config, reference.case, reference.ground.heightMeters))
  assert(Number.isInteger(options.poseCount) && options.poseCount > 0 &&
    options.poseCount <= reference.poses.length, 'Invalid route prefix length')
  const catalogue = path.join(root, descriptor.directory, descriptor.catalogue)
  const pack = JSON.parse(fs.readFileSync(catalogue))
  assert.strictEqual(datasetIdentity(pack), descriptor.datasetSha256, 'Captured fixture changed')
  const base = require('../../../testdata/benchmarks/taian-terrain-v2.json')
  const basePack = JSON.parse(fs.readFileSync(path.join(root, base.directory, base.catalogue)))
  assert.strictEqual(datasetIdentity(basePack), base.datasetSha256)
  assert.strictEqual(reference.data.datasetSha256, base.datasetSha256)
  assert.strictEqual(pack.manifestSha256, basePack.manifestSha256)
  const inputs = new Map(pack.records.map(row => [row.key.join('/'), row]))
  for (const row of basePack.records) {
    const actual = inputs.get(row.key.join('/'))
    assert(actual && ['status','bytes','sha256'].every(key => actual[key] === row[key]), 'Reference data omitted or changed')
  }
  const poses = reference.poses.slice(0, options.poseCount).map(pose => {
    const row = reference.cores.sdk.discoveryRows.find(row => row.id === pose.id)
    verifyReferenceCamera(config, pose, row)
    const camera = cameraSnapshot({transform:'cylindrical', radius:config.radiusMeters}, cameraForPose(pose),
      {...config.viewport, fovRadians:config.verticalFovRadians})
    return {...pose, schema:'terra.view-state.v2', mode:'globe',
      expectedCamera:{cameraPosition:camera.cameraPosition, projectionView:Array.from(camera.projectionView)},
      reference:{nodes:row.nodes, error:row.achievedError, visibleKeys:row.visibleKeys}}
  })
  const records = new Records(root, output, config, {records:catalogue}), chunks = [], rows = []
  let offset = 0
  for (const row of records.records.values()) {
    const bytes = row.status === 404 ? Buffer.from(JSON.stringify({error:{code:'patch_not_found'}})) :
      fs.readFileSync(row.file).subarray(row.offset, row.offset + row.bytes)
    if (row.status !== 404) assert.strictEqual(digest(bytes), row.sha256)
    rows.push({key:row.key, status:row.status, offset, bytes:bytes.length, sha256:digest(bytes)})
    chunks.push(bytes); offset += bytes.length
  }
  const payload = Buffer.concat(chunks), fixture = {schema:'terra.fixture-records.v1', datasetId:'globe',
    heightScale:config.heightScale, count:rows.length, bytes:payload.length, sha256:digest(payload), records:rows}
  const source = {...TIANDITU_TEXTURE}; delete source.url_template
  const dataset = {schema:'terra.dataset-manifest', schema_version:1, dataset_id:'globe', format_version:1,
    patch_dim:config.patchDimension, height_scale:config.heightScale,
    transform:{kind:'cylindrical', bounds:[[-180,-90],[180,90]], radius:config.radiusMeters},
    endpoints:{root:'/terra/v1/datasets/globe/root/{i}/{j}/{k}', detail:'/terra/v1/datasets/globe/detail/{i}/{j}/{k}'},
    textures:[source]}
  const assets = {
    'sdk.js':Buffer.from(browserBundle(root)), 'terra_worker.js':Buffer.from(workerBundle(root)),
    'terra_sdk.wasm':fs.readFileSync(options.wasm), 'tile.png':fs.readFileSync(options.tile),
    'terrain.bin':payload, 'terrain.json':Buffer.from(JSON.stringify(fixture)),
    'case.json':Buffer.from(JSON.stringify({case:reference.case, config, poses, dataset, options,
      canonicalPoseCount:reference.poses.length, acceptanceSeconds:30}))
  }
  // Require actual 256px PNG data rather than synthetic ready flags/FakeGL.
  assert(assets['tile.png'].subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    assets['tile.png'].readUInt32BE(16) === 256 && assets['tile.png'].readUInt32BE(20) === 256, 'Expected a 256px PNG')
  for (const [name, file] of Object.entries({terrain:'tests/web_sdk/navigation_terrain.js',
    probe:'tests/benchmarks/vertical_scale_probe.js', quality:'tests/benchmarks/vertical_scale.js',
    presentation:'tests/web_sdk/canvas_presentation.js', residency:'tests/web_sdk/native_residency.js',
    readback:'tests/web_sdk/readback.js', reclamation:'tests/benchmarks/joint_capacity/reclamation.js',
    ownership:'tests/benchmarks/joint_capacity/ownership.js', visibility:'tests/benchmarks/joint_capacity/visibility.js',
    experiment:'tests/benchmarks/joint_capacity/browser.js'}))
    assets[name + '.js'] = fs.readFileSync(path.join(root, file))
  assets['index.html'] = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><pre id="report" hidden></pre>' +
    ['sdk','terrain','probe','quality','presentation','residency','readback','reclamation','ownership','visibility','experiment'].map(name => '<script src="' + name + '.js"></script>').join('') + '</body></html>')
  const site = path.join(output, 'site'); fs.mkdirSync(site, {recursive:true})
  for (const [name, bytes] of Object.entries(assets)) fs.writeFileSync(path.join(site, name), bytes)
  fs.writeFileSync(path.join(output, 'inputs.json'), JSON.stringify({options,
    reference:{file:options.reference, sha256:digest(referenceBytes)}, datasetSha256:descriptor.datasetSha256,
    assets:Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, {bytes:bytes.length, sha256:digest(bytes)}]))}, null, 2) + '\n')
}
if (require.main === module) prepare(JSON.parse(process.argv[2]))
module.exports = {prepare}
