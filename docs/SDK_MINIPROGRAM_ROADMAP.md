# SDK And Mini-Program Roadmap

## Status And Goal

Implementation continues on branch `feature/miniprogram-sdk` in the separate
`terra-sdk-miniprogram` worktree, created from desktop baseline commit
`e361b81`. The goal is an open, versioned terrain SDK whose platform-neutral
C++14 core runs natively and as WebAssembly and drives globe terrain plus
imagery in a WeChat Mini Program.

Viewer and nav3d remain unchanged desktop regression oracles. They are not SDK
dependencies and will not link new SDK targets until native and WebAssembly
parity has been reviewed as a separate future change. The first product slice
renders the existing EPSG:4326 cylindrical globe with offline Blue Marble.
Tianditu satellite imagery follows as an online extension.

## Scope

Included:

- cylindrical globe metadata and transforms, CBDAM topology, camera, frustum
  culling, LOD/refinement, patch decode, and texture tile selection;
- a versioned native C++ API and stable C ABI for WebAssembly;
- backend-neutral frame data and a thin Mini Program WebGL renderer;
- HTTPS streaming of existing terrain repositories without format changes;
- fixed-camera state, image, network, memory, and frame-time verification;
- offline Blue Marble and authorized Tianditu global-geodetic imagery.

Excluded from the first release:

- unrelated source moves or renames;
- viewer/nav3d behavior, controls, output, or target dependency changes;
- a TypeScript CBDAM rewrite or use of Qt/OpenGL viewer code;
- a new terrain repository format or globe dataset conversion;
- Wasm threads, a POSIX virtual file system, DOM assumptions, or a browser app;
- Tianditu proxying or persistent caching without reviewed provider terms.

## Immutable Desktop Oracle

The behavior at `e361b81` is the initial oracle. Until a separately approved
desktop adoption phase:

- do not edit `ratman/ratman/apps/cbdam/viewer` or
  `ratman/ratman/apps/nav3d` for Mini Program work;
- do not change sources or links of `vic_app_cbdam_viewer` and
  `vic_app_ratman_nav3d`;
- do not replace 1k or globe captures to make an extraction pass;
- preserve `terrain.data`, `terrain.root`, `terrain.xml`, and `victms.xml`;
- keep all compiler logs free of warnings.

Every native algorithm change runs:

```bash
bash scripts/verify_baseline.sh
bash scripts/verify_globe.sh
```

`VERIFY_TIANDITU=1` is a scheduled or manual online gate. Offline Blue Marble
is the deterministic merge gate. A target-manifest check will reject accidental
desktop source or link-graph changes.

## Architecture

```text
Mini Program page and gestures
            |
TypeScript facade ---------------- wx.request / image decode / cache
            |                                      |
       Terra C ABI                           HTTPS services
            |
 platform-neutral C++14 core
            |
 camera + CBDAM + patch codec + WMTS selection
            |
 backend-neutral FramePacket
            |
 thin WebGL 1 renderer
```

TypeScript owns asynchronous IO, image decode, credentials, cache policy, and
Mini Program lifecycle. Wasm owns deterministic terrain state and geometry
selection. WebGL consumes contiguous typed arrays, not per-vertex JS objects.

The first runtime is single-threaded and requires no pthreads,
SharedArrayBuffer, DOM APIs, or Emscripten virtual file system. Worker and
OffscreenCanvas support is a later optimization gated by measured devices.

## Repository Layout

```text
sdk/
  include/terra/
  src/core/
  src/codec/
  src/frame/
  src/c_api/
adapters/wasm/
apps/miniprogram/
services/terrain/
tests/sdk/
tests/wasm/
tests/miniprogram/
testdata/miniprogram/
docs/miniprogram/
```

Existing `spacelib/` and `ratman/` stay in place. Public `terra/...` headers
must not expose SL, VIC, Qt, OpenGL, CURL, Berkeley DB, MPI, or Apache types.

## Dependency Contract

