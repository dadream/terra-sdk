const assert = require('assert')
const loader = require('../../apps/miniprogram/utils/terra_wasm')

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
  const initialBuffer = terra.buffer
  assert.strictEqual(terra.call('grow'), 7)
  assert.notStrictEqual(terra.buffer, initialBuffer)
  assert.strictEqual(terra.dataView.buffer, memory.buffer)
  assert.strictEqual(terra.bytes.buffer, memory.buffer)
  const pointer = terra.alloc(32)
  assert.strictEqual(pointer, 64)
  terra.free(pointer)
  assert.throws(() => terra.alloc(0), /must be positive/)
  assert.throws(() => terra.call('missing'), /export is missing/)
  delete global.WXWebAssembly
  console.log('Mini Program Terra Wasm loader tests passed.')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
