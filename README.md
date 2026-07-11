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

A host build is also supported when dependencies are installed:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --target terra_sdk_cmake_smoke --parallel
ctest --test-dir build --output-on-failure
```

## Direction

The current baseline preserves behavior; it does not yet provide a
platform-neutral SDK. See `docs/ARCHITECTURE.md`,
`docs/BASELINE_STATUS.md`, `docs/GLOBE_VERIFICATION.md`, and
`docs/SDK_MINIPROGRAM_ROADMAP.md` for the dependency boundaries and staged
path toward a WebAssembly/mini-program 3D terrain SDK.

## Licensing

Imported components retain their original licenses and copyright notices. See
`LICENSE`, `spacelib/COPYING`, and `ratman/LICENSE`.
