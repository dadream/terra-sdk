# Terra SDK

Terra SDK is the C++14 monorepo for the SL foundation library and the
Ratman/CBDAM terrain stack. This repository owns all source, build definitions,
tests, fixtures, and regression tooling used by subsequent development. Do not
depend on the former adjacent repositories.

## Layout

- `spacelib/`: SL math, geometry, containers, codecs, and utilities.
- `ratman/base/`: shared VIC support libraries.
- `ratman/ratman/src/`: Geo, VFS, CBDAM, and Ratman libraries.
- `ratman/ratman/apps/`: viewer, nav3d, builders, and retained legacy source.
- `ratman/apache_mod_*/`: Apache service modules.
- `cmake/`: integrated target and dependency definitions.
- `sdk/include/`, `sdk/src/`: platform-neutral C++14 libraries and the versioned C ABI.
- `sdk/js/`: portable camera, imagery, terrain, interaction and public API modules.
- `examples/`: consumers built only against an installed SDK package.
- `adapters/wasm/`, `adapters/webgl/`, `adapters/miniprogram/`: Wasm ABI/worker/runtime, rendering and host integrations.
- `apps/miniprogram/`, `apps/site/`: SDK consumers; generated Mini Program dependencies live under `vendor/terra/`.
- `tests/js/`: JavaScript SDK and adapter contracts, including dependency boundaries.
- `tests/`: headless CTest smoke coverage.
- `docker/`, `scripts/`, `testdata/`: fixed environment and regression tools.

Public include paths remain `sl/...` and `vic/...`. Repository formats such
as `terrain.data`, `terrain.root`, `terrain.xml`, and `victms.xml` are
compatibility contracts.

The current terrain scheduling change separates logical model rounds from
priced physical publication; see [terrain model clock](docs/SDK_TERRAIN_MODEL_CLOCK.md)
for its ownership boundaries, validation scope, and remaining product gates.

## Build And Verify

Build the canonical Docker image after changing `docker/Dockerfile`:

```bash
bash scripts/build_docker_image.sh
```

Build every supported target, run the 16 headless tests, and enforce zero
compiler warnings:

```bash
bash scripts/build_cmake.sh
```

Run the complete release baseline before merging source, build, viewer,
builder, or service changes:

```bash
bash scripts/verify_baseline.sh
```

The gate validates declared and installed artifacts, builders, `mod_victms`,
viewer smoke and interaction captures, and nav3d terrain/texture rendering.
Generated build state lives under `workspace_old/`; logs and reports live
under `viewer_verify_output/`. Both are ignored.

Run the spherical terrain gate when changing coordinate transforms, camera
control, or global imagery:

```bash
bash scripts/verify_globe.sh
```

Build the native and Mini Program release packages and verify them through
installed consumers, service contracts, native/Wasm parity, and real WebGL
browser evidence:

```bash
bash scripts/verify_sdk_release.sh
```

Every test that accesses a live service is subject to the online-resource
cleanup gate. Before reporting success, the test must close all pages,
contexts, and browser/runtime handles it created, and must verify that no
test-owned process remains active. The test must also confirm that no further
requests are being generated for the tested service. A test with incomplete
cleanup is a failed test, even when all functional assertions passed.

Release archives are written under `workspace_old/package/release/`. Manual
DevTools/Android/iOS acceptance is intentionally the final owner step and does
not block the automated engineering gate.

Run the deterministic PS 1k planar visual oracle when changing terrain decode,
frame topology, camera behavior, texture delivery, or WebGL rendering:

```bash
bash scripts/verify_planar_web.sh
```

See `docs/miniprogram/PLANAR_VISUAL_VALIDATION.md` for the DevTools fixed-action
workflow, expected counters, and generated HTML evidence.

A host build is also supported when dependencies are installed:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --target terra_sdk_cmake_smoke --parallel
ctest --test-dir build --output-on-failure
```

## Fixed-view Capacity Benchmark

The vertical-scale benchmark holds longitude, latitude, target ground height,
heading, tilt, viewport and error thresholds fixed. It descends through nominal
internal imagery scales, then returns through exactly the same poses while
retaining caches. It records coverage/precision latency, resource bytes and
spatial membership, distinguishing capacity limits, source limits, diagnostic
inconsistency and timeouts. Scale labels do not force a uniform tile level.
Presented images outside the source's declared levels fail the measurement;
synthetic images must not hide unsupported requests. Unequal endpoint sets
require investigation: CBDAM has coarsening hysteresis, so counts alone do not
prove incorrect selection. Compare spatial membership, error and capacity with
the fresh reference, rather than treating cached resource counts as demand.

After building the SDK, use the local manual service and a Chromium executable:

```bash
node scripts/benchmark_vertical_scale.js --browser /path/to/chromium \
  --output viewer_verify_output/capacity_live
node scripts/benchmark_terrain_reference.js \
  --report viewer_verify_output/capacity_live/report.json \
  --output viewer_verify_output/capacity_terrain --surfaces \
  --upstream http://127.0.0.1:18766
node scripts/benchmark_imagery_reference.js \
  --report viewer_verify_output/capacity_terrain/report.json \
  --output viewer_verify_output/capacity_imagery
```

The terrain reference starts a fresh native CBDAM controller per pose, uses real
decoded heights, and excludes production cache/transition quotas. `--surfaces`
captures the exact visible meshes, UV anchors and projection. The imagery
reference consumes those captures offline through production visibility/error
measurement, the Wasm imagery tree and source adapter. It reports internal nodes,
deduplicated source images, RGBA/mipmap bytes including roots, and UV partition
payload for both source-UV and clipped-UV rendering. It does not fetch images.
Neither reference is an independent correctness oracle, a minimal-cut proof, a
transition-peak bound or a browser/GPU latency measurement.

For an oblique or rotated reference, the terrain command also accepts a JSON
input with `schema: "terra.demand-poses.v1"`, the same `configuration`, and
`poses: [{id, view, terrainThreshold}]`. Each `view` is a complete public
`terra.view-state.v2` globe pose, including target height, range, heading and
tilt. Keep the numerical terrain threshold and viewport from the measured run;
do not derive an oblique reference by changing only its range. The imagery
command verifies the captured projection against that public pose through the
Wasm camera before accepting the result. Regenerate older surface captures
without an explicit pose. The vertical benchmark itself remains fixed nadir.

Omit `--upstream` for offline terrain replay; supply `--records` with a previous
reference's `records.json` when the committed fixture lacks required records.
Missing uncaptured data fails rather than becoming flat terrain. Live capture
checks metadata and one root against the fixture, but the service does not offer
an atomic dataset version. Reference safety ceilings do not prove precision;
source-level exhaustion is explicitly reported. Both commands have bounded
child lifetimes and verify cleanup. Output directories must be new or empty.
Contracts run in `verify_baseline.sh` after the corresponding native/Wasm builds.

## SDK Status

The repository provides a platform-neutral C++14 SDK, a versioned C ABI, a
reproducible Wasm build, a versioned terrain service, a WebGL 2/1 renderer, and a
Mini Program integration sample. Desktop viewer/nav3d remain frozen downstream
oracles rather than SDK dependencies. See `docs/SDK_RELEASE.md` and
`docs/SDK_MINIPROGRAM_ROADMAP.md` for release boundaries and remaining final
user acceptance.

## Licensing

Imported components retain their original licenses and copyright notices. See
`LICENSE`, `NOTICE`, `spacelib/COPYING`, and `ratman/LICENSE` before
redistribution. In particular, the imported terms do not grant unrestricted
commercial or private-source use.
