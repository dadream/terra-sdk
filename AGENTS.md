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
bash scripts/verify_globe.sh
bash scripts/verify_sdk_release.sh
```

The build must have zero compiler warnings. The full gate also checks CMake
artifact registration and installation, 16 CTests, builders, `mod_victms`,
viewer smoke/interaction captures, and nav3d terrain/texture rendering. Run
focused scripts only while iterating; run `verify_baseline.sh` before a
code-change commit. SDK release changes also require
`verify_sdk_release.sh`; DevTools/Android/iOS acceptance is the repository
owner's final manual step and does not block automated engineering progress.

## Milestone Verification Cadence

User instruction recorded on 2026-10-23: prioritize completing a coherent
implementation milestone. During development, use focused checks tied to the
changed behavior; do not repeatedly run the full gates or redeploy the local
manual service after each small change. Run the applicable full gates, commit,
and update the local service together at the milestone acceptance point. Keep
the current manual service running during implementation. This cadence changes
when completion gates run, not their acceptance requirements.

## Current Milestone Scope

User instruction recorded on 2026-10-26: finish the current goal for Web only,
focusing on rapid global-to-near-ground-and-back zoom and high-tilt interaction.
Use three milestones: freeze executable acceptance, fix the measured critical
path, then perform consolidated gates/commit/local deployment. Keep CBDAM,
the unified imagery model, precision, coverage and cleanup requirements. Broader
P0-P4 platform/product work is deferred and must not prevent closing this scoped
goal once its acceptance and delivery are complete. Do not deploy to49 or run
preflight. Preserve the18766 manual service during development.

## Capacity Calibration

User instruction recorded on 2026-10-23: increase capacity when benchmark
evidence shows the current settings cannot hold the required working set.
Historical memory limits are not fixed acceptance targets. Calibrate terrain
selection and joint CPU/GPU handoff capacity together, keeping precision and
route deadlines unchanged. Retain smaller profiles as explicit pressure tests;
do not treat them as the required default or hide their failed results.
Check bounded input/decode/upload workspaces as well as the global budget:
spare global credit does not prove that a local stage has adequate capacity.
Distinguish working-set shortages, temporary backpressure and network timeouts;
increasing request concurrency alone does not establish sufficient throughput.
Keep live network diagnostics separate from controlled capacity comparisons.

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

Globe integration reads external data from `GLOBE_DATA_DIR` and keeps only
reviewed captures under `testdata/viewer_baseline/globe/`. Follow
`docs/GLOBE_VERIFICATION.md`; never commit a Tianditu token.

## Repository Commit Preference

User instruction recorded on 2026-09-11: do not execute preflight in this
repository. Use ordinary Linux workstation Git commands for commits and pushes. Do not run
preflight planning, signing, formatting, telemetry, or submission workflows.
This preference applies to this repository and its worktrees.

## Commits

Use focused imperative messages such as `build: establish CMake-only baseline`.
New commits use `dadream <285083020@qq.com>`. Include validation commands in
pull requests and screenshots for intentional rendering changes. The baseline
tag is updated only after the complete gate passes and the worktree is clean.

## Development API Policy

User instruction recorded on 2026-10-10: this SDK is in development; do not
maintain old API compatibility. Replace changed contracts directly, update all
in-repository callers and packages, and reject mismatched ABI versions. Do not
add compatibility wrappers or dual runtime paths for the replaced interfaces.

## SDK Package Size Policy

User instruction recorded on 2026-10-12: 512 KiB is a package-size reference,
not a hard release constraint. Measure and report core package size; exceeding
the reference is advisory and must not fail verification. Prefer correctness
and maintainability over custom compression or architectural changes made only
to meet this reference. Runtime CPU/GPU resource budgets remain independent.

## Workstation Test Output Storage

User instruction recorded on 2026-10-17: store `viewer_verify_output/` on the
data disk at `/mnt/1t/terra-sdk-anti/terra-sdk-miniprogram/viewer_verify_output`.
The original workspace path is a persistent bind mount so host scripts and
Docker workspace mounts keep using the same path. Verify `mountpoint -q
viewer_verify_output` before output-producing tests; do not recreate the
directory on the system disk if the mount is unavailable. The manual Web
service on port18766 has the same mount prerequisite. See
`docs/WORKSTATION_TEST_STORAGE.md` for verification and cleanup status.
