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

const bundle = require('../tests/web_sdk/bundle')(root)

fs.writeFileSync(path.join(generated, 'terra_browser_bundle.js'), bundle)
// Exercise the exact standalone Worker delivered to SDK consumers.
fs.copyFileSync(path.join(root, 'workspace_old/package/miniprogram/terra_worker.js'),
  path.join(generated, 'terra_worker.js'))

const copies = [
  ['tests/web_sdk/index.html', 'index.html'],
  ['tests/web_sdk/harness.js', 'harness.js'],
  ['tests/web_sdk/navigation_terrain.js', 'navigation_terrain.js'],
  ['tests/web_sdk/network_replay.js', 'network_replay.js'],
  ['tests/web_sdk/network_navigation.js', 'network_navigation.js'],
  ['tests/web_sdk/canvas_presentation.js', 'canvas_presentation.js'],
  ['tests/web_sdk/canvas_presentation_contract.js', 'canvas_presentation_contract.js'],
  ['tests/web_sdk/canvas_reuse.js', 'canvas_reuse.js'],
  ['testdata/miniprogram/navigation_terrain/terrain-records.json',
    'fixtures/navigation-terrain.json'],
  ['testdata/miniprogram/navigation_terrain/terrain-records.bin',
    'fixtures/navigation-terrain.bin'],
  ['tests/web_sdk/surface_facing.js', 'surface_facing.js'],
  ['tests/web_sdk/terrain_visibility.js', 'terrain_visibility.js'],
  ['tests/web_sdk/depth_encoding.js', 'depth_encoding.js'],
  ['tests/web_sdk/visibility_footprint.js', 'visibility_footprint.js'],
  ['tests/web_sdk/display_target.js', 'display_target.js'],
  ['tests/web_sdk/gpu_progress.js', 'gpu_progress.js'],
  ['tests/web_sdk/background_progress.js', 'background_progress.js'],
  ['tests/web_sdk/encoded_residency.js', 'encoded_residency.js'],
  ['tests/web_sdk/surface_publication.js', 'surface_publication.js'],
  ['tests/web_sdk/source_uv_partitions.js', 'source_uv_partitions.js'],
  ['tests/web_sdk/readback.js', 'readback.js'],
  ['tests/web_sdk/native_residency.js', 'native_residency.js'],
  ['apps/site/demo/navigation_scenarios.js', 'navigation_scenarios.js'],
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
