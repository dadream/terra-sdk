// Small real triangular patches, using the native mesh's row layout and strip
// winding. Interior elevation can change without changing the outer boundary.
function patch(id, corners, height = () => 0, dimension = 3, anchor = {level: 0, root: 0, row: 0, column: 0}) {
  const positions = [], uv = [], indices = [], rows = []
  for (let y = 0; y <= dimension; ++y) {
    rows.push(positions.length / 3)
    for (let x = 0; x <= dimension - y; ++x) {
      const point = [0, 1].map(i => corners[0][i] +
        (corners[1][i] - corners[0][i]) * x / dimension +
        (corners[2][i] - corners[0][i]) * y / dimension)
      uv.push(...point)
      positions.push(...point, height(point, x, y, dimension))
    }
  }
  function triangle(a, b, c) {
    if (indices.length) {
      indices.push(indices[indices.length - 1], a)
      if (indices.length % 2) indices.push(a)
    }
    indices.push(a, b, c)
  }
  for (let y = 0; y < dimension; ++y) for (let x = 0; x < dimension - y; ++x) {
    triangle(rows[y] + x, rows[y] + x + 1, rows[y + 1] + x)
    if (x < dimension - y - 1) triangle(rows[y + 1] + x + 1, rows[y + 1] + x, rows[y] + x + 1)
  }
  return {draw: {resourceId: id, textureResourceId: 4294967296 + id, geometryKey: `mesh:${id}`, key: {level: 0, i: 0, j: 0, k: 0},
    textureNode: anchor, texture: {level: anchor.level, matrix: anchor.level, row: anchor.row, column: anchor.column},
    origin: [0, 0, 0], firstIndex: 0, firstVertex: 0, indexCount: indices.length, vertexCount: positions.length / 3},
  resource: {resourceId: id, positions: new Float32Array(positions), textureUv: new Float32Array(uv)},
  indices: new Uint16Array(indices)}
}
function surface(patches) {
  return {draws: patches.map(p => p.draw), meshResources: new Map(patches.map(p => [p.draw.resourceId, p.resource])),
    indices: patches[0].indices}
}
module.exports = {patch, surface}
