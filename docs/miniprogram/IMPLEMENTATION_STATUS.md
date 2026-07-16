# Mini Program Implementation Status

## Baseline

Branch `feature/miniprogram-sdk` uses an independent worktree based on
`e361b81`. The original `main` branch was pushed to `origin/main` before
implementation began.

## M0: Complete

- The implementation roadmap defines scope, contracts, milestones, and gates.
- `desktop_oracle_manifest.txt` freezes viewer/nav3d source trees and direct
  CMake target declarations.
- `check_desktop_oracle.sh` rejects committed, staged, unstaged, or untracked
  changes under those frozen paths.
- `verify_miniprogram_foundation.sh` provides the focused additive gate.

## M1: Automated Engineering Complete

Implemented locally:

- native Mini Program project and full-canvas WebGL probe;
- deterministic shader draw and framebuffer readback;
- checked-in 41-byte Wasm module exporting `add`;
- `WXWebAssembly` loader with expected result 42;
- modern/legacy system capability collection;
- optional credential-free HTTPS ArrayBuffer probe;
- host utility tests and operator documentation.

Deferred final user acceptance (non-blocking):

- successful WeChat DevTools run and screenshot/report;
- successful Android and iOS runs and screenshot/reports;
- configured request-domain ArrayBuffer result;
- reviewed reference-device frame and memory thresholds.

The checked-in device-evidence verifier defines the final local packet and
rejects incomplete reports, invalid probe output, or textual credentials. The
real device packet remains pending user review; it controls production-release
approval rather than M1 engineering progress.

## M2: Complete

Native characterization coverage now includes:

- checked-in globe and planar metadata matching the desktop cylindrical and
  1k reference datasets;
- a 791-line golden report for planar/cylindrical metadata, coordinate
  transforms, canonical grid points, root topology, first child patch IDs, and
  the viewer-equivalent globe camera action sequence;
- exact camera projection/view/PV matrices, clip planes, camera positions, and
  fixed bounding-volume visibility results for initial, zoom, 45-degree tilt,
  30-degree yaw, and reset states;
- three deterministic, converged procedural LOD cuts containing 8, 28, and 62
  leaf patch IDs across levels 0 through 4, using the current root geometry,
  bounding-volume, heap priority, refine/coarsen, and `extract_cut` paths;
- a checked-in real globe detail record plus golden framing, `64x64` residual
  decode statistics, sample values, and raw/decoded hashes;
- global-geodetic WMTS level, row, column, matrix-offset, and URL mapping
  contracts covered by `terra_sdk_geo_tilemap_smoke`;
- dedicated CTests and focused Docker verification script;
- default integration into the complete baseline gate.

M2 characterization is complete. M3 native SDK extraction must match these
fixtures; native-versus-Wasm parity is added in M5.

## M3: Complete

The current additive extraction provides:

- C++14-only `Terra::core`, `Terra::codec`, and `Terra::frame` targets
  with standard-library public types;
- planar/cylindrical transforms, root topology, camera/frustum culling, and
  global-geodetic WMTS selection matching the M2 contracts;
- CBDAM height-record framing plus a decode-only, bounds-checked range/quadtree
  codec matching the real `64x64` M2 globe patch golden;
- deterministic cylindrical child wrapping, shared-fragment refinement,
  oriented bounds, Morton ordering, and LOD cuts matching all 412 M2 LOD
  properties for the 8/28/62-leaf thresholds;
- a typed dataset metadata contract with explicit validation results for
  format version, patch shape, transforms, bounds, scale, SRS, and radius;
- backend-neutral frame packets carrying camera state, bounded LOD decisions,
  texture requests, and WebGL1-compatible terrain mesh buffers;
- explicit status results for malformed framing, exhausted range streams,
  unsupported shapes, invalid frame buffers, and resource limits;
- source-include and target-link dependency closure checks;
- install/export support through `find_package(TerraSdk)` for all three
  targets;
- an installed-consumer build/run test and a warning-free focused gate.

Metadata serialization parsing remains at the service or TypeScript boundary;
the C++ core validates the resulting typed values and does not embed a JSON or
XML dependency. Frame packets define the asynchronous boundary between SDK
decisions, fetched/decoded resources, and the future Mini Program renderer.

Viewer and nav3d remain linked to their original CBDAM targets. M3 is complete;
the next implementation milestone is the versioned terrain delivery service.

## M4: Complete

The versioned terrain delivery milestone provides:

- a read-only `terra_terrain_service` adapter over existing
  `terrain.xml/.root/.data` repositories with no format conversion;
- v1 manifest, root, and detail endpoints using standard JSON and exact
  `application/octet-stream` repository records;
- explicit `400`, `404`, `405`, `500`, and `503` contracts without
  leaking storage paths;
- content length, format version, FNV-1a integrity, ETag/304, HEAD, and
  immutable patch caching contracts;
