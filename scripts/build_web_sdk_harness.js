const fs = require('fs')
const path = require('path')

function requireArgument(index, label) {
  const value = process.argv[index]
  if (!value) {
    throw new Error(`Missing ${label}`)
  }
  return path.resolve(value)
}

const root = requireArgument(2, 'repository root')
const output = requireArgument(3, 'site output directory')
const generated = path.join(output, 'generated')
const fixtures = path.join(output, 'fixtures')

function removeTree(target) {
  if (!fs.existsSync(target)) {
    return
  }
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
fs.mkdirSync(fixtures, { recursive: true })

const modules = [
  ['./terra_wasm', 'apps/miniprogram/utils/terra_wasm.js'],
  ['./terra_globe_common', 'apps/miniprogram/utils/terra_globe_common.js'],
  ['./terra_webgl_renderer', 'apps/miniprogram/utils/terra_webgl_renderer.js'],
  ['./terra_globe_runtime', 'apps/miniprogram/utils/terra_globe_runtime.js']
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
    runtime: localRequire('./terra_globe_runtime'),
    wasm: localRequire('./terra_wasm'),
    webgl: localRequire('./terra_webgl_renderer')
  }
})(window)
`

fs.writeFileSync(path.join(generated, 'terra_browser_bundle.js'), bundle)

const copies = [
  ['tests/web_sdk/index.html', 'index.html'],
  ['tests/web_sdk/harness.js', 'harness.js'],
  ['workspace_old/package/miniprogram/wasm/terra_sdk.wasm',
    'generated/terra_sdk.wasm'],
  ['testdata/miniprogram/golden/globe_root_0_record.bin',
    'fixtures/globe_root_0_record.bin'],
  ['testdata/miniprogram/golden/globe_root_0_detail_record.bin',
    'fixtures/globe_root_0_detail_record.bin'],
  ['testdata/miniprogram/golden/globe_root_3_record.bin',
    'fixtures/globe_root_3_record.bin'],
  ['testdata/miniprogram/golden/globe_root_3_detail_record.bin',
    'fixtures/globe_root_3_detail_record.bin'],
  ['testdata/miniprogram/golden/globe_patch_record.bin',
    'fixtures/globe_patch_record.bin']
]

copies.forEach(([source, destination]) => {
  const sourcePath = path.join(root, source)
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing Web SDK harness input: ${source}`)
  }
  fs.copyFileSync(sourcePath, path.join(output, destination))
})

console.log(`Web SDK harness staged at ${output}`)