`Terra::core`, `Terra::codec`, and `Terra::frame` use C++14 without compiler
extensions. Their target closure may contain only the standard library,
explicitly audited platform-neutral SL code, and lower Terra targets. CMake
tests reject Qt, OpenGL/GLEW, CURL, GDAL, MPI, Berkeley DB, Apache, and platform
socket dependencies.

## Runtime Contracts

### Dataset Manifest

The versioned manifest contains a dataset ID, format version, `patch_dim`,
height scale, SRS, transform and radius, root/detail endpoint templates, codec,
bounds, level range, and texture descriptors. The current globe remains
EPSG:4326, cylindrical, radius 6,378,000 m, and patch dimension 64.

### Terrain Service

The v1 service resolves root/detail keys `(i, j, k)` from current repositories
and returns `application/octet-stream` with format version, length, checksum
or ETag, cache policy, and explicit errors. It never exposes Berkeley DB files
to clients. TypeScript owns concurrency, cancellation, retries, and compressed
cache; Wasm validates and decodes payloads.

### C ABI

The handle-based ABI begins with:

```text
terra_create / terra_destroy
terra_load_manifest
terra_set_viewport / terra_set_camera
terra_submit_patch / terra_fail_patch
terra_update
terra_get_requests / terra_get_frame / terra_get_stats
terra_get_last_error
```

Calls return status codes and never throw across the boundary. Variable data
uses caller buffers or immutable views with explicit lifetimes. Promises and
network callbacks do not enter C++.

### Frame Packet

A frame contains camera state, camera-relative origin, visible patch IDs,
contiguous vertices and indices, draw ranges, texture keys, flags, and counters.
Patch dimension 64 permits per-patch 16-bit indices. Camera-relative GPU
coordinates prevent Earth-radius doubles losing visible precision as floats.

### Texture Sources

Blue Marble is deterministic. Tianditu reuses the tested `img_c` mapping. A
Mini Program-authorized credential is supplied at runtime and never stored in
Git, XML, reports, or logs. Server credentials never enter the app package.

## Milestones

### M0: Isolated Baseline

Tasks:

- push `main` with WSL Git and create the feature worktree;
- record this roadmap and a desktop target source/link manifest;
- add a focused foundation gate that does not change desktop apps.

Exit:

- main and feature worktree share the known base;
- original repositories are clean;
- desktop target manifest and regression commands are reproducible.

### M1: Mini Program Capability Probe

Tasks:

- add a minimal native Mini Program with a full-canvas WebGL view;
- instantiate a tiny checked-in Wasm module using `WXWebAssembly`;
- render and read back a deterministic colored triangle;
- export platform, version, viewport, DPR, WebGL, extensions, texture limits,
  Wasm result, and frame checksum as capability JSON;
- exercise HTTPS ArrayBuffer requests without embedding credentials.

Exit:

- DevTools plus one Android and one iOS device provide reviewed screenshots and
  JSON reports;
- Wasm returns the expected value and the framebuffer is nonblank;
- reference-device frame and memory thresholds are frozen.

### M2: Native Behavior Characterization

Tasks:

- add golden tests for planar/cylindrical metadata and transforms;
- freeze root topology, camera matrices, frustum results, LOD cuts, patch IDs,
  patch decode, and WMTS tile keys;
- capture fixtures from current code without changing current behavior.

Exit:

- fixtures are deterministic and reviewable;
- semantic changes fail without relying on framebuffer noise;
- full desktop and globe gates stay green.

### M3: Platform-Neutral SDK

Tasks:

- introduce `Terra::core`, `Terra::codec`, and `Terra::frame`;
- extract one algorithm at a time behind M2 tests;
- implement metadata, transforms, topology, camera/culling, LOD, texture
  selection, patch decode, and installed-consumer tests.

Exit:

- dependency closure passes;
- public headers expose only Terra and standard types;
- patch decisions and geometry match M2 fixtures;
- viewer/nav3d still use original targets and pass both full gates.

### M4: Versioned Terrain Delivery

Tasks:

