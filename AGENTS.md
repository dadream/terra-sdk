# Repository Guidelines

## Structure

`terra-sdk` is the sole source and build repository. Do not read from or add
dependencies on adjacent legacy repositories. `spacelib/` provides the
`sl` foundation; `ratman/base/` and `ratman/ratman/src/` provide VIC,
Geo, VFS, CBDAM, and Ratman; `ratman/ratman/apps/` contains viewer, nav3d,
and builders. Root `cmake/` owns the supported target graph. `tests/`,
`testdata/`, `scripts/`, and `docker/` own verification.

## Build And Test

Use the repository-owned environment:

```bash
bash scripts/build_docker_image.sh
bash scripts/build_cmake.sh
bash scripts/verify_baseline.sh
```

The build must have zero compiler warnings. The full gate also checks CMake
artifact registration and installation, 16 CTests, builders, `mod_victms`,
viewer smoke/interaction captures, and nav3d terrain/texture rendering. Run
focused scripts only while iterating; run `verify_baseline.sh` before a
code-change commit.

## Coding Rules

All C++ targets require at least C++14 with compiler extensions disabled.
Preserve existing `sl/...` and `vic/...` include paths and local naming
style. Generated headers and outputs belong in `workspace_old/`,
`viewer_verify_output/`, or another ignored build tree. Do not change
serialized terrain/TMS formats during build or directory refactors.

Logs are part of the regression contract. Use stable events such as
`[viewer] opengl_initialized` and `[nav3d] terrain_ready`. Do not add
per-frame, per-tile, raw XML, or unconditional debug output. Repeated runtime
failures must be summarized or rate-limited.

## Test Data

`testdata/datasets/ps_1k/` is the checked-in integration fixture. Do not
replace reference outputs or viewer screenshots without reviewing
`viewer_verify_output/1k/report.html` and documenting the intended change.
Do not add large datasets or deployment payloads without a concrete test need.

## Commits

Use focused imperative messages such as `build: establish CMake-only baseline`.
New commits use `dadream <285083020@qq.com>`. Include validation commands in
pull requests and screenshots for intentional rendering changes. The baseline
tag is updated only after the complete gate passes and the worktree is clean.
