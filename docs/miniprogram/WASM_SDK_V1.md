# Terra WebAssembly SDK v1

## Purpose

The v1 package exposes the platform-neutral Terra core, CBDAM decoder, camera,
LOD selection, and common patch topology to a WeChat Mini Program. It does not
contain Qt, OpenGL, VIC VFS, Berkeley DB, HTTP, Promise, image decode, DOM, or
browser-generated Emscripten glue.

TypeScript owns manifest JSON/schema/SRS validation, request scheduling,
retries, cancellation, cache, credentials, and imagery. It maps validated
numeric manifest fields into the C ABI. Wasm validates those values again,
selects patches, decodes terrain records, and emits deterministic frame data.

## Build And Verify

Run from the repository root in WSL:

```bash
bash scripts/build_wasm.sh
bash scripts/verify_miniprogram_wasm.sh
```

The build uses `docker/Dockerfile.wasm`, Emscripten 3.1.5, and
`adapters/wasm/CMakePresets.json`. The verifier builds both native and Wasm
implementations, compares reports byte for byte, performs two clean Wasm builds
and compares SHA-256, tests the Mini Program loader, rejects compiler warnings,
and enforces a default 1 MiB Wasm limit.

The generated package is:

```text
workspace_old/package/miniprogram/
  include/terra/c_api/terra.h
  utils/terra_wasm.js
  wasm/terra_sdk.wasm
  wasm/terra_sdk_wasm_manifest.json
```

Generated binaries and reports remain outside Git. To rebuild the Docker image,
set `TERRA_SDK_WASM_REBUILD=1`. `TERRA_SDK_WASM_BASE_IMAGE` may select an
explicit registry image; the default uses the Docker daemon's configured
registry and a pinned Ubuntu digest.

## ABI Contract

The installed target is `Terra::c_api`; the C-compatible header is
`terra/c_api/terra.h`. ABI v1 uses opaque `terra_context` handles, fixed-width
integers, versioned structures with `struct_size`, explicit status values, and
caller-owned buffers. No exception crosses the ABI.

Typical call order:

```text
terra_create
terra_load_manifest
terra_set_viewport / terra_set_camera
terra_update
terra_get_requests / terra_get_frame / terra_get_frame_patches
terra_get_index_buffer
terra_submit_patch / terra_fail_patch
terra_get_stats / terra_get_last_error
terra_destroy
```

`terra_get_*` list functions first return the required element count when called
with a null/zero-capacity buffer. `terra_alloc` and `terra_free` are provided for
copying typed data through Wasm memory. Structure-size query functions let host
code reject an incompatible layout before writing fields.

`terra_submit_patch` accepts exact terrain-service record bytes and validates
the current frame key before decoding. `terra_fail_patch` records failure while
leaving retry policy outside C++.

## Patch Topology

For the current `patch_dim=64` globe, the shared triangular topology contains:

- 2,145 addressable vertices;
- 4,096 non-degenerate triangles;
- 24,573 stitched `uint16_t` triangle-strip indices;
- FNV-1a32 `2327969341` over little-endian index bytes.

The index generator follows the legacy CBDAM triangle order and uses explicit
degenerate stitching instead of depending on SL's greedy stripifier. This keeps
the triangle set and winding deterministic across native and Wasm.

## Memory And Host Loader

The module starts at 16 MiB, may grow, and is capped at 64 MiB. Filesystem and
thread support are disabled. Its only imports are:

```text
env.emscripten_notify_memory_growth
wasi_snapshot_preview1.proc_exit
```

`apps/miniprogram/utils/terra_wasm.js` instantiates the module through
`WXWebAssembly`. It compares `memory.buffer` after every exported call and
recreates `DataView` and `Uint8Array` whenever growth replaces the buffer. Host
code must request views again instead of retaining old typed arrays.

## Frozen Parity

The M5 fixture uses radius 6,378,000 m, `1280x720`, threshold `0.005`, and the
checked-in real globe detail record. Both native and Wasm produce 28 initial
patch decisions/requests, the same first and last patch IDs and priorities, the
same camera position, the frozen index buffer, 27 requests after one successful
patch, and 4,096 decoded residual values. The package manifest records binary
size, hash, imports, memory limits, index evidence, and parity status.
