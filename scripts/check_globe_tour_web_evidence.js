'use strict'

const fs = require('fs')

if (process.argv.length !== 3) {
  throw new Error('Usage: check_globe_tour_web_evidence.js <browser-dom.html>')
}

const html = fs.readFileSync(process.argv[2], 'utf8')
if (!/<html[^>]*data-terra-status="passed"/.test(html)) {
  throw new Error('Globe tour Web evidence did not pass')
}
const match = /<pre id="automation-result"[^>]*>([\s\S]*?)<\/pre>/.exec(html)
if (!match) throw new Error('Globe tour evidence report is missing')
const decoded = match[1]
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
const report = JSON.parse(decoded)
if (!report.passed || report.schema !== 'terra.globe-tour-web-evidence.v1') {
  throw new Error('Globe tour evidence report is invalid')
}
const required = ['attribution', 'pois', 'route', 'fly_to', 'orbit',
  'drag_texture', 'zoom_texture', 'global_zoom_transition',
  'global_zoom_texture', 'imagery_quality', 'geometry_transition',
  'hierarchical_imagery', 'navigation_controls',
  'staged_flight', 'route_pause', 'route_complete', 'terrain', 'framebuffer',
  'debug_panel']
required.forEach((name) => {
  const check = report.checks.find((entry) => entry.name === name)
  if (!check || !check.passed) throw new Error(`Missing passed check: ${name}`)
})
const globalQuality = report.qualitySnapshots &&
  report.qualitySnapshots.global
const selectedWithinCapacity = globalQuality &&
  Number.isFinite(globalQuality.selectedTextureCount) &&
  Number.isFinite(globalQuality.maximumTextureCount) &&
  globalQuality.selectedTextureCount <= globalQuality.maximumTextureCount
const acceptableQuality = globalQuality && globalQuality.ready &&
  globalQuality.geometryCoverageReady &&
  selectedWithinCapacity &&
  (globalQuality.meetsTarget ||
    (globalQuality.terrainBound && globalQuality.limitedByLevel &&
      !globalQuality.limitedByTextureBudget &&
      !globalQuality.limitedByBudget))
if (!acceptableQuality) {
  throw new Error('Globe tour imagery quality snapshots are missing')
}
const globalTextures = report.textureSnapshots && report.textureSnapshots.global
if (!globalTextures || globalTextures.state !== 'settled' ||
  !globalTextures.coverageReady || globalTextures.cachedRoots !==
    globalTextures.rootDesired || globalTextures.missingRatio !== 0 ||
  globalTextures.blockedByFailure || globalTextures.presentationTiles <= 0) {
  throw new Error('Globe tour hierarchical imagery did not settle')
}
console.log(`Globe tour Web evidence passed (${required.length} checks).`)
