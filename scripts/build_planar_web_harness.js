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
const fixtures = path.join(output, 'fixtures')

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
fs.mkdirSync(fixtures, { recursive: true })

const { browserBundle, workerBundle } = require('./sdk_modules')
const bundle = browserBundle(root)

fs.writeFileSync(path.join(generated, 'terra_browser_bundle.js'), bundle)

const copies = [
  ['tests/planar_web/index.html', 'index.html'],
  ['tests/planar_web/harness.js', 'harness.js'],
  ['workspace_old/package/miniprogram/wasm/terra_sdk.wasm',
    'generated/terra_sdk.wasm'],
  ['testdata/miniprogram/golden/planar_root_record.bin',
    'fixtures/planar_root_record.bin'],
  ['testdata/miniprogram/golden/planar_root_detail_record.bin',
    'fixtures/planar_root_detail_record.bin'],
  ['testdata/datasets/ps_1k/source/ps_texture_1k.png',
    'fixtures/ps_texture_1k.png']
]
copies.forEach(([source, destination]) => {
  const sourcePath = path.join(root, source)
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing planar Web harness input: ${source}`)
  }
  fs.copyFileSync(sourcePath, path.join(output, destination))
})
console.log(`Planar Web SDK harness staged at ${output}`)
