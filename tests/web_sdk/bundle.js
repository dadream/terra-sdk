const {browserBundle, browserExports} = require('../../scripts/sdk_modules')

module.exports = root => browserBundle(root, {...browserExports,
  testEncoded: 'adapters/browser/encoded_texture_store.js',
  testTextures: 'adapters/browser/texture_store.js',
  testVisibility: 'adapters/webgl/terrain_visibility.js',
  testDepth: 'adapters/webgl/surface_programs.js',
  testBounds: 'sdk/js/terrain/visibility_bounds.js',
  testFootprint: 'sdk/js/terrain/visibility_footprint.js',
  testDisplayTarget: 'adapters/webgl/display_target.js',
  testGlAllocation: 'adapters/webgl/gl_allocation.js',
  testLedger: 'sdk/js/resources/resource_ledger.js',
  testSurface: 'sdk/js/terrain/terra_surface_plan.js',
  testFrame: 'sdk/js/runtime/frame_coordinator.js',
  testMatrix: 'sdk/js/math/matrix.js',
  testFacing: 'sdk/js/terrain/surface_facing.js'})
