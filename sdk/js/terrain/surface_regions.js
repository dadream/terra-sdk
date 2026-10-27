const {compactRegionSteps:compactRegions} = require('./region_compaction')

function uvHull(uv, boundary) {
  return pointHull(Array.from(boundary, i => [uv[i * 2], uv[i * 2 + 1]]))
}

function pointHull(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) -
    (b[1] - a[1]) * (c[0] - a[0])
  const half = values => {
    const result = []
    values.forEach(point => {
      while (result.length > 1 &&
        cross(result[result.length - 2], result[result.length - 1], point) <= 0) result.pop()
      result.push(point)
    })
    result.pop()
    return result
  }
  return half(points).concat(half(points.slice().reverse()))
}

module.exports = {uvHull, compactRegions}
