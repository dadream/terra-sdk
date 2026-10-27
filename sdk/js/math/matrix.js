const common = require('../core/terra_globe_common')

function invertMatrix4(value) {
  const rows = []
  for (let row = 0; row < 4; ++row) {
    rows[row] = []
    for (let column = 0; column < 4; ++column) {
      rows[row][column] = value[column * 4 + row]
    }
    for (let column = 0; column < 4; ++column) {
      rows[row][column + 4] = row === column ? 1 : 0
    }
  }
  for (let column = 0; column < 4; ++column) {
    let pivot = column
    for (let row = column + 1; row < 4; ++row) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) {
        pivot = row
      }
    }
    common.invariant(Math.abs(rows[pivot][column]) > 1e-12,
      'Projection-view matrix is singular')
    const swap = rows[column]
    rows[column] = rows[pivot]
    rows[pivot] = swap
    const scale = rows[column][column]
    for (let index = 0; index < 8; ++index) {
      rows[column][index] /= scale
    }
    for (let row = 0; row < 4; ++row) {
      if (row === column) continue
      const factor = rows[row][column]
      for (let index = 0; index < 8; ++index) {
        rows[row][index] -= factor * rows[column][index]
      }
    }
  }
  const result = new Float32Array(16)
  for (let row = 0; row < 4; ++row) {
    for (let column = 0; column < 4; ++column) {
      result[column * 4 + row] = rows[row][column + 4]
    }
  }
  return result
}

module.exports = { invertMatrix4 }
