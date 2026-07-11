# CMake-Only Baseline Status

## Identity

- Baseline date: 2026-07-11.
- Baseline tag: `baseline-cmake-only-2026-07-11`.
- Language level: C++14 minimum, compiler extensions disabled.
- Build environment: repository-owned `qt-dev-env` Docker image.
- Full gate: `bash scripts/verify_baseline.sh`.

The tag is valid only when the full gate passes with no compiler warnings and
the committed worktree is clean.

## Validation Evidence

The default gate passed on 2026-07-11:

- 16/16 CTests passed and the compiler warning audit found zero matches.
- All 22 declared build artifacts matched the generated registry and install.
- Viewer smoke emitted 11 effective log lines; nav3d emitted 12.
- Viewer interaction emitted 63 lines with no unknown or forbidden entries.
- The HTML report embedded 21 PNGs for seven Baseline/Current/Diff rows.

## Supported Build Surface

The root CMake project builds and registers:

- `sl` and nine `vic_base_*` libraries.
- VFS, Geo base/SRS/builder, CBDAM Geo/base, and Ratman libraries.
- `vic_geo_raster_quadtree_builder` and `vic_cbdam_mpi_builder`.
- `vic_cbdam_viewer` and `vic_ratman_nav3d`.
- `mod_victms.so`.
- Sixteen exact headless CTests.

Historical application source without a registered target is retained for
reference but is outside the supported build and release surface.

## Regression Contract

The baseline gate proves:

1. Clean CMake build, exact CTest registration, all tests passing, zero
   `warning:` diagnostics.
2. Reviewed artifact manifest equals the generated registry and staged install.
3. Builder CLI behavior and deterministic 1k terrain/texture rebuild.
4. `mod_victms` startup and XML responses.
5. Viewer terrain/texture/OpenGL readiness and deterministic interaction
   captures, state JSON, normalized logs, and HTML report.
6. Nav3d terrain repository, texture root/layers, update thread, UI, and
   renderer readiness.

Viewer and nav3d logs use stable `[component] event` records. Per-tile URLs,
raw XML, frame-level output, and repeated missing-file errors are forbidden by
smoke and interaction log budgets.

## Known Boundaries

This baseline preserves behavior; it is not the final SDK. CBDAM core still
contains Qt, OpenGL, storage, networking, and threading dependencies. CMake
source lists are centralized. The next work must extract platform-neutral
algorithms incrementally while keeping this gate green and preserving all
terrain/TMS formats.
