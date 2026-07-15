const TERRA_ABI_VERSION = 1
const DEFAULT_WASM_PATH = 'wasm/terra_sdk.wasm'

function createTerraImports() {
  return {
    env: {
      emscripten_notify_memory_growth() {}
    },
    wasi_snapshot_preview1: {
      proc_exit(code) {
        throw new Error(`Terra Wasm exited with status ${code}`)
      }
    }
  }
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

  call(name, ...args) {
    const fn = this.exports[name]
    if (typeof fn !== 'function') {
      throw new Error(`Terra Wasm export is missing: ${name}`)
    }
    try {
      return fn(...args)
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
      throw new Error(`Terra Wasm allocation failed for ${size} bytes`)
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
  return WXWebAssembly.instantiate(packagePath, createTerraImports()).then(
    (loaded) => {
      const instance = loaded.instance || loaded
      if (instance.exports && typeof instance.exports._initialize === 'function') {
        instance.exports._initialize()
      }
      return new TerraWasmModule(instance)
    }
  )
}

module.exports = {
  DEFAULT_WASM_PATH,
  TERRA_ABI_VERSION,
  TerraWasmModule,
  createTerraImports,
  instantiateTerraWasm
}