- deterministic C++ tests for current-reader byte parity, malformed and
  out-of-range keys, missing and cross-repository records, truncation,
  same-length corruption, unsafe IDs, and conditional requests;
- real HTTP smoke coverage using curl as a client with no VIC VFS or Berkeley
  DB dependency;
- exact service parity for both the checked-in 1k repository and the external
  805,306,368-byte cylindrical globe detail repository;
- HTTPS reverse-proxy, immutable dataset ID, Mini Program request-domain,
  ArrayBuffer validation, runtime dependency, and credential handling
  documentation.

The 1k root/detail SHA-256 values are
`e7715fa22c5951e900e72656cf7fa9aaa4612fae3b4427e969ae22626792e799`
and `840f43eff7d49de194239c9978b0cd0e9ced33f056988a78bb214b7ea7af2512`.
The globe root/detail values are
`48a11255aeb26ae5b1894c059c42c0047548386b3981ddd44114a501bc3905df`
and `8768dee59a22796dffa19f9309c4a742970cc030dea445f064ca21eff531d93f`.
No `.root` or `.data` file is present in `apps/miniprogram`.

M4 is complete. The next implementation milestone is the WebAssembly SDK and
native-versus-Wasm parity gate.

## M5: Complete

The WebAssembly SDK milestone provides:

- a stable, handle-based C ABI with explicit status codes, sized/versioned
  structures, caller-owned buffers, allocation helpers, and a pure-C consumer
  test;
- a CMake/Emscripten build that compiles the platform-neutral SDK directly,
  uses no browser glue, virtual filesystem, DOM API, pthread, or embedded
  network stack, and emits a reproducible standalone Wasm module;
- a small `WXWebAssembly` facade that supplies only the required imports and
  reacquires typed-array views whenever linear memory grows;
- bounded Wasm memory with a 16 MiB initial size and 64 MiB maximum, plus an
  automated growth/view-invalidation contract;
- deterministic CBDAM triangular-strip indices for a `64x64` patch: 2,145
  vertices, 4,096 non-degenerate triangles, 24,573 16-bit indices, and FNV-1a
  hash `2327969341`;
- byte-for-byte native/Wasm parity for camera state, patch decisions,
  priorities, request lists, index topology, real globe patch submission, and
  decoded-value statistics;
- two-clean-build reproducibility, package size, imports, memory limits,
  warning, loader, install, and package-manifest checks in one focused gate;
- packaged headers, facade, manifest, and `terra_sdk.wasm` under
  `workspace_old/package/miniprogram/` without credentials or desktop-only
  dependencies.

The latest verified Wasm module, after the M6 frame extensions, is 72,326
bytes with SHA-256
`f3cafb70f2e36f51628e254bfbc00bbf34a2109660738f4570ad85495e891f38`.
Both complete desktop gates pass after the C ABI and no-exception Wasm work,
and the frozen viewer/nav3d source and direct target declarations are
unchanged. M5 is complete; the next implementation milestone is the Mini
Program WebGL globe renderer.

## M6: Automated Engineering Complete

Implemented locally:

- a full-canvas Globe page backed by WebGL 1 shaders, indexed terrain draws,
  camera-relative vertices, a fallback texture, and context recovery;
- Mini Program image decoding for global-geodetic Blue Marble tiles;
- deterministic reset, zoom, -45 degree tilt, yaw drag, pinch zoom, and
  viewport resize behavior mapped directly to the Terra C ABI camera;
- bounded terrain, geometry, texture, and GPU LRU caches with stale-request
  cancellation, terrain checksum validation, bounded terrain/image retry, and
  user retry;
- device DPR/texture-limit frame budgets controlling request concurrency,
  texture/geometry budgets, and upload work;
- host tests for manifest/payload contracts, cache/cancellation, camera-relative
  matrices, WebGL draw/context recovery, runtime request flow, failure
  recovery, and throttled page-state reporting, wired into the Wasm package
  gate;
- a generated-artifact staging script and a local operator guide at
  `docs/miniprogram/GLOBE_RUNTIME.md`.

The current `verify_miniprogram_wasm.sh` run passed native/Wasm parity,
all six Mini Program Node tests, the warning gate, package generation, and
two-clean-build reproducibility at 72,326 bytes. The required
`verify_baseline.sh` and `verify_globe.sh` desktop gates also passed after the
M6 renderer work.

Deferred final user acceptance (non-blocking):

- successful DevTools, Android, and iOS Blue Marble runs with fixed initial,
  zoom, tilt, yaw, and reset screenshots/reports;
- review context restore and weak-network retry evidence on both devices;
- freeze and meet the M1 reference-device frame-time, memory, and stability
  thresholds; verify no cracks, inverted hemisphere, or image-row mismatch.

