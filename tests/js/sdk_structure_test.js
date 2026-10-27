const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { moduleGraph, browserExports, workerExports, miniprogramEntries, browserBundle, workerBundle, stageModules } = require('../../scripts/sdk_modules')
const root = path.resolve(__dirname, '../..')
const worker = moduleGraph(root, workerExports)
assert(!Array.from(worker.keys()).some(name => name.includes('webgl') || name.includes('globe_runtime') || name.includes('terra_viewer')),
  'Worker computation must not load a renderer, viewer or UI runtime')
const browserScope = {}
vm.runInNewContext(browserBundle(root), { self: browserScope })
assert(!moduleGraph(root, browserExports).has(workerExports.worker), 'The UI bundle includes Worker execution')
assert(!Array.from(moduleGraph(root, browserExports).keys()).some(file => file.startsWith('adapters/miniprogram/')),
  'Browser runtime includes a Mini Program transport')
const miniGraph = moduleGraph(root, miniprogramEntries)
assert(!Array.from(miniGraph.keys()).some(file => file.startsWith('adapters/browser/') ||
  /terra_worker_|worker_protocol/.test(file)), 'Mini Program includes browser Worker code')
assert(!miniGraph.has('adapters/webgl/terrain_visibility.js'),
  'Browser depth collection leaked into the Mini Program graph')
assert(miniGraph.has('adapters/wasm/terra_abi.js'), 'Mini Program lost direct Wasm execution')
for (const name of ['adapters/wasm/imagery_preparation.js','adapters/wasm/imagery_view_change.js',
  'sdk/js/terrain/visibility_evidence.js']) {
  assert(miniGraph.has(name) && worker.has(name), 'Execution adapters lost shared imagery policy: ' + name)
}
assert(miniGraph.has('adapters/wasm/local_terrain_execution.js') &&
  miniGraph.has('adapters/wasm/mesh_candidate_production.js'), 'Mini Program lost candidate admission')
const miniScope = {}
vm.runInNewContext(browserBundle(root, miniprogramEntries), {self:miniScope})
assert.strictEqual(typeof miniScope.TerraWebSdk.viewer.TerraViewer.create, 'function',
  'Mini Program module loading requires browser/Worker globals')
assert(moduleGraph(root, browserExports).has('adapters/wasm/terra_worker_client.js'),
  'Browser entry lost Worker execution and recovery')
assert(moduleGraph(root, browserExports).has('adapters/browser/encoded_texture_store.js'),
  'Browser entry lost encoded imagery recovery')
assert.strictEqual(typeof browserScope.TerraWebSdk.viewer.TerraViewer.create, 'function')
const workerScope = { postMessage() {} }
vm.runInNewContext(workerBundle(root), { self: workerScope })
assert.strictEqual(typeof workerScope.onmessage, 'function')
assert.deepStrictEqual(Object.keys(workerScope.TerraWebSdk), ['worker'])
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-sdk-structure-'))
function removeTree(directory) {
  fs.readdirSync(directory).forEach(name => {
    const file = path.join(directory, name)
    if (fs.statSync(file).isDirectory()) removeTree(file)
    else fs.unlinkSync(file)
  })
  fs.rmdirSync(directory)
}
try {
  stageModules(root, temporary)
  const metadata = JSON.parse(fs.readFileSync(path.join(temporary, 'package.json')))
  assert.strictEqual(metadata.main, miniprogramEntries.viewer)
  assert.strictEqual(metadata.browser, browserExports.viewer)
  const distributedWorker = {postMessage() {}}
  vm.runInNewContext(fs.readFileSync(path.join(temporary, 'terra_worker.js'), 'utf8'), {self: distributedWorker})
  assert.strictEqual(typeof distributedWorker.onmessage, 'function')
  // Restaging must retire any removed module, not only known historic names.
  const obsolete = path.join(temporary, 'adapters/browser/removed_module.js')
  fs.writeFileSync(obsolete, 'throw new Error("Obsolete generated module")')
  const retained = path.join(temporary, 'terra_sdk.wasm')
  fs.writeFileSync(retained, 'separately built Wasm')
  stageModules(root, temporary)
  assert(!fs.existsSync(obsolete), 'All-platform staging retained a removed SDK module')
  assert.strictEqual(fs.readFileSync(retained, 'utf8'), 'separately built Wasm')
  const loadedBefore = new Set(Object.keys(require.cache))
  const exported = require(temporary)
  assert.strictEqual(typeof exported.TerraViewer.create, 'function')
  assert.strictEqual(typeof exported.createWmtsImagerySource, 'function')
  for (const file of Object.keys(require.cache)) {
    if (!loadedBefore.has(file)) {
      assert(file.startsWith(temporary + path.sep), 'Distributed package must not import repository files: ' + file)
      assert(!/adapters\/browser|terra_worker_|worker_protocol/.test(file),
        'Default Mini Program package entry imported browser dependencies')
      delete require.cache[file]
    }
  }
  stageModules(root, temporary, 'miniprogram')
  const coreFiles = JSON.parse(fs.readFileSync(path.join(temporary, 'miniprogram_files.json')))
  assert(!fs.existsSync(path.join(temporary, workerExports.worker)), 'Mini Program staging kept a Worker-only module')
  assert(!fs.existsSync(path.join(temporary, 'terra_worker.js')), 'Mini Program staging kept a Web Worker asset')
  const listJs = folder => fs.readdirSync(folder).flatMap(name => {
    const file = path.join(folder, name)
    return fs.statSync(file).isDirectory() ? listJs(file) : file.endsWith('.js') ? [path.relative(temporary, file)] : []
  })
  assert.deepStrictEqual(listJs(path.join(temporary, 'sdk')).concat(listJs(path.join(temporary, 'adapters'))).sort(), coreFiles.sort(),
    'Core size manifest differs from the actual staged Mini Program graph')
  // Node caches package main resolution. Inspect the restaged platform in a
  // fresh consumer so a previous all-platform load cannot hide a wrong entry.
  require('child_process').execFileSync(process.execPath, ['-e', `
    const assert = require('assert')
    const sdk = require(process.argv[1])
    assert.strictEqual(typeof sdk.TerraViewer.create, 'function')
    assert(!Object.keys(require.cache).some(file => /adapters\\/browser|terra_worker_|worker_protocol/.test(file)))
  `, temporary])
  fs.writeFileSync(path.join(temporary, 'sdk/js/forbidden.js'), "require('../../adapters/webgl/terra_webgl_renderer')")
  assert.throws(() => moduleGraph(temporary, { invalid: 'sdk/js/forbidden.js' }), /Portable SDK must not depend on adapters/)
} finally { removeTree(temporary) }
console.log('SDK dependency boundaries, standalone package, browser and isolated worker passed')
