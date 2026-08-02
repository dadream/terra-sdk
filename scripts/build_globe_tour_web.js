const fs = require('fs')
const path = require('path')

function requireArgument(index, label) {
  const value = process.argv[index]
  if (!value) throw new Error(`Missing ${label}`)
  return path.resolve(value)
}

const root = requireArgument(2, 'repository root')
const output = requireArgument(3, 'site output directory')
const generated = path.join(output, 'generated')
const data = path.join(output, 'data')

function removeTree(target) {
  if (!fs.existsSync(target)) return
  fs.readdirSync(target).forEach((entry) => {
    const item = path.join(target, entry)
    if (fs.lstatSync(item).isDirectory()) {
      removeTree(item)
    } else {
      fs.unlinkSync(item)
    }
  })
  fs.rmdirSync(target)
}

removeTree(output)
fs.mkdirSync(generated, { recursive: true })
fs.mkdirSync(data, { recursive: true })

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

const bundle = `(function (global) {
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

fs.writeFileSync(path.join(generated, 'terra_browser_bundle.js'), bundle)

const copies = [
  ['tests/globe_tour_web/index.html', 'index.html'],
  ['tests/globe_tour_web/styles.css', 'styles.css'],
  ['tests/globe_tour_web/app.js', 'app.js'],
  ['workspace_old/package/miniprogram/wasm/terra_sdk.wasm',
    'generated/terra_sdk.wasm'],
  ['testdata/tours/suzhou-gardens-bicycle.v1.json',
    'data/suzhou-gardens-bicycle.v1.json']
]

copies.forEach(([source, destination]) => {
  const sourcePath = path.join(root, source)
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing globe tour Web input: ${source}`)
  }
  fs.copyFileSync(sourcePath, path.join(output, destination))
})

console.log(`Globe tour Web app staged at ${output}`)
