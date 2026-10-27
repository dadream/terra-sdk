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

const { browserBundle, workerBundle } = require('./sdk_modules')
const bundle = browserBundle(root)

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
