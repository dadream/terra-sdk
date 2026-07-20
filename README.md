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
- `sdk/`: platform-neutral C++14 libraries and the versioned C ABI.
- `examples/`: consumers built only against an installed SDK package.
- `apps/miniprogram/`, `adapters/wasm/`: WebAssembly and Mini Program runtime.
- `tests/`: headless CTest smoke coverage.
- `docker/`, `scripts/`, `testdata/`: fixed environment and regression tools.

Public include paths remain `sl/...` and `vic/...`. Repository formats such
as `terrain.data`, `terrain.root`, `terrain.xml`, and `victms.xml` are
compatibility contracts.

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

## SDK Status

The repository provides a platform-neutral C++14 SDK, C ABI version 1, a
reproducible Wasm build, a versioned terrain service, a WebGL 1 renderer, and a
Mini Program integration sample. Desktop viewer/nav3d remain frozen downstream
oracles rather than SDK dependencies. See `docs/SDK_RELEASE.md` and
`docs/SDK_MINIPROGRAM_ROADMAP.md` for release boundaries and remaining final
user acceptance.

## Licensing

Imported components retain their original licenses and copyright notices. See
`LICENSE`, `NOTICE`, `spacelib/COPYING`, and `ratman/LICENSE` before
redistribution. In particular, the imported terms do not grant unrestricted
commercial or private-source use.
