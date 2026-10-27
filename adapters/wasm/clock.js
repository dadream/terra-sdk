// Register the f64 import with Emscripten. The standalone host supplies its
// implementation; avoiding an i64 WASI precision parameter supports WX/V8
// runtimes that do not expose Wasm BigInt integration.
mergeInto(LibraryManager.library, {
  terra_monotonic_milliseconds: function () {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
});