The real Wasm/WebGL browser gate now machine-checks the fixed action sequence,
PNG readback, transient terrain retry, reset equivalence, and context recovery.
`verify_miniprogram_device_evidence.sh` remains the final user acceptance tool;
it does not block M6 engineering progress or replace hardware validation.

## M7: Automated Engineering Complete

Implemented locally:

- an optional tianditu-img-c profile that preserves Blue Marble as the
  credential-free default and changes the C ABI texture selector to Tianditu
  matrix offset 1 and maximum internal level 17;
- exact HTTPS WMTS KVP generation using the frozen native matrix, row, column,
  and (row + column) % 8 subdomain contract;
- local-only frontend credential lookup, visible Tianditu attribution,
  rate-limited diagnostics, and redaction of credential query values from
  runtime reports and error state;
- deterministic profile, C-ABI override, URL mapping, and report-redaction
  tests wired into the Wasm package gate.

The scheduled native online gate also passed with the authorized service-side
credential: viewer fixed-action captures were nonblank and nav3d recorded both
WMTS source connection and tile decode without warning/error log events. This
validates the existing desktop WMTS contract; it is not evidence of frontend
credential authorization.

Deferred final user acceptance (non-blocking):

- register the terrain origin and all t0 through t7.tianditu.gov.cn imagery
  domains for the authorized Mini Program;
- validate the application-authorized frontend credential in DevTools, Android,
  and iOS without placing it in source, package, logs, screenshots, or reports;
- review the current provider terms, required notices, and product attribution
  with the authorized application owner before enabling any gateway or
  persistent tile cache;
- capture Android and iOS imagery alignment, weak-network retry, and offline
  Blue Marble fallback evidence.

The device-evidence gate checks the final M7 review declaration, Tianditu
profile reports, Android/iOS retry and fallback records, and textual credential
redaction. Authorization, provider terms, visual alignment, and device results
remain pending user review and control production-release approval, not M7
engineering progress.

## M8: Automated Engineering Complete

Implemented locally:

- versioned CMake exports for `Terra::core`, `Terra::codec`, `Terra::frame`,
  and `Terra::c_api`, with C++14 and pure C installed-package examples;
- native and Mini Program archives containing public headers/runtime files,
  complete imported license texts, provenance notices, package manifests, and
  deterministic file lists, without terrain repositories or credentials;
- a release gate that scans exported targets and archive symbols for desktop
  dependencies, creates each archive twice, compares hashes, extracts the
  native archive, and builds/runs both examples from that extraction;
- compatibility, status/error, ownership, cache/network, support, and final
  acceptance policy in `docs/SDK_RELEASE.md`;
- GitHub CI orchestration for native tests, terrain service, native/Wasm parity,
  reproducible Wasm packaging, real WebGL evidence, and release archives.

The Web gate consumes `workspace_old/package/miniprogram/wasm/terra_sdk.wasm`,
so browser evidence is bound to the Wasm package produced in the same run and
cannot silently use an older Mini Program staging file. The automated release
gate deliberately does not invoke local device evidence.

Deferred final user acceptance (non-blocking):

- import the generated package into the authorized Mini Program project;
- validate DevTools, one supported Android device, and one supported iOS device;
- review application-owned Tianditu authorization, provider terms, attribution,
  touch behavior, weak-network recovery, context recovery, memory, stability,
  and frame time;
- validate the final packet with `verify_miniprogram_device_evidence.sh` and
  explicitly approve production release.

## Verification Evidence

The implementation worktree passed:

```bash
bash scripts/verify_miniprogram_foundation.sh
bash scripts/verify_miniprogram_native_golden.sh
bash scripts/verify_miniprogram_sdk.sh
bash scripts/verify_miniprogram_wasm.sh
bash scripts/verify_web_sdk.sh
bash scripts/verify_terrain_service.sh
bash scripts/verify_terrain_service_globe.sh
bash scripts/verify_sdk_release.sh
bash scripts/verify_baseline.sh
bash scripts/verify_globe.sh
VERIFY_TIANDITU=1 bash scripts/verify_globe.sh
```

The Web SDK gate passed 39 browser assertions with six `640x360` PNGs. The
initial/reset/context-restored framebuffer hash was identical, zoom/tilt/yaw
hashes were distinct, all eight root keys rendered through 10-16 draws, the
simulated transient request recovered on its second attempt, and WebGL context
restore reproduced the reset frame. Evidence is available under
`viewer_verify_output/web_sdk/`.

The complete CMake and Wasm builds contained no `warning:` matches. Native and
Wasm reports matched byte for byte, two clean Wasm builds were identical, and
the Mini Program facade passed its memory-growth tests. Terrain service HTTP
and payload parity gates passed for 1k and globe. The 1k baseline, viewer globe
fixed views, and nav3d globe capture passed. All viewer globe captures remained
within the 2.0 mean-difference limit; the nav3d globe difference was 0.0.
