'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const {browserBundle} = require('../../../scripts/sdk_modules')
const probe = require('./probe')

const root = path.resolve(__dirname, '../../..')
const [fixture, wasm, output] = process.argv.slice(2).map(value => path.resolve(value))
if (!fixture || !wasm || !output) throw new Error('Expected fixture site, private Wasm, and fresh output directory')
const outputRoot = path.join(root, 'viewer_verify_output') + path.sep
if (!output.startsWith(outputRoot)) throw new Error('Diagnostic output must use the test-data mount')
if (fs.existsSync(output)) throw new Error('Diagnostic output already exists; preserve earlier evidence')
const page = fs.readFileSync(path.join(root, 'tests/web_sdk/index.html'), 'utf8')
const stale = () => { throw new Error('Fixture page/helpers are stale; rebuild with scripts/build_web_sdk_harness.js') }
if (fs.readFileSync(path.join(fixture, 'index.html'), 'utf8') !== page) stale()
for (const match of page.matchAll(/<script src="([^"]+)"/g)) {
  const file = match[1]
  if (file.startsWith('generated/') || file === 'harness.js') continue
  const source = file === 'navigation_scenarios.js'
    ? path.join(root, 'apps/site/demo', file) : path.join(root, 'tests/web_sdk', file)
  if (!fs.existsSync(path.join(fixture, file)) ||
      !fs.readFileSync(path.join(fixture, file)).equals(fs.readFileSync(source))) stale()
}
const bytes = fs.readFileSync(wasm)
if (!WebAssembly.Module.exports(new WebAssembly.Module(bytes)).some(value => value.name === 'test_mesh_residency'))
  throw new Error('Expected the private mesh residency build')
const harness = probe.instrumentHarness(fs.readFileSync(path.join(root, 'tests/web_sdk/harness.js'), 'utf8'))
const worker = browserBundle(root, {
  worker: 'adapters/wasm/terra_worker_host.js', abi: 'adapters/wasm/terra_abi.js'
}) + probe.workerExtension + 'self.TerraWebSdk.worker.install(self);\n'
fs.mkdirSync(output)
fs.cpSync(fixture, path.join(output, 'site'), {recursive:true})
fs.writeFileSync(path.join(output, 'site/generated/terra_sdk.wasm'), bytes)
fs.writeFileSync(path.join(output, 'site/generated/terra_worker.js'), worker)
// Use the current browser modules too; an older fixture site supplies data,
// never a different runtime to pair with the current Worker/private Wasm.
fs.writeFileSync(path.join(output, 'site/generated/terra_browser_bundle.js'), require('../../web_sdk/bundle')(root))
fs.writeFileSync(path.join(output, 'site/harness.js'), harness)
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const inputs = {privateWasm: {file:wasm, sha256:digest(wasm)}, files:{}}
for (const file of ['tests/wasm/mesh_residency/snapshot.cpp', 'tests/wasm/mesh_residency/probe.js',
  'tests/web_sdk/harness.js']) inputs.files[file] = digest(path.join(root, file))
for (const file of ['harness.js', 'generated/terra_worker.js', 'generated/terra_browser_bundle.js'])
  inputs.files['site/' + file] = digest(path.join(output, 'site', file))
fs.writeFileSync(path.join(output, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n')
