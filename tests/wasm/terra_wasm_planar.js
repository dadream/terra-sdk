const fs = require('fs')
const loader = require('../../apps/miniprogram/utils/terra_wasm')
const { TerraAbi, REQUEST_DETAIL, REQUEST_ROOT } =
  require('../../apps/miniprogram/utils/terra_globe_runtime')

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function fnv1a32(bytes) {
  let hash = 0x811c9dc5
  for (let index = 0; index < bytes.length; ++index) {
    hash ^= bytes[index]
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function fixtureBytes(path) {
  const value = fs.readFileSync(path)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function parseReport(path) {
  const result = {}
  fs.readFileSync(path, 'utf8').trim().split(/\r?\n/).forEach((line) => {
    const separator = line.indexOf('=')
    invariant(separator > 0, `Invalid native planar report line: ${line}`)
    result[line.slice(0, separator)] = line.slice(separator + 1)
  })
  return result
}

async function main() {
  if (process.argv.length !== 6) {
    throw new Error(
      'usage: node terra_wasm_planar.js WASM ROOT ROOT_DETAIL NATIVE_REPORT'
    )
  }
  const wasm = await WebAssembly.compile(fs.readFileSync(process.argv[2]))
  const instance = await WebAssembly.instantiate(
    wasm, loader.createTerraImports())
  if (instance.exports._initialize) {
    instance.exports._initialize()
  }
  const module = new loader.TerraWasmModule(instance)
  const abi = new TerraAbi(module)
  try {
    abi.loadManifest({
      formatVersion: 1,
      patchDimension: 64,
      transform: 'planar',
      heightScale: 0.0000976563,
      minimumU: 0,
      minimumV: 0,
      maximumU: 1025,
      maximumV: 1025,
      radius: 0,
      texture: {
        matrix_level_offset: 0,
        maximum_level: 0
      }
    })
    abi.setPlanarLevel(1)
    abi.setPlanarTarget(600, 400)
    abi.setViewport(640, 360, 30.0 * (3.14 / 180.0))
    let frame = abi.update(0.005)
    invariant(frame.patchCount === 4 && frame.requestCount === 2,
      'Wasm planar initial frame changed')
    invariant(Math.abs(frame.cameraPosition[0] - 600) < 0.000001 &&
      Math.abs(frame.cameraPosition[1] - 400) < 0.000001,
    'Wasm planar target did not move the camera position')
    let requests = abi.getRequests()
    const root = requests.find((request) => request.kind === REQUEST_ROOT)
    const detail = requests.find((request) => request.kind === REQUEST_DETAIL)
    invariant(root && detail && root.key.i === 0 && root.key.j === 0 &&
      root.key.k === 268435456 && detail.key.i === 0 && detail.key.j === 0 &&
      detail.key.k === 268435456, 'Wasm planar dependency chain changed')

    abi.submitRecord(root.kind, root.key, fixtureBytes(process.argv[3]))
    frame = abi.update(0.005)
    invariant(frame.drawCount === 0 && frame.requestCount === 1,
      'Wasm planar root-only frame changed')
    requests = abi.getRequests()
    abi.submitRecord(requests[0].kind, requests[0].key,
      fixtureBytes(process.argv[4]))
    frame = abi.update(0.005)
    const draws = abi.getDrawRanges()
    const positions = abi.getPositions()
    const textureUv = abi.getTextureUv()
    invariant(frame.drawCount === 4 && frame.vertexCount === 8580 &&
      draws.length === 4 && positions.length === 25740 &&
      textureUv.length === 17160, 'Wasm planar draw buffers changed')
    invariant(draws.every((draw) => draw.texture.level === 0 &&
      draw.texture.matrix === 0 && draw.texture.row === 0 &&
      draw.texture.column === 0), 'Wasm planar texture key changed')

    let minimumHeight = Number.POSITIVE_INFINITY
    let maximumHeight = Number.NEGATIVE_INFINITY
    for (let index = 2; index < positions.length; index += 3) {
      minimumHeight = Math.min(minimumHeight, positions[index])
      maximumHeight = Math.max(maximumHeight, positions[index])
    }
    invariant(maximumHeight > minimumHeight,
      'Wasm planar record produced a flat surface')
    const actual = {
      schema: 'terra.c_api.planar.v1',
      draw_count: String(draws.length),
      vertex_count: String(frame.vertexCount),
      position_fnv1a32: String(fnv1a32(new Uint8Array(positions.buffer))),
      texture_fnv1a32: String(fnv1a32(new Uint8Array(textureUv.buffer))),
      height_range: `${minimumHeight.toFixed(6)},${maximumHeight.toFixed(6)}`
    }
    const expected = parseReport(process.argv[5])
    Object.keys(actual).forEach((key) => {
      invariant(actual[key] === expected[key],
        `Planar native/Wasm mismatch at ${key}: ` +
        `${actual[key]} != ${expected[key]}`)
    })
    abi.setPlanarLevel(2)
    frame = abi.update(0.005)
    invariant(frame.requestCount === 4 && abi.getRequests().every(
      (request) => request.kind === REQUEST_DETAIL && request.key.level === 1),
    'Wasm planar level-two requests changed')
    console.log(
      `Terra planar native/Wasm parity passed: ${actual.draw_count} draws, ` +
      `${actual.vertex_count} retained vertices`
    )
  } finally {
    abi.destroy()
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
