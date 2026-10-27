'use strict'

const assert = require('assert')
const {hiddenResources} = require('../../../sdk/js/terrain/visibility_evidence')
const {viewerOptions} = require('./visibility')

function visibilityComparison(report, step) {
  const policy = report.options && report.options.visibility
  if (policy !== undefined) viewerOptions(policy)
  const snapshot = step.visibility, quality = step.final.state?.renderer?.quality
  const result = {policy:policy || 'unrecorded', status:'unrecorded',
    reportedHidden:quality && quality.occludedMeshCount, validatedHidden:0}
  // Old captures cannot prove an all-visible input from a count alone. Preserve
  // their raw differences without upgrading them to an oracle verdict.
  if (!snapshot || !quality || policy === undefined) return result
  result.status = 'invalid-evidence'
  if (typeof snapshot.observerEnabled !== 'boolean' ||
      policy === 'all-visible' && snapshot.observerEnabled ||
      !Number.isSafeInteger(quality.occludedMeshCount) || quality.occludedMeshCount < 0 ||
      !Number.isSafeInteger(quality.visibilityRevision) || quality.visibilityRevision < 0) return result
  if (!snapshot.evidence) {
    if (quality.occludedMeshCount === 0 && quality.visibilityRevision === 0) result.status = 'all-visible'
    return result
  }
  const {evidence, scene} = snapshot
  if (!snapshot.observerEnabled || !scene || !Array.isArray(evidence.hidden)) return result
  try {
    result.validatedHidden = hiddenResources(evidence, scene.frame, scene.draws, scene.viewport).size
  } catch (_) { return result }
  if (!result.validatedHidden || result.validatedHidden !== evidence.hidden.length ||
      quality.occludedMeshCount !== result.validatedHidden || quality.visibilityRevision !== evidence.revision) return result
  result.status = 'gpu-occluded'
  return result
}

function difference(actual, expected) {
  assert(Array.isArray(actual) && Array.isArray(expected), 'Missing reference set')
  const a = new Set(actual), b = new Set(expected)
  assert(a.size === actual.length && b.size === expected.length, 'Duplicate resource identity')
  const extra = [...a].filter(key => !b.has(key)).sort()
  const missing = [...b].filter(key => !a.has(key)).sort()
  return {actual: a.size, expected: b.size, extra, missing, matches: !extra.length && !missing.length}
}

// Compare physical source identities, not internal pyramid nodes. The Native
// oracle uses source/matrix/row/column; the runtime uses level/matrix/row/column.
// This adapter applies only to the canonical numeric geodetic source schema.
function physicalKey(key, source) {
  const fields = key.split('/')
  assert(fields.length === 4 && fields.every(value => /^(0|[1-9][0-9]*)$/.test(value)),
    'Invalid runtime image identity')
  const [level, matrix, row, column] = fields.map(Number)
  assert([level, matrix, row, column].every(Number.isSafeInteger) &&
    level >= source.minimum_level && level <= source.maximum_level &&
    matrix === level + source.matrix_level_offset &&
    row < source.level_zero_rows * 2 ** level && column < source.level_zero_columns * 2 ** level,
  'Image identity does not match source schema')
  return [source.id, matrix, row, column].join('/')
}

function compare(reference, report) {
  assert(report.schema === 'terra.joint-capacity.v1' && report.case === reference.case,
    'Different benchmark case')
  const source = reference.imageryProfile.source
  assert(source.kind === 'global-geodetic' && Number.isInteger(source.matrix_level_offset),
    'Reference requires a numeric geodetic source')
  const rows = reference.cores.sdk.rows, discovery = reference.cores.sdk.discoveryRows
  const ids = new Set()
  const steps = report.steps.map(step => {
    assert(!ids.has(step.id), 'Duplicate pose'); ids.add(step.id)
    const target = rows.find(row => row.id === step.id), progressive = discovery.find(row => row.id === step.id)
    assert(target && progressive && target.imagery && target.imagery.status === 'ready', 'Missing completed imagery reference')
    const config = step.final.configuration
    assert(config.imageryId === source.id, 'Different imagery source')
    for (const key of Object.keys(config.source))
      assert.deepStrictEqual(config.source[key], source[key], 'Different source schema: ' + key)
    const expected = target.imagery.physicalKeys
    assert(expected.every(key => key.startsWith(source.id + '/')), 'Different reference image source')
    const sets = step.final.sets
    const frozenTerrain = difference(sets.terrain, target.visibleKeys)
    const presentedImages = difference(sets.presentedImages.map(key => physicalKey(key, source)), expected)
    const visibility = visibilityComparison(report, step), reasons = []
    if (!step.settled) reasons.push('not-settled')
    const camera = step.cameraCheck
    if (!camera || !Number.isFinite(camera.positionErrorMeters) || camera.positionErrorMeters > 1e-6 ||
        !Number.isFinite(camera.projectionViewRelativeError) || camera.projectionViewRelativeError > 1e-10)
      reasons.push('camera-not-aligned')
    if (!frozenTerrain.matches) reasons.push('different-frozen-terrain')
    if (visibility.status !== 'all-visible') reasons.push('visibility-' + visibility.status)
    return {id: step.id, settled: step.settled, withinOriginalDeadline: step.withinOriginalDeadline,
      terrain: difference(sets.terrain, progressive.visibleKeys),
      frozenTerrain, presentedImages,
      imageComparison:{comparable:reasons.length === 0, reasons, visibility,
        status:reasons.length ? 'not-comparable' : presentedImages.matches ? 'match' : 'mismatch'},
      measuredPixelError: step.final.metrics.imageryError,
      referencePixelError: target.imagery.maximumPixelError}
  })
  assert(steps.length > 0, 'No collected poses')
  const comparable = steps.every(step => step.imageComparison.comparable)
  return {schema: 'terra.joint-reference-comparison.v2', case: report.case,
    scope: 'Raw submitted image identities are not visible pixel coverage. Compare with the frozen all-visible Native oracle only for settled aligned poses with matching frozen terrain and no GPU occlusion. Matching sets do not certify latency, live sources or visual quality.',
    fullRouteCompleted: report.fullRouteCompleted === true,
    allTerrainSetsMatch: steps.every(step => step.terrain.matches),
    allPresentedImageSetsMatch: steps.every(step => step.presentedImages.matches),
    allImageComparisonsComparable:comparable,
    allImageReferencesMatch:comparable ? steps.every(step => step.presentedImages.matches) : null, steps}
}

if (require.main === module) {
  const fs = require('fs')
  assert(process.argv.length === 5, 'Usage: compare_reference.js reference.json report.json output.json')
  const result = compare(JSON.parse(fs.readFileSync(process.argv[2])), JSON.parse(fs.readFileSync(process.argv[3])))
  fs.writeFileSync(process.argv[4], JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
}

module.exports = {compare, physicalKey}
