const fs = require('fs')
const path = require('path')

const browserExports = Object.freeze({
  viewer: 'adapters/browser/terra_viewer.js',
  transport: 'adapters/browser/browser_request.js',
  wasm: 'adapters/wasm/terra_wasm.js',
  runtime: 'adapters/wasm/terra_globe_runtime.js',
  webgl: 'adapters/webgl/terra_webgl_renderer.js',
  common: 'sdk/js/core/terra_globe_common.js',
  imagery: 'sdk/js/imagery/terra_imagery_profiles.js'
})
const workerExports = Object.freeze({ worker: 'adapters/wasm/terra_worker_host.js' })
const miniprogramEntries = Object.freeze(Object.assign({}, browserExports, {
  viewer: 'adapters/miniprogram/terra_viewer.js',
  interaction: 'adapters/miniprogram/terra_miniprogram_interaction.js',
  transport: 'adapters/miniprogram/terra_cloudbase_transport.js'
}))
const requirePattern = /require\(\s*(['"])([^'"]+)\1\s*\)/g

function moduleGraph(root, entries) {
  const modules = new Map()
  function visit(id) {
    if (modules.has(id)) return
    if (!id.startsWith('sdk/js/') && !id.startsWith('adapters/')) {
      throw new Error(`SDK module is outside library directories: ${id}`)
    }
    const source = fs.readFileSync(path.join(root, id), 'utf8')
    const dependencies = {}
    for (const match of source.matchAll(requirePattern)) {
      const request = match[2]
      if (!request.startsWith('.')) throw new Error(`Unsupported SDK dependency: ${id}: ${request}`)
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(id), request))
      if (!target.endsWith('.js')) target += '.js'
      if (id.startsWith('sdk/js/') && !target.startsWith('sdk/js/')) {
        throw new Error(`Portable SDK must not depend on adapters: ${id} -> ${target}`)
      }
      dependencies[request] = target
    }
    modules.set(id, { source, dependencies })
    Object.values(dependencies).forEach(visit)
  }
  Object.values(entries).forEach(visit)
  return modules
}

function browserBundle(root, entries = browserExports) {
  const modules = moduleGraph(root, entries)
  const wrapped = Array.from(modules).sort(([a], [b]) => a.localeCompare(b)).map(([id, module]) => {
    const source = module.source.replace(requirePattern, (match, quote, request) =>
      `require(${JSON.stringify(module.dependencies[request])})`)
    return `${JSON.stringify(id)}: function (require, module, exports) {\n${source}\n}`
  }).join(',\n')
  const exports = Object.entries(entries).map(([name, id]) =>
    `${JSON.stringify(name)}: localRequire(${JSON.stringify(id)})`).join(',\n')
  return `(function (global) {\n'use strict';\nconst modules = {\n${wrapped}\n};
const cache = {};
function localRequire(id) {
  if (!Object.prototype.hasOwnProperty.call(modules, id)) throw new Error('Unknown Terra module: ' + id);
  if (!cache[id]) {
    const module = { exports: {} };
    cache[id] = module;
    modules[id](localRequire, module, module.exports);
  }
  return cache[id].exports;
}
global.TerraWebSdk = {\n${exports}\n};
})(typeof self !== 'undefined' ? self : window);\n`
}

function workerBundle(root) {
  return browserBundle(root, workerExports) + 'self.TerraWebSdk.worker.install(self);\n'
}

function stageModules(root, output, platform = 'all') {
  if (!['all', 'miniprogram'].includes(platform)) throw new Error('Unknown SDK platform')
  if (path.resolve(root) === path.resolve(output)) throw new Error('SDK staging must not overwrite source')
  const allEntries = Object.assign({}, browserExports, workerExports,
    { miniprogram: miniprogramEntries.viewer,
      interaction: miniprogramEntries.interaction, transport: miniprogramEntries.transport })
  const entries = platform === 'all' ? allEntries : miniprogramEntries
  const files = Array.from(moduleGraph(root, entries).keys()).concat('sdk/js/api/terra_viewer.d.ts')
  // These two generated trees belong to this graph. Retire removed modules
  // for either platform without a growing list of former entry names. Wasm,
  // licenses and other separately staged assets remain outside these trees.
  const retained = new Set(files)
  function retireModules(relative) {
    const directory = path.join(output, relative)
    if (!fs.existsSync(directory)) return
    for (const name of fs.readdirSync(directory)) {
      const file = path.posix.join(relative, name), destination = path.join(output, file)
      if (fs.lstatSync(destination).isDirectory()) retireModules(file)
      else if (!retained.has(file)) fs.unlinkSync(destination)
    }
  }
  retireModules('sdk/js')
  retireModules('adapters')
  for (const file of files) {
    const destination = path.join(output, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(root, file), destination)
  }
  const version = /project\(TerraSdk VERSION ([^ )]+)/.exec(fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8'))[1]
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({
    name: '@terra/sdk', version, main: miniprogramEntries.viewer,
    browser: platform === 'all' ? browserExports.viewer : undefined,
    types: 'sdk/js/api/terra_viewer.d.ts', license: 'SEE LICENSE IN licenses/LICENSE'
  }, null, 2) + '\n')
  if (platform === 'all') fs.writeFileSync(path.join(output, 'terra_worker.js'), workerBundle(root))
  else if (fs.existsSync(path.join(output, 'terra_worker.js'))) fs.unlinkSync(path.join(output, 'terra_worker.js'))
  fs.writeFileSync(path.join(output, 'miniprogram_files.json'), JSON.stringify(
    Array.from(moduleGraph(root, miniprogramEntries).keys()), null, 2) + '\n')
  return files
}

module.exports = { browserExports, workerExports, miniprogramEntries, moduleGraph, browserBundle, workerBundle, stageModules }
