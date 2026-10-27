// Legacy concatenated-UV input used only by the frozen imagery oracles.
const common = require('../../../sdk/js/core/terra_globe_common')

function drawUvBounds(draw, textureUv) {
  let minimumU = Number.POSITIVE_INFINITY
  let maximumU = Number.NEGATIVE_INFINITY
  let minimumV = Number.POSITIVE_INFINITY
  let maximumV = Number.NEGATIVE_INFINITY
  for (let vertex = 0; vertex < draw.vertexCount; ++vertex) {
    const offset = (draw.firstVertex + vertex) * 2
    minimumU = Math.min(minimumU, textureUv[offset])
    maximumU = Math.max(maximumU, textureUv[offset])
    minimumV = Math.min(minimumV, textureUv[offset + 1])
    maximumV = Math.max(maximumV, textureUv[offset + 1])
  }
  return {
    minimumU: common.clamp(minimumU, 0, 1),
    maximumU: common.clamp(maximumU, 0, 1),
    minimumV: common.clamp(minimumV, 0, 1),
    maximumV: common.clamp(maximumV, 0, 1)
  }
}

module.exports = {drawUvBounds}
