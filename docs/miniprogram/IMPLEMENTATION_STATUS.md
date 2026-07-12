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

## M1: In Progress

Implemented locally:

- native Mini Program project and full-canvas WebGL probe;
- deterministic shader draw and framebuffer readback;
- checked-in 41-byte Wasm module exporting `add`;
- `WXWebAssembly` loader with expected result 42;
- modern/legacy system capability collection;
- optional credential-free HTTPS ArrayBuffer probe;
- host utility tests and operator documentation.

Still required before M1 can be marked complete:

- successful WeChat DevTools run and screenshot/report;
- successful Android and iOS runs and screenshot/reports;
- configured request-domain ArrayBuffer result;
- reviewed reference-device frame and memory thresholds.

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

## Verification Evidence

The implementation worktree passed:

```bash
bash scripts/verify_miniprogram_foundation.sh
bash scripts/verify_miniprogram_native_golden.sh
bash scripts/verify_miniprogram_sdk.sh
bash scripts/verify_baseline.sh
bash scripts/verify_globe.sh
```

The complete CMake build contained no `warning:` matches. The 1k baseline,
viewer globe fixed views, and nav3d globe capture passed. All viewer globe
captures remained within the 2.0 mean-difference limit; the nav3d globe
difference was 0.0.
