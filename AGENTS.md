# Repository Guidelines

## Structure

This repository combines the former `spacelib` and `ratman` repositories.
The original directory layout is retained during the first migration phase.
`spacelib/` provides the `sl` foundation, while `ratman/base/` and
`ratman/ratman/` provide VIC support, Geo, VFS, CBDAM, Ratman, applications,
builders, and services. Root `cmake/` owns the integrated CMake target graph;
`tests/` owns SDK smoke tests.

## Build And Test

Use the adjacent integration repository for the canonical Docker build:

```bash
cd ../terra-sdk-web
bash build/build_cmake.sh
bash build/verify_cmake_migration.sh
```

For focused local checks:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --target terra_sdk_cmake_smoke --parallel
ctest --test-dir build --output-on-failure
```

Keep qmake functional until its retirement criteria are explicitly met. Run
`../terra-sdk-web/build/build.sh` after changing qmake files or source paths.

## Coding Rules

All targets require at least C++14; CMake targets disable compiler
extensions. Preserve existing
`sl/...` and `vic/...` include paths and local naming style. Generated
headers and build products belong in the build tree, never the source tree.
Do not change serialized terrain/TMS formats as part of directory or build
refactors.

Code-change commits must introduce no compiler warnings. Capture the complete
CMake build log and verify that searching it for `warning:` returns no
matches. Viewer or rendering changes also require the 1k viewer interaction
baseline and nav3d smoke.

## Commits

Use focused imperative messages such as `build: integrate sl into monorepo`.
Preserve imported authorship. New commits use
`dadream <285083020@qq.com>`. Include validation commands in pull requests
and screenshots for intentional viewer changes.
