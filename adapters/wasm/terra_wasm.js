const TERRA_ABI_VERSION = 47
const DEFAULT_WASM_PATH = 'wasm/terra_sdk.wasm'

function createTerraImports() {
  let memory = null
  let lastMonotonicMs = 0
  const imports = {
    env: {
      terra_monotonic_milliseconds() {
        const milliseconds = typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now() : Date.now()
        lastMonotonicMs = Math.max(lastMonotonicMs, milliseconds)
        return lastMonotonicMs
      },
      emscripten_notify_memory_growth() {}
    },
    wasi_snapshot_preview1: {
      clock_time_get(clockId, ...argumentsAfterClock) {
        // Both legalized i64 precision (two integers) and BigInt precision
        // place the result pointer last. Keep this adapter independent of it.
        const pointer = argumentsAfterClock[argumentsAfterClock.length - 1]
        if (!memory || !Number.isInteger(pointer) || pointer < 0 ||
            pointer + 8 > memory.buffer.byteLength ||
            (clockId !== 0 && clockId !== 1)) return 28
        let milliseconds = clockId === 0 ? Date.now() :
          (typeof performance !== 'undefined' &&
           typeof performance.now === 'function' ? performance.now() : Date.now())
        if (clockId === 1) {
          milliseconds = Math.max(lastMonotonicMs, milliseconds)
          lastMonotonicMs = milliseconds
        }
        const nanoseconds = Math.floor(milliseconds * 1000000)
        const view = new DataView(memory.buffer)
        view.setUint32(pointer, nanoseconds % 4294967296, true)
        view.setUint32(pointer + 4, Math.floor(nanoseconds / 4294967296), true)
        return 0
      },
      proc_exit(code) {
        throw new Error(`Terra Wasm exited with status ${code}`)
      }
    }
  }
  Object.defineProperty(imports, 'bindMemory', {
    value(value) { memory = value }
  })
  return imports
}

function initializeTerraInstance(loaded, imports) {
  const instance = loaded.instance || loaded
  if (!instance.exports || !instance.exports.memory) {
    throw new Error('Terra Wasm exports are incomplete')
  }
  imports.bindMemory(instance.exports.memory)
  if (typeof instance.exports._initialize === 'function') instance.exports._initialize()
  return new TerraWasmModule(instance)
}

async function instantiateTerraWasmBytes(bytes) {
  const imports = createTerraImports()
  const loaded = await WebAssembly.instantiate(bytes, imports)
  return initializeTerraInstance(loaded, imports)
}

class TerraWasmModule {
  constructor(instance) {
    if (!instance || !instance.exports) {
      throw new Error('Terra Wasm instance has no exports')
    }
    const exports = instance.exports
    if (!exports.memory || typeof exports.terra_abi_version !== 'function') {
      throw new Error('Terra Wasm exports are incomplete')
    }
    if (exports.terra_abi_version() !== TERRA_ABI_VERSION) {
      throw new Error('Terra Wasm ABI version is unsupported')
    }
    this.instance = instance
    this.exports = exports
    this.buffer = null
    this.dataView = null
    this.bytes = null
    this.refreshMemory()
  }

  refreshMemory() {
    const buffer = this.exports.memory.buffer
    if (buffer !== this.buffer) {
      this.buffer = buffer
      this.dataView = new DataView(buffer)
      this.bytes = new Uint8Array(buffer)
    }
    return {
      dataView: this.dataView,
      bytes: this.bytes
    }
  }

  memoryBytes() {
    return this.exports.memory.buffer.byteLength
  }

  call(name, ...args) {
    const fn = this.exports[name]
    if (typeof fn !== 'function') {
      throw new Error(`Terra Wasm export is missing: ${name}`)
    }
    try {
      return fn(...args)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      const memoryMiB = (this.memoryBytes() / (1024 * 1024)).toFixed(1)
      throw new Error(
        `Terra Wasm call ${name} failed at ${memoryMiB} MiB: ${message}`)
    } finally {
      this.refreshMemory()
    }
  }

  alloc(size) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error('Terra Wasm allocation size must be positive')
    }
    const pointer = this.call('terra_alloc', size)
    if (!pointer) {
      const memoryMiB = (this.memoryBytes() / (1024 * 1024)).toFixed(1)
      throw new Error(
        `Terra Wasm allocation failed for ${size} bytes at ${memoryMiB} MiB`)
    }
    return pointer
  }

  free(pointer) {
    if (pointer) {
      this.call('terra_free', pointer)
    }
  }
}

function instantiateTerraWasm(wasmPath) {
  if (typeof WXWebAssembly === 'undefined') {
    return Promise.reject(new Error('WXWebAssembly is unavailable'))
  }
  const packagePath = wasmPath || DEFAULT_WASM_PATH
  const imports = createTerraImports()
  return WXWebAssembly.instantiate(packagePath, imports).then(
    loaded => initializeTerraInstance(loaded, imports))
}

module.exports = {
  DEFAULT_WASM_PATH,
  TERRA_ABI_VERSION,
  TerraWasmModule,
  createTerraImports,
  initializeTerraInstance,
  instantiateTerraWasmBytes,
  instantiateTerraWasm
}
