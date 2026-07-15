const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const STATUS_OK = 0
const STATUS_BUFFER_TOO_SMALL = 6
const API_VERSION = 1
const INITIAL_MEMORY_BYTES = 16 * 1024 * 1024
const MAXIMUM_MEMORY_BYTES = 64 * 1024 * 1024

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function requireStatus(actual, expected, operation) {
  if (actual !== expected) {
    throw new Error(`${operation} returned ${actual}, expected ${expected}`)
  }
}

function readU64(view, offset) {
  const low = view.getUint32(offset, true)
  const high = view.getUint32(offset + 4, true)
  return low + high * 0x100000000
}

function readKey(view, offset) {
  return {
    level: view.getUint32(offset, true),
    i: view.getInt32(offset + 4, true),
    j: view.getInt32(offset + 8, true),
    k: view.getInt32(offset + 12, true)
  }
}

function formatKey(key) {
  return `${key.level},${key.i},${key.j},${key.k}`
}

function bytesFnv1a32(bytes, pointer, count) {
  let hash = 0x811c9dc5
  for (let index = 0; index < count; ++index) {
    hash ^= bytes[pointer + index]
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function indexFnv1a32(view, pointer, count) {
  let hash = 0x811c9dc5
  for (let index = 0; index < count; ++index) {
    const value = view.getUint16(pointer + index * 2, true)
    hash ^= value & 0xff
    hash = Math.imul(hash, 0x01000193)
    hash ^= (value >>> 8) & 0xff
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function makeImports() {
  return {
    env: {
      emscripten_notify_memory_growth: function () {}
    },
    wasi_snapshot_preview1: {
      proc_exit: function (code) {
        throw new Error(`Terra Wasm exited with status ${code}`)
      }
    }
  }
}

function createMemoryAccess(exports) {
  let buffer = null
  let view = null
  let bytes = null
  function refresh() {
    if (buffer !== exports.memory.buffer) {
      buffer = exports.memory.buffer
      view = new DataView(buffer)
      bytes = new Uint8Array(buffer)
    }
    return { view, bytes }
  }
  function alloc(size) {
    const pointer = exports.terra_alloc(size)
    refresh()
    requireCondition(pointer !== 0, `Wasm allocation failed for ${size} bytes`)
    return pointer
  }
  return { refresh, alloc }
}

function writeManifest(access, pointer, size) {
  const memory = access.refresh()
  memory.bytes.fill(0, pointer, pointer + size)
  const view = memory.view
  view.setUint32(pointer, size, true)
  view.setUint32(pointer + 4, API_VERSION, true)
  view.setUint32(pointer + 8, 1, true)
  view.setUint32(pointer + 12, 64, true)
  view.setUint32(pointer + 16, 2, true)
  view.setFloat64(pointer + 24, 0.001953125, true)
  view.setFloat64(pointer + 32, -180.0, true)
  view.setFloat64(pointer + 40, -90.0, true)
  view.setFloat64(pointer + 48, 180.0, true)
  view.setFloat64(pointer + 56, 90.0, true)
  view.setFloat64(pointer + 64, 6378000.0, true)
  view.setUint32(pointer + 72, 0, true)
  view.setUint32(pointer + 76, 8, true)
}

function writeViewport(access, pointer, size) {
  const memory = access.refresh()
  memory.bytes.fill(0, pointer, pointer + size)
  const view = memory.view
  view.setUint32(pointer, size, true)
  view.setUint32(pointer + 4, 1280, true)
  view.setUint32(pointer + 8, 720, true)
  view.setFloat64(pointer + 16, 30.0 * (3.14 / 180.0), true)
}

async function main() {
  if (process.argv.length !== 10) {
    throw new Error(
      'usage: node terra_wasm_parity.js WASM ROOT0 DETAIL0 ROOT3 DETAIL3 CHILD_DETAIL NATIVE_REPORT OUTPUT_DIR'
    )
  }
  const wasmPath = process.argv[2]
  const root0Path = process.argv[3]
  const detail0Path = process.argv[4]
  const root3Path = process.argv[5]
  const detail3Path = process.argv[6]
  const childDetailPath = process.argv[7]
  const nativeReportPath = process.argv[8]
  const outputDir = process.argv[9]
  const wasmBytes = fs.readFileSync(wasmPath)
  const module = await WebAssembly.compile(wasmBytes)
  const imports = WebAssembly.Module.imports(module)
  requireCondition(
    imports.length === 2 &&
      imports.some(
        (entry) =>
          entry.module === 'env' &&
          entry.name === 'emscripten_notify_memory_growth'
      ) &&
      imports.some(
        (entry) =>
          entry.module === 'wasi_snapshot_preview1' &&
          entry.name === 'proc_exit'
      ),
    `Unexpected Wasm imports: ${JSON.stringify(imports)}`
  )
  const instance = await WebAssembly.instantiate(module, makeImports())
  const exports = instance.exports
  if (exports._initialize) {
    exports._initialize()
  }
  requireCondition(exports.terra_abi_version() === API_VERSION, 'ABI changed')
  requireCondition(
    exports.memory.buffer.byteLength === INITIAL_MEMORY_BYTES,
    'Initial Wasm memory changed'
  )

  const pagesToMaximum =
    (MAXIMUM_MEMORY_BYTES - INITIAL_MEMORY_BYTES) / (64 * 1024)
  exports.memory.grow(pagesToMaximum)
  requireCondition(
    exports.memory.buffer.byteLength === MAXIMUM_MEMORY_BYTES,
    'Wasm memory did not grow to the configured 64 MiB maximum'
  )
  const oldBuffer = exports.memory.buffer
  let maximumRejected = false
  try {
    exports.memory.grow(1)
  } catch (error) {
    maximumRejected = error instanceof RangeError
  }
  requireCondition(maximumRejected, 'Wasm memory maximum is not 64 MiB')
  requireCondition(
    exports.memory.buffer === oldBuffer,
    'Rejected Wasm memory growth replaced the backing buffer'
  )

  const access = createMemoryAccess(exports)
  const layout = {
    manifest: exports.terra_sizeof_manifest_v1(),
    viewport: exports.terra_sizeof_viewport_v1(),
    key: exports.terra_sizeof_patch_key_v1(),
    texture: exports.terra_sizeof_texture_key_v1(),
    request: exports.terra_sizeof_request_v1(),
    decision: exports.terra_sizeof_patch_decision_v1(),
    draw: exports.terra_sizeof_draw_range_v1(),
    frame: exports.terra_sizeof_frame_v1(),
    stats: exports.terra_sizeof_stats_v1()
  }
  requireCondition(
    `${layout.manifest},${layout.viewport},${layout.key},${layout.texture},${layout.request},${layout.decision},${layout.draw},${layout.frame},${layout.stats}` ===
      '80,24,16,16,24,32,88,208,56',
    'Wasm ABI structure layout changed'
  )

  const context = exports.terra_create()
  requireCondition(context !== 0, 'terra_create failed')
  const allocations = []
  function alloc(size) {
    const pointer = access.alloc(size)
    allocations.push(pointer)
    return pointer
  }

  try {
    const manifestPointer = alloc(layout.manifest)
    writeManifest(access, manifestPointer, layout.manifest)
    requireStatus(
      exports.terra_load_manifest(context, manifestPointer),
      STATUS_OK,
      'terra_load_manifest'
    )
    const viewportPointer = alloc(layout.viewport)
    writeViewport(access, viewportPointer, layout.viewport)
    requireStatus(
      exports.terra_set_viewport(context, viewportPointer),
      STATUS_OK,
      'terra_set_viewport'
    )
    requireStatus(exports.terra_update(context, 0.005), STATUS_OK, 'terra_update')

    const framePointer = alloc(layout.frame)
    access.refresh().view.setUint32(framePointer, layout.frame, true)
    requireStatus(
      exports.terra_get_frame(context, framePointer),
      STATUS_OK,
      'terra_get_frame'
    )
    let view = access.refresh().view
    const initial = {
      sequence: readU64(view, framePointer + 8),
      patchCount: view.getUint32(framePointer + 20, true),
      requestCount: view.getUint32(framePointer + 24, true),
      camera: [
        view.getFloat64(framePointer + 40, true),
        view.getFloat64(framePointer + 48, true),
        view.getFloat64(framePointer + 56, true)
      ]
    }

    const countPointer = alloc(4)
    view = access.refresh().view
    view.setUint32(countPointer, 0, true)
    requireStatus(
      exports.terra_get_frame_patches(context, 0, 0, countPointer),
      STATUS_BUFFER_TOO_SMALL,
      'terra_get_frame_patches sizing'
    )
    view = access.refresh().view
    const patchCount = view.getUint32(countPointer, true)
    const patchesPointer = alloc(patchCount * layout.decision)
    requireStatus(
      exports.terra_get_frame_patches(
        context,
        patchesPointer,
        patchCount,
        countPointer
      ),
      STATUS_OK,
      'terra_get_frame_patches'
    )
    view = access.refresh().view
    const firstPatch = {
      key: readKey(view, patchesPointer + 8),
      visible: view.getUint32(patchesPointer + 4, true),
      priority: view.getFloat32(patchesPointer + 24, true)
    }
    const lastOffset = patchesPointer + (patchCount - 1) * layout.decision
    const lastPatch = {
      key: readKey(view, lastOffset + 8),
      visible: view.getUint32(lastOffset + 4, true),
      priority: view.getFloat32(lastOffset + 24, true)
    }

    requireStatus(
      exports.terra_update(context, 0.0025),
      STATUS_OK,
      'terra_update hierarchy cut'
    )

    view.setUint32(countPointer, 0, true)
    requireStatus(
      exports.terra_get_requests(context, 0, 0, countPointer),
      STATUS_BUFFER_TOO_SMALL,
      'terra_get_requests sizing'
    )
    view = access.refresh().view
    const requestCount = view.getUint32(countPointer, true)
    const requestsPointer = alloc(requestCount * layout.request)
    requireStatus(
      exports.terra_get_requests(
        context,
        requestsPointer,
        requestCount,
        countPointer
      ),
      STATUS_OK,
      'terra_get_requests'
    )
    view = access.refresh().view
    function findRequestPointer(kind, level, i, j, k) {
      for (let index = 0; index < requestCount; ++index) {
        const pointer = requestsPointer + index * layout.request
        const key = readKey(view, pointer + 8)
        if (
          view.getUint32(pointer + 4, true) === kind &&
          key.level === level &&
          key.i === i &&
          key.j === j &&
          key.k === k
        ) {
          return pointer
        }
      }
      return 0
    }
    const root0Request = findRequestPointer(1, 0, 0, 134217728, 134217728)
    const detail0Request = findRequestPointer(2, 0, 0, 134217728, 134217728)
    const root3Request = findRequestPointer(1, 0, -134217728, 134217728, 0)
    const detail3Request = findRequestPointer(2, 0, -134217728, 134217728, 0)
    const childDetailRequest = findRequestPointer(
      2,
      1,
      -134217728,
      134217728,
      134217728
    )
    requireCondition(
      root0Request !== 0 &&
        detail0Request !== 0 &&
        root3Request !== 0 &&
        detail3Request !== 0 &&
        childDetailRequest !== 0,
      'Complete globe request chain is missing'
    )
    const requestKind = view.getUint32(root0Request + 4, true)

    view.setUint32(countPointer, 0, true)
    requireStatus(
      exports.terra_get_index_buffer(context, 0, 0, countPointer),
      STATUS_BUFFER_TOO_SMALL,
      'terra_get_index_buffer sizing'
    )
    view = access.refresh().view
    const indexCount = view.getUint32(countPointer, true)
    const indicesPointer = alloc(indexCount * 2)
    requireStatus(
      exports.terra_get_index_buffer(
        context,
        indicesPointer,
        indexCount,
        countPointer
      ),
      STATUS_OK,
      'terra_get_index_buffer'
    )
    view = access.refresh().view
    const indexHash = indexFnv1a32(view, indicesPointer, indexCount)

    function submitRecord(recordPath, kind, requestPointer, label) {
      const recordBytes = fs.readFileSync(recordPath)
      const recordPointer = alloc(recordBytes.length)
      access.refresh().bytes.set(recordBytes, recordPointer)
      requireStatus(
        exports.terra_submit_record(
          context,
          kind,
          requestPointer + 8,
          recordPointer,
          recordBytes.length
        ),
        STATUS_OK,
        label
      )
    }
    submitRecord(root0Path, 1, root0Request, 'terra_submit_record root zero')
    submitRecord(
      detail0Path,
      2,
      detail0Request,
      'terra_submit_record root zero detail'
    )
    submitRecord(root3Path, 1, root3Request, 'terra_submit_record root three')
    submitRecord(
      detail3Path,
      2,
      detail3Request,
      'terra_submit_record root three detail'
    )
    submitRecord(
      childDetailPath,
      2,
      childDetailRequest,
      'terra_submit_record shared child detail'
    )
    requireStatus(
      exports.terra_update(context, 0.0025),
      STATUS_OK,
      'terra_update after records'
    )
    access.refresh().view.setUint32(framePointer, layout.frame, true)
    requireStatus(
      exports.terra_get_frame(context, framePointer),
      STATUS_OK,
      'terra_get_frame after records'
    )
    view = access.refresh().view
    const after = {
      sequence: readU64(view, framePointer + 8),
      patchCount: view.getUint32(framePointer + 20, true),
      requestCount: view.getUint32(framePointer + 24, true),
      loadedPatchCount: view.getUint32(framePointer + 28, true),
      drawCount: view.getUint32(framePointer + 192, true),
      vertexCount: view.getUint32(framePointer + 196, true)
    }

    view.setUint32(countPointer, 0, true)
    requireStatus(
      exports.terra_get_draw_ranges(context, 0, 0, countPointer),
      STATUS_BUFFER_TOO_SMALL,
      'terra_get_draw_ranges sizing'
    )
    view = access.refresh().view
    const drawCount = view.getUint32(countPointer, true)
    const drawsPointer = alloc(drawCount * layout.draw)
    requireStatus(
      exports.terra_get_draw_ranges(
        context,
        drawsPointer,
        drawCount,
        countPointer
      ),
      STATUS_OK,
      'terra_get_draw_ranges'
    )
    view = access.refresh().view
    const firstDraw = {
      key: readKey(view, drawsPointer + 8),
      fragment: view.getUint32(drawsPointer + 4, true),
      texture: {
        level: view.getUint32(drawsPointer + 24, true),
        matrix: view.getInt32(drawsPointer + 28, true),
        row: view.getInt32(drawsPointer + 32, true),
        column: view.getInt32(drawsPointer + 36, true)
      }
    }

    view.setUint32(countPointer, 0, true)
    requireStatus(
      exports.terra_get_position_buffer(context, 0, 0, countPointer),
      STATUS_BUFFER_TOO_SMALL,
      'terra_get_position_buffer sizing'
    )
    view = access.refresh().view
    const positionCount = view.getUint32(countPointer, true)
    const positionsPointer = alloc(positionCount * 4)
    requireStatus(
      exports.terra_get_position_buffer(
        context,
        positionsPointer,
        positionCount,
        countPointer
      ),
      STATUS_OK,
      'terra_get_position_buffer'
    )
    const positionHash = bytesFnv1a32(
      access.refresh().bytes,
      positionsPointer,
      positionCount * 4
    )

    view = access.refresh().view
    view.setUint32(countPointer, 0, true)
    requireStatus(
      exports.terra_get_texture_uv_buffer(context, 0, 0, countPointer),
      STATUS_BUFFER_TOO_SMALL,
      'terra_get_texture_uv_buffer sizing'
    )
    view = access.refresh().view
    const textureCount = view.getUint32(countPointer, true)
    const texturePointer = alloc(textureCount * 4)
    requireStatus(
      exports.terra_get_texture_uv_buffer(
        context,
        texturePointer,
        textureCount,
        countPointer
      ),
      STATUS_OK,
      'terra_get_texture_uv_buffer'
    )
    const textureHash = bytesFnv1a32(
      access.refresh().bytes,
      texturePointer,
      textureCount * 4
    )

    const statsPointer = alloc(layout.stats)
    access.refresh().view.setUint32(statsPointer, layout.stats, true)
    requireStatus(
      exports.terra_get_stats(context, statsPointer),
      STATUS_OK,
      'terra_get_stats'
    )
    view = access.refresh().view
    const stats = {
      updateCount: readU64(view, statsPointer + 8),
      loadedPatchCount: readU64(view, statsPointer + 16),
      decodedValueCount: readU64(view, statsPointer + 32),
      lastSequence: readU64(view, statsPointer + 48)
    }

    const report = [
      'schema=terra.c_api.parity.v1',
      `abi=${exports.terra_abi_version()}`,
      `layout=${layout.manifest},${layout.viewport},${layout.key},${layout.texture},${layout.request},${layout.decision},${layout.draw},${layout.frame},${layout.stats}`,
      `initial.sequence=${initial.sequence}`,
      `initial.patch_count=${initial.patchCount}`,
      `initial.request_count=${initial.requestCount}`,
      `initial.camera=${initial.camera.map((value) => value.toFixed(6)).join(',')}`,
      `initial.first=${formatKey(firstPatch.key)},${firstPatch.visible},${firstPatch.priority.toFixed(6)}`,
      `initial.last=${formatKey(lastPatch.key)},${lastPatch.visible},${lastPatch.priority.toFixed(6)}`,
      `initial.request_kind=${requestKind}`,
      `initial.index_count=${indexCount}`,
      `initial.index_fnv1a32=${indexHash}`,
      `after.sequence=${after.sequence}`,
      `after.patch_count=${after.patchCount}`,
      `after.request_count=${after.requestCount}`,
      `after.loaded_patch_count=${after.loadedPatchCount}`,
      `after.draw_count=${after.drawCount}`,
      `after.vertex_count=${after.vertexCount}`,
      `after.first_draw=${formatKey(firstDraw.key)},${firstDraw.fragment},${firstDraw.texture.level},${firstDraw.texture.matrix},${firstDraw.texture.row},${firstDraw.texture.column}`,
      `after.position_count=${positionCount}`,
      `after.position_fnv1a32=${positionHash}`,
      `after.texture_count=${textureCount}`,
      `after.texture_fnv1a32=${textureHash}`,
      `stats.update_count=${stats.updateCount}`,
      `stats.loaded_patch_count=${stats.loadedPatchCount}`,
      `stats.decoded_value_count=${stats.decodedValueCount}`,
      `stats.last_sequence=${stats.lastSequence}`,
      ''
    ].join('\n')

    const nativeReport = fs
      .readFileSync(nativeReportPath, 'utf8')
      .replace(/\r\n/g, '\n')
    requireCondition(report === nativeReport, 'Native and Wasm reports differ')

    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, 'wasm_parity.txt'), report)
    const manifestOutput = {
      schema: 'terra.wasm.package.v1',
      abi_version: API_VERSION,
      emscripten_version: '3.1.5',
      wasm_file: path.basename(wasmPath),
      wasm_size_bytes: wasmBytes.length,
      wasm_sha256: crypto.createHash('sha256').update(wasmBytes).digest('hex'),
      initial_memory_bytes: INITIAL_MEMORY_BYTES,
      maximum_memory_bytes: MAXIMUM_MEMORY_BYTES,
      imports: imports.map((entry) => `${entry.module}.${entry.name}`),
      index_count: indexCount,
      index_fnv1a32: indexHash,
      draw_count: drawCount,
      vertex_count: after.vertexCount,
      position_fnv1a32: positionHash,
      texture_fnv1a32: textureHash,
      parity: 'passed'
    }
    fs.writeFileSync(
      path.join(outputDir, 'terra_sdk_wasm_manifest.json'),
      `${JSON.stringify(manifestOutput, null, 2)}\n`
    )
    console.log(
      `Terra native/Wasm parity passed: ${initial.patchCount} patches, ${drawCount} draws, ${wasmBytes.length} bytes`
    )
  } finally {
    for (let index = allocations.length - 1; index >= 0; --index) {
      exports.terra_free(allocations[index])
    }
    exports.terra_destroy(context)
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
