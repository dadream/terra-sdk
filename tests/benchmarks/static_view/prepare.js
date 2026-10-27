'use strict'
const assert = require('assert'), fs = require('fs'), path = require('path')
const {execFileSync} = require('child_process')
const {Records, digest, datasetIdentity} = require('../headless_scheduling/records')
const {browserBundle, workerBundle} = require('../../../scripts/sdk_modules')
const {TIANDITU_TEXTURE} = require('../../../sdk/js/imagery/terra_imagery_profiles')
const {readSnapshot} = require('./snapshot')
const root = path.resolve(__dirname, '../../..')

function prepare(options, scene = {}) {
  const mount = path.join(root, 'viewer_verify_output'), output = path.resolve(options.output)
  execFileSync('mountpoint', ['-q', mount])
  assert(output.startsWith(mount + path.sep) && !fs.existsSync(output), 'Use a new directory on the data mount')
  const parent = fs.realpathSync(path.dirname(output)), realMount = fs.realpathSync(mount)
  assert(parent === realMount || parent.startsWith(realMount + path.sep), 'Output leaves the mount')
  assert(Number.isInteger(options.observationSeconds) && options.observationSeconds >= 30 &&
    options.observationSeconds <= 120, 'Observation must be bounded at 30..120 seconds')
  for (const value of Object.values(options.capacity))
    assert(Number.isSafeInteger(value) && value > 0, 'Capacity must be a positive integer')
  assert(options.decodeTasks === undefined || [1,4].includes(options.decodeTasks), 'Invalid diagnostic decoder cap')
  const caseFile = path.join(root, scene.caseFile || 'testdata/benchmarks/beijing-oblique-v1.json')
  const config = JSON.parse(fs.readFileSync(caseFile))
  const catalogue = path.resolve(path.dirname(caseFile), config.terrain)
  const pack = JSON.parse(fs.readFileSync(catalogue))
  assert.strictEqual(datasetIdentity(pack), config.terrainIdentity, 'Captured terrain changed')
  const records = new Records(root, output, {heightScale:1/64}, {records:catalogue})
  const chunks = [], rows = []; let offset = 0
  for (const row of records.records.values()) {
    const bytes = row.status === 404 ? Buffer.from(JSON.stringify({error:{code:'patch_not_found'}})) :
      fs.readFileSync(row.file).subarray(row.offset, row.offset + row.bytes)
    if (row.status !== 404) assert.strictEqual(digest(bytes), row.sha256)
    rows.push({key:row.key, status:row.status, offset, bytes:bytes.length, sha256:digest(bytes)})
    chunks.push(bytes); offset += bytes.length
  }
  const payload = Buffer.concat(chunks)
  const fixture = {schema:'terra.fixture-records.v1', datasetId:'globe', heightScale:1/64,
    count:rows.length, bytes:payload.length, sha256:digest(payload), records:rows}
  const dataset = {...pack.manifest, endpoints:{root:'/terra/v1/datasets/globe/root/{i}/{j}/{k}',
    detail:'/terra/v1/datasets/globe/detail/{i}/{j}/{k}'}, textures:[{...TIANDITU_TEXTURE}]}
  delete dataset.textures[0].url_template
  const assets = {'sdk.js':Buffer.from(browserBundle(root)), 'terra_worker.js':Buffer.from(workerBundle(root)),
    'terra_sdk.wasm':fs.readFileSync(options.wasm), 'tile.png':fs.readFileSync(options.tile),
    'terrain.bin':payload, 'terrain.json':Buffer.from(JSON.stringify(fixture)),
    'case.json':Buffer.from(JSON.stringify({config, dataset, options}))}
  const tile = assets['tile.png']
  assert(tile.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    tile.readUInt32BE(16) === 256 && tile.readUInt32BE(20) === 256, 'Expected a real 256px PNG')
  const snapshot = options.sdkSnapshot ? readSnapshot(options.sdkSnapshot, assets['terra_sdk.wasm']) : null
  if (snapshot) Object.assign(assets, snapshot.assets)
  const scripts = {terrain:'tests/web_sdk/navigation_terrain.js',
    presentation:'tests/web_sdk/canvas_presentation.js', probe:'tests/benchmarks/vertical_scale_probe.js',
    quality:'tests/benchmarks/vertical_scale.js', pipeline:'tests/benchmarks/static_view/pipeline_trace.js',
    ...scene.scripts, experiment:scene.browserFile || 'tests/benchmarks/static_view/browser.js'}
  for (const [name, file] of Object.entries(scripts))
    assets[name + '.js'] = fs.readFileSync(path.join(root, file))
  assets['index.html'] = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><pre id="report" hidden></pre>' +
    ['sdk',...Object.keys(scripts)].map(name => '<script src="' + name + '.js"></script>').join('') + '</body></html>')
  fs.mkdirSync(path.join(output, 'site'))
  for (const [name, bytes] of Object.entries(assets)) fs.writeFileSync(path.join(output, 'site', name), bytes)
  fs.writeFileSync(path.join(output, 'inputs.json'), JSON.stringify({options, configuration:config,
    sdkSnapshot:snapshot && snapshot.provenance,
    commit:execFileSync('git', ['rev-parse','HEAD'], {cwd:root, encoding:'utf8'}).trim(),
    sourceDiff:execFileSync('git', ['diff','--stat'], {cwd:root, encoding:'utf8'}),
    assets:Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, {bytes:bytes.length, sha256:digest(bytes)}]))}, null, 2) + '\n')
}
if (require.main === module) prepare(JSON.parse(process.argv[2]))
module.exports = {prepare}
