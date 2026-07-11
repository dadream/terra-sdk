# Build System

## Ownership

The root CMake project is the only supported build definition. It integrates
SL, VIC base, Geo, VFS, CBDAM, Ratman, builders, viewer, nav3d, and
`mod_victms`. Every C++ target requires C++14 and disables compiler
extensions.

```text
spacelib/sl
  -> ratman/base
  -> Geo / VFS / CBDAM
  -> Ratman
  -> builders / services / viewer / nav3d
```

## Docker Environment

`docker/Dockerfile` fixes the compiler and Qt 5, OpenMPI, GDAL, GLEW,
Berkeley DB, libcurl, PROJ, and Apache/APXS dependencies.

```bash
bash scripts/build_docker_image.sh
```

Scripts mount this repository at `/workspace` and the ignored
`workspace_old/` build state at `/wksp`.

## Build And Tests

```bash
bash scripts/build_cmake.sh
```

This configures `workspace_old/build/cmake/`, builds target
`terra_sdk_cmake_smoke`, verifies all 16 expected CTests, runs them, and
fails when the build log contains `warning:`.

`scripts/cmake_artifacts.tsv` is the reviewed three-column
`kind/artifact/mode` contract. CMake writes
`terra_sdk_cmake_artifacts.tsv` into the build tree. These commands verify
that the declaration, build tree, and staged install agree:

```bash
bash scripts/validate_cmake_artifacts_manifest.sh
bash scripts/check_cmake_artifacts.sh
bash scripts/check_cmake_install_artifacts.sh
```

## Regression Gate

```bash
bash scripts/verify_baseline.sh
```

The gate runs the build and warning audit, artifact checks, staged install,
Apache service smoke, builder CLI and 1k rebuild, rebuilt-data viewer smoke,
viewer smoke, nav3d smoke, and deterministic viewer interaction report.

Focused commands:

```bash
VIEWER_TIMEOUT_SECONDS=25 bash scripts/verify_viewer_1k_smoke.sh
VIEWER_TIMEOUT_SECONDS=120 bash scripts/verify_viewer_1k_interaction.sh
NAV3D_TIMEOUT_SECONDS=45 bash scripts/verify_nav3d_1k_smoke.sh
bash scripts/verify_viewer_1k.sh
bash scripts/verify_nav3d_1k.sh
```

Viewer and nav3d smoke tests validate structured readiness events and enforce
log line budgets. Interaction verification additionally validates captures,
state JSON, the normalized log contract, and the HTML comparison report.

## Boundaries

Source lists remain centralized in `cmake/`, and several core targets still
carry Qt/OpenGL/storage dependencies. Historical application source without a
listed CMake target is retained but is not part of the supported build surface.
SDK extraction must preserve file formats and keep `verify_baseline.sh` green.
