const assert = require('assert')
const loader = require('../../adapters/wasm/terra_wasm')

async function main() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 })
  let initialized = false
  let nextPointer = 64
  const exports = {
    memory,
    _initialize() {
      initialized = true
    },
    terra_abi_version() {
      return loader.TERRA_ABI_VERSION
    },
    terra_alloc(size) {
      const result = nextPointer
      nextPointer += size
      return result
    },
    terra_free() {},
    grow() {
      memory.grow(1)
      return 7
    },
    fail() {
      capturedImports.wasi_snapshot_preview1.proc_exit(1)
    }
  }
  let capturedPath = null
  let capturedImports = null
  global.WXWebAssembly = {
    instantiate(packagePath, imports) {
      capturedPath = packagePath
      capturedImports = imports
      return Promise.resolve({ instance: { exports } })
    }
  }

  const terra = await loader.instantiateTerraWasm()
  assert.strictEqual(capturedPath, loader.DEFAULT_WASM_PATH)
  assert.strictEqual(initialized, true)
  assert.strictEqual(
    typeof capturedImports.env.emscripten_notify_memory_growth,
    'function'
  )
  assert.strictEqual(
    typeof capturedImports.wasi_snapshot_preview1.proc_exit,
    'function'
  )
  assert.strictEqual(terra.memoryBytes(), 64 * 1024)
  const initialBuffer = terra.buffer
  assert.strictEqual(terra.call('grow'), 7)
  assert.strictEqual(terra.memoryBytes(), 128 * 1024)
  assert.notStrictEqual(terra.buffer, initialBuffer)
  assert.strictEqual(terra.dataView.buffer, memory.buffer)
  assert.strictEqual(terra.bytes.buffer, memory.buffer)
  const clock = capturedImports.wasi_snapshot_preview1.clock_time_get
  assert.strictEqual(clock(1, 0, 0, 16), 0)
  const nanoseconds = () => terra.dataView.getUint32(16, true) +
    terra.dataView.getUint32(20, true) * 4294967296
  const firstTime = nanoseconds()
  assert(firstTime >= 0)
  assert.strictEqual(clock(1, BigInt(0), 16), 0)
  assert(nanoseconds() >= firstTime)
  assert.strictEqual(clock(2, 0, 16), 28)
  assert.strictEqual(clock(1, 0, memory.buffer.byteLength - 4), 28)
  const other = loader.createTerraImports()
  assert.strictEqual(other.wasi_snapshot_preview1.clock_time_get(1, 0, 16), 28)
  const otherMemory = new WebAssembly.Memory({ initial: 1 })
  other.bindMemory(otherMemory)
  const previousTime = nanoseconds()
  assert.strictEqual(other.wasi_snapshot_preview1.clock_time_get(0, 0, 16), 0)
  assert.strictEqual(nanoseconds(), previousTime)
  assert.throws(() => terra.call('fail'),
    /call fail failed at 0\.1 MiB: Terra Wasm exited with status 1/)
  const pointer = terra.alloc(32)
  assert.strictEqual(pointer, 64)
  terra.free(pointer)
  assert.throws(() => terra.alloc(0), /must be positive/)
  assert.throws(() => terra.call('missing'), /export is missing/)
  exports.terra_abi_version = () => loader.TERRA_ABI_VERSION - 1
  await assert.rejects(loader.instantiateTerraWasm(), /ABI version is unsupported/)
  delete global.WXWebAssembly
  console.log('Mini Program Terra Wasm loader tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
