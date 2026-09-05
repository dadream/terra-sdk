const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function argument(index, label) {
  const value = process.argv[index]
  if (!value) throw new Error(`Missing ${label}`)
  return path.resolve(value)
}

const root = argument(2, 'repository root')
const output = argument(3, 'site output directory')
if (output === root || !output.startsWith(root + path.sep)) {
  throw new Error('Product site output must be below the repository root')
}

function copyFile(source, destination) {
  const sourcePath = path.join(root, source)
  const destinationPath = path.join(output, destination)
  if (!fs.existsSync(sourcePath)) throw new Error(`Missing site input: ${source}`)
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  fs.copyFileSync(sourcePath, destinationPath)
}

function removeTree(target) {
  if (!fs.existsSync(target)) return
  fs.readdirSync(target).forEach((entry) => {
    const item = path.join(target, entry)
    if (fs.lstatSync(item).isDirectory()) removeTree(item)
    else fs.unlinkSync(item)
  })
  fs.rmdirSync(target)
}

function cmakeVersion() {
  const cmake = fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8')
  const match = /project\(TerraSdk VERSION ([^ )]+)/.exec(cmake)
  if (!match) throw new Error('Unable to read Terra SDK version')
  return match[1]
}

function browserBundle() {
  const modules = [
    ['./terra_wasm', 'apps/miniprogram/utils/terra_wasm.js'],
    ['./terra_globe_common', 'apps/miniprogram/utils/terra_globe_common.js'],
    ['./terra_webgl_renderer', 'apps/miniprogram/utils/terra_webgl_renderer.js'],
    ['./terra_globe_runtime', 'apps/miniprogram/utils/terra_globe_runtime.js'],
    ['./terra_interaction_controller',
      'apps/miniprogram/utils/terra_interaction_controller.js'],
    ['./terra_camera_motion',
      'apps/miniprogram/utils/terra_camera_motion.js'],
    ['./terra_viewer', 'apps/miniprogram/utils/terra_viewer.js'],
    ['./terra_imagery_profiles',
      'apps/miniprogram/utils/terra_imagery_profiles.js']
  ]
  const wrapped = modules.map(([id, relativePath]) => {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    return `${JSON.stringify(id)}: function (require, module, exports) {\n` +
      `${source}\n}`
  }).join(',\n')
  return `(function (global) {
  'use strict'
  const modules = {
${wrapped}
  }
  const cache = {}
  function localRequire(id) {
    if (!Object.prototype.hasOwnProperty.call(modules, id)) {
      throw new Error('Unknown Terra browser module: ' + id)
    }
    if (!cache[id]) {
      const module = { exports: {} }
      cache[id] = module
      modules[id](localRequire, module, module.exports)
    }
    return cache[id].exports
  }
  global.TerraWebSdk = {
    common: localRequire('./terra_globe_common'),
    imagery: localRequire('./terra_imagery_profiles'),
    runtime: localRequire('./terra_globe_runtime'),
    viewer: localRequire('./terra_viewer'),
    wasm: localRequire('./terra_wasm'),
    webgl: localRequire('./terra_webgl_renderer')
  }
})(window)
`
}

removeTree(output)
fs.mkdirSync(path.join(output, 'assets'), { recursive: true })

const copies = [
  ['apps/site/index.html', 'index.html'],
  ['apps/site/styles.css', 'styles.css'],
  ['apps/site/site.js', 'site.js'],
  ['apps/site/demo/styles.css', 'demo/styles.css'],
  ['apps/site/demo/app.js', 'demo/app.js'],
  ['apps/site/services/index.html', 'services/index.html'],
  ['apps/site/docs/quickstart/index.html', 'docs/quickstart/index.html'],
  ['apps/site/license/index.html', 'license/index.html'],
  ['apps/site/downloads/index.html', 'downloads/index.html'],
  ['workspace_old/package/miniprogram/wasm/terra_sdk.wasm',
    'assets/terra_sdk.wasm']
]
copies.forEach(([source, destination]) => copyFile(source, destination))

const bundlePath = path.join(output, 'assets', 'terra_browser_bundle.js')
fs.writeFileSync(bundlePath, browserBundle(), 'utf8')
const assetRevision = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(output, 'site.js')))
  .update(fs.readFileSync(path.join(output, 'styles.css')))
  .update(fs.readFileSync(path.join(output, 'demo/app.js')))
  .update(fs.readFileSync(path.join(output, 'demo/styles.css')))
  .update(fs.readFileSync(bundlePath))
  .digest('hex').slice(0, 12)

const localizedPages = [
  'index.html',
  'services/index.html',
  'docs/quickstart/index.html',
  'license/index.html',
  'downloads/index.html'
]
for (const relativePath of localizedPages) {
  const destination = path.join(output, relativePath)
  const rendered = fs.readFileSync(destination, 'utf8')
    .split('__TERRA_ASSET_REVISION__').join(assetRevision)
  fs.writeFileSync(destination, rendered, 'utf8')
}

const template = fs.readFileSync(
  path.join(root, 'apps/site/demo/index.html'), 'utf8')
for (const mode of ['globe', 'planar']) {
  const destination = path.join(output, 'demo', mode, 'index.html')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const rendered = template
    .split('__TERRA_DEMO_MODE__').join(mode)
    .split('__TERRA_ASSET_REVISION__').join(assetRevision)
  fs.writeFileSync(destination, rendered, 'utf8')
}
fs.writeFileSync(path.join(output, 'demo', 'index.html'),
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" ' +
  'content="0;url=/demo/globe/"><title>Terra Demo</title>\n', 'utf8')

const version = cmakeVersion()
const releasePath = path.join(root, 'workspace_old/package/release',
  'release_manifest.json')
const releaseManifest = fs.existsSync(releasePath)
  ? JSON.parse(fs.readFileSync(releasePath, 'utf8')) : {}
if (releaseManifest.sdk_version && releaseManifest.sdk_version !== version) {
  throw new Error('SDK release manifest does not match the CMake version')
}
const tag = `v${version}`
const releaseUrl = `https://github.com/dadream/terra-sdk/releases/tag/${tag}`
const downloadRoot = `https://github.com/dadream/terra-sdk/releases/download/${tag}`
const release = {
  schema: 'terra.product-site-release.v1',
  version,
  tag,
  releaseUrl,
  native: releaseManifest.native_archive || `terra-sdk-${version}-native.tar.gz`,
  nativeSha256: releaseManifest.native_sha256 || '',
  miniprogram: releaseManifest.miniprogram_archive ||
    `terra-sdk-${version}-miniprogram.tar.gz`,
  miniprogramSha256: releaseManifest.miniprogram_sha256 || '',
  downloadRoot
}
fs.writeFileSync(path.join(output, 'assets', 'release.json'),
  JSON.stringify(release, null, 2) + '\n', 'utf8')

console.log(`Terra SDK product site staged at ${output}`)