- implement manifest and root/detail patch HTTP contracts;
- adapt current repositories behind a modern service;
- prove payload parity with the current repository reader;
- test malformed keys, missing patches, truncation, checksums, and caching;
- document HTTPS deployment and Mini Program request-domain setup.

Exit:

- clients fetch manifest, root, and detail patches without VFS/DB access;
- success and failure contracts are automated;
- the 768 MiB detail repository stays outside the app package.

### M5: WebAssembly SDK

Tasks:

- implement the C ABI and Emscripten CMake preset/toolchain;
- use a small `WXWebAssembly` loader instead of browser glue;
- keep network and image decode outside Wasm;
- bound memory and reacquire typed views after growth;
- compare native and Wasm fixtures.

Exit:

- clean builds emit reproducible Wasm, facade, headers, and manifest;
- state, requests, patch IDs, and indices match native;
- package size and peak memory pass frozen limits.

### M6: Globe WebGL Renderer

Tasks:

- implement WebGL 1 shaders, draw path, GPU caches, and context restore;
- decode imagery through Mini Program image APIs;
- add reset, zoom, 45-degree tilt, yaw, and resize;
- add geometry/image/GPU LRU caches and stale-request cancellation;
- adapt screen error, DPR, requests, and work to a frame budget.

Exit:

- the full Blue Marble globe renders;
- fixed actions match exact SDK state and approved perceptual images;
- no topology cracks, inverted hemispheres, or tile-row mismatch exist;
- reference devices meet M1 performance and stability thresholds.

### M7: Tianditu

Tasks:

- validate an application-authorized frontend credential on real devices;
- configure legal request domains and `img_c` requests;
- show required attribution and preserve provider notices;
- handle credential/network failures with rate-limited diagnostics;
- review terms before any gateway or persistent tile cache is enabled.

Exit:

- Android and iOS evidence shows correctly aligned imagery;
- no credential appears in source, package, logs, or reports;
- offline globe operation remains available.

### M8: SDK Release

Tasks:

- publish versioned C++/C APIs, exports, and consumer samples;
- audit licenses, notices, data rights, and generated artifacts;
- add native, Wasm, service, package, and device-evidence CI;
- document compatibility, errors, cache, and support policy;
- treat desktop adoption as a separate post-parity goal.

Exit:

- a clean checkout builds, tests, packages, and runs samples;
- SDK artifacts contain no desktop-only or proprietary dependencies;
- viewer/nav3d remain green desktop oracles.

## Verification Matrix

| Change | Focused gate | Required regression |
| --- | --- | --- |
| Documentation/probe | probe static checks | clean desktop worktree |
| Core or codec | golden tests/dependency audit | both desktop gates |
| Service | HTTP and repository parity | `verify_baseline.sh` |
| C ABI/Wasm | native-Wasm parity/package | both desktop gates |
| WebGL renderer | fixed state/image/device report | both desktop gates |
| Tianditu | scheduled real-device check | offline globe gate |

Compiled gates reject `warning:`. Native core and service tests add sanitizers
and malformed inputs where the toolchain supports them.

## Iteration And Commit Policy

Each iteration:

1. Adds a deterministic assertion.
2. Implements one complete boundary change.
3. Runs the focused gate.
4. Runs required desktop gates.
5. Reviews state, logs, and images before commit.

Commits use `dadream <285083020@qq.com>`, imperative messages, and WSL Git.
Never commit tokens, external globe data, private DevTools settings, build
outputs, or unreviewed baseline replacements.

## Completion Criteria

The goal is complete only when:

- native and Wasm behavior has deterministic parity evidence;
- existing globe data streams through the versioned terrain service;
- Blue Marble and authorized Tianditu render on reference Android/iOS devices;
- interactions, weak network, cache bounds, context recovery, package size,
  memory, stability, and frame-time gates pass;
- public SDK artifacts and docs build from a clean checkout;
- viewer/nav3d behavior, targets, logs, captures, and regression gates remain
  unchanged from the desktop oracle.
